import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { OrganismWorker } from "../worker.js";
import { curateAction, type OrganismActionDeps } from "../actions.js";
import { ORGANISM_DEFAULTS } from "../config.js";
import { CURATOR_DEFAULTS } from "../curator.js";
import { listPending } from "@spider/memory";
import type { DigestModel } from "../types.js";

let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => ctx?.cleanup());

const model: DigestModel = {
  complete: async (system) =>
    system.includes("summary") // consolidation prompt
      ? JSON.stringify({ summary: "did auth", selfName: "auth-refactor" })
      : JSON.stringify({ memory: [{ category: "insight", content: "prefers small PRs" }], todos: [], skills: [] }),
};

function seed(db: any): void {
  db.prepare(`INSERT INTO sessions (id, reason, started_at) VALUES ('s1','startup',1)`).run();
  db.prepare(`INSERT INTO runs (id, session_id, agent, status) VALUES ('r1','s1','worker','done')`).run();
  db.prepare(
    `INSERT INTO run_events (run_id, session_id, ts, type, summary) VALUES ('r1','s1',2,'tool_result','did a thing')`
  ).run();
}

describe("OrganismWorker.runDrain", () => {
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
