import { afterEach, expect, it, vi } from "vitest";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { finalSkillBody } from "./helpers/skill.js";
import { SkillStore } from "../skill-usage.js";
import { applyDigest } from "../apply.js";
import { runSkillReviewQueue, skillReviewQueueStatus } from "../skill-review-queue.js";
import { registerOrganism } from "../index.js";
import { OrganismWorker } from "../worker.js";
import { ORGANISM_DEFAULTS } from "../config.js";
import { CURATOR_DEFAULTS } from "../curator.js";
import { openDbAt } from "@spider/db-core";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { persistReviewError } from "@spider/memory";
let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => { ctx?.cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const fixture = () => { ctx = makeOrgDb(); return new SkillStore(ctx.repoDb); };
const candidate = { name: "tracing-writers", body: finalSkillBody("tracing-writers", "Trace ownership.") };
const enqueue = async (skills: SkillStore, skillReview: object = { reviewer: async () => "" }) => applyDigest({ db: ctx.repoDb, worktreeDb: ctx.db, globalDb: ctx.repoDb, scope: "repo", sessionId: "s1", project: {} as any, skills, skillReview }, { memory: [], todos: [], skills: [candidate] }, { max: 5, used: 0 });
it("apply only queues valid capped learner skills durably and never waits for a reviewer", async () => {
  const skills = fixture(); const reviewer = vi.fn(() => new Promise<never>(() => {}));
  const result = await enqueue(skills, { reviewer });
  expect(result).toMatchObject({ skillsQueued: 1, skillsStaged: 0 }); expect(reviewer).not.toHaveBeenCalled(); expect(skills.list()).toEqual([]);
  expect(ctx.repoDb.prepare("SELECT name,origin,attempts,last_error FROM skill_review_queue").all()).toEqual([{ name: candidate.name, origin: "learner", attempts: 0, last_error: null }]);
});
it.each(["new", "duplicate", "not_durable", "low_quality"])("queue only stages new, records %s and removes completed work", async verdict => {
  const skills = fixture(); await enqueue(skills);
  const extra = verdict === "duplicate" ? { existing_name: "writing-skills" } : verdict === "low_quality" ? { failures: ["Token Efficiency"] } : {};
  await runSkillReviewQueue(ctx.repoDb, { reviewer: async () => JSON.stringify({ verdict, reason: "deciding rule", ...extra }) });
  expect(skills.get(candidate.name)?.status).toBe(verdict === "new" ? "staged" : undefined);
  if (verdict === "new") expect(skills.get(candidate.name)?.reviewReason).toBe("deciding rule");
  expect(skillReviewQueueStatus(ctx.repoDb).pending).toBe(0);
  expect(skillReviewQueueStatus(ctx.repoDb).recent[0]).toMatchObject({ verdict, reason: "deciding rule" });
});
it.each(["error", "unparseable", "timeout"])("queue keeps a failed item and drops after three %s attempts", async mode => {
  const skills = fixture(); await enqueue(skills);
  for (let i=1; i<=3; i++) {
    const controller = new AbortController();
    const reviewer = async () => { if (mode === "error") throw Error("offline"); if (mode === "unparseable") return "invalid"; controller.abort(); return '{"verdict":"new","reason":"not allowed after abort"}'; };
    if (mode === "timeout") vi.useFakeTimers();
    try {
      const task = runSkillReviewQueue(ctx.repoDb, { timeoutMs: 1000, signal: controller.signal, reviewer: mode === "timeout" ? () => new Promise<never>(() => {}) : reviewer });
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(1000);
      await task;
    } finally { vi.useRealTimers(); }
    const row = ctx.repoDb.prepare("SELECT attempts,last_error FROM skill_review_queue").get() as any;
    if (i<3) { expect(row.attempts).toBe(i); expect(row.last_error).toBeTruthy(); } else expect(row).toBeUndefined();
    expect(skills.list()).toEqual([]);
  }
  expect(skillReviewQueueStatus(ctx.repoDb).recent[0].reason).toContain("3 attempts");
});
it("queue serializes across two handles to the same repo DB", async () => {
  const skills = fixture(); await enqueue(skills);
  const other = openDbAt(ctx.repoDb.raw.name, "repo"); let finish!: (value: string) => void;
  const reviewer = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  try {
    const first = runSkillReviewQueue(ctx.repoDb, { reviewer });
    await vi.waitFor(() => expect(reviewer).toHaveBeenCalledTimes(1));
    await runSkillReviewQueue(other, { reviewer });
    expect(reviewer).toHaveBeenCalledTimes(1);
    finish('{"verdict":"new","reason":"reusable"}'); await first;
    expect(skills.list()).toHaveLength(1);
  } finally { other.close(); }
});
it("queue never reviews or stages in a child", async () => {
  const skills = fixture(); await enqueue(skills); vi.stubEnv("PI_SUBAGENT_CHILD", "1"); const reviewer = vi.fn(async () => '{"verdict":"new","reason":"reusable"}');
  await runSkillReviewQueue(ctx.repoDb, { reviewer }); expect(reviewer).not.toHaveBeenCalled(); expect(skillReviewQueueStatus(ctx.repoDb).pending).toBe(1); expect(skills.list()).toEqual([]);
});
const setupWorker = () => {
  const skills = fixture(); ctx.db.prepare("INSERT INTO sessions(id,reason,started_at) VALUES ('s1','test',1)").run();
  return { skills, worker: new OrganismWorker({ db: ctx.repoDb, worktreeDb: ctx.db, globalDb: ctx.repoDb, project: {} as any, getEmbedder: async () => null,
    makeModel: () => ({ complete: async () => '{"memory":[],"skills":[],"todos":[]}' }), org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: false, consolidation: false, reflection: false, insights: false } }, curator: CURATOR_DEFAULTS,
    skillReview: { reviewer: async () => '{"verdict":"new","reason":"reusable"}' } }) };
};
it("session start reviews queued skills fire-and-forget without a learner call", async () => {
  const { skills, worker } = setupWorker(); await enqueue(skills); const events: Record<string, any> = {};
  registerOrganism({}, { on: (name: string, callback: any) => { events[name] = callback; } }, () => worker);
  const ctxHost = { sessionManager: { getSessionId: () => "s1", getBranch: () => [] } } as any;
  expect(events.session_start({}, ctxHost)).toBeUndefined(); await vi.waitFor(() => expect(skills.list()).toHaveLength(1));
  expect(worker.getLastDrain()).toBeUndefined();
});
it("shutdown never starts a queue review", async () => {
  const { skills, worker } = setupWorker(); await enqueue(skills); const events: Record<string, any> = {};
  registerOrganism({}, { on: (name: string, callback: any) => { events[name] = callback; } }, () => worker);
  await events.session_shutdown({}, { sessionManager: { getSessionId: () => "s1", getBranch: () => [] } });
  expect(skills.list()).toEqual([]); expect(skillReviewQueueStatus(ctx.repoDb).pending).toBe(1);
});
it("before compact starts queue review only after its drain completes", async () => {
  const { skills, worker } = setupWorker(); await enqueue(skills); const events: Record<string, any> = {};
  registerOrganism({}, { on: (name: string, callback: any) => { events[name] = callback; } }, () => worker);
  events.session_before_compact({ branchEntries: [] }, { sessionManager: { getSessionId: () => "s1", getBranch: () => [] } });
  await vi.waitFor(() => expect(skills.list()).toHaveLength(1)); expect(worker.getLastDrain()?.reason).toBe("before_compact");
});
it("child session_start and compact do not resolve a runtime or review queue", async () => {
  fixture(); vi.stubEnv("PI_SUBAGENT_CHILD", "1"); const resolve = vi.fn(); const events: Record<string, any> = {};
  registerOrganism({}, { on: (name: string, callback: any) => { events[name] = callback; } }, resolve);
  const hostCtx = { sessionManager: { getSessionId: () => "s1", getBranch: () => [] } };
  events.session_start({}, hostCtx); events.session_before_compact({}, hostCtx); await events.session_shutdown({}, hostCtx);
  expect(resolve).not.toHaveBeenCalled();
});

