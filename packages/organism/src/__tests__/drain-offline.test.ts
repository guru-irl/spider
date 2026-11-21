import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrganismWorker, type WorkerDeps } from "../worker.js";
import { registerOrganism } from "../index.js";
import { ORGANISM_DEFAULTS } from "../config.js";
import { CURATOR_DEFAULTS } from "../curator.js";
import { makeOrgDb } from "./helpers/tmpdb.js";
import { openDbAt, type Db } from "@spider/db-core";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { DigestModel, DrainReport } from "../types.js";

let databases: ReturnType<typeof makeOrgDb>;
let globalDb: Db;
let globalPath: string;
const workers: OrganismWorker[] = [];
beforeEach(() => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  databases = makeOrgDb();
  globalPath = join(process.cwd(), ".spider", "scratch", `drain-offline-${crypto.randomUUID()}.db`);
  globalDb = openDbAt(globalPath, "global");
  databases.db.prepare("INSERT INTO sessions(id,started_at) VALUES ('session',1)").run();
});
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stopSkillReviews();
  globalDb.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(globalPath + suffix, { force: true });
  databases.cleanup(); vi.useRealTimers(); vi.unstubAllEnvs();
});
function fixture(complete: DigestModel["complete"], overrides: Partial<WorkerDeps> = {}) {
  const deps: WorkerDeps = {
    db: databases.repoDb, globalDb, worktreeDb: databases.db,
    project: {} as never, getEmbedder: async () => null,
    makeModel: () => ({ complete }),
    org: { ...ORGANISM_DEFAULTS, selfNaming: false, passes: { runMemoryTodo: false, todoMemory: false, learning: true, consolidation: true, reflection: false, insights: false } },
    curator: CURATOR_DEFAULTS, ...overrides,
  };
  const worker = new OrganismWorker(deps); workers.push(worker); return worker;
}
const snapshot = (content: string) => ({ transcript: [{ role: "user" as const, content }] });
const offline = () => Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
const response = '{"memory":[],"skills":[],"todos":[],"summary":"Recorded context.","selfName":"fixture"}';
const receipts = () => databases.db.prepare("SELECT payload FROM run_events WHERE summary LIKE 'organism drain (%' ORDER BY id").all() as Array<{ payload: string }>;

it("stops after the first transport failure, keeps one receipt, and retries distinct captured inputs", async () => {
  let online = false;
  const delivered: string[][] = [];
  const complete = vi.fn(async (_system: string, messages: Array<{ content: string }>) => {
    if (!online) throw offline();
    delivered.push(messages.map(message => message.content));
    return response;
  });
  const worker = fixture(complete);
  const first = snapshot("First captured conversation is retained.");
  const second = snapshot("A later captured conversation is retained too.");
  await worker.runDrain("session", "before_compact", first);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(worker.getLastDrain()).toMatchObject({ status: "failed", modelCalls: 1, errors: [{ message: "fetch failed" }] });
  for (let i = 0; i < 120; i++) await worker.runDrain("session", "before_compact", first);
  await worker.runDrain("session", "before_compact", second);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(receipts()).toHaveLength(1);
  expect(worker.getLastDrain()).toMatchObject({ status: "failed", modelCalls: 0, errors: [{ message: "fetch failed" }], outage: { occurrences: 100 } });
  online = true;
  await vi.advanceTimersByTimeAsync(300_000 - 1);
  expect(delivered).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(delivered.some(messages => messages.includes(first.transcript[0].content))).toBe(true);
  expect(delivered.some(messages => messages.includes(second.transcript[0].content))).toBe(true);
  expect(delivered.filter(messages => messages.includes(first.transcript[0].content))).toHaveLength(2);
  expect(delivered.filter(messages => messages.includes(second.transcript[0].content))).toHaveLength(2);
  expect(worker.getLastDrain()).toMatchObject({ status: "completed", errors: [] });
});

it("keeps one failure receipt per affected session during the same outage", async () => {
  databases.db.prepare("INSERT INTO sessions(id,started_at) VALUES ('other',1)").run();
  const complete = vi.fn(async () => { throw offline(); });
  const worker = fixture(complete);
  await worker.runDrain("session", "before_compact", snapshot("First session input."));
  await worker.runDrain("other", "before_compact", snapshot("Second session input."));
  await worker.runDrain("other", "before_compact", snapshot("Second session input."));
  expect(complete).toHaveBeenCalledTimes(1);
  const rows = databases.db.prepare("SELECT session_id,payload FROM run_events WHERE summary LIKE 'organism drain (%' ORDER BY id").all() as Array<{ session_id: string; payload: string }>;
  expect(rows.map(row => row.session_id)).toEqual(["session", "other"]);
  expect(rows.map(row => JSON.parse(row.payload).status)).toEqual(["failed", "failed"]);
});

