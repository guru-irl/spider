import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { bindSession, openGlobal, openDbAt, paths, setGlobalDbPathForTests, type Db } from "@spider/db-core";
import { recordRunUsage, RunStore, registerShared, releaseShared } from "@spider/subagents";
import { createEventGate } from "../../../subagents/src/rpc-child";
import { teardownAll } from "../../../subagents/src/coordinators";
import { resetSharedRegistryForTests } from "../../../subagents/src/child-registry";
import { UsageAccounting } from "../usage-accounting";
import spiderExtension from "../extension";
import { controlConfig } from "../control";

const projectResolutions = vi.hoisted(() => vi.fn());
vi.mock("@spider/db-core", async original => {
  const actual = await original<typeof import("@spider/db-core")>();
  return { ...actual, resolveProject: (...args: Parameters<typeof actual.resolveProject>) => { projectResolutions(...args); return actual.resolveProject(...args); } };
});
vi.mock("@spider/memory", async original => ({ ...await original<typeof import("@spider/memory")>(), resolveEmbedder: async () => null }));
const fixtureSpawner = vi.hoisted(() => vi.fn((): any => { throw Error("no fixture spawner configured"); }));
vi.mock("../../../subagents/src/spawn-default", () => ({ defaultSpawner: fixtureSpawner }));
const scratch = resolve(".spider/scratch/usage-accounting");
const roots: string[] = [];
const dbs: Db[] = [], stops: Array<() => Promise<void>> = [];
const oldRoot = paths.globalRoot;
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); teardownAll(); resetSharedRegistryForTests(); for (const db of dbs.splice(0)) if (db.raw.open) db.close(); paths.globalRoot = oldRoot; setGlobalDbPathForTests(null); vi.restoreAllMocks(); fixtureSpawner.mockReset(); fixtureSpawner.mockImplementation(() => { throw Error("no fixture spawner configured"); }); vi.unstubAllEnvs(); for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true }); });
const usage = { input: 10, output: 3, cacheRead: 5, cacheWrite: 2, totalTokens: 20, cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 } };
const remember = { action: "remember", category: "convention", content: "Verify generated metadata before release.", justification: "A durable project rule that future agents can reuse in this repo." };
function root() {
  mkdirSync(scratch, { recursive: true }); const cwd = mkdtempSync(join(scratch, "fixture-"));
  roots.push(cwd); vi.stubEnv("GIT_CEILING_DIRECTORIES", scratch); paths.globalRoot = join(cwd, "global"); setGlobalDbPathForTests(join(cwd, "global", "spider.db"));
  controlConfig("set", cwd, "organism.enabled", false); return cwd;
}
function setup(cwd: string, fallback = false, response?: () => Promise<any>, priorSession?: SessionManager) {
  const session = priorSession ?? SessionManager.inMemory(cwd), handlers = new Map<string, Array<(...a: any[]) => any>>(); let tool: any;
  const ctx: any = { cwd, hasUI: false, sessionManager: fallback ? { getSessionId: () => session.getSessionId(), getEntries: () => session.getEntries(), getBranch: () => session.getBranch() } : session,
    modelRegistry: { find: () => ({ reasoning: false }), streamSimple: (_model: any, context: any) => ({ result: response ?? (async () => ({ role: "assistant", provider: "fixture", model: "requested", responseModel: "actual", api: "openai-responses", timestamp: 1, stopReason: "stop", usage,
      content: [{ type: "text", text: context.systemPrompt.startsWith("Review a skill candidate.") ? '{"verdict":"new","reason":"reusable"}' : '{"verdict":"new","reason":"durable"}' }] })) }) } };
  spiderExtension({ registerTool(t: any) { if (t.name === "spider") tool = t; }, registerCommand() {},
    on(name: string, fn: any) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); return () => {}; }, appendEntry() {}, sendMessage() {} } as any);
  const emit = async (name: string, event: any = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
  let stopped = false; const stop = async (reason = "quit") => { if (!stopped) { stopped = true; await emit("session_shutdown", { reason }); } }; stops.push(stop);
  return { session, ctx, emit, stop, execute: (args: any) => tool.execute("fixture", args, undefined, undefined, ctx) };
}
const entries = (session: SessionManager) => session.getEntries().filter(e => e.type === "usage");

it("retries a partially appended run without writing an already reported model twice", () => {
  const cwd = root(), db = openDbAt(join(cwd, "retry.db"), "project"); dbs.push(db);
  const session = SessionManager.inMemory(cwd), accounting = new UsageAccounting(); accounting.activate({ sessionManager: session });
  const runs = new RunStore(db), { id } = runs.create({ sessionId: session.getSessionId(), agent: "worker" });
  for (const model of ["one", "two"]) recordRunUsage(db, id, { provider: "fixture", model, usage });
  runs.finish(id, { status: "done" });
  const append = session.appendUsage.bind(session); let reject = true;
  vi.spyOn(session, "appendUsage").mockImplementation((kind, provider, model, data, note) => {
    if (model === "two" && reject) { reject = false; throw Error("fixture append failure"); }
    return append(kind, provider, model, data, note);
  });
  expect(() => accounting.reportRun(db, runs.get(id)!)).toThrow("fixture append failure");
  accounting.reportRun(db, runs.get(id)!);
  expect(entries(session).map(e => e.model)).toEqual(["one", "two"]);
  expect(db.prepare("SELECT COUNT(*) n FROM run_events WHERE type='spider_usage_reported'").get()).toEqual({ n: 1 });
});

