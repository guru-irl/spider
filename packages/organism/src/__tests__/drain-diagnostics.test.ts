import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import { addMemory, upsertVector, type Embedder } from "@spider/memory";
import { OrganismWorker, type WorkerDeps } from "../worker";
import { CURATOR_DEFAULTS } from "../curator";
import { ORGANISM_DEFAULTS } from "../config";
import { REFLECTION_PROMPT } from "../passes/reflection";

const scratch = resolve(".spider/scratch/drain-diagnostics");
const roots: string[] = [];
const connections: Db[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(overrides: Partial<WorkerDeps> & { drainTimeoutMs?: number } = {}) {
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "case-")); roots.push(dir);
  const db = openDbAt(join(dir, "worktree.db"), "worktree");
  const repoDb = openDbAt(join(dir, "repo.db"), "repo");
  const globalDb = openDbAt(join(dir, "global.db"), "global");
  connections.push(db, repoDb, globalDb);
  db.prepare("INSERT INTO sessions(id,started_at) VALUES ('session',1)").run();
  const deps: WorkerDeps = {
    db: repoDb, worktreeDb: db, globalDb,
    project: { projectKey: dir, realPath: dir, dbPath: join(dir, "worktree.db") },
    getEmbedder: async () => null,
    makeModel: () => ({ complete: async () => '{"memory":[],"skills":[],"todos":[]}' }),
    org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: true, consolidation: true, reflection: false, insights: false } },
    curator: CURATOR_DEFAULTS,
    ...overrides,
  };
  return { db, repoDb, worker: new OrganismWorker(deps) };
}
const options = { transcript: [{ role: "user" as const, content: "Keep regression fixtures isolated." }] };
function receipt(db: Db): Record<string, unknown> {
  const row = db.prepare("SELECT payload FROM run_events WHERE summary LIKE 'organism %' ORDER BY id DESC LIMIT 1").get() as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) : {};
}

describe("organism drain outcomes", () => {
  it("records model setup failure instead of throwing or disappearing", async () => {
    const f = fixture({ makeModel: () => { throw new Error("No authenticated model available"); } });
    await expect(f.worker.runDrain("session", "shutdown", options)).resolves.toMatchObject({ memoryStaged: 0, skillsStaged: 0 });
    expect(receipt(f.db)).toMatchObject({ status: "failed", errors: [{ phase: "model", message: expect.stringContaining("authenticated model") }] });
  });

  it("distinguishes failed passes from a healthy model returning no candidates", async () => {
    const f = fixture({ makeModel: () => ({ complete: async () => { throw new Error("Provider temporarily unavailable"); } }) });
    await f.worker.runDrain("session", "shutdown", options);
    expect(receipt(f.db)).toMatchObject({ status: "failed", modelCalls: 2 });
    expect((receipt(f.db).errors as unknown[])).toHaveLength(2);
  });

  it("records a healthy empty response as completed with zero new proposals", async () => {
    const f = fixture();
    await f.worker.runDrain("session", "shutdown", options);
    expect(receipt(f.db)).toMatchObject({ status: "completed", memoryStaged: 0, skillsStaged: 0, modelCalls: 2, errors: [] });
  });

  it("reports no input without calling a model or treating its own receipts as activity", async () => {
    let calls = 0;
    const f = fixture({ makeModel: () => { calls++; return { complete: async () => "{}" }; } });
    await f.worker.runDrain("session", "before_compact");
    await f.worker.runDrain("session", "shutdown");
    expect(calls).toBe(0);
    expect(receipt(f.db)).toMatchObject({ status: "skipped", skipReason: "no-input", modelCalls: 0 });
  });

  it("leaves disabled mode free of automatic DB writes and model calls", async () => {
    let calls = 0;
    const f = fixture({ org: { ...ORGANISM_DEFAULTS, enabled: false }, makeModel: () => { calls++; return null; } });
    await f.worker.runDrain("session", "shutdown", options);
    expect(calls).toBe(0);
    expect(f.db.prepare("SELECT COUNT(*) n FROM run_events").get()).toEqual({ n: 0 });
    expect(f.repoDb.prepare("SELECT COUNT(*) n FROM memory").get()).toEqual({ n: 0 });
  });

  it("bounds shutdown even when the provider never settles and signals cancellation", async () => {
    let signal: AbortSignal | undefined;
    const f = fixture({
      drainTimeoutMs: 30,
      makeModel: (s?: AbortSignal) => { signal = s; return { complete: () => new Promise<string>(() => {}) }; },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        f.worker.runDrain("session", "shutdown", options).then(() => "finished"),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve("hung"), 250); }),
      ]);
      expect(outcome).toBe("finished");
      expect(signal?.aborted).toBe(true);
      expect(receipt(f.db)).toMatchObject({ status: "failed", modelCalls: 1 });
      expect(JSON.stringify(receipt(f.db).errors)).toContain("timed out");
    } finally {
      clearTimeout(timer);
    }
  });
});

