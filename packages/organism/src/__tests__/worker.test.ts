import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { OrganismWorker } from "../worker.js";
import { curateAction, type OrganismActionDeps } from "../actions.js";
import { ORGANISM_DEFAULTS } from "../config.js";
import { CURATOR_DEFAULTS } from "../curator.js";
import { addMemory, listPending, upsertVector, type Embedder } from "@spider/memory";
import { openDbAt, paths } from "@spider/db-core";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { DigestModel } from "../types.js";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

const model: DigestModel = {
  complete: async (system) =>
    system.includes("summary") // consolidation prompt
      ? JSON.stringify({ summary: "did auth", selfName: "auth-refactor" })
      : JSON.stringify({ memory: [{ category: "insight", content: "prefers small PRs", scope: "repo", justification: "Durable repo-specific practice useful to future agents.", evidence: "packages/organism/src/passes/learning.ts:1" }], todos: [], skills: [] }),
};

function seed(db: any): void {
  db.prepare(`INSERT INTO sessions (id, reason, started_at) VALUES ('s1','startup',1)`).run();
  db.prepare(`INSERT INTO runs (id, session_id, agent, status) VALUES ('r1','s1','worker','done')`).run();
  db.prepare(
    `INSERT INTO run_events (run_id, session_id, ts, type, summary) VALUES ('r1','s1',2,'tool_result','did a thing')`
  ).run();
}