it("does not revive a captured auxiliary sink when the same session reactivates after shutdown", () => {
  const accounting = new UsageAccounting(), session = SessionManager.inMemory(process.cwd());
  accounting.activate({ sessionManager: session });
  const sink = accounting.factory(session.getSessionId())("learner")!;
  accounting.shutdown(); accounting.activate({ sessionManager: session });
  sink({ provider: "fixture", model: "actual", usage });
  expect(entries(session)).toEqual([]);
});

it("defers fallback reporting until an optimistically cancelled child's owned handle is released", () => {
  const cwd = root(), db = openDbAt(join(cwd, "partial.db"), "project"); dbs.push(db);
  const accounting = new UsageAccounting(), session = SessionManager.inMemory(cwd), sessionId = session.getSessionId();
  accounting.activate({ sessionManager: { getSessionId: () => sessionId } });
  const runs = new RunStore(db), { id } = runs.create({ sessionId, agent: "worker" });
  registerShared({ runId: id, sessionId, dbPath: join(cwd, "partial.db"), mode: "rpc", survivable: true,
    handle: { wait: () => new Promise(() => {}), kill() {} } });
  try {
    recordRunUsage(db, id, { provider: "fixture", model: "actual", usage }); runs.cancel(id);
    expect(accounting.takeFallback(db, sessionId)).toBeUndefined();
    recordRunUsage(db, id, { provider: "fixture", model: "actual", usage }); releaseShared(id);
    expect(accounting.takeFallback(db, sessionId)?.totalTokens).toBe(40);
  } finally { releaseShared(id); }
});

// Break: a reviewer call site forgets the host sink or uses the requested instead of response model.
it("appends parent memory and skill review calls as spider-aux with their purposes", async () => {
  const cwd = root(), f = setup(cwd); await f.emit("session_start");
  await f.execute(remember);
  await f.execute({ action: "skill", op: "add", name: "fixture-skill", text: "---\nname: fixture-skill\ndescription: Use when generated metadata needs validation\n---\nValidate metadata before release." });
  expect(entries(f.session).map(e => ({ kind: e.kind, provider: e.provider, model: e.model, usage: e.usage, note: e.note }))).toEqual([
    { kind: "spider-aux", provider: "fixture", model: "actual", usage, note: "memory-review" },
    { kind: "spider-aux", provider: "fixture", model: "actual", usage, note: "skill-review" },
  ]);
});

it.each(["switch", "shutdown"])("skips an in-flight parent call after a session %s", async boundary => {
  const cwd = root(); let finish!: (answer: any) => void;
  const f = setup(cwd, false, () => new Promise(resolve => { finish = resolve; })); await f.emit("session_start");
  const pending = f.execute(remember);
  expect(finish).toBeTypeOf("function");
  if (boundary === "switch") { f.session.newSession(); await f.emit("session_start"); } else await f.stop();
  finish({ provider: "fixture", model: "actual", stopReason: "stop", usage, content: [{ type: "text", text: '{"verdict":"new","reason":"durable"}' }] });
  await pending;
  expect(entries(f.session)).toEqual([]);
});

it("attaches fallback usage only to the next spider result in its own session and drains it once", async () => {
  const cwd = root(), f = setup(cwd, true); await f.emit("session_start");
  const result = await f.execute(remember);
  expect(result.usage).toEqual(usage); expect(entries(f.session)).toEqual([]);
  expect((await f.execute({ action: "todo", op: "list" })).usage).toBeUndefined();
});

// Break: restoring a terminal row double reports, reports into a foreign session, or drops partial cancellation.
it("restores terminal run usage once, leaving foreign session runs unreported", async () => {
  const cwd = root(), f = setup(cwd), db = openDbAt(join(cwd, ".spider", "project.db"), "project"); dbs.push(db);
  const store = new RunStore(db);
  for (const sessionId of [f.session.getSessionId(), "foreign"]) {
    const row = store.create({ sessionId, agent: "worker", name: "fixture-run" });
    recordRunUsage(db, row.id, { provider: "fixture", model: "actual", usage }); store.finish(row.id, { status: "cancelled" });
  }
  await f.emit("session_start"); await f.emit("session_start", { reason: "reload" });
  expect(entries(f.session).map(e => ({ kind: e.kind, usage: e.usage, note: e.note }))).toEqual([
    { kind: "subagent", usage, note: expect.stringMatching(/^fixture-run \(.+\)$/) },
  ]);
  expect(db.prepare("SELECT session_id FROM run_events WHERE type='spider_usage_reported'").all()).toEqual([{ session_id: f.session.getSessionId() }]);
});

it("restores subagent usage through the tool-result fallback without duplicate reporting", async () => {
  const cwd = root(), f = setup(cwd, true), db = openDbAt(join(cwd, ".spider", "project.db"), "project"); dbs.push(db);
  const store = new RunStore(db), row = store.create({ sessionId: f.session.getSessionId(), agent: "worker" });
  recordRunUsage(db, row.id, { provider: "fixture", model: "actual", usage }); store.finish(row.id, { status: "done" });
  await f.emit("session_start");
  expect(db.prepare("SELECT COUNT(*) n FROM run_events WHERE type='spider_usage_reported'").get()).toEqual({ n: 0 });
  expect((await f.execute({ action: "todo", op: "list" })).usage).toEqual(usage);
  expect((await f.execute({ action: "todo", op: "list" })).usage).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) n FROM run_events WHERE type='spider_usage_reported'").get()).toEqual({ n: 1 });
});

