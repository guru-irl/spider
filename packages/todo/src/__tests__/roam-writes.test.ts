import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as dbCore from "@spider/db-core";
import { openDb, setGlobalDbPathForTests } from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { addTodo, clearTodos, listTodos, removeTodo, toggleTodo } from "../store";

const LOCAL = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";

describe("roaming todo writes", () => {
  it("cross-session mutation checks target home", () => {
    const worktree = createReplica("worktree", LOCAL);
    const global = createReplica("global", LOCAL);
    setGlobalDbPathForTests(join(global.root, "store.db"));
    try {
      addTodo(worktree.db, "other", "target");
      worktree.db.prepare("INSERT INTO roam_sessions (session_id, epoch, state) VALUES ('other', 1, 'active')").run();
      worktree.db.exec("UPDATE roam_meta SET capture_enabled = 1");
      global.db.prepare("INSERT INTO session_homes (session_id, machine_id, epoch, updated_at) VALUES ('other', ?, 1, 1)").run(FOREIGN);
      expect(listTodos(worktree.db, "other")).toEqual([{ seq: 1, text: "target", done: false }]);
      for (const editForeign of [
        () => addTodo(worktree.db, "other", "new"),
        () => toggleTodo(worktree.db, "other", 1),
        () => removeTodo(worktree.db, "other", 1),
        () => clearTodos(worktree.db, "other", true),
      ]) expect(() => editForeign()).toThrow(/home/i);
      expect(listTodos(worktree.db, "other")).toEqual([{ seq: 1, text: "target", done: false }]);
      global.db.prepare("UPDATE session_homes SET machine_id = ? WHERE session_id = 'other'").run(LOCAL);
      expect(toggleTodo(worktree.db, "other", 1)?.done).toBe(true);
      worktree.db.prepare("UPDATE roam_sessions SET state = 'frozen' WHERE session_id = 'other'").run();
      expect(() => removeTodo(worktree.db, "other", 1)).toThrow(/home|frozen/i);
    } finally { setGlobalDbPathForTests(null); global.close(); worktree.close(); }
  }, 5000);

  it("known home without membership stays blocked when the global store disappears", () => {
    const worktree = createReplica("worktree", LOCAL);
    const global = createReplica("global", LOCAL);
    setGlobalDbPathForTests(join(global.root, "store.db"));
    try {
      global.db.prepare("INSERT INTO session_homes (session_id, machine_id, epoch, updated_at) VALUES ('home-only', ?, 1, 1)").run(FOREIGN);
      expect(() => addTodo(worktree.db, "home-only", "no")).toThrow(/home/i);
      setGlobalDbPathForTests(join(global.root, "missing.db"));
      expect(() => addTodo(worktree.db, "home-only", "still no")).toThrow(/home/i);
      expect(listTodos(worktree.db, "home-only")).toEqual([]);
    } finally { setGlobalDbPathForTests(null); global.close(); worktree.close(); }
  }, 5000);

  it("unknown participation admits writes with one warning when the global store is unavailable", () => {
    const worktree = createReplica("worktree", LOCAL);
    setGlobalDbPathForTests(join(worktree.root, "missing-global.db"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(addTodo(worktree.db, "unknown-global", "first").seq).toBe(1);
      expect(addTodo(worktree.db, "unknown-global", "second").seq).toBe(2);
      expect(listTodos(worktree.db, "unknown-global")).toHaveLength(2);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(expect.stringMatching(/participation/i));
    } finally { warning.mockRestore(); setGlobalDbPathForTests(null); worktree.close(); }
  }, 5000);

  it("membership read failure admits only unknown sessions and still checks known homes", () => {
    const worktree = createReplica("worktree", LOCAL);
    const global = createReplica("global", LOCAL);
    setGlobalDbPathForTests(join(global.root, "store.db"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalPrepare = worktree.db.prepare.bind(worktree.db);
    let read: ReturnType<typeof vi.spyOn> | undefined;
    try {
      worktree.db.prepare("INSERT INTO sessions (id, started_at) VALUES ('known-read-error', 1)").run();
      worktree.db.prepare("INSERT INTO roam_sessions (session_id, epoch, state) VALUES ('known-read-error', 1, 'active')").run();
      worktree.db.exec("UPDATE roam_meta SET capture_enabled = 1");
      global.db.prepare("INSERT INTO session_homes (session_id, machine_id, epoch, updated_at) VALUES ('known-read-error', ?, 1, 1), ('foreign-read-error', ?, 1, 1)").run(LOCAL, FOREIGN);
      expect(addTodo(worktree.db, "known-read-error", "before").seq).toBe(1);
      read = vi.spyOn(worktree.db, "prepare").mockImplementation(sql => {
        if (sql.includes("FROM roam_sessions WHERE session_id = ?")) throw new Error("fixture membership read failure");
        return originalPrepare(sql);
      });
      expect(addTodo(worktree.db, "unknown-read-error", "allowed").seq).toBe(1);
      expect(() => addTodo(worktree.db, "known-read-error", "blocked")).toThrow(/home/i);
      expect(() => addTodo(worktree.db, "foreign-read-error", "blocked")).toThrow(/home/i);
      expect(listTodos(worktree.db, "known-read-error")).toEqual([{ seq: 1, text: "before", done: false }]);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally { read?.mockRestore(); warning.mockRestore(); setGlobalDbPathForTests(null); global.close(); worktree.close(); }
  }, 5000);

  it("retries a busy membership read before admitting a write", () => {
    const worktree = createReplica("worktree", LOCAL);
    const global = createReplica("global", LOCAL);
    setGlobalDbPathForTests(join(global.root, "store.db"));
    const originalPrepare = worktree.db.prepare.bind(worktree.db);
    let attempts = 0;
    try {
      worktree.db.prepare("INSERT INTO roam_sessions (session_id, epoch, state) VALUES ('busy-membership', 1, 'active')").run();
      worktree.db.exec("UPDATE roam_meta SET capture_enabled = 1");
      global.db.prepare("INSERT INTO session_homes (session_id, machine_id, epoch, updated_at) VALUES ('busy-membership', ?, 1, 1)").run(LOCAL);
      const prepare = vi.spyOn(worktree.db, "prepare").mockImplementation(sql => {
        if (sql.includes("FROM roam_sessions WHERE session_id = ?") && ++attempts === 1) throw new Error("database is locked");
        return originalPrepare(sql);
      });
      try {
        expect(addTodo(worktree.db, "busy-membership", "captured")).toEqual({ seq: 1, text: "captured", done: false });
        expect(attempts).toBeGreaterThanOrEqual(2);
        expect(worktree.db.prepare("SELECT count(*) AS n FROM roam_changes WHERE entity = 'todos'").get()).toEqual({ n: 1 });
      } finally { prepare.mockRestore(); }
    } finally { setGlobalDbPathForTests(null); global.close(); worktree.close(); }
  }, 5000);

  it("retries a busy home read before admitting a write", () => {
    const worktree = createReplica("worktree", LOCAL);
    const global = createReplica("global", LOCAL);
    setGlobalDbPathForTests(join(global.root, "store.db"));
    const actualOpen = dbCore.openGlobalReadOnly;
    let attempts = 0;
    const open = vi.spyOn(dbCore, "openGlobalReadOnly").mockImplementation(() => {
      const connection = actualOpen();
      if (connection) {
        const originalPrepare = connection.prepare.bind(connection);
        connection.prepare = sql => {
          if (sql.includes("FROM session_homes WHERE session_id = ?") && ++attempts === 1) throw new Error("database is locked");
          return originalPrepare(sql);
        };
      }
      return connection;
    });
    try {
      worktree.db.prepare("INSERT INTO roam_sessions (session_id, epoch, state) VALUES ('busy-home', 1, 'active')").run();
      worktree.db.exec("UPDATE roam_meta SET capture_enabled = 1");
      global.db.prepare("INSERT INTO session_homes (session_id, machine_id, epoch, updated_at) VALUES ('busy-home', ?, 1, 1)").run(LOCAL);
      expect(addTodo(worktree.db, "busy-home", "captured")).toEqual({ seq: 1, text: "captured", done: false });
      expect(attempts).toBe(2);
      expect(worktree.db.prepare("SELECT count(*) AS n FROM roam_changes WHERE entity = 'todos'").get()).toEqual({ n: 1 });
    } finally { open.mockRestore(); setGlobalDbPathForTests(null); global.close(); worktree.close(); }
  }, 5000);

  it.each([
    ["disabled", 0, 1, null, false],
    ["diagnostic", 1, 1, "Roaming trigger layout drift", false],
    ["non-roamable", 1, 0, null, false],
    ["missing key", 1, 1, null, true],
  ] as const)("unsafe capture blocks participating todo writes (%s)", (_kind, enabled, roamable, problem, missingKey) => {
    const worktree = createReplica("worktree", LOCAL);
    const global = createReplica("global", LOCAL);
    setGlobalDbPathForTests(join(global.root, "store.db"));
    try {
      worktree.db.prepare("INSERT INTO roam_sessions (session_id, epoch, state) VALUES ('unsafe', 1, 'active')").run();
      global.db.prepare("INSERT INTO session_homes (session_id, machine_id, epoch, updated_at) VALUES ('unsafe', ?, 1, 1)").run(LOCAL);
      worktree.db.prepare("UPDATE roam_meta SET store_key = ?, capture_enabled = ?, roamable = ?, problem = ?")
        .run(missingKey ? null : worktree.storeKey, enabled, roamable, problem);
      expect(() => addTodo(worktree.db, "unsafe", "no")).toThrow(/capture|home/i);
      expect(listTodos(worktree.db, "unsafe")).toEqual([]);
    } finally { setGlobalDbPathForTests(null); global.close(); worktree.close(); }
  }, 5000);

  it("participating todo writes are blocked during import mode", () => {
    const worktree = createReplica("worktree", LOCAL);
    const global = createReplica("global", LOCAL);
    setGlobalDbPathForTests(join(global.root, "store.db"));
    try {
      worktree.db.prepare("INSERT INTO roam_sessions (session_id, epoch, state) VALUES ('importing', 1, 'active')").run();
      worktree.db.exec("UPDATE roam_meta SET capture_enabled = 1, importing = 1");
      global.db.prepare("INSERT INTO session_homes (session_id, machine_id, epoch, updated_at) VALUES ('importing', ?, 1, 1)").run(LOCAL);
      expect(() => addTodo(worktree.db, "importing", "not captured")).toThrow(/capture|import/i);
      expect(listTodos(worktree.db, "importing")).toEqual([]);
      expect(worktree.db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n: 0 });
    } finally { setGlobalDbPathForTests(null); global.close(); worktree.close(); }
  }, 5000);

  it("only the current local home or matching initial origin may mutate", () => {
    const worktree = createReplica("worktree", LOCAL);
    const global = createReplica("global", LOCAL);
    setGlobalDbPathForTests(join(global.root, "store.db"));
    try {
      const addSession = worktree.db.prepare("INSERT INTO sessions (id, started_at, origin_machine) VALUES (?, 1, ?)");
      addSession.run("initial-local", LOCAL);
      addSession.run("initial-foreign", FOREIGN);
      addSession.run("initial-late-epoch", LOCAL);
      worktree.db.prepare(`INSERT INTO roam_sessions (session_id, epoch, state) VALUES
        ('initial-local', 1, 'active'), ('initial-foreign', 1, 'active'), ('initial-late-epoch', 2, 'active')`).run();
      worktree.db.exec("UPDATE roam_meta SET capture_enabled = 1");
      expect(addTodo(worktree.db, "initial-local", "allowed").seq).toBe(1);
      expect(() => addTodo(worktree.db, "initial-foreign", "blocked")).toThrow(/home/i);
      expect(() => addTodo(worktree.db, "initial-late-epoch", "blocked")).toThrow(/home/i);
      global.db.prepare("INSERT INTO session_homes (session_id, machine_id, epoch, updated_at) VALUES ('initial-local', ?, 2, 1)").run(LOCAL);
      expect(() => addTodo(worktree.db, "initial-local", "stale epoch")).toThrow(/home/i);
      global.db.prepare("UPDATE session_homes SET machine_id = '', epoch = 1 WHERE session_id = 'initial-local'").run();
      expect(() => addTodo(worktree.db, "initial-local", "unassigned conflict")).toThrow(/home/i);
      expect(listTodos(worktree.db, "initial-local")).toEqual([{ seq: 1, text: "allowed", done: false }]);
    } finally { setGlobalDbPathForTests(null); global.close(); worktree.close(); }
  }, 5000);

  it("allocation takes the write lock before reading the next sequence", () => {
    const worktree = createReplica("worktree", LOCAL);
    const global = createReplica("global", LOCAL);
    setGlobalDbPathForTests(join(global.root, "store.db"));
    const other = openDb(join(worktree.root, "store.db"), { busyTimeoutMs: 20 });
    const originalPrepare = worktree.db.prepare.bind(worktree.db);
    let raced = false;
    let concurrentError: unknown;
    const prepare = vi.spyOn(worktree.db, "prepare").mockImplementation(sql => {
      if (!raced && sql.includes("SELECT COALESCE(MAX(seq), 0)")) {
        raced = true;
        try { other.prepare("INSERT INTO todos (session_id, seq, text, created_at) VALUES ('lock-test', 1, 'other', 1)").run(); }
        catch (error) { concurrentError = error; }
      }
      return originalPrepare(sql);
    });
    try {
      expect(addTodo(worktree.db, "lock-test", "first").seq).toBe(1);
      expect(raced).toBe(true);
      expect(String(concurrentError)).toMatch(/locked|busy/i);
      expect(listTodos(worktree.db, "lock-test")).toEqual([{ seq: 1, text: "first", done: false }]);
    } finally { prepare.mockRestore(); other.close(); setGlobalDbPathForTests(null); global.close(); worktree.close(); }
  }, 5000);

  it("allocation serializes sequences", () => {
    const worktree = createReplica("worktree", LOCAL);
    const other = openDb(join(worktree.root, "store.db"), { busyTimeoutMs: 20 });
    try {
      worktree.db.raw.transaction(() => {
        expect(addTodo(worktree.db, "s", "first").seq).toBe(1);
        expect(() => addTodo(other, "s", "blocked")).toThrow(/locked|busy/i);
      }).immediate();
      expect(addTodo(other, "s", "second").seq).toBe(2);
      expect(listTodos(worktree.db, "s").map(todo => todo.seq)).toEqual([1, 2]);
    } finally { other.close(); worktree.close(); }
  }, 5000);

  it("sequence allocation refuses overflow without changing todos", () => {
    const worktree = createReplica("worktree", LOCAL);
    const global = createReplica("global", LOCAL);
    setGlobalDbPathForTests(join(global.root, "store.db"));
    try {
      worktree.db.prepare("INSERT INTO todos (uuid, session_id, seq, text, created_at) VALUES ('last', 'full', 9007199254740991, 'last', 1)").run();
      expect(() => addTodo(worktree.db, "full", "overflow")).toThrow(/sequence.*range/i);
      expect(listTodos(worktree.db, "full")).toEqual([{ seq: 9007199254740991, text: "last", done: false }]);
    } finally { setGlobalDbPathForTests(null); global.close(); worktree.close(); }
  }, 5000);

  it("edits address resolved UUID", () => {
    const worktree = createReplica("worktree", LOCAL);
    const global = createReplica("global", LOCAL);
    setGlobalDbPathForTests(join(global.root, "store.db"));
    try {
      const first = addTodo(worktree.db, "s", "first");
      const second = addTodo(worktree.db, "s", "second");
      addTodo(worktree.db, "other-same-seq", "other first");
      addTodo(worktree.db, "other-same-seq", "other second");
      expect(toggleTodo(worktree.db, "s", second.seq)).toEqual({ seq: 2, text: "second", done: true });
      expect(removeTodo(worktree.db, "s", first.seq)).toEqual({ seq: 1, text: "first", done: false });
      expect(listTodos(worktree.db, "s")).toEqual([{ seq: 2, text: "second", done: true }]);
      expect(clearTodos(worktree.db, "s")).toEqual({ removed: 1, kept: 0 });
      expect(listTodos(worktree.db, "s")).toEqual([]);
      expect(listTodos(worktree.db, "other-same-seq")).toEqual([
        { seq: 1, text: "other first", done: false }, { seq: 2, text: "other second", done: false },
      ]);
    } finally { setGlobalDbPathForTests(null); global.close(); worktree.close(); }
  }, 5000);
});