const secondCandidate = { name: "tracing-readers", body: finalSkillBody("tracing-readers", "Trace reader ownership.") };
const queueSecond = () => ctx.repoDb.prepare("INSERT INTO skill_review_queue(name,body,origin,created_at) VALUES (?,?,'learner',?)").run(secondCandidate.name, secondCandidate.body, Date.now() + 1);
it("a live foreign lease blocks, and an expired crash lease is taken over and released", async () => {
  const store = fixture(); await enqueue(store);
  ctx.repoDb.prepare("INSERT INTO skill_review_lock(id,token,lease_until) VALUES (1,?,?)").run("crashed-owner", Date.now() + 60_000);
  const reviewer = vi.fn(async () => '{"verdict":"new","reason":"reusable"}');
  await runSkillReviewQueue(ctx.repoDb, { reviewer });
  expect(reviewer).not.toHaveBeenCalled();
  expect(skillReviewQueueStatus(ctx.repoDb).pending).toBe(1);
  ctx.repoDb.prepare("UPDATE skill_review_lock SET lease_until=? WHERE id=1").run(Date.now() - 1);
  await runSkillReviewQueue(ctx.repoDb, { reviewer });
  expect(store.get(candidate.name)?.status).toBe("staged");
  expect(skillReviewQueueStatus(ctx.repoDb).pending).toBe(0);
  expect(ctx.repoDb.prepare("SELECT token,lease_until FROM skill_review_lock").get()).toEqual({ token: "", lease_until: 0 });
});
it("renews the lease before each item even after a clock jump", async () => {
  let now = 10_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const store = fixture(); await enqueue(store); queueSecond();
  const leases: number[] = [];
  await runSkillReviewQueue(ctx.repoDb, { timeoutMs: 1000, reviewer: async () => {
    leases.push((ctx.repoDb.prepare("SELECT lease_until FROM skill_review_lock").get() as { lease_until: number }).lease_until);
    now += 10_000;
    return '{"verdict":"new","reason":"reusable"}';
  } });
  expect(leases).toEqual([16_000, 26_000]);
  expect(store.list({ status: "staged" })).toHaveLength(2);
});
it.each(["new", "error"])("fences a slow %s runner after an expired lease takeover", async mode => {
  const store = fixture(); await enqueue(store);
  ctx.repoDb.prepare("UPDATE skill_review_queue SET attempts=2").run();
  const other = openDbAt(ctx.repoDb.raw.name, "repo");
  let finish!: () => void; let finishSecond!: () => void;
  let started!: () => void; let startedSecond!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const enteredSecond = new Promise<void>(resolve => { startedSecond = resolve; });
  let firstOwner: unknown; let secondOwner: unknown;
  let first = Promise.resolve(); let second = Promise.resolve();
  try {
    first = runSkillReviewQueue(ctx.repoDb, { reviewer: () => {
      firstOwner = ctx.repoDb.prepare("SELECT token FROM skill_review_lock").get();
      started();
      return new Promise<string>((resolve, reject) => { finish = () => mode === "error" ? reject(Error("provider reset")) : resolve('{"verdict":"new","reason":"stale decision"}'); });
    } });
    await entered;
    other.prepare("UPDATE skill_review_lock SET lease_until=? WHERE id=1").run(Date.now() - 1);
    second = runSkillReviewQueue(other, { reviewer: () => {
      secondOwner = other.prepare("SELECT token FROM skill_review_lock").get();
      startedSecond();
      return new Promise<string>(resolve => { finishSecond = () => resolve(mode === "error" ? '{"verdict":"new","reason":"winner decision"}' : '{"verdict":"not_durable","reason":"winner decision"}'); });
    } });
    await enteredSecond;
    expect(secondOwner).not.toEqual(firstOwner);
    finish(); await first;
    // The obsolete owner cannot stage, record, increment attempts, or release the new owner's lock.
    expect(skillReviewQueueStatus(ctx.repoDb)).toEqual({ pending: 1, recent: [] });
    expect(store.list()).toEqual([]);
    expect(ctx.repoDb.prepare("SELECT attempts FROM skill_review_queue").get()).toEqual({ attempts: 2 });
    expect(other.prepare("SELECT token FROM skill_review_lock").get()).toEqual(secondOwner);
    finishSecond(); await second;
    expect(skillReviewQueueStatus(ctx.repoDb)).toEqual({ pending: 0, recent: [{ name: candidate.name, verdict: mode === "error" ? "new" : "not_durable", reason: "winner decision" }] });
    expect(store.get(candidate.name)?.reviewReason).toBe(mode === "error" ? "winner decision" : undefined);
    expect(store.list()).toHaveLength(mode === "error" ? 1 : 0);
  } finally { finish?.(); finishSecond?.(); await first; await second; other.close(); }
});
it.each(["active", "staged"])("records new_not_staged when the name becomes %s during review", async status => {
  const store = fixture(); await enqueue(store);
  await runSkillReviewQueue(ctx.repoDb, { reviewer: async () => {
    if (status === "active") store.upsert({ name: candidate.name });
    else store.stageCandidate(candidate);
    return '{"verdict":"new","reason":"reusable"}';
  } });
  expect(store.get(candidate.name)?.status).toBe(status);
  expect(skillReviewQueueStatus(ctx.repoDb).recent[0]).toMatchObject({ verdict: "new_not_staged" });
  expect(skillReviewQueueStatus(ctx.repoDb).recent[0].reason).toContain(`already ${status}`);
});
it.each(["parse", "stage"])("logs an item %s error, drops it after three attempts, and continues later items", async mode => {
  const store = fixture(); await enqueue(store); queueSecond();
  if (mode === "parse") ctx.repoDb.prepare("UPDATE skill_review_queue SET related='broken JSON' WHERE name=?").run(candidate.name);
  else {
    const original = SkillStore.prototype.stageCandidate;
    vi.spyOn(SkillStore.prototype, "stageCandidate").mockImplementation(function (this: SkillStore, c) {
      if (c.name === candidate.name) { original.call(this, c); throw Error("item staging failed"); }
      return original.call(this, c);
    });
  }
  const logRoot = join(process.cwd(), ".spider", "scratch", `queue-errors-${crypto.randomUUID()}`);
  mkdirSync(logRoot, { recursive: true });
  vi.stubEnv("GIT_CEILING_DIRECTORIES", join(process.cwd(), ".spider", "scratch"));
  try {
    const opts = { reviewer: async () => '{"verdict":"new","reason":"reusable"}', onReviewError: (error: string, raw: unknown) => persistReviewError(logRoot, "skill", error, raw) };
    for (let attempt = 1; attempt <= 3; attempt++) {
      await runSkillReviewQueue(ctx.repoDb, opts);
      const row = ctx.repoDb.prepare("SELECT attempts,last_error FROM skill_review_queue WHERE name=?").get(candidate.name) as { attempts: number; last_error: string } | undefined;
      if (attempt < 3) expect(row).toMatchObject({ attempts: attempt, last_error: expect.any(String) });
      else expect(row).toBeUndefined();
      expect(store.get(secondCandidate.name)?.status).toBe("staged");
      expect(store.get(candidate.name)).toBeUndefined();
    }
    const diagnostics = readFileSync(join(logRoot, ".spider", "logs", "reviewer-errors.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.every(row => row.reviewer === "skill" && row.error.includes(mode === "parse" ? "JSON" : "item staging failed"))).toBe(true);
    expect(skillReviewQueueStatus(ctx.repoDb).recent.find(row => row.name === candidate.name)).toMatchObject({ verdict: "review_skipped", reason: expect.stringContaining("dropped after 3 attempts") });
  } finally { rmSync(logRoot, { recursive: true, force: true }); }
});
it("retains only the newest 30 results", async () => {
  const store = fixture(); await enqueue(store);
  for (let i = 0; i < 35; i++) ctx.repoDb.prepare("INSERT INTO skill_review_results(name,verdict,reason,created_at) VALUES (?,'not_durable','old',?)").run(`old-${i}`, i);
  await runSkillReviewQueue(ctx.repoDb, { reviewer: async () => '{"verdict":"new","reason":"newest"}' });
  const results = ctx.repoDb.prepare("SELECT name FROM skill_review_results ORDER BY id").all();
  expect(results).toHaveLength(30);
  expect(results[0]).toEqual({ name: "old-6" });
  expect(results[29]).toEqual({ name: candidate.name });
});
it("session cancellation preserves attempts and does not log a reviewer failure", async () => {
  const store = fixture(); await enqueue(store); queueSecond();
  ctx.repoDb.prepare("UPDATE skill_review_queue SET attempts=2,last_error='previous error' WHERE name=?").run(candidate.name);
  const diagnostics = vi.fn();
  for (let i = 0; i < 3; i++) {
    const controller = new AbortController();
    await runSkillReviewQueue(ctx.repoDb, { signal: controller.signal, onReviewError: diagnostics, reviewer: async () => {
      controller.abort(); return '{"verdict":"new","reason":"cancelled"}';
    } });
  }
  expect(ctx.repoDb.prepare("SELECT attempts,last_error FROM skill_review_queue WHERE name=?").get(candidate.name)).toEqual({ attempts: 2, last_error: "previous error" });
  expect(skillReviewQueueStatus(ctx.repoDb)).toEqual({ pending: 2, recent: [] });
  expect(store.list()).toEqual([]);
  expect(diagnostics).not.toHaveBeenCalled();
});
it("a provider error named aborted still counts when the session was not cancelled", async () => {
  const store = fixture(); await enqueue(store);
  await runSkillReviewQueue(ctx.repoDb, { reviewer: async () => { throw Error("aborted"); } });
  expect(ctx.repoDb.prepare("SELECT attempts,last_error FROM skill_review_queue").get()).toEqual({ attempts: 1, last_error: "aborted" });
});
it("a top-level queue runner failure reaches worker diagnostics", async () => {
  const { skills } = setupWorker(); await enqueue(skills);
  const logRoot = join(process.cwd(), ".spider", "scratch", `runner-errors-${crypto.randomUUID()}`);
  mkdirSync(logRoot, { recursive: true });
  vi.stubEnv("GIT_CEILING_DIRECTORIES", join(process.cwd(), ".spider", "scratch"));
  // Use a separate worker with the real host diagnostics callback.
  const diagnosticWorker = new OrganismWorker({ db: ctx.repoDb, worktreeDb: ctx.db, globalDb: ctx.repoDb, project: {} as any, getEmbedder: async () => null,
    makeModel: () => null, org: ORGANISM_DEFAULTS, curator: CURATOR_DEFAULTS,
    skillReview: { reviewer: async () => "", onReviewError: (error, raw) => persistReviewError(logRoot, "skill", error, raw) } });
  const original = ctx.repoDb.prepare;
  vi.spyOn(ctx.repoDb, "prepare").mockImplementation(sql => {
    if (sql === "SELECT * FROM skill_review_queue ORDER BY created_at,name") throw Error("runner queue read failed");
    return original(sql);
  });
  try {
    diagnosticWorker.startSkillReviews();
    await diagnosticWorker.stopSkillReviews();
    const diagnostic = JSON.parse(readFileSync(join(logRoot, ".spider", "logs", "reviewer-errors.jsonl"), "utf8").trim());
    expect(diagnostic).toMatchObject({ reviewer: "skill", error: expect.stringContaining("runner queue read failed") });
    expect(skillReviewQueueStatus(ctx.repoDb).pending).toBe(1);
  } finally { rmSync(logRoot, { recursive: true, force: true }); }
});