it("records a child's memory reviewer usage in the dispatcher's DB for the parent total", async () => {
  const cwd = root(), db = openDbAt(join(cwd, "dispatcher.db"), "project"); dbs.push(db);
  const store = new RunStore(db), row = store.create({ sessionId: "parent", agent: "worker" });
  recordRunUsage(db, row.id, { provider: "fixture", model: "actual", usage }); // The child's assistant turn.
  vi.stubEnv("PI_SUBAGENT_CHILD", "1"); vi.stubEnv("PI_SUBAGENT_RUN_ID", row.id); vi.stubEnv("PI_SPIDER_DB_PATH", join(cwd, "dispatcher.db")); vi.stubEnv("PI_SPIDER_SESSION_ID", "parent");
  const f = setup(cwd); await f.emit("session_start"); await f.execute(remember);
  expect(store.get(row.id)?.token_count).toBe(40);
  expect(db.prepare("SELECT session_id, payload FROM run_events WHERE type='spider_usage' ORDER BY id").all()).toEqual([
    { session_id: "parent", payload: JSON.stringify({ type: "spider_usage", provider: "fixture", model: "actual", usage }) },
    { session_id: "parent", payload: JSON.stringify({ type: "spider_usage", provider: "fixture", model: "actual", usage, purpose: "memory-review" }) },
  ]);
  expect(entries(f.session)).toEqual([]); // Never double-account in the child session.
  await f.stop();
  const parent = SessionManager.inMemory(cwd, { id: "parent" }), accounting = new UsageAccounting(); accounting.activate({ sessionManager: parent });
  accounting.reportRun(db, store.get(row.id)!);
  expect(entries(parent)).toContainEqual(expect.objectContaining({ kind: "subagent", model: "actual", usage: expect.objectContaining({ totalTokens: 40, cost: expect.objectContaining({ total: 0.74 }) }) }));
});

it("does not scan post-result run usage inside a child", async () => {
  const cwd = root(); vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  const f = setup(cwd); await f.emit("session_start");
  const scan = vi.spyOn(UsageAccounting.prototype, "takeFallback");
  const result = await f.execute({ action: "todo", op: "list" });
  expect(result.details).toBeDefined();
  expect(scan).not.toHaveBeenCalled();
});

// P5: accounting must not replace doctor's completed result or break session startup.
it.each(["tool", "start"])("keeps accounting best effort with a corrupt project DB at %s", async boundary => {
  const cwd = root(), f = setup(cwd);
  writeFileSync(join(cwd, ".spider", "project.db"), "not a database");
  if (boundary === "start") await expect(f.emit("session_start")).resolves.toBeUndefined();
  else {
    const result = await f.execute({ action: "control", command: "doctor" });
    expect(result.details).toMatchObject({ ok: false });
    expect(JSON.stringify(result.content)).toContain("database");
  }
});

// P4/M1: querying/reporting another owner's row must neither append nor mark it.
it.each([false, true])("defers A's finished run while B is active, then reports A exactly once (fallback=%s)", fallback => {
  const cwd = root(), db = openDbAt(join(cwd, "guard.db"), "project"); dbs.push(db);
  const a = SessionManager.inMemory(cwd, { id: "owner-a" }), b = SessionManager.inMemory(cwd, { id: "owner-b" });
  const accounting = new UsageAccounting(), store = new RunStore(db), row = store.create({ sessionId: "owner-a", agent: "worker" });
  recordRunUsage(db, row.id, { provider: "fixture", model: "actual", usage }); store.finish(row.id, { status: "done" });
  const manager = (s: SessionManager) => fallback ? { getSessionId: () => s.getSessionId() } : s;
  accounting.activate({ sessionManager: manager(b) });
  accounting.reportRun(db, store.get(row.id)!);
  expect(accounting.takeFallback(db, "owner-a")).toBeUndefined();
  expect(accounting.takeFallback(db, "owner-b")).toBeUndefined();
  expect(entries(b)).toEqual([]);
  expect(db.prepare("SELECT COUNT(*) n FROM run_events WHERE type='spider_usage_reported'").get()).toEqual({ n: 0 });
  accounting.activate({ sessionManager: manager(a) });
  accounting.reportRun(db, store.get(row.id)!);
  expect(accounting.takeFallback(db, "owner-a")?.totalTokens).toBe(fallback ? 20 : undefined);
  accounting.reportRun(db, store.get(row.id)!);
  expect(accounting.takeFallback(db, "owner-a")).toBeUndefined();
  expect(entries(a)).toHaveLength(fallback ? 0 : 1);
  expect(db.prepare("SELECT COUNT(*) n FROM run_events WHERE type='spider_usage_reported'").get()).toEqual({ n: 1 });
});