describe("OrganismWorker.runDrain", () => {
  it("applies a configured per-pass cap to learning, run and todo, counting all truncated proposals", async () => {
    ctx = makeOrgDb();
    seed(ctx.db);
    ctx.db.prepare("INSERT INTO todos(session_id, seq, text, done, created_at) VALUES ('s1', 1, 'Completed checklist', 1, 1)").run();
    const org = { ...ORGANISM_DEFAULTS, autoWriteBudget: 20, maxMemoryProposals: 2,
      passes: { ...ORGANISM_DEFAULTS.passes, consolidation: false, reflection: false, insights: false } };
    const fake: DigestModel = { complete: async (system) => {
      const pass = system.includes("completed todos") ? "todo" : system.includes("run activity") ? "run" : "learn";
      return JSON.stringify({ memory: Array.from({ length: 4 }, (_, i) => ({ category: "convention",
        content: `Stable ${pass} convention ${i}`, scope: "repo", justification: "Durable guidance for future agents in this repo",
        evidence: "src/rules.ts:2" })), skills: [], todos: [] });
    } };
    const filename = join(paths.scratch("worktree", process.cwd()), `cap-global-${crypto.randomUUID()}.db`);
    const globalDb = openDbAt(filename, "global");
    try {
      const w = new OrganismWorker({ db: ctx.repoDb, worktreeDb: ctx.db, globalDb,
        project: { projectKey: "k" } as never, getEmbedder: async () => null, makeModel: () => fake,
        org, curator: CURATOR_DEFAULTS });
      const summary = await w.runDrain("s1", "shutdown", { transcript: [{ role: "user", content: "Discuss a stable convention" }] });
      expect(w.getLastDrain()?.inputs.messages).toBe(1);
      expect(w.getLastDrain()).toMatchObject({ modelCalls: 3, capDroppedByPass: { runMemoryTodo: 2, todoMemory: 2, learning: 2 } });
      expect(summary).toMatchObject({ memoryStaged: 6, dropped: 6, rejected: 0 });
      expect(w.getLastDrain()).toMatchObject({ dropped: 6, status: "completed" });
      expect(listPending(ctx.repoDb, "repo")).toHaveLength(6);
    } finally {
      globalDb.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(filename + suffix, { force: true });
    }
  });

  it("passes the configured cap to reflection and counts its dropped proposals", async () => {
    ctx = makeOrgDb();
    seed(ctx.db);
    for (let i = 0; i < 3; i++) {
      const row = addMemory(ctx.repoDb, "repo", { category: "insight", content: `cluster seed ${i}` });
      upsertVector(ctx.repoDb, "memory", row.uuid, new Float32Array(8).fill(1), "test-model");
    }
    const embedder: Embedder = { model: "test", dim: 8, embed: async texts => texts.map(() => new Float32Array(8)) };
    const filename = join(paths.scratch("worktree", process.cwd()), `reflection-global-${crypto.randomUUID()}.db`);
    const globalDb = openDbAt(filename, "global");
    try {
      const w = new OrganismWorker({ db: ctx.repoDb, worktreeDb: ctx.db, globalDb,
        project: { projectKey: "k" } as never, getEmbedder: async () => embedder,
        makeModel: () => ({ complete: async () => JSON.stringify({ memory: Array.from({ length: 4 }, (_, i) => ({
          category: "insight", content: `Reflection convention ${i}`, scope: "repo",
          justification: "Durable synthesis for future sessions", evidence: "src/rules.ts:4",
        })) }) }),
        org: { ...ORGANISM_DEFAULTS, maxMemoryProposals: 1, passes: {
          runMemoryTodo: false, todoMemory: false, learning: false, consolidation: false,
          reflection: true, insights: false,
        } }, curator: CURATOR_DEFAULTS });
      const summary = await w.runDrain("s1", "shutdown");
      expect(w.getLastDrain()).toMatchObject({ modelCalls: 1, capDroppedByPass: { reflection: 3 } });
      expect(summary).toMatchObject({ memoryStaged: 1, dropped: 3 });
      expect(listPending(ctx.repoDb, "repo")).toHaveLength(1);
    } finally {
      globalDb.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(filename + suffix, { force: true });
    }
  });

  it("supplies active global and repo content, never staged content, to the learning model", async () => {
    ctx = makeOrgDb();
    seed(ctx.db);
    const filename = join(paths.scratch("worktree", process.cwd()), `active-global-${crypto.randomUUID()}.db`);
    const globalDb = openDbAt(filename, "global");
    try {
      addMemory(globalDb, "global", { category: "preference", content: "Global standing rule" });
      addMemory(ctx.repoDb, "repo", { category: "convention", content: "Repo standing rule" });
      addMemory(ctx.repoDb, "repo", { category: "insight", content: "Unapproved speculation", status: "staged" });
      let learnerInput = "";
      const w = new OrganismWorker({ db: ctx.repoDb, globalDb, worktreeDb: ctx.db,
        project: { projectKey: "k" } as never, getEmbedder: async () => null,
        makeModel: () => ({ complete: async (system) => { learnerInput = system; return '{"memory":[],"skills":[],"todos":[]}'; } }),
        org: { ...ORGANISM_DEFAULTS, passes: { ...ORGANISM_DEFAULTS.passes, runMemoryTodo: false, todoMemory: false, consolidation: false, reflection: false, insights: false } },
        curator: CURATOR_DEFAULTS });
      await w.runDrain("s1", "shutdown", { transcript: [{ role: "user", content: "hello" }] });
      expect(learnerInput).toContain("BEGIN ACTIVE MEMORY DATA");
      expect(learnerInput).toContain("Global standing rule");
      expect(learnerInput).toContain("Repo standing rule");
      expect(learnerInput).not.toContain("Unapproved speculation");
    } finally {
      globalDb.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(filename + suffix, { force: true });
    }
  });
  it("runs enabled passes, stages under budget, and self-names the session", async () => {
    ctx = makeOrgDb();
    seed(ctx.db);
    const w = new OrganismWorker({
      db: ctx.repoDb,
      worktreeDb: ctx.db,
      globalDb: ctx.db,
      project: { projectKey: "k", realPath: "/x", dbPath: "/x" } as any,
      getEmbedder: async () => null,
      makeModel: () => model,
      org: ORGANISM_DEFAULTS,
      curator: CURATOR_DEFAULTS,
    });
    const summary = await w.runDrain("s1", "shutdown");
    expect(summary.memoryStaged).toBeGreaterThan(0);
    expect(listPending(ctx.repoDb, "repo").length).toBe(summary.memoryStaged);
    expect((ctx.db.prepare("SELECT name FROM sessions WHERE id='s1'").get() as any).name).toBe("auth-refactor");
  });

  it("master toggle off → no drain, no writes", async () => {
    ctx = makeOrgDb();
    seed(ctx.db);
    const w = new OrganismWorker({
      db: ctx.repoDb,
      worktreeDb: ctx.db,
      globalDb: ctx.db,
      project: {} as any,
      getEmbedder: async () => null,
      makeModel: () => model,
      org: { ...ORGANISM_DEFAULTS, enabled: false },
      curator: CURATOR_DEFAULTS,
    });
    const summary = await w.runDrain("s1", "shutdown");
    expect(summary.memoryStaged).toBe(0);
    expect(listPending(ctx.repoDb, "repo")).toHaveLength(0);
  });

  it("per-pass toggle off skips that pass (real attribution)", async () => {
    ctx = makeOrgDb();
    seed(ctx.db);
    const org = { ...ORGANISM_DEFAULTS, passes: { ...ORGANISM_DEFAULTS.passes, runMemoryTodo: false } };
    const w = new OrganismWorker({
      db: ctx.repoDb,
      worktreeDb: ctx.db,
      globalDb: ctx.db,
      project: {} as any,
      getEmbedder: async () => null,
      makeModel: () => model,
      org,
      curator: CURATOR_DEFAULTS,
    });
    const summary = await w.runDrain("s1", "shutdown");
    // runMemoryTodo is the ONLY memory-producing pass in this seed (learning
    // short-circuits on empty transcript, reflection is empty with null
    // embedder, consolidation emits only summary/selfName). Disabling it →
    // zero staged memory.
    expect(summary.memoryStaged).toBe(0);
    expect(listPending(ctx.repoDb, "repo")).toHaveLength(0);
    // consolidation still runs → self-name persisted.
    expect((ctx.db.prepare("SELECT name FROM sessions WHERE id='s1'").get() as any).name).toBe("auth-refactor");
  });

  it("per-pass resilience: a throwing first pass does not abort the drain; consolidation still self-names", async () => {
    ctx = makeOrgDb();
    seed(ctx.db);
    // A fake model whose FIRST invocation throws (simulating a flaky aux-model
    // pass). Every later call behaves normally, so consolidation still runs and
    // self-names the session. A pre-fix unguarded drain would reject here.
    let calls = 0;
    const flaky: DigestModel = {
      complete: async (system) => {
        calls += 1;
        if (calls === 1) throw new Error("aux model boom on first pass");
        return system.includes("summary")
          ? JSON.stringify({ summary: "did auth", selfName: "auth-refactor" })
          : JSON.stringify({ memory: [], todos: [], skills: [] });
      },
    };
    const w = new OrganismWorker({
      db: ctx.repoDb,
      worktreeDb: ctx.db,
      globalDb: ctx.db,
      project: { projectKey: "k", realPath: "/x", dbPath: "/x" } as any,
      getEmbedder: async () => null,
      makeModel: () => flaky,
      org: ORGANISM_DEFAULTS,
      curator: CURATOR_DEFAULTS,
    });
    // Must resolve (not reject) even though the first pass threw.
    const summary = await w.runDrain("s1", "shutdown");
    expect(summary).toBeTruthy();
    // Consolidation still ran → the session is self-named.
    expect((ctx.db.prepare("SELECT name FROM sessions WHERE id='s1'").get() as any).name).toBe("auth-refactor");
    expect(calls).toBeGreaterThan(1);
  });
});