// Two well-separated reflection clusters so a malformed cluster can be
// distinguished from a valid one within the SAME pass (G4a).
function seedReflectionClusters(repoDb: Db, dim: number): void {
  for (let g = 0; g < 2; g++) {
    for (let i = 0; i < 4; i++) {
      const rec = addMemory(repoDb, "repo", { category: "insight", content: `insight ${g}-${i}` });
      const vec = new Float32Array(dim).fill(g === 0 ? 1 : -1);
      vec[i % dim] += i * 1e-4;
      upsertVector(repoDb, "memory", rec.uuid, vec, "test-model");
    }
  }
}
const stubEmbedder = (dim: number): Embedder => ({
  model: "test", dim, embed: async (t: string[]) => t.map(() => new Float32Array(dim)),
});

describe("organism drain — reflection outcome accounting (G4a)", () => {
  it("counts an all-malformed reflection pass as failed, not a healthy zero-proposal completion", async () => {
    const dim = 8;
    const f = fixture({
      org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: false, consolidation: false, reflection: true, insights: false } },
      getEmbedder: async () => stubEmbedder(dim),
      makeModel: () => ({ complete: async () => "Sorry, I can't help with that request." }),
    });
    seedReflectionClusters(f.repoDb, dim);
    await f.worker.runDrain("session", "shutdown", options);
    const rpt = receipt(f.db);
    expect(rpt.status).toBe("failed");
    expect((rpt.errors as Array<{ phase: string }>).some(e => e.phase === "reflection")).toBe(true);
  });

  it("preserves valid digest items from a mixed reflection pass and reports partial, not completed", async () => {
    const dim = 8;
    const f = fixture({
      org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: false, consolidation: false, reflection: true, insights: false } },
      getEmbedder: async () => stubEmbedder(dim),
      makeModel: () => ({
        complete: async (_system: string, messages: { content: string }[]) =>
          (messages[0]?.content ?? "").includes("insight 0-")
            ? "Sorry, I can't help with that request."
            : JSON.stringify({ memory: [{ category: "insight", content: "group1 umbrella lesson" }] }),
      }),
    });
    seedReflectionClusters(f.repoDb, dim);
    await f.worker.runDrain("session", "shutdown", options);
    const rpt = receipt(f.db);
    expect(rpt.status).toBe("partial");
    expect((rpt.errors as Array<{ phase: string }>).filter(e => e.phase === "reflection")).toHaveLength(1);
    expect(rpt.memoryStaged as number).toBeGreaterThan(0);
  });

  it("an all-failed reflection pass alongside a successful pass is partial, not failed, and keeps the other pass's staged items", async () => {
    const dim = 8;
    const f = fixture({
      org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: true, consolidation: false, reflection: true, insights: false } },
      getEmbedder: async () => stubEmbedder(dim),
      makeModel: () => ({
        complete: async (system: string) =>
          system === REFLECTION_PROMPT
            ? "Sorry, I can't help with that request."
            : JSON.stringify({ memory: [{ category: "insight", content: "learned something" }], todos: [], skills: [] }),
      }),
    });
    seedReflectionClusters(f.repoDb, dim);
    await f.worker.runDrain("session", "shutdown", options);
    const rpt = receipt(f.db);
    expect(rpt.status).toBe("partial");
    expect(rpt.memoryStaged as number).toBeGreaterThan(0);
    expect((rpt.errors as Array<{ phase: string }>).filter(e => e.phase === "reflection")).toHaveLength(1);
  });
});

