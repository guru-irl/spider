import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { openDbAt, paths, type Db } from "@spider/db-core";
import { hasEmbeddingWork, invalidOwnerSql, repairStaleVectors, repairMissingVectors, upsertVector } from "../embeddings/vectors";

let root: string, db: Db;
afterEach(() => { vi.restoreAllMocks(); db?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
it("keeps idle probes and stale repair bounded at 6000 fully vectorized content chunks", () => {
  root = join(paths.globalRoot, `vector-scaling-${randomUUID()}`); mkdirSync(root);
  db = openDbAt(join(root, "fixture.db"), "worktree");
  const insert = db.prepare("INSERT INTO content(id, source, chunk, created_at) VALUES (?, 'fixture', 'fixture chunk', 1)");
  const vector = new Float32Array(384); vector[0] = 1;
  let inserted = 0;
  const samples: Array<{ chunks: number; probeMs: number; repairMs: number }> = [];
  for (const chunks of [1000, 3000, 6000]) {
    db.raw.transaction(() => {
      for (; inserted < chunks; inserted++) {
        insert.run(inserted + 1);
        upsertVector(db, "content", String(inserted + 1), vector, "fixture");
      }
    })();
    const measure = (scan: () => unknown) => {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now(); scan(); times.push(performance.now() - start);
      }
      return times.sort((a, b) => a - b)[2];
    };
    samples.push({ chunks, probeMs: measure(() => expect(hasEmbeddingWork(db)).toBe(false)),
      repairMs: measure(() => expect(db.raw.transaction(() => repairStaleVectors(db)).immediate()).toBe(0)) });
  }
  console.log("content scan timings (median of five, ms)", JSON.stringify(samples));
  if (!process.env.CI) {
    // Wall-clock bounds are local evidence; shared CI runners are too noisy, so CI keeps the plan assertion below.
    expect(samples[2].probeMs).toBeLessThan(60);
    expect(samples[2].repairMs).toBeLessThan(60);
  }
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM vector_map m WHERE ${invalidOwnerSql(db, "m")}`).all() as { detail: string }[];
  expect(plan.some(row => /SEARCH x USING INTEGER PRIMARY KEY/.test(row.detail))).toBe(true);
});

it("scans missing vectors once per DB session and again after an insert failure", () => {
  root = join(paths.globalRoot, `vector-probe-cache-${randomUUID()}`); mkdirSync(root);
  db = openDbAt(join(root, "fixture.db"), "worktree");
  const vector = new Float32Array(384); vector[0] = 1;
  upsertVector(db, "run", "indexed", vector, "fixture");
  const scans = new Map<string, number>();
  expect(hasEmbeddingWork(db, scans)).toBe(false);
  const load = vi.spyOn(db, "loadVec");
  expect(hasEmbeddingWork(db, scans)).toBe(false);
  expect(repairMissingVectors(db, 8, scans)).toBe(0);
  expect(load).not.toHaveBeenCalled();
  // A new session gets a fresh scan, even with the same DB path.
  expect(hasEmbeddingWork(db, new Map())).toBe(false);
  expect(load).toHaveBeenCalledTimes(1);
  const failure = load.mockImplementation(() => { throw new Error("fixture native insert unavailable"); });
  upsertVector(db, "run", "gap", vector, "fixture");
  failure.mockRestore();
  expect(hasEmbeddingWork(db, scans)).toBe(true);
  expect(repairMissingVectors(db, 8, scans)).toBe(1);
  expect(hasEmbeddingWork(db, scans)).toBe(false);
  const afterRepair = vi.spyOn(db, "loadVec");
  expect(hasEmbeddingWork(db, scans)).toBe(false);
  expect(afterRepair).not.toHaveBeenCalled();
  const second = openDbAt(join(root, "second.db"), "worktree");
  try {
    second.prepare("INSERT INTO vector_map(owner_kind, owner_id, model, dim, embedding) VALUES ('run', 'legacy', 'fixture', 384, ?)").run(Buffer.from(vector.buffer));
    expect(hasEmbeddingWork(second, scans)).toBe(true);
  } finally { second.close(); }
});

it("continues bounded legacy gap repairs until all missing vectors are indexed", () => {
  root = join(paths.globalRoot, `vector-probe-repair-${randomUUID()}`); mkdirSync(root);
  db = openDbAt(join(root, "fixture.db"), "worktree");
  const insert = db.prepare("INSERT INTO vector_map(owner_kind, owner_id, model, dim, embedding) VALUES ('run', ?, 'fixture', 384, ?)");
  for (let i = 0; i < 10; i++) insert.run(String(i), Buffer.from(new Float32Array(384).buffer));
  const scans = new Map<string, number>();
  expect(hasEmbeddingWork(db, scans)).toBe(true);
  expect(repairMissingVectors(db, 8, scans)).toBe(8);
  expect(hasEmbeddingWork(db, scans)).toBe(true);
  expect(repairMissingVectors(db, 8, scans)).toBe(2);
  expect(hasEmbeddingWork(db, scans)).toBe(false);
  db.exec("INSERT INTO embed_queue(owner_kind, owner_id, text, enqueued_at, tries) VALUES ('run', 'new', 'fixture', 1, 0)");
  expect(hasEmbeddingWork(db, scans)).toBe(true);
  db.exec("DELETE FROM embed_queue; DELETE FROM content");
  expect(hasEmbeddingWork(db, scans)).toBe(false);
});

it("does not accept malformed owner ids that happen to cast to an existing rowid", () => {
  root = join(paths.globalRoot, `vector-owner-${randomUUID()}`); mkdirSync(root);
  db = openDbAt(join(root, "fixture.db"), "worktree");
  db.exec("INSERT INTO content(id, source, chunk, created_at) VALUES (1, 'fixture', 'text', 1)");
  const vector = new Float32Array(384); vector[0] = 1;
  for (const owner of ["1junk", "01", "1.0", "1"]) upsertVector(db, "content", owner, vector, "fixture");
  expect(repairStaleVectors(db)).toBe(3);
  expect(db.prepare("SELECT owner_id FROM vector_map").all()).toEqual([{ owner_id: "1" }]);
});
