import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import { OrganismWorker, type WorkerDeps } from "../worker.js";
import { readLastDrainReport, readLastDrainReportForWorktree } from "../diagnostics.js";
import { CURATOR_DEFAULTS } from "../curator.js";
import { ORGANISM_DEFAULTS } from "../config.js";

// G2a/G2b: readLastDrainReport/readLastDrainReportForWorktree have no dedicated
// test today — the only doctor assertion runs in-process against the SAME `pi`
// object, so `worker.getLastDrain()` always short-circuits the `??` fallback and
// the persisted-reload path is never actually exercised. These tests write a
// REAL receipt via a real #doRunDrain, then read it back through a brand-new
// worker/connection against the same on-disk file — never via getLastDrain().

const scratch = resolve(".spider/scratch/drain-receipt-reload");
const roots: string[] = [];
const handles: Db[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureDir(): string {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "case-"));
  roots.push(dir);
  return dir;
}

function makeWorker(dir: string): { worker: OrganismWorker; worktreeDb: Db; repoDb: Db } {
  const worktreeDb = openDbAt(join(dir, "worktree.db"), "worktree");
  const repoDb = openDbAt(join(dir, "repo.db"), "repo");
  handles.push(worktreeDb, repoDb);
  const deps: WorkerDeps = {
    db: repoDb,
    worktreeDb,
    globalDb: repoDb,
    project: { projectKey: dir, realPath: dir, dbPath: join(dir, "worktree.db") },
    getEmbedder: async () => null,
    makeModel: () => ({ complete: async () => { throw new Error("Provider unavailable in fixture"); } }),
    org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: true, consolidation: false, reflection: false, insights: false } },
    curator: CURATOR_DEFAULTS,
  };
  return { worker: new OrganismWorker(deps), worktreeDb, repoDb };
}

const opts = { transcript: [{ role: "user" as const, content: "Persist real receipts across a reload." }] };

describe("persisted drain receipt reload (G2a/G2b)", () => {
  it("a brand-new worker/connection reads the persisted receipt for the SAME session via readLastDrainReport", async () => {
    const dir = fixtureDir();
    const first = makeWorker(dir);
    await first.worker.runDrain("session-a", "shutdown", opts);
    // Fresh connection to the SAME file, and a brand-new worker instance — the
    // in-process #lastDrain cache of `first.worker` is deliberately unused here.
    const worktreeDb2 = openDbAt(join(dir, "worktree.db"), "worktree");
    handles.push(worktreeDb2);
    const persisted = readLastDrainReport(worktreeDb2, "session-a");
    expect(persisted).toBeDefined();
    expect(persisted).toMatchObject({
      status: "failed",
      sessionId: "session-a",
      errors: [{ phase: "learning" }],
    });
    expect(persisted!.inputs.messages).toBe(1);
  });

  it("a different session id is invisible to the session-scoped reader but surfaces via the worktree-wide fallback, clearly provenanced", async () => {
    const dir = fixtureDir();
    const first = makeWorker(dir);
    await first.worker.runDrain("session-a", "shutdown", opts);

    const worktreeDb2 = openDbAt(join(dir, "worktree.db"), "worktree");
    handles.push(worktreeDb2);
    expect(readLastDrainReport(worktreeDb2, "session-b")).toBeUndefined();

    const worktreeWide = readLastDrainReportForWorktree(worktreeDb2);
    expect(worktreeWide).toBeDefined();
    // Must carry the ORIGINAL session's identity — never relabeled as session-b's own drain.
    expect(worktreeWide!.sessionId).toBe("session-a");
    expect(worktreeWide!.status).toBe("failed");
  });

  it("readLastDrainReportForWorktree returns undefined when no receipt has ever been written", () => {
    const dir = fixtureDir();
    const worktreeDb = openDbAt(join(dir, "worktree.db"), "worktree");
    handles.push(worktreeDb);
    expect(readLastDrainReportForWorktree(worktreeDb)).toBeUndefined();
  });
});