// M8: restore must not mark an optimistic cancellation before late pipe usage arrives.
it("waits for the live shared handle before restoring terminal usage", () => {
  const cwd = root(), dbPath = join(cwd, "live.db"), db = openDbAt(dbPath, "project"); dbs.push(db);
  const session = SessionManager.inMemory(cwd), sessionId = session.getSessionId(), accounting = new UsageAccounting();
  accounting.activate({ sessionManager: session });
  const store = new RunStore(db), row = store.create({ sessionId, agent: "worker" });
  registerShared({ runId: row.id, sessionId, dbPath, mode: "rpc", survivable: true, handle: { wait: () => new Promise(() => {}), kill() {} } });
  try {
    recordRunUsage(db, row.id, { provider: "fixture", model: "actual", usage }); store.cancel(row.id);
    accounting.restore(db, sessionId);
    expect(entries(session)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) n FROM run_events WHERE type='spider_usage_reported'").get()).toEqual({ n: 0 });
    recordRunUsage(db, row.id, { provider: "fixture", model: "actual", usage }); releaseShared(row.id);
    accounting.restore(db, sessionId);
    expect(entries(session)).toContainEqual(expect.objectContaining({ usage: expect.objectContaining({ totalTokens: 40 }) }));
  } finally { releaseShared(row.id); }
});

// M12/M13: an inherited child identity cannot write another process/owner's run.
it.each(["pid", "owner"])("rejects child auxiliary usage with a mismatched %s", mismatch => {
  const cwd = root(), dbPath = join(cwd, "child-guard.db"), db = openDbAt(dbPath, "project"); dbs.push(db);
  const store = new RunStore(db), row = store.create({ sessionId: "parent", agent: "worker" });
  store.setPid(row.id, mismatch === "pid" ? process.pid + 100000 : process.pid, process.pid);
  vi.stubEnv("PI_SUBAGENT_CHILD", "1"); vi.stubEnv("PI_SUBAGENT_RUN_ID", row.id); vi.stubEnv("PI_SPIDER_DB_PATH", dbPath); vi.stubEnv("PI_SPIDER_SESSION_ID", mismatch === "owner" ? "foreign" : "parent");
  const session = SessionManager.inMemory(cwd), accounting = new UsageAccounting(); accounting.activate({ sessionManager: session });
  accounting.factory(session.getSessionId())("memory-review")!({ provider: "fixture", model: "actual", usage });
  expect(store.get(row.id)?.token_count).toBe(0);
  expect(db.prepare("SELECT COUNT(*) n FROM run_events WHERE type='spider_usage'").get()).toEqual({ n: 0 });
  expect(entries(session)).toEqual([]);
});

it("keeps earlier fallback usage when a later run's marker insert fails", () => {
  const cwd = root(), db = openDbAt(join(cwd, "two-run.db"), "project"); dbs.push(db);
  const accounting = new UsageAccounting(), sessionId = "two-run-owner";
  accounting.activate({ sessionManager: { getSessionId: () => sessionId } });
  const store = new RunStore(db);
  for (let i = 0; i < 2; i++) {
    const row = store.create({ sessionId, agent: "worker" });
    recordRunUsage(db, row.id, { provider: "fixture", model: "actual", usage: { ...usage, totalTokens: 13 } });
    store.finish(row.id, { status: "done" });
  }
  const prepare = db.prepare.bind(db); let inserts = 0;
  const spy = vi.spyOn(db, "prepare").mockImplementation(sql => {
    if (sql.includes("INSERT INTO run_events (run_id, session_id, ts, type)") && ++inserts === 2) throw Error("SQLITE_IOERR fixture");
    return prepare(sql);
  });
  let first = 0;
  try { first = accounting.takeFallback(db, sessionId)?.totalTokens ?? 0; } catch { /* emulate the extension's best-effort boundary */ }
  spy.mockRestore();
  const second = accounting.takeFallback(db, sessionId)?.totalTokens ?? 0;
  expect(first + second).toBe(26);
  expect(db.prepare("SELECT COUNT(*) n FROM run_events WHERE type='spider_usage_reported'").get()).toEqual({ n: 2 });
  expect(accounting.takeFallback(db, sessionId)).toBeUndefined();
});

// Break: legacy-only backlogs enter a full-scan reporting transaction for every run.
it.each(["restore", "fallback"] as const)("bulk marks legacy terminal runs in at most one %s reporting transaction", mode => {
  const cwd = root(), db = openDbAt(join(cwd, "legacy.db"), "project"); dbs.push(db);
  const session = SessionManager.inMemory(cwd), sessionId = session.getSessionId(), accounting = new UsageAccounting();
  accounting.activate({ sessionManager: mode === "restore" ? session : { getSessionId: () => sessionId } });
  const store = new RunStore(db), ids: string[] = [];
  for (let i = 0; i < 7; i++) {
    const { id } = store.create({ sessionId, agent: "worker" }); ids.push(id);
    store.finish(id, { status: ["done", "failed", "cancelled"][i % 3] as "done" | "failed" | "cancelled" });
  }
  // Neither running nor foreign-session runs may be bulk marked.
  const running = store.create({ sessionId, agent: "worker" }); store.start(running.id);
  const foreign = store.create({ sessionId: "foreign", agent: "worker" }); store.finish(foreign.id, { status: "done" });
  const transactions = vi.spyOn(db, "transaction");
  if (mode === "restore") accounting.restore(db, sessionId);
  else expect(accounting.takeFallback(db, sessionId)).toBeUndefined();
  expect(db.prepare("SELECT run_id FROM run_events WHERE type='spider_usage_reported' ORDER BY run_id").all()).toEqual(ids.sort().map(run_id => ({ run_id })));
  expect(entries(session)).toEqual([]);
  expect(transactions.mock.calls.length).toBeLessThanOrEqual(1);
  transactions.mockClear();
  if (mode === "restore") accounting.restore(db, sessionId);
  else expect(accounting.takeFallback(db, sessionId)).toBeUndefined();
  expect(transactions).not.toHaveBeenCalled();
});

