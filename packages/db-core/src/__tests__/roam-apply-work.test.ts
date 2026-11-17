import { describe, expect, it } from "vitest";
import { applyBatch } from "../roam/apply";
import { migrate } from "../migrate";
import { createReplicaEffects } from "../roam/effects";
import type { Change } from "../roam/types";
import { A, NOW, batch, clock, deleted, memory, replica, session } from "./roam-apply-fixture";
import { measureDerivedRows } from "./roam-sql-work";

async function measuredApply(root: ReturnType<typeof replica>, changes: Change[]) {
  const incoming = await batch(root, changes);
  const effects = createReplicaEffects(() => {});
  const options = { hubMachine: A, effects, now: NOW, sessionHome: () => null };
  const meter = measureDerivedRows(root.db);
  try {
    const receipt = applyBatch(root.db, incoming, options);
    const rows = meter.rows;
    expect(applyBatch(root.db, incoming, options)).toEqual({ ...receipt, applyMs: null });
    expect(meter.rows).toBe(rows);
    return rows;
  } finally { meter.stop(); }
}

describe("roaming derived-state work", () => {
  it("counts full-scan candidates without turning rowid seeks into scans", () => {
    const root = replica("repo");
    const insert = root.db.prepare("INSERT INTO memory_fts(uuid,content) VALUES (?,'word')");
    for (let i = 0; i < 32; i++) insert.run(`memory-${i}`);
    const meter = measureDerivedRows(root.db);
    try {
      root.db.prepare("SELECT uuid FROM memory_fts WHERE uuid = ?").all("absent");
      expect(meter.rows).toBe(32);
      root.db.prepare("SELECT uuid FROM memory_fts WHERE rowid = ?").all(1);
      expect(meter.rows).toBe(33);
    } finally { meter.stop(); }
  });

  it.each(["repo", "worktree"] as const)("repairs bounded owner lookups when reopening an existing %s store", scope => {
    const root = replica(scope);
    root.db.exec("DROP INDEX IF EXISTS idx_vector_map_owner; DROP INDEX IF EXISTS idx_embed_queue_owner");
    for (let i = 0; i < 32; i++) {
      root.db.prepare("INSERT INTO vector_map(owner_kind,owner_id,model,dim) VALUES ('memory',?,'fixture',1)").run(`memory-${i}`);
      root.db.prepare("INSERT INTO embed_queue(owner_kind,owner_id,text,enqueued_at) VALUES ('memory',?,'word',1)").run(`memory-${i}`);
    }
    migrate(root.db, scope);
    const meter = measureDerivedRows(root.db);
    try {
      expect(root.db.prepare("SELECT rowid FROM vector_map WHERE owner_kind='memory' AND owner_id=?").all("memory-31")).toHaveLength(1);
      expect(root.db.prepare("SELECT id FROM embed_queue WHERE owner_kind='memory' AND owner_id=?").all("memory-31")).toHaveLength(1);
      expect(meter.rows).toBeLessThanOrEqual(2);
    } finally { meter.stop(); }
    expect(root.db.prepare("SELECT count(*) AS n FROM vector_map").get()).toEqual({ n: 32 });
    expect(root.db.prepare("SELECT count(*) AS n FROM embed_queue").get()).toEqual({ n: 32 });
    expect(root.db.pragma("user_version")).toBe(14);
  });

  it.each([false, true])("memory apply scales with winners instead of rescanning owners, replacing=%s", async replacing => {
    const work: number[] = [];
    for (const n of [24, 96]) {
      const root = replica("repo");
      // Lexical rowids need not match base rowids, and unrelated owners must survive.
      root.db.prepare("INSERT INTO memory_fts(uuid,content) VALUES ('unrelated','backgroundword')").run();
      const insert = root.db.prepare("INSERT INTO memory(uuid,category,content,created_at) VALUES (?,'insight','oldword',1)");
      const lexical = root.db.prepare("INSERT INTO memory_fts(uuid,content) VALUES (?,'oldword')");
      const vector = root.db.prepare("INSERT INTO vector_map(owner_kind,owner_id,model,dim) VALUES ('memory',?,'fixture',1)");
      const queue = root.db.prepare("INSERT INTO embed_queue(owner_kind,owner_id,text,enqueued_at) VALUES ('memory',?,'oldword',1)");
      root.db.raw.transaction(() => {
        for (let i = 0; i < n; i++) {
          for (const id of [`unrelated-${i}`, ...(replacing ? [`memory-${i}`] : [])]) {
            insert.run(id); lexical.run(id); vector.run(id); queue.run(id);
          }
        }
      })();
      root.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
      const changes = Array.from({ length: n }, (_, i) => memory(`memory-${i}`, "freshword"));
      work.push(await measuredApply(root, changes));
      expect(root.db.prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'freshword'").get()).toEqual({ n });
      expect(root.db.prepare("SELECT count(*) AS n FROM embed_queue WHERE text='freshword'").get()).toEqual({ n });
      expect(root.db.prepare("SELECT count(*) AS n FROM vector_map").get()).toEqual({ n });
      expect(root.db.prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'oldword'").get()).toEqual({ n });
      expect(root.db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual({ n });
      expect(root.db.prepare("SELECT last_seq FROM roam_cursors WHERE peer_machine=?").get(A)).toEqual({ last_seq: n });
    }
    expect(work[0]).toBeGreaterThan(0);
    expect(work[1]).toBeLessThan(work[0] * 8);
  });

  it.each([false, true])("session apply does not rescan unrelated excerpts per winner, replacing=%s", async replacing => {
    const work: number[] = [];
    for (const n of [24, 96]) {
      const root = replica();
      const lexical = root.db.prepare("INSERT INTO sessions_fts(id,name,content) VALUES (?,'oldword','excerptword')");
      root.db.raw.transaction(() => {
        for (let i = 0; i < n; i++) {
          lexical.run(`unrelated-${i}`);
          if (replacing) lexical.run(`session-${i}`);
        }
      })();
      const changes = Array.from({ length: n }, (_, i) => {
        const value = session();
        return { ...value, changeId: `session-put-${i}`, rowKey: `session-${i}`, writerSession: `session-${i}`,
          body: { ...value.body!, id: `session-${i}`, name: "freshword" } };
      });
      work.push(await measuredApply(root, changes));
      expect(root.db.prepare("SELECT count(*) AS n FROM sessions_fts WHERE sessions_fts MATCH 'freshword'").get()).toEqual({ n });
      expect(root.db.prepare("SELECT count(*) AS n FROM sessions_fts WHERE sessions_fts MATCH 'excerptword'").get()).toEqual({ n: n * (replacing ? 2 : 1) });
    }
    expect(work[0]).toBeGreaterThan(0);
    expect(work[1]).toBeLessThan(work[0] * 8);
  });

  it("does not update another session when a deleted lexical rowid is reused", async () => {
    const root = replica();
    const first = session();
    const other = { ...session(clock(3000), "other"), rowKey: "other-session", writerSession: "other-session",
      body: { ...first.body!, id: "other-session", name: "otherterm" } };
    const last = { ...session(clock(4000), "last"), body: { ...first.body!, name: "lastterm" } };
    await measuredApply(root, [first, deleted(first, clock(2000), "removed"), other, last]);
    expect(root.db.prepare("SELECT id,name FROM sessions_fts ORDER BY id").all()).toEqual([
      { id: "other-session", name: "otherterm" }, { id: first.rowKey, name: "lastterm" },
    ]);
    expect(root.db.prepare("SELECT id FROM sessions_fts WHERE sessions_fts MATCH 'portable'").all()).toEqual([]);
  });

  it("retries rolled-back lexical changes with a fresh transaction snapshot", async () => {
    const root = replica("repo");
    await measuredApply(root, [memory("memory-a", "oldterm")]);
    const incoming = await batch(root, [memory("memory-a", "newterm", clock(2000), "updated")], { after: 1, id: "retry" });
    const real = createReplicaEffects(() => {});
    let fail = true;
    const effects = { ...real, begin(db: typeof root.db) {
      const writer = real.begin(db);
      return { winning(...args: Parameters<typeof writer.winning>) {
        writer.winning(...args);
        if (fail) { fail = false; throw new Error("derived failure"); }
      } };
    } };
    const options = { hubMachine: A, effects, now: NOW, sessionHome: () => null };
    expect(() => applyBatch(root.db, incoming, options)).toThrow("derived failure");
    expect(root.db.prepare("SELECT content FROM memory_fts").all()).toEqual([{ content: "oldterm" }]);
    expect(applyBatch(root.db, incoming, options).through).toBe(2);
    expect(root.db.prepare("SELECT content FROM memory_fts").all()).toEqual([{ content: "newterm" }]);
    expect(root.db.prepare("SELECT text FROM embed_queue").all()).toEqual([{ text: "newterm" }]);
    expect(root.db.prepare("SELECT count(*) AS n FROM roam_receipts").get()).toEqual({ n: 2 });
  });

  it("keeps lexical identities current for repeated winners in one batch", async () => {
    const root = replica("repo");
    root.db.prepare("INSERT INTO memory_fts(uuid,content) VALUES ('memory-a','staleterm'),('memory-a','duplicateterm'),('other','unrelatedterm')").run();
    const first = memory("memory-a", "firstterm");
    const next = memory("memory-a", "secondterm", clock(2000), "second");
    const last = memory("memory-a", "lastterm", clock(4000), "last");
    await measuredApply(root, [first, next, deleted(next, clock(3000), "removed"), last]);
    expect(root.db.prepare("SELECT uuid,content FROM memory_fts ORDER BY uuid").all()).toEqual([
      { uuid: "memory-a", content: "lastterm" }, { uuid: "other", content: "unrelatedterm" },
    ]);
    expect(root.db.prepare("SELECT owner_id,text FROM embed_queue").all()).toEqual([{ owner_id: "memory-a", text: "lastterm" }]);
    expect(root.db.prepare("SELECT uuid FROM memory_fts WHERE memory_fts MATCH 'firstterm OR secondterm OR staleterm OR duplicateterm'").all()).toEqual([]);
  });
});