describe("OrganismWorker.runCurate consolidation", () => {
  it("calls the model for an explicit consolidate request even when config defaults off", async () => {
    ctx = makeOrgDb();
    ctx.repoDb.prepare("INSERT INTO skills (name, source, use_count, last_used_at, created_at) VALUES ('candidate','auto',1,1,1)").run();
    let calls = 0;
    const worker = new OrganismWorker({
      db: ctx.repoDb, worktreeDb: ctx.db, globalDb: ctx.db,
      project: {} as any, getEmbedder: async () => null,
      makeModel: () => ({ complete: async () => { calls++; return '{"absorbed":[]}'; } }),
      org: ORGANISM_DEFAULTS, curator: CURATOR_DEFAULTS,
    });
    const result = await curateAction({ db: ctx.repoDb, globalDb: ctx.db, project: {} as any, worker }, { force: true, consolidate: true });
    expect(calls).toBe(1);
    expect((result.details as { consolidated: boolean }).consolidated).toBe(true);
  });

  it("reports the disabled gate instead of claiming consolidation ran", async () => {
    ctx = makeOrgDb();
    const worker = new OrganismWorker({
      db: ctx.repoDb, worktreeDb: ctx.db, globalDb: ctx.db,
      project: {} as any, getEmbedder: async () => null, makeModel: () => null,
      org: { ...ORGANISM_DEFAULTS, enabled: false }, curator: CURATOR_DEFAULTS,
    });
    const result = await curateAction({ db: ctx.repoDb, globalDb: ctx.db, project: {} as any, worker }, { consolidate: true });
    expect((result.details as { consolidated: boolean; skipReason?: string }).consolidated).toBe(false);
    expect((result.details as { skipReason?: string }).skipReason).toBe("disabled");
    expect(result.display).toMatch(/organism disabled/i);
    expect(result.display).not.toMatch(/consolidation: ran/i);
  });

  it("reports the paused gate when curate is requested without force", async () => {
    ctx = makeOrgDb();
    ctx.repoDb.prepare("INSERT INTO curator_state (scope, last_run_at, paused) VALUES ('project', NULL, 1)").run();
    const worker = new OrganismWorker({
      db: ctx.repoDb, worktreeDb: ctx.db, globalDb: ctx.db,
      project: {} as any, getEmbedder: async () => null, makeModel: () => null,
      org: ORGANISM_DEFAULTS, curator: CURATOR_DEFAULTS,
    });
    const result = await curateAction({ db: ctx.repoDb, globalDb: ctx.db, project: {} as any, worker }, { consolidate: true });
    expect(result.details).toMatchObject({ consolidated: false, skipReason: "paused" });
    expect(result.display).toMatch(/curator: skipped \(paused; use force to override\)/i);
    expect(result.display).toMatch(/consolidation: requested but did not run/i);
  });

  it("reports the interval gate when the previous run is too recent", async () => {
    ctx = makeOrgDb();
    ctx.repoDb.prepare("INSERT INTO curator_state (scope, last_run_at, paused) VALUES ('project', ?, 0)").run(Date.now());
    const worker = new OrganismWorker({
      db: ctx.repoDb, worktreeDb: ctx.db, globalDb: ctx.db,
      project: {} as any, getEmbedder: async () => null, makeModel: () => null,
      org: ORGANISM_DEFAULTS, curator: CURATOR_DEFAULTS,
    });
    const result = await curateAction({ db: ctx.repoDb, globalDb: ctx.db, project: {} as any, worker }, { consolidate: true });
    expect(result.details).toMatchObject({ consolidated: false, skipReason: "interval" });
    expect(result.display).toMatch(/curator: skipped \(minimum interval has not elapsed; use force to override\)/i);
    expect(result.display).toMatch(/consolidation: requested but did not run/i);
  });
});