// Break: a legacy classification goes stale when another connection writes usage before the bulk transaction.
it.each(["restore", "fallback"] as const)("reports usage arriving before the bulk %s transaction exactly once", mode => {
  const cwd = root(), dbPath = join(cwd, "bulk-usage-race.db"), db = openDbAt(dbPath, "project"), writer = openDbAt(dbPath, "project"); dbs.push(db, writer);
  const session = SessionManager.inMemory(cwd), sessionId = session.getSessionId(), accounting = new UsageAccounting();
  accounting.activate({ sessionManager: mode === "restore" ? session : { getSessionId: () => sessionId } });
  const store = new RunStore(db), { id } = store.create({ sessionId, agent: "worker" }); store.finish(id, { status: "done" });
  const transaction = db.transaction.bind(db); let first = true;
  vi.spyOn(db, "transaction").mockImplementation(fn => {
    if (first) { first = false; recordRunUsage(writer, id, { provider: "fixture", model: "actual", usage }); }
    return transaction(fn);
  });
  if (mode === "restore") { accounting.restore(db, sessionId); expect(entries(session)).toEqual([]); }
  else expect(accounting.takeFallback(db, sessionId)).toBeUndefined();
  expect(db.prepare("SELECT run_id FROM run_events WHERE type='spider_usage_reported'").all()).toEqual([]);
  if (mode === "restore") {
    accounting.restore(db, sessionId);
    expect(entries(session)).toEqual([expect.objectContaining({ kind: "subagent", model: "actual", usage })]);
    accounting.restore(db, sessionId);
    expect(entries(session)).toHaveLength(1);
  } else {
    expect(accounting.takeFallback(db, sessionId)).toEqual(usage);
    expect(accounting.takeFallback(db, sessionId)).toBeUndefined();
    expect(entries(session)).toEqual([]);
  }
  expect(db.prepare("SELECT run_id FROM run_events WHERE type='spider_usage_reported'").all()).toEqual([{ run_id: id }]);
});

// Break: two hosts classify the same legacy rows before either host's bulk marking commits.
it.each(["restore", "fallback"] as const)("writes one marker per legacy run across competing bulk %s passes", mode => {
  const cwd = root(), dbPath = join(cwd, "bulk-host-race.db"), db = openDbAt(dbPath, "project"), otherDb = openDbAt(dbPath, "project"); dbs.push(db, otherDb);
  const session = SessionManager.inMemory(cwd), sessionId = session.getSessionId(), accounting = new UsageAccounting(), other = new UsageAccounting();
  const manager = mode === "restore" ? session : { getSessionId: () => sessionId };
  accounting.activate({ sessionManager: manager }); other.activate({ sessionManager: manager });
  const store = new RunStore(db), ids: string[] = [];
  for (let i = 0; i < 3; i++) { const { id } = store.create({ sessionId, agent: "worker" }); ids.push(id); store.finish(id, { status: "done" }); }
  db.prepare("INSERT INTO run_events (run_id, session_id, ts, type) VALUES (NULL, ?, ?, 'spider_usage_reported')").run(sessionId, Date.now());
  const pass = (host: UsageAccounting, connection: Db) => {
    if (mode === "restore") host.restore(connection, sessionId);
    else expect(host.takeFallback(connection, sessionId)).toBeUndefined();
  };
  const transaction = db.transaction.bind(db); let first = true;
  vi.spyOn(db, "transaction").mockImplementation(fn => {
    if (first) { first = false; pass(other, otherDb); }
    return transaction(fn);
  });
  pass(accounting, db); pass(other, otherDb); pass(accounting, db);
  expect(db.prepare("SELECT run_id, COUNT(*) n FROM run_events WHERE type='spider_usage_reported' AND run_id IS NOT NULL GROUP BY run_id ORDER BY run_id").all()).toEqual(ids.sort().map(run_id => ({ run_id, n: 1 })));
  expect(entries(session)).toEqual([]);
});

// Break: a mixed backlog still sends legacy rows through per-run reporting or loses real usage.
it.each(["restore", "fallback"] as const)("bulk marks legacy rows and reports usage rows once during %s", mode => {
  const cwd = root(), db = openDbAt(join(cwd, "mixed.db"), "project"); dbs.push(db);
  const session = SessionManager.inMemory(cwd), sessionId = session.getSessionId(), accounting = new UsageAccounting();
  accounting.activate({ sessionManager: mode === "restore" ? session : { getSessionId: () => sessionId } });
  const store = new RunStore(db), ids: string[] = [], usageIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const { id } = store.create({ sessionId, agent: "worker" }); ids.push(id);
    if (i % 3 === 0) { usageIds.push(id); recordRunUsage(db, id, { provider: "fixture", model: "actual", usage }); }
    store.finish(id, { status: "done" });
  }
  const transactions = vi.spyOn(db, "transaction");
  if (mode === "restore") {
    accounting.restore(db, sessionId);
    expect(entries(session).map(e => ({ usage: e.usage, note: e.note }))).toEqual(usageIds.map(id => ({ usage, note: `worker (${id})` })));
  } else expect(accounting.takeFallback(db, sessionId)?.totalTokens).toBe(40);
  expect(db.prepare("SELECT run_id FROM run_events WHERE type='spider_usage_reported' ORDER BY run_id").all()).toEqual(ids.sort().map(run_id => ({ run_id })));
  expect(transactions).toHaveBeenCalledTimes(3); // one bulk transaction plus two priced runs
  transactions.mockClear();
  if (mode === "restore") { accounting.restore(db, sessionId); expect(entries(session)).toHaveLength(2); }
  else expect(accounting.takeFallback(db, sessionId)).toBeUndefined();
  expect(transactions).not.toHaveBeenCalled();
});

