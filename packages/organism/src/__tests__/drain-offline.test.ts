import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrganismWorker, type WorkerDeps } from "../worker.js";
import { DrainRetryStore } from "../drain-retry.js";
import { drainSession } from "../drain.js";
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

it("defers the remaining passes when the provider is temporarily unavailable", async () => {
  let online = false;
  const complete = vi.fn(async () => { if (!online) throw new Error("Provider temporarily unavailable"); return response; });
  const worker = fixture(complete), input = snapshot("Keep this captured input.");
  await worker.runDrain("session", "before_compact", input);
  await worker.runDrain("session", "before_compact", input);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(receipts()).toHaveLength(1);
  expect(worker.getLastDrain()).toMatchObject({ status: "failed", modelCalls: 0, outage: { occurrences: 2 } });
  online = true; await vi.advanceTimersByTimeAsync(300_000);
  expect(complete).toHaveBeenCalledTimes(3);
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

it("finishes a reflection retry when the embedder stays unavailable and no provider call is needed", async () => {
  const complete = vi.fn(async () => response);
  const store = new DrainRetryStore(databases.db);
  const input = drainSession(databases.db, "session", "before_compact", snapshot("Keep this for reflection."));
  store.failure(input, ["reflection"], "reflection", "fetch failed");
  const worker = fixture(complete, {
    getEmbedder: () => new Promise(() => {}),
    org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: false, consolidation: false, reflection: true, insights: false } },
  });
  worker.startDeferredDrains();
  await vi.advanceTimersByTimeAsync(305_000);
  expect(complete).not.toHaveBeenCalled();
  expect(store.next()).toBeUndefined();
  expect(store.outage()).toBeUndefined();
  expect(worker.getLastDrain()).toMatchObject({ status: "completed", modelCalls: 0 });
});

it("clears a no-model retry and lets other saved inputs run before trying it again", async () => {
  databases.db.prepare("INSERT INTO sessions(id,started_at) VALUES ('other',1)").run();
  const store = new DrainRetryStore(databases.db);
  const first = drainSession(databases.db, "session", "before_compact", snapshot("First saved input."));
  const second = drainSession(databases.db, "other", "before_compact", snapshot("Second saved input."));
  store.failure(first, ["learning"], "learning", "fetch failed");
  vi.setSystemTime(Date.now() + 1);
  store.defer(second, ["learning"]);
  const delivered: string[] = [];
  const complete = vi.fn(async (_system: string, messages: Array<{ content: string }>) => {
    delivered.push(messages.map(message => message.content).join("\n"));
    return response;
  });
  const makeModel = vi.fn().mockReturnValueOnce(null).mockReturnValue({ complete });
  const outagesAfterNoModel: unknown[] = [];
  const worker = fixture(complete, {
    makeModel,
    onDrainReport: report => { if (report.skipReason === "no-model") outagesAfterNoModel.push(store.outage()); },
    org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: true, consolidation: false, reflection: false, insights: false } },
  });
  worker.startDeferredDrains();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain("Second saved input.");
  expect(outagesAfterNoModel).toEqual([undefined]);
  expect(store.outage()).toBeUndefined();
  expect(store.next()?.bundle.sessionId).toBe("session");
  await vi.advanceTimersByTimeAsync(300_000);
  expect(delivered).toHaveLength(2);
  expect(delivered[1]).toContain("First saved input.");
  expect(store.next()).toBeUndefined();
});

it("finishes a retry when its remaining passes short-circuit on missing input", async () => {
  databases.db.prepare("INSERT INTO run_events(session_id,ts,type,summary) VALUES ('session',1,'tool_result','Saved activity')").run();
  const complete = vi.fn(async () => response);
  const store = new DrainRetryStore(databases.db);
  const input = drainSession(databases.db, "session", "before_compact", snapshot(""));
  input.transcript = [];
  store.failure(input, ["todoMemory", "learning", "consolidation"], "learning", "fetch failed");
  const worker = fixture(complete, {
    org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: true, learning: true, consolidation: true, reflection: false, insights: false } },
  });
  worker.startDeferredDrains();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(complete).not.toHaveBeenCalled();
  expect(store.next()).toBeUndefined();
  expect(store.outage()).toBeUndefined();
});

it("lets a fresh drain probe the provider after the outage deadline", async () => {
  databases.db.prepare("INSERT INTO sessions(id,started_at) VALUES ('other',1)").run();
  let online = false;
  const complete = vi.fn(async () => { if (!online) throw offline(); return response; });
  const worker = fixture(complete);
  await worker.runDrain("session", "before_compact", snapshot("Saved before the outage."));
  vi.setSystemTime(Date.now() + 300_000);
  online = true;
  await worker.runDrain("other", "before_compact", snapshot("Fresh input after the retry is due."));
  expect(complete).toHaveBeenCalledTimes(3);
  expect(worker.getLastDrain()).toMatchObject({ sessionId: "other", status: "completed", modelCalls: 2 });
  expect(new DrainRetryStore(databases.db).outage()).toBeUndefined();
});

