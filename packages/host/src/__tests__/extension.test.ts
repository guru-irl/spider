// packages/host/src/__tests__/extension.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests } from "@spider/db-core";
import spiderExtension from "../extension.js";
import { HOOK_NAMES } from "../hooks.js";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `ext-${process.pid}`);
afterEach(() => { setGlobalDbPathForTests(null); rmSync(scratch, { recursive: true, force: true }); });

function fakePi() {
  const tools: Record<string, unknown> = {};
  const hooks: Record<string, unknown> = {};
  return {
    registerTool: (t: { name: string }) => { tools[t.name] = t; },
    registerCommand: () => {},
    on: (name: string, fn: unknown) => { hooks[name] = fn; },
    _tools: tools, _hooks: hooks,
  };
}

describe("spider extension entry", () => {
  it("registers exactly one tool named 'spider'", () => {
    const pi = fakePi();
    spiderExtension(pi as never);
    expect(Object.keys(pi._tools)).toEqual(["spider"]);
  });

  it("registers a handler for every contract hook", () => {
    const pi = fakePi();
    spiderExtension(pi as never);
    for (const name of HOOK_NAMES) expect(pi._hooks[name]).toBeTypeOf("function");
  });

  it("the spider tool routes control doctor", async () => {
    mkdirSync(scratch, { recursive: true });
    setGlobalDbPathForTests(join(scratch, `g-${Date.now()}.db`));
    const dir = join(scratch, "proj"); mkdirSync(dir, { recursive: true });
    const pi = fakePi();
    spiderExtension(pi as never);
    const tool = pi._tools["spider"] as {
      execute(id: string, args: unknown, ctx: unknown): Promise<unknown>;
    };
    const res = await tool.execute("c1", { action: "control", command: "doctor", cwd: dir }, {}) as { lines: string[] };
    expect(res.lines.join("\n")).toMatch(/spider doctor/);
  });

  it("an unregistered action returns the not-implemented stub", async () => {
    const pi = fakePi();
    spiderExtension(pi as never);
    const tool = pi._tools["spider"] as { execute(id: string, args: unknown, ctx: unknown): Promise<unknown> };
    const res = await tool.execute("c2", { action: "remember" }, {}) as { error: string };
    expect(res.error).toMatch(/not.*implemented/i);
  });
});