// Break: bulk marking races an optimistically cancelled live child before its first usage arrives.
it.each(["restore", "fallback"] as const)("does not bulk mark a live-handle legacy terminal run during %s", mode => {
  const cwd = root(), dbPath = join(cwd, "live-legacy.db"), db = openDbAt(dbPath, "project"); dbs.push(db);
  const session = SessionManager.inMemory(cwd), sessionId = session.getSessionId(), accounting = new UsageAccounting();
  accounting.activate({ sessionManager: mode === "restore" ? session : { getSessionId: () => sessionId } });
  const store = new RunStore(db), { id } = store.create({ sessionId, agent: "worker" });
  registerShared({ runId: id, sessionId, dbPath, mode: "rpc", survivable: true, handle: { wait: () => new Promise(() => {}), kill() {} } });
  try {
    store.cancel(id);
    if (mode === "restore") accounting.restore(db, sessionId);
    else expect(accounting.takeFallback(db, sessionId)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) n FROM run_events WHERE type='spider_usage_reported'").get()).toEqual({ n: 0 });
    recordRunUsage(db, id, { provider: "fixture", model: "actual", usage }); releaseShared(id);
    if (mode === "restore") { accounting.restore(db, sessionId); expect(entries(session)).toEqual([expect.objectContaining({ usage })]); }
    else expect(accounting.takeFallback(db, sessionId)).toEqual(usage);
    expect(db.prepare("SELECT COUNT(*) n FROM run_events WHERE type='spider_usage_reported'").get()).toEqual({ n: 1 });
  } finally { releaseShared(id); }
});

// Break: restore retries every marked row, taking write locks on every session activation.
it("does not enter reporting transactions on a second restore with all rows marked", () => {
  const cwd = root(), db = openDbAt(join(cwd, "restore-once.db"), "project"); dbs.push(db);
  const session = SessionManager.inMemory(cwd), sessionId = session.getSessionId(), accounting = new UsageAccounting();
  accounting.activate({ sessionManager: session });
  const store = new RunStore(db);
  for (let i = 0; i < 5; i++) {
    const { id } = store.create({ sessionId, agent: "worker" });
    recordRunUsage(db, id, { provider: "fixture", model: "actual", usage }); store.finish(id, { status: "done" });
  }
  accounting.restore(db, sessionId);
  const prepares = vi.spyOn(db, "prepare");
  accounting.restore(db, sessionId);
  expect(prepares.mock.calls.filter(([sql]) => sql.includes("INSERT INTO run_events"))).toHaveLength(0);
  expect(entries(session)).toHaveLength(5);
});

// Break: hosts without appendUsage retry refused reporting transactions at each start.
it("returns from restore without querying when appendUsage is absent", () => {
  const cwd = root(), db = openDbAt(join(cwd, "restore-fallback.db"), "project"); dbs.push(db);
  const sessionId = "restore-fallback", accounting = new UsageAccounting();
  accounting.activate({ sessionManager: { getSessionId: () => sessionId } });
  const store = new RunStore(db), { id } = store.create({ sessionId, agent: "worker" });
  recordRunUsage(db, id, { provider: "fixture", model: "actual", usage }); store.finish(id, { status: "done" });
  const prepares = vi.spyOn(db, "prepare");
  accounting.restore(db, sessionId);
  expect(prepares).not.toHaveBeenCalled();
  expect(accounting.takeFallback(db, sessionId)).toEqual(usage);
  expect(accounting.takeFallback(db, sessionId)).toBeUndefined();
});

// Break: NOT IN becomes unknown for every run if a NULL marker is not filtered out.
it.each(["fallback", "restore"] as const)("ignores a NULL run_id marker during %s reporting", mode => {
  const cwd = root(), db = openDbAt(join(cwd, "null-marker.db"), "project"); dbs.push(db);
  const session = SessionManager.inMemory(cwd), sessionId = session.getSessionId(), accounting = new UsageAccounting();
  accounting.activate({ sessionManager: mode === "restore" ? session : { getSessionId: () => sessionId } });
  const store = new RunStore(db), { id } = store.create({ sessionId, agent: "worker" });
  recordRunUsage(db, id, { provider: "fixture", model: "actual", usage }); store.finish(id, { status: "done" });
  db.prepare("INSERT INTO run_events (run_id, session_id, ts, type) VALUES (NULL, ?, ?, 'spider_usage_reported')").run(sessionId, Date.now());
  if (mode === "restore") {
    accounting.restore(db, sessionId);
    expect(entries(session)).toEqual([expect.objectContaining({ kind: "subagent", usage })]);
    accounting.restore(db, sessionId);
    expect(entries(session)).toHaveLength(1);
  } else {
    expect(accounting.takeFallback(db, sessionId)).toEqual(usage);
    expect(accounting.takeFallback(db, sessionId)).toBeUndefined();
  }
  expect(db.prepare("SELECT run_id FROM run_events WHERE type='spider_usage_reported' AND run_id IS NOT NULL").all()).toEqual([{ run_id: id }]);
});

