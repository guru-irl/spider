import { describe, it, expect, afterEach } from "vitest";
import { makeTodoDb } from "./helpers/tmpdb.js";
import { addTodo, viewSession, resolveSession } from "../store.js";

let ctx: ReturnType<typeof makeTodoDb>;
afterEach(() => ctx?.cleanup());

describe("todo view/resolve", () => {
  it("view 'all' groups every session", () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "sess-aaa", "a"); addTodo(ctx.db, "sess-bbb", "b");
    const groups = viewSession(ctx.db, "all", "sess-aaa");
    expect(groups.map(g => g.session).sort()).toEqual(["sess-aaa", "sess-bbb"]);
  });
  it("resolveSession matches unique prefix", () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "sess-aaa", "a");
    expect(resolveSession(ctx.db, "sess-a")).toBe("sess-aaa");
  });
  it("resolveSession returns null on no match", () => {
    ctx = makeTodoDb();
    expect(resolveSession(ctx.db, "nope")).toBeNull();
  });
});
