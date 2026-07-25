import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { OrganismWorker } from "../worker.js";
import { ORGANISM_DEFAULTS } from "../config.js";
import { CURATOR_DEFAULTS } from "../curator.js";
import { SkillStore } from "../skill-usage.js";
import { buildLearningGraph } from "../learning-graph.js";
import { listPending, addMemory } from "@spider/memory";
import { paths } from "@spider/db-core";
import type { Db } from "@spider/db-core";
import type { WorkerDeps } from "../worker.js";
import type { DigestModel } from "../types.js";

// ---------------------------------------------------------------------------
// End-to-end Phase-6 smoke: drain → passes → apply → persist, budget cap,
// curator decay, and learning-graph persistence — all on ONE project DB under
// `.spider/scratch/` (NEVER /tmp). Multiple passes hit the fake model, so the
// TOTAL candidate count is non-deterministic; every assertion uses
// presence/inequality, not exact counts.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

// Only consolidation's system prompt contains "summary". Every other pass gets
// the memory/todo/skill branch. See task-15 brief for the exact shape.
const fakeModel: DigestModel = {
  complete: async (system) =>
    system.includes("summary")
      ? JSON.stringify({ summary: "shipped auth", selfName: "auth-refactor" })
      : JSON.stringify({
          memory: [
            { category: "insight", content: "prefers small PRs" },
            { category: "convention", content: "uses PKCE for auth" },
          ],
          todos: [{ text: "ship it" }],
          skills: [{ name: "auth-flow", category: "security", body: "# Auth flow\nUse PKCE." }],
        }),
};

let ctx: ReturnType<typeof makeOrgDb>;
const transcripts: string[] = [];
afterEach(() => {
  ctx?.cleanup();
  for (const p of transcripts.splice(0)) rmSync(p, { force: true });
});

/** Seed one session's activity: run, run_event, tracked event, completed todo. */
function seedSession(db: Db, sessionId: string): void {
  db.prepare(`INSERT INTO sessions (id, reason, started_at) VALUES (?, 'shutdown', 1)`).run(sessionId);
  db.prepare(`INSERT INTO runs (id, session_id, agent, status) VALUES (?, ?, 'worker', 'done')`).run(
    `r-${sessionId}`,
    sessionId
  );
  db.prepare(
    `INSERT INTO run_events (run_id, session_id, ts, type, summary) VALUES (?, ?, 2, 'tool_result', 'ran the auth refactor')`
  ).run(`r-${sessionId}`, sessionId);
  db.prepare(
    `INSERT INTO events (session_id, ts, phase, tool, description) VALUES (?, 3, 'after', 'exec', 'applied PKCE auth flow')`
  ).run(sessionId);
  db.prepare(
    `INSERT INTO todos (session_id, seq, text, done, created_at) VALUES (?, 1, 'wire up PKCE', 1, 4)`
  ).run(sessionId);
}

/**
 * Write a stub transcript `.jsonl` UNDER THE SCRATCH DIR (never /tmp) and
 * return its path. A non-empty transcript is REQUIRED to exercise the learning
 * pass (it short-circuits on an empty transcript, and skills are emitted ONLY
 * by the learning pass).
 */
function writeTranscript(sessionId: string): string {
  const dir = paths.scratch("repo", process.cwd());
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `transcript-${sessionId}-${crypto.randomUUID()}.jsonl`);
  const lines = [
    { role: "user", content: "the auth flow should use PKCE, please keep PRs small" },
    { role: "assistant", content: "understood — refactoring auth to PKCE now" },
    { role: "user", content: "great, ship it" },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  transcripts.push(path);
  return path;
}

function makeWorker(repoDb: Db, worktreeDb: Db, overrides?: Partial<WorkerDeps>): OrganismWorker {
  return new OrganismWorker({
    db: repoDb,
    worktreeDb,
    globalDb: repoDb,  // Use repo DB as global for test simplicity
    project: { projectKey: "k", realPath: process.cwd(), dbPath: "x" } as never,
    getEmbedder: async () => null,
    makeModel: () => fakeModel,
    org: ORGANISM_DEFAULTS,
    curator: CURATOR_DEFAULTS,
    ...overrides,
  });
}

