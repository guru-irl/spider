import { describe, it, expect, afterEach } from "vitest";
import { makeTodoDb } from "./helpers/tmpdb.js";
import { registerTodo } from "../index.js";

function fakePi() { const a: Record<string, Function> = {}; return { registerAction: (n: string, h: Function) => { a[n] = h; }, registerCommand: () => {}, on: () => {}, _a: a } as any; }
let ctx: ReturnType<typeof makeTodoDb>;
afterEach(() => ctx?.cleanup());

describe("todo action", () => {
  it("add then list round-trips through the action", async () => {
    ctx = makeTodoDb();
    const pi = fakePi();
    registerTodo(pi, { projectDb: ctx.db, getSessionId: () => "s1" });
    await pi._a.todo({ action: "todo", op: "add", text: "write plan" }, {});
    const res = await pi._a.todo({ action: "todo", op: "list" }, {});
    expect(JSON.stringify(res.details)).toContain("write plan");
  });
});
