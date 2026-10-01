import { afterEach, expect, it, vi } from "vitest";
import { openDb, type Db } from "../db";
import { migrate } from "../migrate";
import { appendRunEvent, appendEvent, bus, type RunEvent } from "../events";
import { scratchDbPath, cleanupScratch } from "../testutil";

const dbs: Db[] = [];
const offs: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const off of offs.splice(0)) off();
  for (const db of dbs.splice(0)) db.close();
  cleanupScratch();
});
function fixture() {
  const path = scratchDbPath("post-commit");
  const db = openDb(path);
  migrate(db, "project");
  const reader = openDb(path);
  dbs.push(db, reader);
  const seen: RunEvent[] = [];
  const committed: number[] = [];
  offs.push(bus.on(e => {
    seen.push(e);
    committed.push((reader.prepare("SELECT COUNT(*) AS n FROM run_events").get() as { n: number }).n);
  }));
  const append = (type: string) => appendRunEvent(db, { sessionId: "commit", ts: 1, type });
  return { db, reader, seen, committed, append };
}

it("publishes immediately outside a transaction", () => {
  const { seen, committed, append } = fixture();
  append("outside");
  expect(seen.map(e => e.type)).toEqual(["outside"]);
  expect(committed).toEqual([1]);
});

it("publishes nested transaction events in order only after the outermost commit", () => {
  const { db, seen, committed, append } = fixture();
  db.transaction(() => {
    append("outer-before");
    db.transaction(() => { append("inner"); })();
    append("outer-after");
    expect(seen).toEqual([]);
  })();
  expect(seen.map(e => e.type)).toEqual(["outer-before", "inner", "outer-after"]);
  expect(committed).toEqual([3, 3, 3]);
});

it("discards rolled back savepoint events but retains outer events", () => {
  const { db, seen, committed, append } = fixture();
  db.transaction(() => {
    append("outer-before");
    expect(() => db.transaction(() => {
      append("rolled-back");
      throw new Error("savepoint failure");
    })()).toThrow("savepoint failure");
    append("outer-after");
  })();
  expect(seen.map(e => e.type)).toEqual(["outer-before", "outer-after"]);
  expect(committed).toEqual([2, 2]);
});

it("discards outer and successful nested events on rollback and does not leak them later", () => {
  const { db, seen, append } = fixture();
  expect(() => db.transaction(() => {
    append("outer");
    db.transaction(() => { append("inner"); })();
    throw new Error("outer failure");
  })()).toThrow("outer failure");
  expect(seen).toEqual([]);
  db.transaction(() => { append("later"); })();
  expect(seen.map(e => e.type)).toEqual(["later"]);
});

it("discards events when COMMIT itself fails", () => {
  const { db, seen, reader, append } = fixture();
  db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);`);
  expect(() => db.transaction(() => {
    append("not-committed");
    db.prepare("INSERT INTO child VALUES (1)").run();
  })()).toThrow("FOREIGN KEY constraint failed");
  expect(seen).toEqual([]);
  expect(reader.prepare("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 0 });
  append("later");
  expect(seen.map(e => e.type)).toEqual(["later"]);
});

it("runs callbacks immediately in autocommit and outside the transaction after commit", () => {
  const { db, seen, append } = fixture();
  const effects: string[] = [];
  db.afterCommit(() => { effects.push("immediate"); });
  expect(effects).toEqual(["immediate"]);
  const value = db.transaction(() => {
    append("committed");
    db.afterCommit(() => {
      expect(db.raw.inTransaction).toBe(false);
      expect(seen.map(e => e.type)).toEqual(["committed"]);
      effects.push("committed");
    });
    expect(effects).toEqual(["immediate"]);
    return 42;
  })();
  expect(value).toBe(42);
  expect(effects).toEqual(["immediate", "committed"]);
});

it("a callback error is reported without making a committed transaction throw or dropping later callbacks", () => {
  const { db, reader, seen, append } = fixture();
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = new Error("callback failure");
  const transact = db.transaction(() => {
    db.afterCommit(() => { throw error; });
    append("committed");
    return 42;
  });
  expect(transact()).toBe(42);
  expect(diagnostic).toHaveBeenCalledWith("Post-commit effect failed", error);
  expect(reader.prepare("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 1 });
  expect(seen.map(e => e.type)).toEqual(["committed"]);
  append("later");
  expect(seen.map(e => e.type)).toEqual(["committed", "later"]);
});

it("multiple callback errors are reported without skipping successful callbacks", () => {
  const { db, seen, append } = fixture();
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const errors = [new Error("first"), new Error("second")];
  expect(() => db.transaction(() => {
    for (const error of errors) db.afterCommit(() => { throw error; });
    append("committed");
  })()).not.toThrow();
  expect(diagnostic.mock.calls).toEqual(errors.map(error => ["Post-commit effect failed", error]));
  expect(seen.map(e => e.type)).toEqual(["committed"]);
});

it("re-entrant listener transactions flush immediately in order without leaking rolled-back events", () => {
  const { db, reader, seen, append } = fixture();
  const inTransaction: boolean[] = [];
  offs.push(bus.on(event => {
    if (event.type !== "first") return;
    inTransaction.push(db.raw.inTransaction);
    db.transaction(() => { append("reentrant"); })();
    try {
      db.transaction(() => {
        append("reentrant-rolled-back");
        throw new Error("savepoint failure");
      })();
    } catch { /* the listener recovers from its own rolled-back transaction */ }
    throw new Error("listener failure");
  }));
  db.transaction(() => {
    append("first");
    append("second");
  })();
  expect(inTransaction).toEqual([false]);
  expect(seen.map(event => event.type)).toEqual(["first", "reentrant", "second"]);
  expect(reader.prepare("SELECT type FROM run_events ORDER BY id").all()).toEqual([
    { type: "first" }, { type: "second" }, { type: "reentrant" },
  ]);
});

it("also defers routing and tracking events until commit", () => {
  const { db, reader, seen } = fixture();
  db.transaction(() => {
    appendEvent(db, { sessionId: "commit", ts: 1, phase: "before", tool: "test" });
    expect(seen).toEqual([]);
  })();
  expect(seen.map(e => e.type)).toEqual(["tool_intent"]);
  expect(reader.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
});