describe("curateAction — honest consolidate passthrough (G5c)", () => {
  it("forwards the actual requested consolidate flag to the worker instead of dropping it", async () => {
    ctx = makeOrgDb();
    let capturedOpts: unknown;
    const worker = {
      runCurate: async (_now?: number, opts?: unknown) => {
        capturedOpts = opts;
        return { toStale: [], toArchived: [], skipped: [], consolidated: (opts as { consolidate?: boolean } | undefined)?.consolidate === true };
      },
    } as unknown as OrganismWorker;
    const deps: OrganismActionDeps = { db: ctx.repoDb, globalDb: ctx.db, project: {} as any, worker };
    const result = await curateAction(deps, { consolidate: true });
    expect(capturedOpts).toMatchObject({ consolidate: true });
    expect((result.details as { consolidated: boolean }).consolidated).toBe(true);
    expect((result.details as { consolidateRequested: boolean }).consolidateRequested).toBe(true);
  });

  it("does not claim consolidation ran when it was requested but the worker did not actually perform it", async () => {
    ctx = makeOrgDb();
    const worker = {
      runCurate: async () => ({ toStale: [], toArchived: [], skipped: [], consolidated: false }),
    } as unknown as OrganismWorker;
    const deps: OrganismActionDeps = { db: ctx.repoDb, globalDb: ctx.db, project: {} as any, worker };
    const result = await curateAction(deps, { consolidate: true });
    expect((result.details as { consolidated: boolean }).consolidated).toBe(false);
    expect((result.details as { consolidateRequested: boolean }).consolidateRequested).toBe(true);
  });

  it("preserves an unrequested (undefined) consolidate as a real absence, not a fabricated false", async () => {
    ctx = makeOrgDb();
    let capturedOpts: unknown;
    const worker = {
      runCurate: async (_now?: number, opts?: unknown) => {
        capturedOpts = opts;
        return { toStale: [], toArchived: [], skipped: [], consolidated: false };
      },
    } as unknown as OrganismWorker;
    const deps: OrganismActionDeps = { db: ctx.repoDb, globalDb: ctx.db, project: {} as any, worker };
    await curateAction(deps, {});
    expect((capturedOpts as { consolidate?: boolean }).consolidate).toBeUndefined();
  });

  // F8 (organism-review.md): the honest consolidated-vs-requested distinction (G5c) lands
  // in `details` but the RENDERED panel a human reads is silent about it — stale/archived/
  // skipped only. Genuine RED-first fix (not a promotion): renderCurateResult currently
  // ignores both fields entirely.
  it("surfaces the honest consolidation outcome in the rendered display, not just in details (F8)", async () => {
    ctx = makeOrgDb();
    const ran = {
      runCurate: async () => ({ toStale: [], toArchived: [], skipped: [], consolidated: true }),
    } as unknown as OrganismWorker;
    const requestedNotRun = {
      runCurate: async () => ({ toStale: [], toArchived: [], skipped: [], consolidated: false }),
    } as unknown as OrganismWorker;
    const notRequested = {
      runCurate: async () => ({ toStale: [], toArchived: [], skipped: [], consolidated: false }),
    } as unknown as OrganismWorker;
    const deps = (worker: OrganismWorker): OrganismActionDeps => ({ db: ctx.repoDb, globalDb: ctx.db, project: {} as any, worker });

    const ranResult = await curateAction(deps(ran), { consolidate: true });
    expect(ranResult.display).toMatch(/consolidat(ion|ed).*ran/i);

    const notRunResult = await curateAction(deps(requestedNotRun), { consolidate: true });
    expect(notRunResult.display).toMatch(/consolidat(ion|e).*(not run|did not run|did not happen)/i);

    const unrequestedResult = await curateAction(deps(notRequested), {});
    expect(unrequestedResult.display).not.toMatch(/consolidat(ion|ed) ran/i);
  });
});