it("treats the drain deadline as a local failure and permits a later drain", async () => {
  let slow = true;
  let signal: AbortSignal | undefined;
  const complete = vi.fn(async () => slow ? new Promise<string>(() => {}) : response);
  const worker = fixture(complete, { makeModel: s => { signal = s; return { complete }; } });
  const first = worker.runDrain("session", "before_compact", snapshot("A slow local drain."));
  await vi.advanceTimersByTimeAsync(30_000);
  await first;
  expect(signal?.reason).toMatchObject({ name: "OrganismDeadline", message: "organism drain timed out" });
  expect(worker.getLastDrain()).toMatchObject({ status: "failed", modelCalls: 1 });
  const store = new DrainRetryStore(databases.db);
  expect(store.outage()).toBeUndefined();
  expect(store.next()).toBeUndefined();
  slow = false;
  await worker.runDrain("session", "shutdown", snapshot("A later reachable drain."));
  expect(complete).toHaveBeenCalledTimes(3);
  expect(worker.getLastDrain()).toMatchObject({ status: "completed", errors: [] });
});

it("drops a snapshot after eight connectivity retries without spending another snapshot's budget", async () => {
  const complete = vi.fn(async () => { throw offline(); });
  const worker = fixture(complete);
  await worker.runDrain("session", "before_compact", snapshot("First saved input."));
  await worker.runDrain("session", "before_compact", snapshot("Second saved input."));
  const store = new DrainRetryStore(databases.db);
  const delays = [300_000, 600_000, 1_200_000, 2_400_000, 4_800_000, 9_600_000, 19_200_000, 21_600_000];
  for (const [index, delay] of delays.entries()) {
    await vi.advanceTimersByTimeAsync(delay);
    expect(complete).toHaveBeenCalledTimes(index + 2);
    if (index < 7) expect(store.next()?.bundle.transcript[0].content).toBe("First saved input.");
  }
  expect(store.next()?.bundle.transcript[0].content).toBe("Second saved input.");
  expect(JSON.parse(receipts().at(-1)!.payload)).toMatchObject({ sessionId: "session", deferredDropped: 1 });
  await vi.advanceTimersByTimeAsync(21_600_000);
  expect(complete).toHaveBeenCalledTimes(10);
  expect(store.next()?.bundle.transcript[0].content).toBe("Second saved input.");
});

it("merges the same saved input across compaction and shutdown", async () => {
  const complete = vi.fn(async () => { throw offline(); });
  const worker = fixture(complete);
  const input = snapshot("The same captured conversation.");
  await worker.runDrain("session", "before_compact", input);
  await worker.runDrain("session", "shutdown", input);
  const row = databases.db.prepare("SELECT snapshots FROM organism_deferred_drain WHERE session_id='session'").get() as { snapshots: string };
  expect(JSON.parse(row.snapshots)).toHaveLength(1);
  expect(complete).toHaveBeenCalledTimes(1);
});

it("retains the two newest saved inputs per session and records the oldest drop", async () => {
  const complete = vi.fn(async () => { throw offline(); });
  const worker = fixture(complete);
  await worker.runDrain("session", "before_compact", snapshot("First input."));
  vi.setSystemTime(Date.now() + 1);
  await worker.runDrain("session", "before_compact", snapshot("Second input."));
  vi.setSystemTime(Date.now() + 1);
  await worker.runDrain("session", "before_compact", snapshot("Third input."));
  const row = databases.db.prepare("SELECT snapshots FROM organism_deferred_drain WHERE session_id='session'").get() as { snapshots: string };
  const saved = JSON.parse(row.snapshots) as Array<{ bundle: { transcript: Array<{ content: string }> } }>;
  expect(saved.map(item => item.bundle.transcript[0].content)).toEqual(["Second input.", "Third input."]);
  expect(worker.getLastDrain()).toMatchObject({ deferredDropped: 1 });
  const drops = databases.db.prepare("SELECT session_id,payload FROM run_events WHERE summary LIKE 'organism deferred drain dropped%'").all() as Array<{ session_id: string; payload: string }>;
  expect(drops.map(row => ({ sessionId: row.session_id, ...JSON.parse(row.payload) }))).toEqual([
    expect.objectContaining({ sessionId: "session", cause: "session-cap", dropped: 1 }),
  ]);
});

