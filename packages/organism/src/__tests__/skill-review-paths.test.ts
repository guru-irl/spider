import { runSkillReviewQueue } from "../skill-review-queue.js";
import { learningPass } from "../passes/learning.js";
import { parseCandidates } from "../aux-model.js";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { SkillStore } from "../skill-usage.js";
import { applyDigest } from "../apply.js";
import { skillAction, curateAction } from "../actions.js";
import { consolidateSkills, CURATOR_DEFAULTS } from "../curator.js";
import { openDbAt } from "@spider/db-core";
import { OrganismWorker } from "../worker.js";
import { ORGANISM_DEFAULTS } from "../config.js";
import { readOrganismConfig } from "../config.js";

const body = (name: string) => `---\nname: ${name}\ndescription: Use when asynchronous writes need completion evidence\n---\n# Writer ownership\nTrack each writer and assert the final writer closes its output before reading it.`;
let dir: string;
let ctx: ReturnType<typeof makeOrgDb>;
afterEach(() => { ctx?.cleanup(); if (dir) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const setup = (skillReview: object = {}) => {
  ctx = makeOrgDb();
  const root = join(process.cwd(), ".spider", "scratch", "skill-reviewer"); mkdirSync(root, { recursive: true });
  dir = mkdtempSync(join(root, "paths-"));
  return { db: ctx.repoDb, globalDb: ctx.repoDb, worktreeDb: ctx.db, scope: "repo" as const,
    sessionId: "s1", skills: new SkillStore(ctx.repoDb), project: { realPath: dir, projectKey: "fixture" } as any,
    worker: {} as any, skillReview };
};

it("learner fails closed when review throws, with counted skips and short reasons", async () => {
  const deps = setup({ reviewer: async () => { throw Error("model offline"); } });
  const result = await applyDigest(deps, { memory: [], todos: [], skills: [{ name: "tracking-writers", body: body("tracking-writers") }] }, { max: 5, used: 0 });
  expect(result).toMatchObject({ skillsQueued: 1, skillsStaged: 0, rejected: 0 });
  await runSkillReviewQueue(ctx.repoDb, deps.skillReview);
  expect(deps.skills.list()).toHaveLength(0);
  expect(ctx.repoDb.prepare("SELECT attempts,last_error FROM skill_review_queue").get()).toEqual({ attempts: 1, last_error: "model offline" });
});

it("learner counts each rejection verdict without reserving the name", async () => {
  const deps = setup({ reviewer: async () => '{"verdict":"not_durable","reason":"one task"}' });
  const result = await applyDigest(deps, { memory: [], todos: [], skills: [{ name: "tracking-writers", body: body("tracking-writers") }] }, { max: 5, used: 0 });
  expect(result.skillsQueued).toBe(1); await runSkillReviewQueue(ctx.repoDb, deps.skillReview);
  expect(ctx.repoDb.prepare("SELECT verdict FROM skill_review_results").get()).toEqual({ verdict: "not_durable" }); expect(deps.skills.get("tracking-writers")).toBeUndefined();
});

it("agent add stages on unavailable review, returns the skip reason and stores it", async () => {
  const deps = setup();
  const result = await skillAction(deps, { op: "add", name: "tracking-writers", text: body("tracking-writers") });
  expect(result.display).toMatch(/review skipped:/); expect(deps.skills.get("tracking-writers")?.status).toBe("staged");
  expect(deps.skills.get("tracking-writers")?.reviewReason).toMatch(/review skipped:/);
});

it("agent add rejects deterministic failures even when unavailable", async () => {
  const deps = setup();
  const result = await skillAction(deps, { op: "add", name: "tracking-writers", text: "# Missing metadata" });
  expect(result.display).toMatch(/frontmatter/); expect(deps.skills.list()).toHaveLength(0);
});

it("agent add returns the semantic verdict and reason to the calling agent", async () => {
  const deps = setup({ reviewer: async () => '{"verdict":"duplicate","existing_name":"systematic-debugging","reason":"same method"}' });
  const result = await skillAction(deps, { op: "add", name: "tracking-writers", text: body("tracking-writers") });
  expect(result.display).toContain("duplicate"); expect(result.display).toContain("same method"); expect(deps.skills.list()).toHaveLength(0);
});

it("applies the skill cap AFTER deterministic checks, with counted drops and no extra model calls", async () => {
  const reviewer = vi.fn(async () => '{"verdict":"new","reason":"reusable"}');
  const deps = setup({ reviewer });
  const result = await applyDigest({ ...deps, maxSkillProposals: 1 }, { memory: [], todos: [], skills: [
    { name: "bad/name", body: "x" }, { name: "first-skill", body: body("first-skill") }, { name: "second-skill", body: body("second-skill") },
  ] }, { max: 10, used: 0 });
  expect(result).toMatchObject({ skillsQueued: 1, skillsStaged: 0, rejected: 1, dropped: 1, skillCapDropped: 1 });
  expect(reviewer).not.toHaveBeenCalled(); await runSkillReviewQueue(ctx.repoDb, deps.skillReview); expect(deps.skills.get("first-skill")?.status).toBe("staged"); expect(deps.skills.get("second-skill")).toBeUndefined();
  expect(readOrganismConfig({}).maxSkillProposals).toBe(1);
  expect(readOrganismConfig({ "organism.maxSkillProposals": 0 }).maxSkillProposals).toBe(0);
  expect(readOrganismConfig({ "organism.maxSkillProposals": -1 }).maxSkillProposals).toBe(1);
});

it("approval preserves final-format frontmatter instead of nesting it in synthesized metadata", async () => {
  const deps = setup({ reviewer: async () => '{"verdict":"new","reason":"reusable"}' });
  await skillAction(deps, { op: "add", name: "tracking-writers", text: body("tracking-writers") });
  const result = deps.skills.approveCandidate("tracking-writers", dir);
  expect(result.ok).toBe(true);
  if (result.ok) expect(readFileSync(result.row.path!, "utf8")).toBe(body("tracking-writers") + "\n");
});

it("worker queues reviews, forwards the cap and persists queued counts in the drain receipt", async () => {
  const deps = setup(); const globalDb = openDbAt(join(dir, "global.db"), "global");
  ctx.db.prepare("INSERT INTO sessions(id,reason,started_at) VALUES ('s1','test',1)").run();
  deps.skills.stageCandidate({ name: "pending-coverage", body: body("pending-coverage") });
  let learnerPrompt = "";
  try {
    const worker = new OrganismWorker({ ...deps, globalDb,
      getEmbedder: async () => null,
      makeModel: () => ({ complete: async system => { learnerPrompt = system; return JSON.stringify({ memory: [], todos: [], skills: [
        { name: "first-skill", body: body("first-skill") }, { name: "second-skill", body: body("second-skill") },
      ] }); } }),
      skillReview: { reviewer: async () => { throw Error("worker reviewer unavailable"); } },
      org: { ...ORGANISM_DEFAULTS, maxSkillProposals: 1, passes: { runMemoryTodo: false, todoMemory: false, learning: true, consolidation: false, reflection: false, insights: false } },
      curator: CURATOR_DEFAULTS,
    });
    const summary = await worker.runDrain("s1", "shutdown", { transcript: [{ role: "user", content: "Reusable technique" }] });
    expect(summary).toMatchObject({ skillsQueued: 1, skillsStaged: 0, rejected: 0, dropped: 1, skillCapDropped: 1 });
    expect(worker.getLastDrain()?.skillsQueued).toBe(1);
    expect(learnerPrompt).toContain("pending-coverage");
    const receipt = ctx.db.prepare("SELECT payload FROM run_events WHERE type='log' ORDER BY id DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(receipt.payload).skillsQueued).toBe(1);
  } finally { globalDb.close(); }
});

it("curator result only reports archival, never unsolicited staging review fields", async () => {
  const deps = setup();
  const result = await curateAction({ ...deps, worker: { runCurate: async () => ({ toStale: [], toArchived: [], skipped: [], consolidated: true,
    skillsRejected: { not_durable: 1 }, skillReviewReasons: ["not_durable: one task only"] }) } as any }, { consolidate: true });
  expect(result.display).not.toContain("skill review");
  expect(result.display).toContain("archived: 0");
});

it("keeps raw skill strings intact so whitespace and empty bodies receive counted deterministic rejection", () => {
  const result = parseCandidates(JSON.stringify({ skills: [{ name: " spaced-name ", body: "\n---\nname: spaced-name\ndescription: Use when needed\n---\nx" }, { name: "empty-body", body: "" }] }));
  expect(result.skills).toHaveLength(2);
  expect(result.skills[0].name).toBe(" spaced-name "); expect(result.skills[0].body).toMatch(/^\n---/);
});
it("counts learner task-artifact and malformed proposals at the shared gate instead of silently filtering them", async () => {
  const deps = setup({ reviewer: async () => '{"verdict":"not_durable","reason":"task artifact"}' });
  const proposals = [
    { name: "fix-pr-1234-today", body: body("fix-pr-1234-today") },
    { name: " spaced-name ", body: "\n" + body("spaced-name") },
    { name: "empty-body", body: "" },
  ];
  const result = await learningPass({ sessionId: "s1", reason: "shutdown", runs: [], runEvents: [], events: [], todos: [], transcript: [{ role: "user", content: "Task artifact" }] }, { complete: async () => JSON.stringify({ memory: [], todos: [], skills: proposals }) });
  const summary = await applyDigest(deps, result, { max: 10, used: 0 });
  expect(summary).toMatchObject({ skillsStaged: 0, skillsQueued: 1, rejected: 2, skillsRejected: { deterministic_failure: 2 } });
});
