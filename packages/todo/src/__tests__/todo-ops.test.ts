import { afterEach, describe, expect, it } from "vitest";
import { makeTodoDb } from "./helpers/tmpdb";
import { makeTodo } from "../actions";
import { addTodo, listTodos, resolveSession, toggleTodo } from "../store";
import { toToolResult } from "../../../host/src/result";

let ctx: ReturnType<typeof makeTodoDb>;
afterEach(() => ctx?.cleanup());
function setup() {
  ctx = makeTodoDb();
  return makeTodo({ projectDb: ctx.db, getSessionId: () => "current" });
}
function matches(text: string) {
  return ctx.db.prepare("SELECT rowid FROM todos_fts WHERE todos_fts MATCH ?").all(text);
}

describe("todo mutations", () => {
  it("removes just one item and its FTS posting, returning the removed item", async () => {
    const action = setup();
    const removed = addTodo(ctx.db, "current", "obsoleteword");
    const kept = addTodo(ctx.db, "current", "keepword");
    addTodo(ctx.db, "other", "otherword");
    expect(matches("obsoleteword")).toHaveLength(1);
    const result = await action({ op: "remove", id: removed.seq }, {});
    expect(result.details).toEqual({ ...removed, session: "current" });
    expect(listTodos(ctx.db, "current")).toEqual([kept]);
    expect(listTodos(ctx.db, "other")).toHaveLength(1);
    expect(matches("obsoleteword")).toEqual([]);
    expect(matches("keepword")).toHaveLength(1);
  });

  it.each(["toggle", "remove"])("%s rejects missing, invalid and unknown ids with session context", async (op) => {
    const action = setup();
    addTodo(ctx.db, "current", "untouched");
    for (const id of [undefined, "bogus", 99, 0, 1.5]) {
      const result = await action({ op, id }, {});
      expect(toToolResult(result).isError).toBe(true);
      expect(result.details).toMatchObject({ error: expect.stringContaining(String(id)) });
      expect(JSON.stringify(result.details)).toContain("current");
    }
    expect(listTodos(ctx.db, "current")).toEqual([{ seq: 1, text: "untouched", done: false }]);
  });

  it.each(["toggle", "remove"])("%s targets another session by id, prefix or name", async (op) => {
    const action = setup();
    ctx.db.prepare("INSERT INTO sessions(id, name, started_at) VALUES (?, ?, ?)").run("previous-session", "Cleanup", 1);
    const local = addTodo(ctx.db, "current", "local");
    for (const session of ["previous-session", "previous-", "cleanup"]) {
      const target = addTodo(ctx.db, "previous-session", "leftover");
      const result = await action({ op, id: target.seq, session }, {});
      expect(toToolResult(result).isError).toBe(false);
      expect(result.details).toEqual({ ...target, done: op === "toggle", session: "previous-session", name: "Cleanup" });
      const content = toToolResult(result).content.map((block) => block.text).join("\n");
      expect(content).toContain("previous-session");
      expect(content).toContain("Cleanup");
      expect(listTodos(ctx.db, "current")).toEqual([local]);
      if (op === "remove") expect(listTodos(ctx.db, "previous-session")).toEqual([]);
    }
  });

  it.each(["toggle", "remove"])("%s rejects all, unresolved and ambiguous selectors without mutation", async (op) => {
    const action = setup();
    const local = addTodo(ctx.db, "current", "local");
    addTodo(ctx.db, "shared-a", "a");
    addTodo(ctx.db, "shared-b", "b");
    for (const session of ["all", "missing", "shared-"]) {
      const result = await action({ op, id: 1, session }, {});
      expect(toToolResult(result).isError).toBe(true);
      expect(JSON.stringify(result.details)).toContain(session);
    }
    expect(listTodos(ctx.db, "current")).toEqual([local]);
    expect(listTodos(ctx.db, "shared-a")[0].done).toBe(false);
    expect(listTodos(ctx.db, "shared-b")[0].done).toBe(false);
  });

  it.each([false, true])("clear rejects any session selector with force=%s without deleting items", async (force) => {
    const action = setup();
    const local = addTodo(ctx.db, "current", "localword");
    const other = addTodo(ctx.db, "other", "otherword");
    toggleTodo(ctx.db, "current", 1);
    for (const session of ["other", "current", "all", "", "   "]) {
      const result = await action({ op: "clear", session, force }, {});
      expect(toToolResult(result).isError).toBe(true);
      expect(result.details).toMatchObject({ error: expect.stringMatching(/clear.*session.*current session/i) });
      expect(listTodos(ctx.db, "current")).toEqual([{ ...local, done: true }]);
      expect(listTodos(ctx.db, "other")).toEqual([other]);
      expect(matches("localword")).toHaveLength(1);
      expect(matches("otherword")).toHaveLength(1);
    }
  });

  it.each(["toggle", "remove", "view"])("%s rejects empty and whitespace selectors without matching another session", async (op) => {
    const action = setup();
    const other = addTodo(ctx.db, "other", "untouched");
    for (const session of ["", "   ", "\t\n"]) {
      expect(resolveSession(ctx.db, session)).toBeNull();
      const result = await action({ op, session, id: 1 }, {});
      expect(toToolResult(result).isError).toBe(true);
      expect(result.details).toMatchObject({ error: expect.stringMatching(/session.*(blank|empty)/i) });
    }
    expect(listTodos(ctx.db, "other")).toEqual([other]);
  });

  it.each(["toggle", "remove", "view"])("%s resolves an exact id despite a longer id prefix", async (op) => {
    const action = setup();
    const target = addTodo(ctx.db, "review", "target");
    const longer = addTodo(ctx.db, "review2", "untouched");
    expect(resolveSession(ctx.db, "review")).toBe("review");
    const result = await action({ op, session: "review", id: 1 }, {});
    expect(toToolResult(result).isError).toBe(false);
    if (op === "view") expect(result.details).toMatchObject([{ session: "review", todos: [target] }]);
    else expect(result.details).toMatchObject({ session: "review", text: "target", done: op === "toggle" });
    expect(listTodos(ctx.db, "review2")).toEqual([longer]);
  });

  it.each(["toggle", "remove", "view"])("%s reports an existing empty session by id, prefix or name", async (op) => {
    const action = setup();
    ctx.db.prepare("INSERT INTO sessions(id, name, started_at) VALUES (?, ?, ?)").run("empty-session", "Archive", 1);
    for (const session of ["empty-session", "empty-", "archive"]) {
      expect(resolveSession(ctx.db, session)).toBe("empty-session");
      const result = await action({ op, session, id: 1 }, {});
      expect(toToolResult(result).isError).toBe(true);
      expect(result.details).toMatchObject({ error: expect.stringMatching(/session.*empty-session.*has no todos/i) });
      expect(JSON.stringify(result.details)).not.toMatch(/unresolved|ambiguous/i);
    }
  });

  it("remove reports no todos when the last item was already removed", async () => {
    const action = setup();
    ctx.db.prepare("INSERT INTO sessions(id, name, started_at) VALUES (?, ?, ?)").run("archive", "Cleanup", 1);
    addTodo(ctx.db, "archive", "last");
    expect(toToolResult(await action({ op: "remove", session: "archive", id: 1 }, {})).isError).toBe(false);
    const result = await action({ op: "remove", session: "archive", id: 1 }, {});
    expect(result.details).toMatchObject({ error: expect.stringMatching(/session.*archive.*has no todos/i) });
    expect(toToolResult(result).isError).toBe(true);
  });

  it.each(["toggle", "remove", "view"])("%s trims id, prefix and name selectors before lookup", async (op) => {
    const action = setup();
    ctx.db.prepare("INSERT INTO sessions(id, name, started_at) VALUES (?, ?, ?)").run("previous-session", "Cleanup", 1);
    for (const session of [" previous-session ", "\tprevious-\n", " cleanup "]) {
      const target = addTodo(ctx.db, "previous-session", "target");
      expect(resolveSession(ctx.db, session)).toBe("previous-session");
      const result = await action({ op, session, id: target.seq }, {});
      expect(toToolResult(result).isError).toBe(false);
      if (op === "view") expect(result.details).toMatchObject([{ session: "previous-session" }]);
      else expect(result.details).toMatchObject({ session: "previous-session", seq: target.seq });
    }
  });

  it.each(["toggle", "remove"])("%s rejects padded all instead of resolving a session named all", async (op) => {
    const action = setup();
    ctx.db.prepare("INSERT INTO sessions(id, name, started_at) VALUES (?, ?, ?)").run("archive", "all", 1);
    const todo = addTodo(ctx.db, "archive", "untouched");
    const result = await action({ op, session: " all ", id: 1 }, {});
    expect(result.details).toMatchObject({ error: expect.stringMatching(/all.*ids are per session/i) });
    expect(toToolResult(result).isError).toBe(true);
    expect(listTodos(ctx.db, "archive")).toEqual([todo]);
  });

  it.each(["toggle", "remove", "view"])("%s rejects duplicate session names", async (op) => {
    const action = setup();
    for (const session of ["first", "second"]) {
      ctx.db.prepare("INSERT INTO sessions(id, name, started_at) VALUES (?, ?, ?)").run(session, "Cleanup", 1);
      addTodo(ctx.db, session, session);
    }
    const result = await action({ op, session: "cleanup", id: 1 }, {});
    expect(toToolResult(result).isError).toBe(true);
    expect(result.details).toMatchObject({ error: expect.stringMatching(/ambiguous/i) });
    for (const session of ["first", "second"]) expect(listTodos(ctx.db, session)).toEqual([{ seq: 1, text: session, done: false }]);
  });

  it.each(["toggle", "remove"])("%s rejects all even when a session is named all", async (op) => {
    const action = setup();
    ctx.db.prepare("INSERT INTO sessions(id, name, started_at) VALUES (?, ?, ?)").run("archive", "all", 1);
    const todo = addTodo(ctx.db, "archive", "untouched");
    const result = await action({ op, session: "all", id: 1 }, {});
    expect(toToolResult(result).isError).toBe(true);
    expect(result.details).toMatchObject({ error: expect.stringMatching(/all.*ids are per session/i) });
    expect(listTodos(ctx.db, "archive")).toEqual([todo]);
  });

  it.each(["toggle", "remove", "view"])("%s rejects a name that also matches another session id prefix", async (op) => {
    const action = setup();
    ctx.db.prepare("INSERT INTO sessions(id, name, started_at) VALUES (?, ?, ?)").run("archive", "abc", 1);
    addTodo(ctx.db, "archive", "named");
    addTodo(ctx.db, "abc123", "prefixed");
    const result = await action({ op, session: "abc", id: 1 }, {});
    expect(toToolResult(result).isError).toBe(true);
    expect(result.details).toMatchObject({ error: expect.stringMatching(/ambiguous/i) });
    expect(listTodos(ctx.db, "archive")).toEqual([{ seq: 1, text: "named", done: false }]);
    expect(listTodos(ctx.db, "abc123")).toEqual([{ seq: 1, text: "prefixed", done: false }]);
  });

  it.each(["toggle", "remove", "view"])("%s rejects a name that also matches another session's exact id", async (op) => {
    const action = setup();
    ctx.db.prepare("INSERT INTO sessions(id, name, started_at) VALUES (?, ?, ?)").run("archive", "abc123", 1);
    const named = addTodo(ctx.db, "archive", "named");
    const identified = addTodo(ctx.db, "abc123", "identified");
    const result = await action({ op, session: "abc123", id: 1 }, {});
    expect(toToolResult(result).isError).toBe(true);
    expect(result.details).toMatchObject({ error: expect.stringMatching(/ambiguous/i) });
    expect(listTodos(ctx.db, "archive")).toEqual([named]);
    expect(listTodos(ctx.db, "abc123")).toEqual([identified]);
  });

  it("a name and prefix matching the same session are not ambiguous", async () => {
    const action = setup();
    ctx.db.prepare("INSERT INTO sessions(id, name, started_at) VALUES (?, ?, ?)").run("cleanup-session", "Cleanup", 1);
    addTodo(ctx.db, "cleanup-session", "leftover");
    const result = await action({ op: "toggle", session: "cleanup", id: 1 }, {});
    expect(toToolResult(result).isError).toBe(false);
    expect(result.details).toMatchObject({ session: "cleanup-session", name: "Cleanup", done: true });
  });

  it.each(["toggle", "remove"])("%s accepts the displayed #2 id", async (op) => {
    const action = setup();
    const first = addTodo(ctx.db, "current", "first");
    addTodo(ctx.db, "current", "second");
    const result = await action({ op, id: "#2" }, {});
    expect(toToolResult(result).isError).toBe(false);
    expect(result.details).toMatchObject({ seq: 2, text: "second", session: "current" });
    expect(listTodos(ctx.db, "current")[0]).toEqual(first);
    expect(listTodos(ctx.db, "current")).toHaveLength(op === "remove" ? 1 : 2);
  });

  it.each(["toggle", "remove"])("%s rejects boolean and non-numeric ids without mutation", async (op) => {
    const action = setup();
    const todo = addTodo(ctx.db, "current", "untouched");
    for (const id of [true, false, "bogus", "#bogus", [1], {}, "", " "]) {
      const result = await action({ op, id }, {});
      expect(toToolResult(result).isError).toBe(true);
      expect(result.details).toMatchObject({ error: expect.stringMatching(/invalid id/i) });
      expect(listTodos(ctx.db, "current")).toEqual([todo]);
    }
  });

  it("defaults toggle and remove to the current session", async () => {
    const action = setup();
    addTodo(ctx.db, "current", "local");
    const other = addTodo(ctx.db, "other", "other");
    expect((await action({ op: "toggle", id: 1 }, {})).details).toMatchObject({ done: true });
    await action({ op: "remove", id: 1 }, {});
    expect(listTodos(ctx.db, "current")).toEqual([]);
    expect(listTodos(ctx.db, "other")).toEqual([other]);
  });

  it("unknown op returns an error listing valid operations", async () => {
    const action = setup();
    const todo = addTodo(ctx.db, "current", "untouched");
    const result = await action({ op: "delete", id: 1 }, {});
    expect(toToolResult(result).isError).toBe(true);
    for (const op of ["add", "list", "toggle", "remove", "clear", "sessions", "view"]) {
      expect(JSON.stringify(result.details)).toContain(op);
    }
    expect(listTodos(ctx.db, "current")).toEqual([todo]);
  });

  it.each([undefined, "", "   ", "\t\n"])("add rejects missing or blank text %j", async (text) => {
    const action = setup();
    const result = await action({ op: "add", text }, {});
    expect(toToolResult(result).isError).toBe(true);
    expect(result.details).toMatchObject({ error: expect.stringMatching(/text/i) });
    expect(listTodos(ctx.db, "current")).toEqual([]);
  });

  it.each(["missing", "shared-"])("view rejects unresolved or ambiguous session %s", async (session) => {
    const action = setup();
    addTodo(ctx.db, "shared-a", "a");
    addTodo(ctx.db, "shared-b", "b");
    const result = await action({ op: "view", session }, {});
    expect(toToolResult(result).isError).toBe(true);
    expect(result.details).toMatchObject({ error: expect.stringContaining(session) });
  });

  it.each([false, true])("clear force=%s reports counts and maintains FTS", async (force) => {
    const action = setup();
    const open = addTodo(ctx.db, "current", "openword");
    addTodo(ctx.db, "current", "doneword");
    toggleTodo(ctx.db, "current", 2);
    addTodo(ctx.db, "other", "otherword");
    const result = await action({ op: "clear", ...(force ? { force: true } : {}) }, {});
    expect(result.details).toEqual({ removed: force ? 2 : 1, kept: force ? 0 : 1 });
    expect(listTodos(ctx.db, "current")).toEqual(force ? [] : [open]);
    expect(matches("doneword")).toEqual([]);
    expect(matches("openword")).toHaveLength(force ? 0 : 1);
    expect(listTodos(ctx.db, "other")).toHaveLength(1);
  });
});