it("keeps at most 64 saved inputs across sessions and records each global drop", () => {
  const store = new DrainRetryStore(databases.db);
  const first = drainSession(databases.db, "session", "before_compact", snapshot("First global input."));
  store.failure(first, ["learning"], "learning", "fetch failed");
  for (let i = 1; i <= 32; i++) {
    const id = `session-${String(i).padStart(2, "0")}`;
    databases.db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,1)").run(id);
    for (const suffix of ["a", "b"]) {
      vi.setSystemTime(Date.now() + 1);
      store.defer(drainSession(databases.db, id, "before_compact", snapshot(`Input ${i}${suffix}.`)), ["learning"]);
    }
  }
  const rows = databases.db.prepare("SELECT snapshots FROM organism_deferred_drain").all() as Array<{ snapshots: string }>;
  expect(rows.reduce((total, row) => total + JSON.parse(row.snapshots).length, 0)).toBe(64);
  expect(store.next()?.bundle.sessionId).toBe("session-01");
  const drops = databases.db.prepare("SELECT session_id,payload FROM run_events WHERE summary LIKE 'organism deferred drain dropped%'").all() as Array<{ session_id: string; payload: string }>;
  expect(drops.map(row => ({ sessionId: row.session_id, ...JSON.parse(row.payload) }))).toEqual([
    expect.objectContaining({ sessionId: "session", cause: "global-cap", dropped: 1 }),
  ]);
});

it.each(["saved", "legacy"])("expires %s snapshots after seven days and records the drop", kind => {
  const store = new DrainRetryStore(databases.db);
  const input = drainSession(databases.db, "session", "before_compact", snapshot("Expiring input."));
  store.failure(input, ["learning"], "learning", "fetch failed");
  if (kind === "legacy") {
    databases.db.prepare("UPDATE organism_deferred_drain SET snapshots=? WHERE session_id='session'").run(JSON.stringify([{ bundle: input, passes: ["learning"] }]));
  }
  vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000 - 1);
  expect(store.next()?.bundle.sessionId).toBe("session");
  vi.setSystemTime(Date.now() + 1);
  expect(store.next()).toBeUndefined();
  const drops = databases.db.prepare("SELECT session_id,payload FROM run_events WHERE summary LIKE 'organism deferred drain dropped%'").all() as Array<{ session_id: string; payload: string }>;
  expect(drops.map(row => ({ sessionId: row.session_id, ...JSON.parse(row.payload) }))).toEqual([
    expect.objectContaining({ sessionId: "session", cause: "age", dropped: 1 }),
  ]);
  expect(drops[0].payload).not.toContain("Expiring input.");
});

it("lets a fresh lifecycle drain run between saved inputs", async () => {
  databases.db.prepare("INSERT INTO sessions(id,started_at) VALUES ('other',1),('fresh',1)").run();
  let online = false;
  let release!: () => void;
  const delivered: string[] = [];
  const complete = vi.fn(async (_system: string, messages: Array<{ content: string }>) => {
    if (!online) throw offline();
    const content = messages[0].content;
    delivered.push(content);
    if (content === "First saved input.") return new Promise<string>(resolve => { release = () => resolve(response); });
    return response;
  });
  const worker = fixture(complete, {
    org: { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: true, consolidation: false, reflection: false, insights: false } },
  });
  await worker.runDrain("session", "before_compact", snapshot("First saved input."));
  vi.setSystemTime(Date.now() + 1);
  await worker.runDrain("other", "before_compact", snapshot("Second saved input."));
  online = true;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(delivered).toEqual(["First saved input."]);
  const fresh = worker.runDrain("fresh", "shutdown", snapshot("Fresh lifecycle input."));
  await vi.advanceTimersByTimeAsync(0);
  expect(delivered).toEqual(["First saved input."]);
  release(); await fresh; await vi.advanceTimersByTimeAsync(0);
  expect(delivered).toEqual(["First saved input.", "Fresh lifecycle input.", "Second saved input."]);
});

it("does not apply an in-flight snapshot evicted by another worker", async () => {
  let online = false;
  let release!: () => void;
  const complete = vi.fn(async () => {
    if (!online) throw offline();
    return new Promise<string>(resolve => { release = () => resolve('{"summary":"Evicted input was applied."}'); });
  });
  const org = { ...ORGANISM_DEFAULTS, passes: { runMemoryTodo: false, todoMemory: false, learning: false, consolidation: true, reflection: false, insights: false } };
  const first = fixture(complete, { org });
  await first.runDrain("session", "before_compact", snapshot("First input."));
  vi.setSystemTime(Date.now() + 1);
  await first.runDrain("session", "before_compact", snapshot("Second input."));
  online = true;
  await vi.advanceTimersByTimeAsync(300_000);
  const other = fixture(async () => { throw offline(); }, { org });
  await other.runDrain("session", "before_compact", snapshot("Third input."));
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(databases.db.prepare("SELECT summary FROM sessions WHERE id='session'").get()).toEqual({ summary: null });
  const row = databases.db.prepare("SELECT snapshots FROM organism_deferred_drain WHERE session_id='session'").get() as { snapshots: string };
  expect((JSON.parse(row.snapshots) as Array<{ bundle: { transcript: Array<{ content: string }> } }>).map(item => item.bundle.transcript[0].content)).toEqual(["Second input.", "Third input."]);
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
