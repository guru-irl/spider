import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildChildSpawnSpec,
  SPIDER_DB_PATH_ENV,
  SUBAGENT_CHILD_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_ORCHESTRATOR_TARGET_ENV,
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
} from "../pi-args";

let scratchRoot: string;

beforeAll(() => {
  scratchRoot = path.join(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider", "scratch", "child-extensions", `pi-args-${process.pid}`);
  fs.mkdirSync(scratchRoot, { recursive: true });
});

afterAll(() => {
  // Clean up test scratch
  if (scratchRoot) {
    try {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

const base = {
  runId: "r1",
  sessionId: "s1",
  agent: "worker",
  task: "do it",
  context: "fresh" as const,
  parentSessionId: "s1",
  childIndex: 0,
  dbPath: "", // Will be set in tests
  scratchRoot: "", // Will be set in tests
};

describe("buildChildSpawnSpec", () => {
  it("marks the child and threads the shared DB path + run id through env", () => {
    const dbPath = path.join(scratchRoot, "test.db");
    const spec = buildChildSpawnSpec({ ...base, scratchRoot, dbPath });
    expect(spec.env[SUBAGENT_CHILD_ENV]).toBe("1");
    expect(spec.env[SPIDER_DB_PATH_ENV]).toBe(dbPath);
    expect(spec.env[SUBAGENT_RUN_ID_ENV]).toBe("r1");
  });

  it("places the session file under the scratch root as a .jsonl, never in /tmp", () => {
    const spec = buildChildSpawnSpec({ ...base, scratchRoot });
    expect(spec.sessionFile.startsWith(scratchRoot)).toBe(true);
    expect(spec.sessionFile.endsWith(".jsonl")).toBe(true);
    expect(spec.sessionFile.includes("/tmp")).toBe(false);
  });

  it("references the parent session in argv when forking", () => {
    const spec = buildChildSpawnSpec({ ...base, scratchRoot, context: "fork" });
    expect(spec.argv.includes("s1")).toBe(true);
  });

  it("propagates intercom/orchestrator env when provided", () => {
    const spec = buildChildSpawnSpec({
      ...base,
      scratchRoot,
      orchestratorTarget: "orch-session",
      intercomSessionName: "child-name",
    });
    expect(spec.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV]).toBe("orch-session");
    expect(spec.env.PI_SUBAGENT_INTERCOM_SESSION_NAME).toBe("child-name");
    expect(spec.env[SUBAGENT_CHILD_AGENT_ENV]).toBe("worker");
    expect(spec.env[SUBAGENT_CHILD_INDEX_ENV]).toBe("0");
  });

  it("loads the injected spider bundle as the child extension with discovery disabled", () => {
    const spec = buildChildSpawnSpec({ ...base, scratchRoot, childExtensionPath: "/abs/dist/extension.js" });
    expect(spec.argv).toContain("--no-extensions");
    const i = spec.argv.indexOf("--extension");
    expect(i).toBeGreaterThan(-1);
    expect(spec.argv[i + 1]).toBe("/abs/dist/extension.js");
  });

  it("never references the unported upstream helper extensions (regression: child failed to start)", () => {
    const spec = buildChildSpawnSpec({ ...base, scratchRoot });
    const joined = spec.argv.join(" ");
    expect(joined).not.toContain("subagent-prompt-runtime.ts");
    expect(joined).not.toContain("fanout-child.ts");
    // and it DOES load a child extension (defaulted to this module's own bundled entry)
    const i = spec.argv.indexOf("--extension");
    expect(i).toBeGreaterThan(-1);
    expect(spec.argv[i + 1]).toBeTruthy();
  });
});

import { buildPiArgs, thinkingFromModel, stripThinkingSuffix } from "../pi-args";
it.each([undefined, ["/path/to/spider.js", "/path/to/intercom.ts"]])("appends child-only extensions after explicit extensions %j", extensions => {
  const { args } = buildPiArgs({ baseArgs: [], task: "work", sessionEnabled: false, inheritProjectContext: true, inheritSkills: true,
    extensions, subagentOnlyExtensions: ["/path/to/first.ts", "/path/to/first.ts", "/path/to/second.ts"] });
  expect(args.flatMap((arg, i) => arg === "--extension" ? [args[i + 1]] : [])).toEqual([
    ...(extensions ?? []), "/path/to/first.ts", "/path/to/second.ts",
  ]);
  expect(args.includes("--no-extensions")).toBe(extensions !== undefined);
});
function extensionAliases() {
  const spider = path.join(scratchRoot, "spider.js"), intercom = path.join(scratchRoot, "intercom.js");
  fs.writeFileSync(spider, "export default () => {};\n");
  fs.writeFileSync(intercom, "export default () => {};\n");
  const alias = path.join(scratchRoot, "spider-alias.js"), intercomAlias = path.join(scratchRoot, "intercom-alias.js");
  if (!fs.existsSync(alias)) fs.symlinkSync(spider, alias);
  if (!fs.existsSync(intercomAlias)) fs.symlinkSync(intercom, intercomAlias);
  const first = path.join(scratchRoot, "first.js");
  fs.writeFileSync(first, "export default () => {};\n");
  return { spider, intercom, first, aliases: [`${scratchRoot}/./spider.js`, `${scratchRoot}//spider.js`, alias, intercomAlias] };
}

it.each([false, true])("canonicalizes aliases in buildPiArgs with explicit extensions=%s while keeping the first spelling", explicit => {
  const { spider, intercom, first, aliases } = extensionAliases();
  const firstSpelling = `${scratchRoot}/./first.js`;
  const { args } = buildPiArgs({ baseArgs: [], task: "work", sessionEnabled: false, inheritProjectContext: true, inheritSkills: true,
    extensions: explicit ? [spider, intercom] : undefined,
    subagentOnlyExtensions: [...(explicit ? [] : [spider, intercom]), ...aliases, firstSpelling, first] });
  expect(args.flatMap((arg, i) => arg === "--extension" ? [args[i + 1]] : [])).toEqual([spider, intercom, firstSpelling]);
});

it.each(["rpc", "print"] as const)("does not load spider path aliases twice in %s spawn specs", childMode => {
  const { spider, intercom, first, aliases } = extensionAliases();
  const spec = buildChildSpawnSpec({ ...base, scratchRoot, childMode, childExtensionPath: spider, intercomExtensions: [intercom],
    subagentOnlyExtensions: [...aliases.slice(0, 3), ...(childMode === "rpc" ? [aliases[3]] : []), first, `${scratchRoot}/./first.js`] });
  expect(spec.argv.flatMap((arg, i) => arg === "--extension" ? [spec.argv[i + 1]] : []))
    .toEqual([spider, ...(childMode === "rpc" ? [intercom] : []), first]);
});

describe("thinking suffix parsing", () => {
  it("thinkingFromModel extracts a whitelisted level, else undefined", () => {
    expect(thinkingFromModel("github-copilot/claude-opus-4.8:high")).toBe("high");
    expect(thinkingFromModel("prov/m:low")).toBe("low");
    expect(thinkingFromModel("github-copilot/claude-opus-4.8")).toBeUndefined();
    expect(thinkingFromModel("prov/m:notalevel")).toBeUndefined();
    expect(thinkingFromModel(undefined)).toBeUndefined();
  });
  it("stripThinkingSuffix removes only a whitelisted level suffix", () => {
    expect(stripThinkingSuffix("github-copilot/claude-opus-4.8:high")).toBe("github-copilot/claude-opus-4.8");
    expect(stripThinkingSuffix("prov/m:notalevel")).toBe("prov/m:notalevel");
    expect(stripThinkingSuffix("prov/m")).toBe("prov/m");
  });
});


it("recognizes max suffixes and passes max through the explicit pi CLI flag", () => {
  expect(thinkingFromModel("acme/model:max")).toBe("max");
  expect(stripThinkingSuffix("acme/model:max")).toBe("acme/model");
  const built = buildPiArgs({ baseArgs: [], task: "hi", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false, model: "acme/model:max" });
  expect(built.args.slice(built.args.indexOf("--model"), built.args.indexOf("--model") + 2)).toEqual(["--model", "acme/model"]);
  expect(built.args.slice(built.args.indexOf("--thinking"), built.args.indexOf("--thinking") + 2)).toEqual(["--thinking", "max"]);
});