// F6 (organism-review.md): the four G4a acceptance criteria P22 named explicitly as
// "not malformed failures" were correct in the shipped redesign but unasserted at the
// worker/receipt level. Promoted from organism-review-probe/c-g1-g4.probe.test.ts
// (PROBE G4a). Verified non-vacuous by mutation (production already passes; see
// organism-fix-report.md for the mutation log), not tests-first.
describe("organism drain \u2014 reflection health accounting, the unasserted G4a criteria (F6)", () => {
  it("a VALID reply carrying zero proposals stays healthy (completed, no reflection error)", async () => {
    const dim = 8;
    const f = fixture({
      org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: false, consolidation: false, reflection: true, insights: false } },
      getEmbedder: async () => stubEmbedder(dim),
      makeModel: () => ({ complete: async () => '{"memory":[]}' }), // valid JSON, no candidates
    });
    seedReflectionClusters(f.repoDb, dim);
    await f.worker.runDrain("session", "shutdown", options);
    const rpt = receipt(f.db);
    expect(rpt.status).toBe("completed");
    expect(rpt.errors).toEqual([]);
    expect(rpt.memoryStaged).toBe(0);
  });

  it("policy-dropped candidates are also healthy, not a malformed failure", async () => {
    const dim = 8;
    const f = fixture({
      org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: false, consolidation: false, reflection: true, insights: false } },
      getEmbedder: async () => stubEmbedder(dim),
      // Parses fine; content is short/low-signal so the capture guardrail drops it.
      makeModel: () => ({ complete: async () => JSON.stringify({ memory: [{ category: "insight", content: "ok" }] }) }),
    });
    seedReflectionClusters(f.repoDb, dim);
    await f.worker.runDrain("session", "shutdown", options);
    const rpt = receipt(f.db);
    expect(rpt.errors).toEqual([]);
    expect(rpt.status).toBe("completed");
  });

  it("no clusters at all (embedder present, nothing to cluster) is healthy, never a failure", async () => {
    const dim = 8;
    const f = fixture({
      org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: false, consolidation: false, reflection: true, insights: false } },
      getEmbedder: async () => stubEmbedder(dim),
    });
    // No seedReflectionClusters call: nothing to cluster.
    await f.worker.runDrain("session", "shutdown", options);
    const rpt = receipt(f.db);
    expect(rpt.errors).toEqual([]);
    expect(rpt.status).toBe("completed");
    expect(rpt.modelCalls).toBe(0);
  });

  it("a PROVIDER error on every cluster is failed \u2014 distinct from a parse failure, and never silently swallowed", async () => {
    const dim = 8;
    const f = fixture({
      org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: false, consolidation: false, reflection: true, insights: false } },
      getEmbedder: async () => stubEmbedder(dim),
      makeModel: () => ({ complete: async () => { throw new Error("Provider temporarily unavailable"); } }),
    });
    seedReflectionClusters(f.repoDb, dim);
    await f.worker.runDrain("session", "shutdown", options);
    const rpt = receipt(f.db);
    expect(rpt.status).toBe("failed");
    expect((rpt.errors as Array<{ phase: string }>).some(e => e.phase === "reflection")).toBe(true);
  });
});