it("does not repeat a successful pass when a later provider call fails", async () => {
  databases.db.prepare("INSERT INTO runs(id,session_id,agent,status) VALUES ('run','session','worker','done')").run();
  let online = false;
  const complete = vi.fn(async (system: string) => {
    if (system.includes("memory/todo digest")) return '{"memory":[],"skills":[],"todos":[{"text":"Keep the prior result."}]}';
    if (!online) throw offline();
    return response;
  });
  const worker = fixture(complete, { org: { ...ORGANISM_DEFAULTS, selfNaming: false, passes: { runMemoryTodo: true, todoMemory: false, learning: true, consolidation: false, reflection: false, insights: false } } });
  await worker.runDrain("session", "before_compact", snapshot("Keep this captured input."));
  expect(databases.db.prepare("SELECT text FROM todos WHERE session_id='session'").all()).toEqual([{ text: "Keep the prior result." }]);
  expect(complete).toHaveBeenCalledTimes(2);
  online = true;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(complete).toHaveBeenCalledTimes(3);
  expect(databases.db.prepare("SELECT text FROM todos WHERE session_id='session'").all()).toEqual([{ text: "Keep the prior result." }]);
});

it("coalesces identical lifecycle drains while the first provider call is in flight", async () => {
  let reject!: (error: Error) => void;
  const complete = vi.fn(() => new Promise<string>((_, fail) => { reject = fail; }));
  const reports: DrainReport[] = [];
  const worker = fixture(complete, { onDrainReport: report => reports.push(report) });
  const opts = snapshot("The same captured conversation.");
  const first = worker.runDrain("session", "before_compact", opts);
  await vi.advanceTimersByTimeAsync(0);
  const repeats = Array.from({ length: 20 }, () => worker.runDrain("session", "before_compact", opts));
  reject(offline());
  await Promise.all([first, ...repeats]);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(reports).toHaveLength(1);
  expect(receipts()).toHaveLength(1);
  expect(worker.blocksReload()).toBe(false);
});

it("does not merge in-flight drains when new activity arrives", async () => {
  databases.db.prepare("INSERT INTO runs(id,session_id,agent,status) VALUES ('run','session','worker','done')").run();
  let reject!: (error: Error) => void;
  let online = false;
  const delivered: string[] = [];
  const complete = vi.fn(async (_system: string, messages: Array<{ content: string }>) => {
    if (!online) return new Promise<string>((_, fail) => { reject = fail; });
    delivered.push(messages.map(message => message.content).join("\n")); return response;
  });
  const reports: DrainReport[] = [];
  const worker = fixture(complete, {
    onDrainReport: report => reports.push(report),
    org: { ...ORGANISM_DEFAULTS, selfNaming: false, passes: { runMemoryTodo: true, todoMemory: false, learning: false, consolidation: false, reflection: false, insights: false } },
  });
  const opts = snapshot("The same captured conversation.");
  const first = worker.runDrain("session", "before_compact", opts);
  await vi.advanceTimersByTimeAsync(0);
  databases.db.prepare("INSERT INTO run_events(session_id,ts,type,summary) VALUES ('session',1,'tool_result','later activity')").run();
  const second = worker.runDrain("session", "before_compact", opts);
  reject(offline()); await Promise.all([first, second]);
  expect(reports).toHaveLength(2);
  online = true;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(delivered).toHaveLength(2);
  expect(delivered[0]).not.toContain("later activity");
  expect(delivered[1]).toContain("later activity");
});