it("uses a non-correlated query to find unreported terminal runs", () => {
  const cwd = root(), db = openDbAt(join(cwd, "plan.db"), "project"); dbs.push(db);
  const session = SessionManager.inMemory(cwd), accounting = new UsageAccounting(); accounting.activate({ sessionManager: session });
  const prepare = db.prepare.bind(db); let query = "";
  vi.spyOn(db, "prepare").mockImplementation(sql => { if (sql.includes("SELECT id, session_id, status, name, agent")) query = sql; return prepare(sql); });
  accounting.takeFallback(db, session.getSessionId());
  expect(query).not.toBe("");
  const plan = db.raw.prepare("EXPLAIN QUERY PLAN " + query).all(session.getSessionId()) as Array<{ detail: string }>;
  expect(plan.map(row => row.detail).join(" | ")).not.toContain("CORRELATED");
});

it.each(["todo", "run"])("resolves the project only once per %s call after session activation", async action => {
  const cwd = root(), f = setup(cwd); await f.emit("session_start");
  let finish!: (result: { exitCode: number; result: string }) => void;
  if (action === "run") fixtureSpawner.mockImplementationOnce(() => ({ wait: () => new Promise(resolve => { finish = resolve; }), kill() {}, detach() {} }));
  projectResolutions.mockClear();
  await f.execute(action === "todo" ? { action, op: "list" } : { action, agent: "worker", model: "fixture/requested", task: "fixture", context: "fresh" });
  expect(projectResolutions).toHaveBeenCalledTimes(1);
  if (finish) { finish({ exitCode: 0, result: "fixture" }); await new Promise<void>(resolve => setImmediate(resolve)); }
});

// Break: a prior call's project overrides a new session binding for explicit-cwd runs.
it.each(["todo", "run"])("records an explicit-cwd run in the newly bound project after warming with %s", async warm => {
  const cwd = root(), f = setup(cwd); await f.emit("session_start");
  if (warm === "run") {
    fixtureSpawner.mockImplementationOnce(() => ({ wait: async () => ({ exitCode: 0, result: "fixture" }), kill() {}, detach() {} }));
    await f.execute({ action: "run", agent: "worker", model: "fixture/requested", task: "fixture", context: "fresh" });
    await new Promise<void>(resolve => setImmediate(resolve));
  } else await f.execute({ action: "todo", op: "list" });
  const target = join(cwd, "target"), bound = join(cwd, "bound"); mkdirSync(target); mkdirSync(bound);
  const global = openGlobal();
  try { bindSession(global, f.session.getSessionId(), bound); } finally { global.close(); }
  fixtureSpawner.mockImplementationOnce(() => ({ wait: async () => ({ exitCode: 0, result: "fixture" }), kill() {}, detach() {} }));
  const result = await f.execute({ action: "run", cwd: target, agent: "worker", model: "fixture/requested", task: "fixture", context: "fresh" });
  await new Promise<void>(resolve => setImmediate(resolve));
  const db = openDbAt(join(bound, ".spider", "project.db"), "project"); dbs.push(db);
  expect(new RunStore(db).get(result.details.run.id)?.session_id).toBe(f.session.getSessionId());
  const old = openDbAt(join(cwd, ".spider", "project.db"), "project"); dbs.push(old);
  expect(new RunStore(old).get(result.details.run.id)).toBeUndefined();
});

// Break H2: explicit-cwd dispatch hands the target project to session post-result accounting.
it("attaches session usage on an explicit-cwd fallback exec without recreating target state", async () => {
  const cwd = root(), target = join(cwd, "target"); mkdirSync(target);
  const f = setup(cwd, true); await f.emit("session_start");
  const db = openDbAt(join(cwd, ".spider", "project.db"), "project"); dbs.push(db);
  const store = new RunStore(db), { id } = store.create({ sessionId: f.session.getSessionId(), agent: "worker" });
  recordRunUsage(db, id, { provider: "fixture", model: "actual", usage }); store.finish(id, { status: "done" });
  // Dispatch opens the target DB before exec. Remove that fixture state to isolate
  // whether the post-result scan incorrectly opens it again rather than the session DB.
  const result = await f.execute({ action: "exec", cwd: target, language: "shell", code: `rm -rf '${join(target, ".spider")}'; echo fixture` });
  expect(result.content[0].text).toContain("fixture");
  expect(result.usage).toEqual(usage);
  expect(existsSync(join(target, ".spider"))).toBe(false);
  expect(db.prepare("SELECT run_id FROM run_events WHERE type='spider_usage_reported'").all()).toEqual([{ run_id: id }]);
  expect((await f.execute({ action: "todo", op: "list" })).usage).toBeUndefined();
});

// Break H5/H5b: session_start uses an earlier call's project instead of a fresh binding.
it("restores from the bound DB on session_start after a non-explicit call", async () => {
  const cwd = root(), bound = join(cwd, "bound"); mkdirSync(bound);
  const f = setup(cwd); await f.emit("session_start"); await f.execute({ action: "todo", op: "list" });
  const global = openGlobal();
  try { bindSession(global, f.session.getSessionId(), bound); } finally { global.close(); }
  const db = openDbAt(join(bound, ".spider", "project.db"), "project"); dbs.push(db);
  const store = new RunStore(db), { id } = store.create({ sessionId: f.session.getSessionId(), agent: "worker", name: "bound-run" });
  recordRunUsage(db, id, { provider: "fixture", model: "actual", usage }); store.finish(id, { status: "done" });
  await f.emit("session_start", { reason: "reload" });
  expect(entries(f.session)).toEqual([expect.objectContaining({ kind: "subagent", usage, note: `bound-run (${id})` })]);
  await f.emit("session_start", { reason: "reload" });
  expect(entries(f.session)).toHaveLength(1);
  expect(db.prepare("SELECT run_id FROM run_events WHERE type='spider_usage_reported'").all()).toEqual([{ run_id: id }]);
});

