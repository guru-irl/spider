import { describe, expect, it } from "vitest";
import { applyBatch } from "@spider/db-core/roam/apply";
import { bus } from "@spider/db-core";
import { createReplicaEffects } from "@spider/db-core/roam/effects";
import type { Change, ReplicaEffects } from "@spider/db-core/roam/types";
import { A, NOW, SESSION, batch, clock, deleted, memory, replica, session, todo } from "./roam-apply-fixture";

async function accept(root: ReturnType<typeof replica>, changes: Change[], effects: ReplicaEffects, after = 0) {
  const artifact = await batch(root, changes, { after, id: `batch-${after}` });
  return applyBatch(root.db, artifact, { hubMachine: A, effects, now: NOW, sessionHome: () => null });
}

function findTodo(root: ReturnType<typeof replica>, text: string) {
  return root.db.prepare("SELECT t.uuid FROM todos_fts f JOIN todos t ON t.id = f.rowid WHERE todos_fts MATCH ?").all(text);
}
function findMemory(root: ReturnType<typeof replica>, text: string) {
  return root.db.prepare("SELECT uuid FROM memory_fts WHERE memory_fts MATCH ?").all(text);
}

describe("replica derived data", () => {
  it("winning changes update lexical state transactionally", async () => {
    const root = replica();
    const notices: string[] = [];
    const effects = createReplicaEffects(key => notices.push(key));
    const first = todo("todo-1", 1, "oldword");
    await accept(root, [first], effects);
    expect(findTodo(root, "oldword")).toEqual([{ uuid: "todo-1" }]);
    const next = todo("todo-1", 1, "newword", clock(2000), "new-todo");
    await accept(root, [next], effects, 1);
    expect(findTodo(root, "oldword")).toEqual([]);
    expect(findTodo(root, "newword")).toEqual([{ uuid: "todo-1" }]);
    await accept(root, [deleted(next, clock(3000), "delete-todo")], effects, 2);
    expect(findTodo(root, "newword")).toEqual([]);
    expect(notices).toEqual([root.storeKey, root.storeKey, root.storeKey]);
  }, 5000);

  it("an unlogged foreign-home collision removes the displaced todo search entry", async () => {
    const root = replica();
    const row = root.db.prepare("INSERT INTO todos(uuid,session_id,seq,text,done,created_at) VALUES ('displaced',?,1,'displacedword',0,1)").run(SESSION);
    root.db.prepare("INSERT INTO todos_fts(rowid,text) VALUES (?,?)").run(row.lastInsertRowid, "displacedword");
    const incoming = await batch(root, [todo("replacement", 1, "replacementword")]);
    applyBatch(root.db, incoming, { hubMachine: A, effects: createReplicaEffects(() => {}), now: NOW, sessionHome: () => ({ sessionId: SESSION, machineId: A, epoch: 1, moveId: null, updatedAt: 1 }) });
    expect(findTodo(root, "displacedword")).toEqual([]);
    expect(findTodo(root, "replacementword")).toEqual([{ uuid: "replacement" }]);
  }, 5000);

  it("maintains active memory search and embedding state", async () => {
    const root = replica("repo");
    const effects = createReplicaEffects(() => {});
    const first = memory("mem-1", "old memory");
    await accept(root, [first], effects);
    expect(findMemory(root, "old")).toEqual([{ uuid: "mem-1" }]);
    expect(root.db.prepare("SELECT text FROM embed_queue WHERE owner_id = ?").all("mem-1")).toEqual([{ text: "old memory" }]);
    root.db.prepare("INSERT INTO vector_map(owner_kind,owner_id,model,dim,embedding) VALUES ('memory','mem-1','fixture',1,?)").run(Buffer.alloc(4));
    const next = memory("mem-1", "new memory", clock(2000), "new-memory");
    await accept(root, [next], effects, 1);
    expect(findMemory(root, "old")).toEqual([]);
    expect(findMemory(root, "new")).toEqual([{ uuid: "mem-1" }]);
    expect(root.db.prepare("SELECT text FROM embed_queue WHERE owner_id = ?").all("mem-1")).toEqual([{ text: "new memory" }]);
    expect(root.db.prepare("SELECT * FROM vector_map WHERE owner_id = ?").all("mem-1")).toEqual([]);
    const archived = { ...memory("mem-1", "hidden memory", clock(3000), "archive-memory"), body: { ...next.body!, content: "hidden memory", status: "archived" } };
    await accept(root, [archived], effects, 2);
    expect(findMemory(root, "new")).toEqual([]);
    expect(findMemory(root, "hidden")).toEqual([]);
    expect(root.db.prepare("SELECT * FROM embed_queue WHERE owner_id = ?").all("mem-1")).toEqual([]);
  }, 5000);

  it("memory tombstones clear search and embedding work", async () => {
    const root = replica("repo");
    const effects = createReplicaEffects(() => {});
    const first = memory("mem-1", "obsolete memory");
    await accept(root, [first], effects);
    await accept(root, [deleted(first, clock(2000), "delete-memory")], effects, 1);
    expect(findMemory(root, "obsolete")).toEqual([]);
    expect(root.db.prepare("SELECT * FROM embed_queue WHERE owner_id='mem-1'").all()).toEqual([]);
    expect(root.db.prepare("SELECT * FROM memory WHERE uuid='mem-1'").all()).toEqual([]);
  }, 5000);

  it("native vectors for the replaced memory are removed without touching other owners", async () => {
    const root = replica("repo");
    const effects = createReplicaEffects(() => {});
    await accept(root, [memory("mem-1", "old memory")], effects);
    root.db.loadVec();
    const vector = Buffer.alloc(384 * 4);
    for (const owner of ["mem-1", "other"]) {
      const row = root.db.prepare("INSERT INTO vector_map(owner_kind,owner_id,model,dim,embedding) VALUES ('memory',?,'fixture',384,?)").safeIntegers().run(owner, vector);
      root.db.prepare("INSERT INTO vectors(rowid,embedding) VALUES (?,?)").run(row.lastInsertRowid, vector);
    }
    await accept(root, [memory("mem-1", "new memory", clock(2000), "new-memory")], effects, 1);
    expect(root.db.prepare("SELECT owner_id FROM vector_map ORDER BY owner_id").all()).toEqual([{ owner_id: "other" }]);
    expect(root.db.prepare("SELECT owner_id FROM vector_map m JOIN vectors v ON v.rowid = m.rowid").all()).toEqual([{ owner_id: "other" }]);
    expect(root.db.prepare("SELECT COUNT(*) AS n FROM vectors").get()).toEqual({ n: 1 });
  }, 5000);

  it("rollback restores memory search vectors and embedding queue", async () => {
    const root = replica("repo");
    const real = createReplicaEffects(() => {});
    await accept(root, [memory("mem-1", "old memory")], real);
    root.db.loadVec();
    const vector = Buffer.alloc(384 * 4);
    const row = root.db.prepare("INSERT INTO vector_map(owner_kind,owner_id,model,dim,embedding) VALUES ('memory','mem-1','fixture',384,?)").safeIntegers().run(vector);
    root.db.prepare("INSERT INTO vectors(rowid,embedding) VALUES (?,?)").run(row.lastInsertRowid, vector);
    const failing: ReplicaEffects = { ...real, winning(db, before, after, change) {
      real.winning(db, before, after, change);
      expect(findMemory(root, "new")).toEqual([{ uuid: "mem-1" }]);
      expect(root.db.prepare("SELECT COUNT(*) AS n FROM vectors").get()).toEqual({ n: 0 });
      expect(root.db.prepare("SELECT text FROM embed_queue").all()).toEqual([{ text: "new memory" }]);
      throw new Error("derived failure");
    } };
    const incoming = await batch(root, [memory("mem-1", "new memory", clock(2000), "new-memory")], { after: 1, id: "fail" });
    expect(() => applyBatch(root.db, incoming, { hubMachine: A, effects: failing, now: NOW, sessionHome: () => null })).toThrow("derived failure");
    expect(findMemory(root, "old")).toEqual([{ uuid: "mem-1" }]);
    expect(findMemory(root, "new")).toEqual([]);
    expect(root.db.prepare("SELECT text FROM embed_queue").all()).toEqual([{ text: "old memory" }]);
    expect(root.db.prepare("SELECT owner_id FROM vector_map m JOIN vectors v ON v.rowid = m.rowid").all()).toEqual([{ owner_id: "mem-1" }]);
  }, 5000);

  it("staged memory queues embeddings but does not enter active search", async () => {
    const root = replica("repo");
    const staged = memory("mem-1", "staged phrase");
    staged.body = { ...staged.body!, status: "staged" };
    await accept(root, [staged], createReplicaEffects(() => {}));
    expect(findMemory(root, "staged")).toEqual([]);
    expect(root.db.prepare("SELECT text FROM embed_queue").all()).toEqual([{ text: "staged phrase" }]);
  }, 5000);

  it("imported events produce only one post-commit invalidation and no operational event", async () => {
    const root = replica();
    const notices: string[] = [];
    const events: string[] = [];
    const remove = bus.on(value => events.push(value.type));
    try {
      const effects = createReplicaEffects(key => {
        expect(root.db.raw.inTransaction).toBe(false);
        notices.push(key);
      });
      const event: Change = { changeId: "event", entity: "run_events", rowKey: "event-1", op: "put", clock: clock(), writerSession: SESSION, writerEpoch: 1, schema: 14, body: { uuid: "event-1", run_id: null, session_id: SESSION, ts: 1, type: "status", tool: null, summary: "done", payload: null } };
      const incoming = await batch(root, [event]);
      const options = { hubMachine: A, effects, now: NOW, sessionHome: () => null };
      applyBatch(root.db, incoming, options);
      applyBatch(root.db, incoming, options);
      expect(root.db.prepare("SELECT type FROM run_events").all()).toEqual([{ type: "status" }]);
      expect(notices).toEqual([root.storeKey]);
      expect(events).toEqual([]);
    } finally { remove(); }
  }, 5000);

  it("session summaries do not replace imported excerpts", async () => {
    const root = replica();
    const effects = createReplicaEffects(() => {});
    root.db.prepare("INSERT INTO sessions_fts(id,name,summary,content) VALUES (?,?,?,?)").run(SESSION, "prior", "prior summary", "private excerpt");
    const incoming = session();
    incoming.body = { ...incoming.body!, name: "fresh title", summary: "fresh summary" };
    await accept(root, [incoming], effects);
    expect(root.db.prepare("SELECT name,summary,content FROM sessions_fts WHERE id = ?").get(SESSION)).toEqual({ name: "fresh title", summary: "fresh summary", content: "private excerpt" });
    expect(root.db.prepare("SELECT id FROM sessions_fts WHERE sessions_fts MATCH ?").all("fresh")).toEqual([{ id: SESSION }]);
  }, 5000);

  it("all local excerpts for the same session survive summary updates", async () => {
    const root = replica();
    const effects = createReplicaEffects(() => {});
    root.db.prepare("INSERT INTO sessions_fts(id,name,summary,content) VALUES (?,?,?,?)").run(SESSION, "old", "old", "first excerpt");
    root.db.prepare("INSERT INTO sessions_fts(id,name,summary,content) VALUES (?,?,?,?)").run(SESSION, "old", "old", "second excerpt");
    const incoming = session();
    incoming.body = { ...incoming.body!, name: "fresh title", summary: "fresh summary" };
    await accept(root, [incoming], effects);
    expect(root.db.prepare("SELECT name,summary,content FROM sessions_fts WHERE id = ? ORDER BY rowid").all(SESSION)).toEqual([
      { name: "fresh title", summary: "fresh summary", content: "first excerpt" },
      { name: "fresh title", summary: "fresh summary", content: "second excerpt" },
    ]);
  }, 5000);

  it("session deletion removes summary terms but retains local excerpts", async () => {
    const root = replica();
    const effects = createReplicaEffects(() => {});
    const first = session();
    first.body = { ...first.body!, name: "obsolete title", summary: "obsolete summary" };
    await accept(root, [first], effects);
    root.db.prepare("UPDATE sessions_fts SET content = 'local excerpt' WHERE id = ?").run(SESSION);
    await accept(root, [deleted(first, clock(2000), "delete-session")], effects, 1);
    expect(root.db.prepare("SELECT id FROM sessions_fts WHERE sessions_fts MATCH 'obsolete'").all()).toEqual([]);
    expect(root.db.prepare("SELECT content FROM sessions_fts WHERE sessions_fts MATCH 'excerpt'").all()).toEqual([{ content: "local excerpt" }]);
  }, 5000);

  it("unrelated imported FTS rows survive", async () => {
    const root = replica();
    const effects = createReplicaEffects(() => {});
    root.db.prepare("INSERT INTO sessions_fts(id,name,summary,content) VALUES ('other','other title','other summary','other excerpt')").run();
    const before = root.db.prepare("SELECT * FROM sessions_fts WHERE id='other'").get();
    await accept(root, [session()], effects);
    expect(root.db.prepare("SELECT * FROM sessions_fts WHERE id='other'").get()).toEqual(before);
  }, 5000);

  it("rollback restores derived state", async () => {
    const root = replica();
    const notices: string[] = [];
    const real = createReplicaEffects(key => notices.push(key));
    const first = todo("todo-1", 1, "oldword");
    await accept(root, [first], real);
    const failing: ReplicaEffects = { ...real, winning(db, before, after, change) {
      real.winning(db, before, after, change);
      expect(findTodo(root, "oldword")).toEqual([]);
      expect(findTodo(root, "newword")).toEqual([{ uuid: "todo-1" }]);
      throw new Error("derived failure");
    } };
    const incoming = await batch(root, [todo("todo-1", 1, "newword", clock(2000), "new-todo")], { after: 1, id: "fail" });
    expect(() => applyBatch(root.db, incoming, { hubMachine: A, effects: failing, now: NOW, sessionHome: () => null })).toThrow("derived failure");
    expect(findTodo(root, "oldword")).toEqual([{ uuid: "todo-1" }]);
    expect(findTodo(root, "newword")).toEqual([]);
    expect(root.db.prepare("SELECT text FROM todos WHERE uuid='todo-1'").get()).toEqual({ text: "oldword" });
    expect(notices).toEqual([root.storeKey]);
  }, 5000);
});
