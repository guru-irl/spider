import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDbAt, paths, type Db } from "@spider/db-core";
import { registerOrganism } from "../index.js";
import { OrganismWorker, type WorkerDeps } from "../worker.js";
import { enqueueSkillReview } from "../skill-review-queue.js";
import { SkillStore } from "../skill-usage.js";
import { ORGANISM_DEFAULTS } from "../config.js";
import { CURATOR_DEFAULTS } from "../curator.js";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { finalSkillBody } from "./helpers/skill.js";

let databases: ReturnType<typeof makeOrgDb>;
let global: Db;
let root: string;
const workers: OrganismWorker[] = [];
beforeEach(() => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  root = join(paths.scratch("worktree", process.cwd()), `organism-auto-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  databases = makeOrgDb();
  global = openDbAt(join(root, "global.db"), "global");
  databases.db.prepare("INSERT INTO sessions(id,reason,started_at) VALUES ('s1','startup',1)").run();
});
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stopSkillReviews();
  global.close(); databases.cleanup(); rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function deps(): WorkerDeps {
  return {
    db: databases.repoDb, worktreeDb: databases.db, globalDb: global,
    project: { projectKey: root, realPath: root, dbPath: join(root, "worktree.db") },
    getEmbedder: async () => null,
    makeModel: () => ({ complete: async () => '{"memory":[],"skills":[],"todos":[]}' }),
    org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: true, consolidation: false, reflection: false, insights: false } },
    curator: CURATOR_DEFAULTS,
  };
}
function activation(worker: OrganismWorker, automatic: () => boolean) {
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, handler); } };
  (registerOrganism as (...args: unknown[]) => void)(null, pi, () => worker, undefined, () => true, automatic);
  const ctx = { sessionManager: { getSessionId: () => "s1", getBranch: () => [
    { type: "message", message: { role: "user", content: "Keep the durable review queue." } },
  ] } };
  return { emit: async (name: string, event: unknown) => { await hooks.get(name)?.(event, ctx); } };
}

it("skips an automatic shutdown drain and resumes the durable review queue in the new activation", async () => {
  const candidate = { name: "durable-review", body: finalSkillBody("durable-review") };
  expect(enqueueSkillReview(databases.repoDb, candidate)).toBe(true);
  const reviewStarted = vi.fn();
  const learner = vi.fn(async () => '{"memory":[],"skills":[],"todos":[]}');
  const first = new OrganismWorker({ ...deps(), makeModel: () => ({ complete: learner }), skillReview: {
    reviewer: async () => { reviewStarted(); return new Promise(() => {}); },
    loadContext: () => ({ rubric: "Review reusable skills.", skills: [] }),
  } });
  workers.push(first);
  const old = activation(first, () => true);
  await old.emit("session_start", { reason: "startup" });
  await vi.waitFor(() => expect(reviewStarted).toHaveBeenCalledOnce());
  await old.emit("session_shutdown", { reason: "reload" });
  expect(learner).not.toHaveBeenCalled();
  expect(databases.repoDb.prepare("SELECT name,attempts FROM skill_review_queue").all()).toEqual([{ name: "durable-review", attempts: 0 }]);

  const next = new OrganismWorker({ ...deps(), skillReview: {
    reviewer: async () => '{"verdict":"new","reason":"reusable"}',
    loadContext: () => ({ rubric: "Review reusable skills.", skills: [] }),
  } });
  workers.push(next);
  const reloaded = activation(next, () => false);
  await reloaded.emit("session_start", { reason: "reload" });
  await vi.waitFor(() => expect(new SkillStore(databases.repoDb).get("durable-review")?.status).toBe("staged"));
  expect(databases.repoDb.prepare("SELECT count(*) n FROM skill_review_queue").get()).toEqual({ n: 0 });
});

it("reports serialized organism work as active until the drain settles", async () => {
  let release!: (value: string) => void;
  const modelCall = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
  const worker = new OrganismWorker({ ...deps(), makeModel: () => ({ complete: modelCall }) });
  workers.push(worker);
  const drain = worker.runDrain("s1", "before_compact", { transcript: [{ role: "user", content: "Keep the durable review queue." }] });
  try {
    await vi.waitFor(() => expect(modelCall).toHaveBeenCalledOnce());
    expect((worker as unknown as { blocksReload?: () => boolean }).blocksReload?.()).toBe(true);
  } finally {
    release?.('{"memory":[],"skills":[],"todos":[]}');
    await drain;
  }
  expect((worker as unknown as { blocksReload?: () => boolean }).blocksReload?.()).toBe(false);
});

it("keeps the existing shutdown drain on a manual reload", async () => {
  const learner = vi.fn(async () => '{"memory":[],"skills":[],"todos":[]}');
  const worker = new OrganismWorker({ ...deps(), makeModel: () => ({ complete: learner }) });
  workers.push(worker);
  const manual = activation(worker, () => false);
  await manual.emit("session_shutdown", { reason: "reload" });
  expect(learner).toHaveBeenCalledOnce();
  expect(worker.getLastDrain()).toMatchObject({ reason: "shutdown", sessionId: "s1" });
});
