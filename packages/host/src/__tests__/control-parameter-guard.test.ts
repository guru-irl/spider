import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scanHandlerArgs } from "./control-parameter-analysis";
import { SPIDER_PARAMETERS } from "../extension";

const root = new URL("../../../../", import.meta.url);
const handlers: Array<[string, string, string]> = [
  ["control", "packages/host/src/extension.ts", "handleControl"],
  ["remember", "packages/host/src/extension.ts", "remember"],
  ["recall", "packages/host/src/extension.ts", "recall"],
  ["search", "packages/context/src/actions/search.ts", "runSearch"],
  ["index", "packages/context/src/actions/index-fetch.ts", "runIndex"],
  ["fetch", "packages/context/src/actions/index-fetch.ts", "runFetch"],
  ["exec", "packages/context/src/actions/exec.ts", "runExec"],
  ["exec_file", "packages/context/src/actions/exec.ts", "runExecFile"],
  ["batch", "packages/context/src/actions/exec.ts", "runBatch"],
  ["import", "packages/context/src/actions/import.ts", "runImport"],
  ["run", "packages/subagents/src/actions/run.ts", "runHandler"],
  ["kill", "packages/subagents/src/actions/kill.ts", "killHandler"],
  ["message", "packages/subagents/src/actions/message.ts", "messageHandler"],
  ["todo", "packages/todo/src/actions.ts", "makeTodo"],
  ["skill", "packages/organism/src/actions.ts", "skillAction"],
];

describe("model-facing control and run parameters", () => {
  it("declares mark as a string with its required package and ref", () => {
    const mark = (SPIDER_PARAMETERS.properties as unknown as Record<string, { type?: string; description?: string }>).mark;
    expect(mark?.type).toBe("string");
    expect(mark?.description).toMatch(/upstream-watch.*package.*ref/i);
  });

  it("declares handoff and describes the actual pipeline continuation", () => {
    const handoff = (SPIDER_PARAMETERS.properties as unknown as Record<string, { type?: string; description?: string }>).handoff;
    expect(handoff?.type).toBe("string");
    expect(handoff?.description).toMatch(/fresh.*child.*previous/i);
  });

  it("describes import selection as an epoch cutoff with combined filters", () => {
    const { select } = SPIDER_PARAMETERS.properties;
    expect(select.description).toMatch(/since.*epoch timestamp in milliseconds.*modified at or after/i);
    expect(select.description).toMatch(/filters combine.*AND/i);
    expect(select.description).toMatch(/all.*replaces.*project/i);
  });

  it("describes the fetch cache TTL and its 24 h default", () => {
    expect(SPIDER_PARAMETERS.properties.ttl.description).toMatch(/24 h default/i);
  });

  it("declares reads from all 15 action handlers and argument-receiving helpers", () => {
    const declared = new Set(Object.keys(SPIDER_PARAMETERS.properties));
    expect(handlers.map(([action]) => action).sort()).toEqual([...SPIDER_PARAMETERS.properties.action.enum].sort());
    const missing: string[] = [];
    for (const [action, path, handler] of handlers) {
      const file = fileURLToPath(new URL(path, root));
      const source = readFileSync(file, "utf8");
      const reads = scanHandlerArgs(source, handler);
      if (action !== "import") expect(reads.size, `${action} handler not scanned`).toBeGreaterThan(0);
      for (const name of reads) {
        if (!declared.has(name)) missing.push(`${action}.${name}`);
      }
    }
    // These helpers receive the whole argument object from their registered actions.
    for (const [action, path, helper] of [
      ["import", "packages/context/src/import.ts", "importSessions"],
      ["skill", "packages/organism/src/actions.ts", "skillAction"],
      ["control", "packages/organism/src/actions.ts", "curateAction"],
      ["remember/recall", "packages/host/src/extension.ts", "scopeOf"],
      ["remember/recall", "packages/host/src/extension.ts", "removedMemoryScope"],
    ]) {
      const reads = scanHandlerArgs(readFileSync(fileURLToPath(new URL(path, root)), "utf8"), helper);
      expect(reads.size, `${helper} helper not scanned`).toBeGreaterThan(0);
      for (const name of reads) if (!declared.has(name)) missing.push(`${action}.${name}`);
    }
    expect(missing.sort()).toEqual([]);
  });

  it.each([
    ["destructuring", "const { undeclared } = args"],
    ["bracket", "args['undeclared']"],
    ["alias", "const a2 = args; a2.undeclared"],
    ["non-null", "args!.undeclared"],
    ["as assertion", "(args as any).undeclared"],
    ["helper", "helper(args); function helper(input: any) { return input.undeclared; }"],
    ["helper destructure", "helper(args); function helper(input: any) { const { undeclared } = input; }"],
    ["type assertion", "(<any>args).undeclared"],
  ])("detects undeclared reads via %s", (_form, body) => {
    const names = scanHandlerArgs(`function handle(args: any) { ${body} }`, "handle");
    expect(names.has("undeclared")).toBe(true);
  });

  it("fails closed on computed args keys", () => {
    expect(() => scanHandlerArgs("function handle(args: any, key: string) { return args[key]; }", "handle")).toThrow(/dynamic args key/);
  });
});
