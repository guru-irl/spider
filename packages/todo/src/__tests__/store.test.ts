import { describe, it, expect, afterEach } from "vitest";
import { makeTodoDb } from "./helpers/tmpdb";
import { listTodos, addTodo, toggleTodo, clearTodos, sessionSummaries } from "../store";

let ctx: ReturnType<typeof makeTodoDb>;
afterEach(() => ctx?.cleanup());

describe("todo store", () => {
  it("adds with per-session seq starting at 1", () => {
    ctx = makeTodoDb();
    expect(addTodo(ctx.db, "s1", "first").seq).toBe(1);
    expect(addTodo(ctx.db, "s1", "second").seq).toBe(2);
    expect(addTodo(ctx.db, "s2", "other").seq).toBe(1); // per-session
  });
  it("lists todos for a session only", () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "s1", "a"); addTodo(ctx.db, "s2", "b");
    expect(listTodos(ctx.db, "s1").map(t => t.text)).toEqual(["a"]);
  });
  it("toggles done by seq", () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "s1", "task");
    expect(toggleTodo(ctx.db, "s1", 1)?.done).toBe(true);
    expect(toggleTodo(ctx.db, "s1", 1)?.done).toBe(false);
  });
  it("clears a session's todos", () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "s1", "x"); clearTodos(ctx.db, "s1");
    expect(listTodos(ctx.db, "s1")).toHaveLength(0);
  });
  it("summarizes sessions with counts + current flag", () => {
    ctx = makeTodoDb();
    addTodo(ctx.db, "s1", "a"); const t = addTodo(ctx.db, "s1", "b"); toggleTodo(ctx.db, "s1", t.seq);
    const sum = sessionSummaries(ctx.db, "s1").find(s => s.session === "s1")!;
    expect(sum.total).toBe(2); expect(sum.done).toBe(1); expect(sum.current).toBe(true);
  });
});
