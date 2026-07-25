// packages/host/src/__tests__/extension.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setGlobalDbPathForTests, openDbAt } from "@spider/db-core";
import spiderExtension, { buildActionCtx, sessionIdOf, cwdOf } from "../extension";
import { getAction } from "../dispatch";
import { HOOK_NAMES } from "../hooks";

const scratch = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".spider", "scratch", `ext-${process.pid}`);
afterEach(() => { setGlobalDbPathForTests(null); rmSync(scratch, { recursive: true, force: true }); });

function fakePi() {
  const tools: Record<string, unknown> = {};
  const hooks: Record<string, unknown> = {};
  const commands: Record<string, unknown> = {};
  return {
    registerTool: (t: { name: string }) => { tools[t.name] = t; },
    registerCommand: (name: string, def: unknown) => { commands[name] = def; },
    on: (name: string, fn: unknown) => { hooks[name] = fn; },
    _tools: tools, _hooks: hooks, _commands: commands,
  };
}

describe("spider extension entry", () => {
  it("advertises run/query params in the tool schema so the model passes them (regression: empty tasks/0 tool calls)", () => {
    const pi = fakePi();
    spiderExtension(pi as never);
    const props = (pi._tools.spider as { parameters: { properties: Record<string, any> } }).parameters.properties;
    for (const k of ["agent", "task", "tasks", "chain", "query", "content"]) {
      expect(props[k], `schema must advertise '${k}'`).toBeTruthy();
    }
    // async-only: there is NO synchronous option, so the schema must NOT advertise `async`.
    expect(props.async).toBeUndefined();
    expect(props.tasks.items.required).toEqual(expect.arrayContaining(["agent", "task"]));
  });

  it("registers the 'spider' tool (with the 🕸 description) alongside the edit/write overrides", () => {
    const pi = fakePi();
    spiderExtension(pi as never);
    // Routing wires edit/write overrides at load, so there are now three tools.
    expect(new Set(Object.keys(pi._tools))).toEqual(new Set(["spider", "edit", "write"]));
    const spider = pi._tools["spider"] as { description: string };
    expect(spider.description).toContain("🕸");
  });

  it("registers a handler for every contract hook", () => {
    const pi = fakePi();
    spiderExtension(pi as never);
    // tool_call is now in HOOK_NAMES for exec enforcement.
    // tool_result remains routing-only.
    expect(HOOK_NAMES).toContain("tool_call");
    expect(HOOK_NAMES).not.toContain("tool_result");
    for (const name of HOOK_NAMES) expect(pi._hooks[name]).toBeTypeOf("function");
  });

  it("wires routing at load: tool_call/tool_result hooks + edit/write tool overrides", () => {
    const pi = fakePi();
    spiderExtension(pi as never);
    expect(pi._hooks["tool_call"]).toBeTypeOf("function");
    expect(pi._hooks["tool_result"]).toBeTypeOf("function");
    expect(pi._tools["edit"]).toBeTruthy();
    expect(pi._tools["write"]).toBeTruthy();
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
    const res = await tool.execute("c1", { action: "control", command: "doctor", cwd: dir }, {}) as { content: { text: string }[]; details: { lines?: string[] } };
    // execute() now normalizes to pi's AgentToolResult: model-facing text in content[0].text.
    expect(res.content[0].text).toMatch(/spider doctor/);
  });

  it("control migrate routes to the import action (empty list → 0 imported)", async () => {
    mkdirSync(scratch, { recursive: true });
    setGlobalDbPathForTests(join(scratch, `g-mig-${Date.now()}.db`));
    const dir = join(scratch, "proj-mig"); mkdirSync(dir, { recursive: true });
    const pi = fakePi();
    spiderExtension(pi as never);
    const tool = pi._tools["spider"] as { execute(id: string, args: unknown, ctx: unknown): Promise<unknown> };
    const res = await tool.execute("cm", { action: "control", command: "migrate", sessions: [], cwd: dir }, {}) as { content: { text: string }[]; details: { imported?: number } };
    expect(res.details.imported).toBe(0);
    expect(res.content[0].text.toLowerCase()).toContain("import");
  });

  it("builds an ActionCtx that carries the models router", () => {
    mkdirSync(scratch, { recursive: true });
    setGlobalDbPathForTests(join(scratch, `g-ctx-${Date.now()}.db`));
    const dir = join(scratch, "proj-ctx"); mkdirSync(dir, { recursive: true });
    const pi = fakePi();
    spiderExtension(pi as never);
    const ctx = buildActionCtx(pi as never, { action: "recall", cwd: dir }, "s-1");
    expect(typeof ctx.models.catalog).toBe("function");
    expect(typeof ctx.models.pick).toBe("function");
    expect(typeof ctx.models.complete).toBe("function");
    expect(ctx.sessionId).toBe("s-1");
    ctx.db.close(); ctx.globalDb.close();
  });

  it("sessionIdOf reads ExtensionContext.sessionManager.getSessionId() (real pi tool-ctx shape)", () => {
    expect(sessionIdOf({ sessionManager: { getSessionId: () => "sess-42" } })).toBe("sess-42");
    expect(sessionIdOf(undefined)).toBe("");
    expect(sessionIdOf({})).toBe("");
  });

  it("cwdOf reads ExtensionContext.cwd (string only)", () => {
    expect(cwdOf({ cwd: "/x" })).toBe("/x");
    expect(cwdOf(undefined)).toBeUndefined();
    expect(cwdOf({})).toBeUndefined();
  });

  it("buildActionCtx prefers args.cwd, else the ExtensionContext cwd hint", () => {
    mkdirSync(scratch, { recursive: true });
    setGlobalDbPathForTests(join(scratch, `g-cwd-${Date.now()}.db`));
    const dirA = join(scratch, "cwd-a"); mkdirSync(dirA, { recursive: true });
    const dirB = join(scratch, "cwd-b"); mkdirSync(dirB, { recursive: true });
    const pi = fakePi(); spiderExtension(pi as never);
    const c1 = buildActionCtx(pi as never, { action: "recall", cwd: dirA }, "s", dirB);
    expect(c1.cwd).toBe(dirA); c1.db.close(); c1.globalDb.close();
    const c2 = buildActionCtx(pi as never, { action: "recall" }, "s", dirB);
    expect(c2.cwd).toBe(dirB); c2.db.close(); c2.globalDb.close();
  });

  it("registers a ctx-native 'todo' action that round-trips add\u2192list against ctx.db", async () => {
    mkdirSync(scratch, { recursive: true });
    setGlobalDbPathForTests(join(scratch, `g-todo-${Date.now()}.db`));
    const pi = fakePi();
    spiderExtension(pi as never);
    const todo = getAction("todo");
    expect(todo).toBeTypeOf("function");
    const dbPath = join(scratch, `todo-${Date.now()}.db`);
    const db = openDbAt(dbPath, "project");
    await todo!({ action: "todo", op: "add", text: "write plan" } as never, { db, sessionId: "s1" } as never);
    const res = await todo!({ action: "todo", op: "list" } as never, { db, sessionId: "s1" } as never) as { details: unknown };
    expect(JSON.stringify(res.details)).toContain("write plan");
    db.close();
  });

  it("registers a real-contract '/todos' command that notifies via ctx.ui.notify", async () => {
    mkdirSync(scratch, { recursive: true });
    setGlobalDbPathForTests(join(scratch, `g-cmd-${Date.now()}.db`));
    const dir = join(scratch, "proj-cmd"); mkdirSync(dir, { recursive: true });
    const pi = fakePi();
    spiderExtension(pi as never);
    const cmd = pi._commands["todos"] as { description: string; handler: (a: string, c: unknown) => Promise<void> };
    expect(cmd).toBeTruthy();
    expect(cmd.description).toBeTypeOf("string");
    expect(cmd.handler).toBeTypeOf("function");
    const notified: string[] = [];
    await cmd.handler("", { cwd: dir, sessionManager: { getSessionId: () => "s-fresh" }, hasUI: true, ui: { notify: (m: string) => notified.push(m) } });
    expect(notified.join("\n")).toContain("(no todos)");
  });

  it("routes the now-wired 'skill' action at the tool boundary (no Phase-0 stub)", async () => {
    mkdirSync(scratch, { recursive: true });
    setGlobalDbPathForTests(join(scratch, `g-skill-${Date.now()}.db`));
    const dir = join(scratch, "proj-skill"); mkdirSync(dir, { recursive: true });
    const pi = fakePi();
    spiderExtension(pi as never);
    const tool = pi._tools["spider"] as { execute(id: string, args: unknown, ctx: unknown): Promise<unknown> };
    const res = await tool.execute("c2", { action: "skill", op: "list", cwd: dir }, {}) as { content: { text: string }[]; details: unknown };
    // The organism skill action is mounted now: `list` returns a rendered panel
    // + an array of skill rows, NOT the "not yet implemented (Phase 0 stub)".
    expect(res.content[0].text).not.toMatch(/not.*implemented/i);
    expect(Array.isArray(res.details)).toBe(true);
  });
});
