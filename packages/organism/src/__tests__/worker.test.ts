import { describe, it, expect, afterEach } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { OrganismWorker } from "../worker.js";
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
      db: ctx.db,
      globalDb: ctx.db,
      project: { projectKey: "k", realPath: "/x", dbPath: "/x" } as any,
      getEmbedder: async () => null,
      makeModel: () => model,
      org: ORGANISM_DEFAULTS,
      curator: CURATOR_DEFAULTS,
    });
    const summary = await w.runDrain("s1", "shutdown");
    expect(summary.memoryStaged).toBeGreaterThan(0);
    expect(listPending(ctx.db, "project").length).toBe(summary.memoryStaged);
    expect((ctx.db.prepare("SELECT name FROM sessions WHERE id='s1'").get() as any).name).toBe("auth-refactor");
  });

  it("master toggle off → no drain, no writes", async () => {
    ctx = makeOrgDb();
    seed(ctx.db);
    const w = new OrganismWorker({
      db: ctx.db,
      globalDb: ctx.db,
      project: {} as any,
      getEmbedder: async () => null,
      makeModel: () => model,
      org: { ...ORGANISM_DEFAULTS, enabled: false },
      curator: CURATOR_DEFAULTS,
    });
    const summary = await w.runDrain("s1", "shutdown");
    expect(summary.memoryStaged).toBe(0);
    expect(listPending(ctx.db, "project")).toHaveLength(0);
  });

  it("per-pass toggle off skips that pass (real attribution)", async () => {
    ctx = makeOrgDb();
    seed(ctx.db);
    const org = { ...ORGANISM_DEFAULTS, passes: { ...ORGANISM_DEFAULTS.passes, runMemoryTodo: false } };
    const w = new OrganismWorker({
      db: ctx.db,
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
    expect(listPending(ctx.db, "project")).toHaveLength(0);
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
      db: ctx.db,
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
