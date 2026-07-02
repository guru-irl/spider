import { describe, it, expect, afterEach } from "vitest";
import { makeTodoDb } from "./helpers/tmpdb.js";
import { makeTodosCommand } from "../command.js";
import { addTodo } from "../store.js";

let ctx: ReturnType<typeof makeTodoDb>;
afterEach(() => ctx?.cleanup());

describe("makeTodosCommand (real pi command contract)", () => {
  it("returns { description, handler } shaped for pi.registerCommand", async () => {
    ctx = makeTodoDb();
    const cmd = makeTodosCommand({ getDb: () => ctx.db, getSessionId: () => "s1" });
    expect(cmd.description).toBeTypeOf("string");
    expect(cmd.handler).toBeTypeOf("function");
    // real pi commands are fire-once: no run/render/handleInput
    expect((cmd as any).run).toBeUndefined();
  });

  it("notifies the current session's todos via ctx.ui.notify", async () => {
    ctx = makeTodoDb();
    const cmd = makeTodosCommand({ getDb: () => ctx.db, getSessionId: () => "s1" });
    addTodo(ctx.db, "s1", "write plan");
    let captured = "";
    await cmd.handler("", { hasUI: true, ui: { notify: (m: string) => { captured = m; } } });
    expect(captured).toContain("write plan");
  });

  it("notifies (no todos) for an empty session", async () => {
    ctx = makeTodoDb();
    const cmd = makeTodosCommand({ getDb: () => ctx.db, getSessionId: () => "empty" });
    let captured = "";
    await cmd.handler("", { hasUI: true, ui: { notify: (m: string) => { captured = m; } } });
    expect(captured).toBe("(no todos)");
  });

  it("never throws when there is no ui surface", async () => {
    ctx = makeTodoDb();
    const cmd = makeTodosCommand({ getDb: () => ctx.db, getSessionId: () => "s1" });
    await expect(cmd.handler("", { hasUI: false })).resolves.toBeUndefined();
  });
});