it("backs off repeated transport failures without appending new receipts", async () => {
  let online = false;
  const complete = vi.fn(async () => { if (!online) throw offline(); return response; });
  const worker = fixture(complete);
  await worker.runDrain("session", "before_compact", snapshot("Keep this for later."));
  for (const [index, delay] of [300_000, 600_000, 1_200_000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(complete).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(complete).toHaveBeenCalledTimes(index + 2);
    expect(receipts()).toHaveLength(1);
  }
  online = true;
  await vi.advanceTimersByTimeAsync(2_400_000);
  expect(worker.getLastDrain()).toMatchObject({ status: "completed", errors: [] });
  expect(receipts()).toHaveLength(2);
});

it("runs only one deferred retry across live workers sharing a database", async () => {
  let online = false;
  let release!: () => void;
  let onlineCalls = 0;
  const complete = vi.fn(async () => {
    if (!online) throw offline();
    onlineCalls++;
    if (onlineCalls === 1) return new Promise<string>(resolve => { release = () => resolve(response); });
    return response;
  });
  const first = fixture(complete);
  await first.runDrain("session", "before_compact", snapshot("Keep a single deferred retry."));
  const second = fixture(complete);
  second.startDeferredDrains();
  online = true;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(onlineCalls).toBe(1);
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(onlineCalls).toBe(2);
  await vi.advanceTimersByTimeAsync(35_000);
  expect(onlineCalls).toBe(2);
  expect(receipts()).toHaveLength(2);
});

it("fences an expired retry owner after another worker finishes the saved input", async () => {
  let online = false;
  let release!: () => void;
  let onlineCalls = 0;
  const complete = vi.fn(async () => {
    if (!online) throw offline();
    onlineCalls++;
    if (onlineCalls === 1) return new Promise<string>(resolve => { release = () => resolve(response); });
    return response;
  });
  const first = fixture(complete);
  await first.runDrain("session", "before_compact", snapshot("Keep a fenced retry."));
  online = true;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(onlineCalls).toBe(1);
  vi.setSystemTime(Date.now() + 36_000);
  const second = fixture(complete); second.startDeferredDrains();
  await vi.advanceTimersByTimeAsync(1);
  expect(onlineCalls).toBe(3);
  expect(receipts()).toHaveLength(2);
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(onlineCalls).toBe(3);
  expect(receipts()).toHaveLength(2);
});

it("restores a deferred captured input in the next live session", async () => {
  let online = false;
  const delivered: string[][] = [];
  const complete = vi.fn(async (_system: string, messages: Array<{ content: string }>) => {
    if (!online) throw offline();
    delivered.push(messages.map(message => message.content)); return response;
  });
  const first = fixture(complete);
  await first.runDrain("session", "before_compact", snapshot("Keep this captured input after a restart."));
  await first.stopSkillReviews();
  const next = fixture(complete);
  const events: Record<string, (...args: any[]) => unknown> = {};
  registerOrganism({}, { on: (name: string, callback: (...args: any[]) => unknown) => { events[name] = callback; } }, () => next);
  expect(events.session_start({}, { sessionManager: { getSessionId: () => "session" } })).toBeUndefined();
  online = true;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(delivered.some(messages => messages.includes("Keep this captured input after a restart."))).toBe(true);
  expect(next.getLastDrain()).toMatchObject({ status: "completed" });
});

it("keeps independent identity failures on the existing per-pass path", async () => {
  const complete = vi.fn(async () => { throw Object.assign(new Error("authentication failed"), { status: 401 }); });
  const worker = fixture(complete);
  await worker.runDrain("session", "before_compact", snapshot("An ordinary captured conversation."));
  await worker.runDrain("session", "before_compact", snapshot("An ordinary captured conversation."));
  expect(complete).toHaveBeenCalledTimes(4);
  expect(receipts()).toHaveLength(2);
  expect(worker.getLastDrain()).toMatchObject({ status: "failed", modelCalls: 2, errors: [{ message: "authentication failed" }, { message: "authentication failed" }] });
  await vi.advanceTimersByTimeAsync(600_000);
  expect(complete).toHaveBeenCalledTimes(4);
});

it("does not hold up compaction while an offline drain is pending", async () => {
  const complete = vi.fn(async () => { throw offline(); });
  const worker = fixture(complete);
  const events: Record<string, (...args: any[]) => unknown> = {};
  registerOrganism({}, { on: (name: string, callback: (...args: any[]) => unknown) => { events[name] = callback; } }, () => worker);
  const ctx = { sessionManager: { getSessionId: () => "session", getBranch: () => [] } };
  expect(events.session_before_compact({ branchEntries: [{ type: "message", message: { role: "user", content: "Keep the context." } }] }, ctx)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(0);
  expect(worker.getLastDrain()).toMatchObject({ status: "failed", modelCalls: 1 });
});