describe("Phase-6 integration smoke", () => {
  it("(A) drains a session into staged memory + skills and self-names the session", async () => {
    ctx = makeOrgDb();
    seedSession(ctx.db, "s1");
    const transcriptPath = writeTranscript("s1");

    const w = makeWorker(ctx.repoDb, ctx.db);
    const summary = await w.runDrain("s1", "shutdown", { transcriptPath });

    // Staged memory is visible AND fully accounted for by the summary.
    expect(listPending(ctx.repoDb, "repo").length).toBeGreaterThan(0);
    expect(listPending(ctx.repoDb, "repo").length).toBe(summary.memoryStaged);

    // The learning pass staged at least one skill candidate.
    expect(new SkillStore(ctx.repoDb).list({ status: "staged" }).length).toBeGreaterThanOrEqual(1);

    // Consolidation self-named the session.
    const row = ctx.db.prepare("SELECT name FROM sessions WHERE id = 's1'").get() as { name: string };
    expect(row.name).toBe("auth-refactor");
  });

  it("(B) enforces the per-drain auto-write budget (caps writes, counts drops)", async () => {
    ctx = makeOrgDb();
    seedSession(ctx.db, "s2");
    const transcriptPath = writeTranscript("s2");

    const w = makeWorker(ctx.repoDb, ctx.db, { org: { ...ORGANISM_DEFAULTS, autoWriteBudget: 2 } });
    const capped = await w.runDrain("s2", "shutdown", { transcriptPath });

    expect(capped.memoryStaged + capped.skillsStaged).toBeLessThanOrEqual(2);
    expect(capped.dropped).toBeGreaterThan(0);
  });

  it("(C) curator decays idle skills, never touching pinned/protected", async () => {
    ctx = makeOrgDb();
    const now = Date.now();
    ctx.repoDb
      .prepare(`INSERT INTO skills (name, source, use_count, last_used_at, created_at) VALUES ('fresh40','auto',1,?,?)`)
      .run(now - 40 * DAY, now - 40 * DAY);
    ctx.repoDb
      .prepare(`INSERT INTO skills (name, source, use_count, last_used_at, created_at) VALUES ('old100','auto',1,?,?)`)
      .run(now - 100 * DAY, now - 100 * DAY);
    ctx.repoDb
      .prepare(
        `INSERT INTO skills (name, source, pinned, protected, use_count, last_used_at, created_at) VALUES ('pinnedOld','auto',1,0,1,?,?)`
      )
      .run(now - 200 * DAY, now - 200 * DAY);
    ctx.repoDb
      .prepare(
        `INSERT INTO skills (name, source, pinned, protected, use_count, last_used_at, created_at) VALUES ('builtin','user',0,1,1,?,?)`
      )
      .run(now - 200 * DAY, now - 200 * DAY);

    const w = makeWorker(ctx.repoDb, ctx.db);
    const decay = await w.runCurate(now, { force: true });

    expect(decay.toStale).toContain("fresh40");
    expect(decay.toArchived).toContain("old100");
    expect(decay.skipped).toEqual(expect.arrayContaining(["pinnedOld", "builtin"]));

    const store = new SkillStore(ctx.repoDb);
    expect(store.get("pinnedOld")!.state).toBe("active");
    expect(store.get("builtin")!.state).toBe("active");
  });

  it("(D) builds and persists the learning graph as insights rows", () => {
    ctx = makeOrgDb();
    const store = new SkillStore(ctx.repoDb);
    if (store.get("auth-flow") === undefined) store.upsert({ name: "auth-flow", category: "security" });
    addMemory(ctx.repoDb, "repo", { category: "convention", content: "the auth flow uses PKCE" });

    const g = buildLearningGraph(ctx.repoDb, ctx.repoDb, { persist: true });
    expect(g.nodes.length).toBeGreaterThan(0);

    const rows = ctx.repoDb
      .prepare("SELECT COUNT(*) c FROM insights WHERE kind IN ('node','edge')")
      .get() as { c: number };
    expect(rows.c).toBeGreaterThan(0);
  });

  it("(E) uses a scratch path under spider dir — never /tmp", () => {
    ctx = makeOrgDb();
    const scratch = paths.scratch("repo", process.cwd());
    expect(scratch).not.toContain("/tmp");
    // Repo tier scratch is under .git/spider/scratch (shared across worktrees)
    expect(scratch).toContain("spider");

    const transcriptPath = writeTranscript("s-scratch");
    expect(transcriptPath).not.toContain("/tmp");
    expect(transcriptPath.startsWith(scratch)).toBe(true);
  });
});