// Break: a warmed project bypasses fresh resolution and recreates a removed session cwd.
it("rejects an explicit-cwd run after the warmed session cwd is deleted", async () => {
  const cwd = root(), gone = join(cwd, "gone"), target = join(cwd, "target"); mkdirSync(gone); mkdirSync(target);
  controlConfig("set", gone, "organism.enabled", false);
  const f = setup(gone); await f.emit("session_start"); await f.execute({ action: "todo", op: "list" });
  rmSync(gone, { recursive: true, force: true });
  // No real process can escape teardown even on the buggy dispatch path.
  fixtureSpawner.mockImplementationOnce(() => ({ wait: async () => ({ exitCode: 0, result: "fixture" }), kill() {}, detach() {} }));
  await expect(f.execute({ action: "run", cwd: target, agent: "worker", model: "fixture/requested", task: "fixture", context: "fresh" }))
    .rejects.toThrow(`cannot open session run DB (${join(gone, ".spider", "project.db")})`);
  expect(existsSync(join(gone, ".spider"))).toBe(false);
});

it("does not recreate the deleted session cwd during an explicit-cwd post-result scan", async () => {
  const cwd = root(), gone = join(cwd, "gone"), target = join(cwd, "target"); mkdirSync(gone); mkdirSync(target);
  controlConfig("set", gone, "organism.enabled", false);
  const f = setup(gone); await f.emit("session_start"); await f.execute({ action: "todo", op: "list" });
  rmSync(gone, { recursive: true, force: true });
  const result = await f.execute({ action: "todo", op: "list", cwd: target });
  expect(result.details).toBeDefined();
  expect(existsSync(join(gone, ".spider"))).toBe(false);
});

// Break: the call-local handoff opens a removed project and recreates the action's cwd.
it("does not recreate its session cwd after a non-explicit exec removes it", async () => {
  const cwd = root(), gone = join(cwd, "gone"); mkdirSync(gone);
  controlConfig("set", gone, "organism.enabled", false);
  const f = setup(gone); await f.emit("session_start");
  const result = await f.execute({ action: "exec", language: "shell", code: `rm -rf '${gone}'; echo removed` });
  expect(result.content[0].text).toContain("removed");
  expect(existsSync(gone)).toBe(false);
});

it("does not enter reporting transactions when all terminal runs are already reported", () => {
  const cwd = root(), db = openDbAt(join(cwd, "scan.db"), "project"); dbs.push(db);
  const session = SessionManager.inMemory(cwd), accounting = new UsageAccounting(); accounting.activate({ sessionManager: session });
  const store = new RunStore(db);
  for (let i = 0; i < 5; i++) {
    const row = store.create({ sessionId: session.getSessionId(), agent: "worker" });
    recordRunUsage(db, row.id, { provider: "fixture", model: "actual", usage }); store.finish(row.id, { status: "done", result: "r".repeat(4000) });
  }
  accounting.takeFallback(db, session.getSessionId());
  const transactions = vi.spyOn(db, "transaction");
  expect(accounting.takeFallback(db, session.getSessionId())).toBeUndefined();
  expect(transactions).not.toHaveBeenCalled();
});

// M31/M32: run dispatch/adoption must wire the real accounting callback, not just Runner unit tests.
it.each([false, true])("reports child usage through spider run after exit (reload=%s)", async reload => {
  const cwd = root(), f = setup(cwd); await f.emit("session_start");
  let finish!: (v: { exitCode: number; result: string }) => void, gate!: ReturnType<typeof createEventGate>;
  const exit = new Promise<{ exitCode: number; result: string }>(resolve => { finish = resolve; });
  fixtureSpawner.mockImplementationOnce((...args: any[]) => {
    const spec = args[0]; gate = createEventGate(spec.onRpcEvent);
    return { wait: () => exit, kill: () => finish({ exitCode: 137, result: "fixture killed" }), detach() {}, bindEvents: gate.bind, unbindEvents: gate.unbind };
  });
  const result = await f.execute({ action: "run", agent: "worker", model: "fixture/requested", task: "fixture", context: "fresh" });
  const row = result.details.run;
  expect(row.status).toBe("running");
  const message = { type: "message_end", message: { role: "assistant", provider: "fixture", model: "requested", responseModel: "actual", usage } };
  gate.report(message);
  if (reload) {
    await f.stop("reload"); gate.report(message);
    const next = setup(cwd, false, undefined, f.session); await next.emit("session_start", { reason: "reload" });
  }
  finish({ exitCode: 0, result: "fixture report" }); await new Promise<void>(resolve => setImmediate(resolve));
  expect(entries(f.session)).toEqual([expect.objectContaining({ kind: "subagent", provider: "fixture", model: "actual", note: expect.stringContaining(row.id), usage: expect.objectContaining({ totalTokens: reload ? 40 : 20 }) })]);
});
