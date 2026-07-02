// packages/host/src/__tests__/integration.smoke.test.ts
//
// Phase 1 closing smoke test: threads the whole memory write -> approve ->
// snapshot -> embed -> knn pipeline plus todo CRUD through a hermetic temp
// project DB under the scratch root (NEVER /tmp).
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openDbAt, paths, type Db } from "@spider/db-core";
import {
  stageWrite,
  listPending,
  approvePending,
  rejectPending,
  getMemory,
  assembleSnapshot,
  enqueueEmbed,
  drainEmbedQueue,
  knn,
  type Embedder,
} from "@spider/memory";
import { addTodo, listTodos } from "@spider/todo";

// A deterministic fake embedder matching the real Embedder interface:
// char-code hashing into 8 buckets, L2-normalized.
const fakeEmbedder: Embedder = {
  model: "fake",
  dim: 8,
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const buckets = new Float32Array(8);
      for (let i = 0; i < text.length; i++) {
        buckets[text.charCodeAt(i) % 8] += 1;
      }
      let norm = 0;
      for (const v of buckets) norm += v * v;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < buckets.length; i++) buckets[i] /= norm;
      return buckets;
    });
  },
};

function makeProjectDb(): { db: Db; dbPath: string; cleanup(): void } {
  const scratchRoot = paths.scratch("project", process.cwd());
  const dbPath = join(scratchRoot, `smoke-${randomUUID()}.db`);
  const db = openDbAt(dbPath, "project");
  return {
    db,
    dbPath,
    cleanup() {
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(`${dbPath}${suffix}`, { force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    },
  };
}

describe("Phase 1 integration smoke: memory write->approve->snapshot->embed->knn + todo CRUD", () => {
  let project: { db: Db; dbPath: string; cleanup(): void } | undefined;

  afterEach(() => {
    project?.cleanup();
    project = undefined;
  });

  it("threads the full pipeline end-to-end on a hermetic scratch-root temp DB", async () => {
    project = makeProjectDb();
    const { db, dbPath } = project;

    // --- Guard: scratch db is NOT under /tmp, and IS under the scratch root. ---
    expect(dbPath).not.toContain("/tmp");
    expect(dbPath.startsWith(paths.scratch("project", process.cwd()))).toBe(true);

    const content = "spider uses a shared sqlite db as the single source of truth";

    // --- 1. Stage a background ("auto") write: must land STAGED, not active. ---
    const staged = stageWrite(db, "project", {
      category: "insight",
      content,
      link: null,
      source: "auto",
    });
    expect(staged.status).toBe("staged");
    expect(staged.uuid).toBeTruthy();
    const uuid = staged.uuid!;

    const preApprovalRecord = getMemory(db, "project", uuid);
    expect(preApprovalRecord?.status).toBe("staged");

    // A pre-approval snapshot must NOT include the staged (not-yet-active) content.
    const preApprovalSnapshot = assembleSnapshot({ project: db });
    expect(preApprovalSnapshot).not.toContain(content);

    // --- 2. listPending contains the staged uuid. ---
    const pending = listPending(db, "project");
    expect(pending.some((r) => r.uuid === uuid)).toBe(true);

    // --- 3. Approve -> active. ---
    const approved = approvePending(db, "project", uuid);
    expect(approved?.status).toBe("active");
    const activeRecord = getMemory(db, "project", uuid);
    expect(activeRecord?.status).toBe("active");

    // --- 4. Snapshot now contains the approved content. ---
    const snapshot = assembleSnapshot({ project: db });
    expect(snapshot).toContain(content);

    // --- 5. Embeddings: drain the queue entry enqueued by the write, then knn. ---
    const drained = await drainEmbedQueue(db, fakeEmbedder);
    expect(drained).toBeGreaterThanOrEqual(1);

    const [queryVec] = await fakeEmbedder.embed(["shared sqlite source of truth"]);
    const hits = knn(db, queryVec, 5, "memory");
    expect(hits.some((h) => h.ownerId === uuid)).toBe(true);

    // --- 6. Todo CRUD round-trip. ---
    const added = addTodo(db, "smoke-sess", "write the smoke test");
    expect(added.text).toBe("write the smoke test");
    const todos = listTodos(db, "smoke-sess");
    expect(todos.some((t) => t.text === "write the smoke test")).toBe(true);
  });

  it("rejectPending marks a staged memory rejected and it never reaches the snapshot", () => {
    project = makeProjectDb();
    const { db } = project;

    const content2 = "reject-path memory content, never approved";
    const staged = stageWrite(db, "project", {
      category: "insight",
      content: content2,
      link: null,
      source: "auto",
    });
    expect(staged.status).toBe("staged");
    const uuid = staged.uuid!;

    rejectPending(db, "project", uuid);
    const rec = getMemory(db, "project", uuid);
    expect(rec?.status).toBe("rejected");

    const snapshot = assembleSnapshot({ project: db });
    expect(snapshot).not.toContain(content2);

    // rejected memories must not surface in listPending anymore either.
    const pending = listPending(db, "project");
    expect(pending.some((r) => r.uuid === uuid)).toBe(false);
  });
});
