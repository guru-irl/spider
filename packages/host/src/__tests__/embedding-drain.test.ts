import { fixtureIntercom } from "../roam/__tests__/intercom-move-fixture";
import { withPiEvents, hostUnitPorts } from './fixtures/pi-events';
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance as realPerformance } from "node:perf_hooks";
import { openRepo, openProject, openDbAt, openGlobal, paths, resolveProject, setGlobalDbPathForTests, type Db } from "@spider/db-core";
import { addMemory, enqueueEmbed, getVectorState, upsertVector, type Embedder } from "@spider/memory";
import spiderExtension from "../extension";
import { controlConfig, controlDoctor } from "../control";
import { HostEmbeddingRuntime } from "../embedding-runtime";
import { openFreezeJournal } from "@spider/roam/journal";
import type { Operation } from "@spider/roam/contracts";
import { freezeParticipant, unfreezeParticipant, type FreezePorts } from "../roam/freeze";
import { createProducerDrain } from "../roam/producers";
import type { AdmissionGate } from "../roam/admission";

const provider = vi.hoisted(() => ({ workers: 0, nativeScans: 0, batches: [] as number[], calls: 0, get: undefined as undefined | (() => Promise<Embedder | null>) }));
vi.mock("@spider/memory", async importOriginal => {
  const actual = await importOriginal<typeof import("@spider/memory")>();
  return { ...actual, hasEmbeddingWork: (...args: Parameters<typeof actual.hasEmbeddingWork>) => {
    const db = args[0]; const prepare = db.prepare.bind(db);
    const queries = vi.spyOn(db, "prepare").mockImplementation(sql => {
      if (/NOT EXISTS \(SELECT 1 FROM vectors/.test(sql)) provider.nativeScans++;
      return prepare(sql);
    });
    try { return actual.hasEmbeddingWork(...args); } finally { queries.mockRestore(); }
  }, drainEmbedQueue: (...args: Parameters<typeof actual.drainEmbedQueue>) => { provider.batches.push(args[2] ?? 0); return actual.drainEmbedQueue(...args); }, getReadyEmbedder: () => null, isEmbedderLoaded: () => false, resolveEmbedder: async () => {
    provider.calls++;
    if (provider.get) return provider.get();
    return { model: "fixture", dim: 384, async embed(texts: string[]) {
      return texts.map(() => { const v = new Float32Array(384); v[0] = 1; return v; });
    } };
  } };
});

vi.mock("fastembed", () => ({ FlagEmbedding: { init() { throw new Error("real provider init forbidden"); } }, EmbeddingModel: { BGESmallENV15: "fixture" } }));

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync),
    spawn() { provider.workers++; throw new Error("real worker forbidden in runtime fixtures"); },
  };
});

function host() {
  const hooks = new Map<string, Array<(...args: any[]) => unknown>>();
  const pi = { registerTool() {}, registerCommand() {}, registerMessageRenderer() {},
    on(name: string, fn: (...args: any[]) => unknown) { hooks.set(name, [...hooks.get(name) ?? [], fn]); },
    async emit(name: string, ctx?: unknown) { for (const fn of hooks.get(name) ?? []) await fn(name === 'session_shutdown' ? { reason: 'quit' } : {}, ctx); } };
  spiderExtension(withPiEvents(pi as never), hostUnitPorts);
  return pi;
}
let root: string;
let pi: ReturnType<typeof host> | undefined;
const dbs: Db[] = [];
beforeEach(() => {
  vi.useFakeTimers(); provider.nativeScans = 0; provider.calls = 0; provider.batches = []; provider.get = undefined;
  root = resolve(".spider/scratch", `embedding-drain-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  setGlobalDbPathForTests(join(root, "global.db"));
  controlConfig("set", root, "organism.enabled", false);
});
afterEach(async () => {
  await pi?.emit("session_shutdown"); pi = undefined;
  for (const db of dbs.splice(0)) db.close();
  expect(provider.workers).toBe(0);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  setGlobalDbPathForTests(null); rmSync(root, { recursive: true, force: true });
});
const context = () => ({ cwd: root, hasUI: false, ui: { notify() {} }, sessionManager: { getSessionId: () => "fixture-session", getSessionFile: () => undefined, getEntries: () => [] } });
function tierDbs() {
  const info = resolveProject(root);
  const repo = openRepo(info.repoKey!); const worktree = openProject(info.projectKey);
  dbs.push(repo, worktree); return { repo, worktree };
}

it("registration alone does not start a provider or timer", () => {
  pi = host();
  expect(provider.calls).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("session_start drains all owner kinds in bounded background batches with organism disabled", async () => {
  const { repo, worktree } = tierDbs();
  for (let i = 0; i < 40; i++) addMemory(repo, "repo", { category: "insight", content: `fixture ${i}` });
  for (const kind of ["session", "run"] as const) enqueueEmbed(worktree, kind, kind, "fixture");
  pi = host();
  await pi.emit("session_start", context());
  await vi.advanceTimersByTimeAsync(5000);
  expect(provider.batches).toEqual([8]);
  expect(getVectorState(repo)).toMatchObject({ mapped: 8, indexed: 8, pending: 32 });
  expect(getVectorState(worktree)).toMatchObject({ mapped: 0, indexed: 0, pending: 2 });
  expect(controlDoctor(root).lines.join("\n")).toMatch(/vector recall \(repo\).*last_drain=\d.*last_error=none/);
  await vi.advanceTimersByTimeAsync(35000);
  expect(getVectorState(repo)).toMatchObject({ mapped: 40, indexed: 40, pending: 0 });
  expect(getVectorState(worktree)).toMatchObject({ mapped: 2, indexed: 2, pending: 0 });
});

it("infers at most eight total texts even after yielding to the second DB in a tick", async () => {
  const { repo, worktree } = tierDbs();
  for (let i = 0; i < 16; i++) { addMemory(repo, "repo", { category: "insight", content: `repo ${i}` }); enqueueEmbed(worktree, "run", String(i), `run ${i}`); }
  pi = host(); await pi.emit("session_start", context());
  await vi.advanceTimersByTimeAsync(5002);
  expect(getVectorState(repo).mapped + getVectorState(worktree).mapped).toBe(8);
  expect(provider.calls).toBe(1);
});

it("does not repair after shutdown cancels pending provider setup", async () => {
  const { repo } = tierDbs(); const m = addMemory(repo, "repo", { category: "insight", content: "repair fixture" });
  repo.prepare("INSERT INTO vector_map(owner_kind, owner_id, model, dim, embedding) VALUES ('memory', ?, 'fixture', 384, ?)").run(m.uuid, Buffer.from(new Float32Array(384).buffer));
  let ready!: (embedder: Embedder | null) => void;
  provider.get = () => new Promise(resolve => { ready = resolve; });
  pi = host(); await pi.emit("session_start", context()); await vi.advanceTimersByTimeAsync(5000);
  const stopping = pi.emit("session_shutdown"); ready(null); await stopping; pi = undefined;
  expect(getVectorState(repo)).toMatchObject({ mapped: 1, indexed: 0, missing: 1, pending: 1 });
  expect(vi.getTimerCount()).toBe(0);
});

it("child sessions never start the embedding consumer", async () => {
  const { repo } = tierDbs(); addMemory(repo, "repo", { category: "insight", content: "fixture" });
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  pi = host(); await pi.emit("session_start", context());
  await vi.advanceTimersByTimeAsync(15000);
  expect(provider.calls).toBe(0);
  expect(getVectorState(repo)).toMatchObject({ mapped: 0, pending: 1 });
});

it("bounds initialization waits without treating initializing as a drain error", async () => {
  const { repo } = tierDbs(); addMemory(repo, "repo", { category: "insight", content: "fixture" });
  provider.get = () => new Promise(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  pi = host(); await pi.emit("session_start", context());
  await vi.advanceTimersByTimeAsync(15000);
  expect(getVectorState(repo)).toMatchObject({ mapped: 0, pending: 1 });
  expect(controlDoctor(root).lines.join("\n")).toMatch(/vector recall \(repo\).*last_error=none/);
  provider.get = undefined;
  await vi.advanceTimersByTimeAsync(15000);
  expect(getVectorState(repo)).toMatchObject({ mapped: 1, indexed: 1, pending: 0 });
});

it("shutdown cancels in-flight inference without late writes or lingering timers", async () => {
  const { repo } = tierDbs(); addMemory(repo, "repo", { category: "insight", content: "fixture" });
  let finish: ((value: Float32Array[]) => void) | undefined;
  provider.get = async () => ({ model: "fixture", dim: 384,
    embed: () => new Promise(resolve => { finish = resolve; }) });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  pi = host(); await pi.emit("session_start", context());
  await vi.advanceTimersByTimeAsync(5000);
  expect(finish).toBeDefined();
  await pi.emit("session_shutdown"); pi = undefined;
  finish!([new Float32Array(384)]);
  await vi.advanceTimersByTimeAsync(0);
  expect(controlDoctor(root).lines.join("\n")).toMatch(/vector recall \(repo\).*last_error=none.*drain_errors=0/);
  expect(getVectorState(repo)).toMatchObject({ mapped: 0, pending: 1, retried: 0 });
  expect(vi.getTimerCount()).toBe(0);
});

it("pauses an in-flight embedding drain without late writes and resumes it once", async () => {
  const { repo } = tierDbs();
  addMemory(repo, "repo", { category: "insight", content: "pause fixture" });
  let finish!: (vectors: Float32Array[]) => void;
  let calls = 0;
  provider.get = async () => ({ model: "fixture", dim: 384, embed: texts => {
    calls++;
    return calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(texts.map(() => new Float32Array(384)));
  } });
  const runtime = new HostEmbeddingRuntime(context);
  runtime.start();
  try {
    await vi.advanceTimersByTimeAsync(5000);
    expect(finish).toBeDefined();
    await runtime.pause();
    await runtime.pause();
    finish([new Float32Array(384)]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(getVectorState(repo)).toMatchObject({ mapped: 0, pending: 1 });
    expect(calls).toBe(1);
    runtime.resume(); runtime.resume();
    await vi.advanceTimersByTimeAsync(5002);
    expect(getVectorState(repo)).toMatchObject({ mapped: 1, pending: 0 });
    expect(calls).toBe(2);
  } finally { await runtime.stop(); }
});

it("holds an in-flight embedding result through freeze and resumes only after an authorized abort", async () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const { repo, worktree } = tierDbs();
  addMemory(repo, "repo", { category: "insight", content: "freeze fixture" });
  const machineId = "11111111-1111-4111-8111-111111111111", sessionId = "fixture-session";
  worktree.prepare("UPDATE roam_meta SET machine_id=?,store_key='worktree:fixture:workspace',capture_enabled=1 WHERE id=1").run(machineId);
  worktree.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,1,?)").run(sessionId, machineId);
  worktree.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,2,'active')").run(sessionId);
  const file = join(root, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root }) + "\n" +
    JSON.stringify({ type: "model_change", id: "leaf-1", parentId: null, timestamp: "2026-01-01T00:00:00Z" }) + "\n");
  let finish!: (vectors: Float32Array[]) => void, calls = 0, admitted = true;
  provider.get = async () => ({ model: "fixture", dim: 384, embed: texts => {
    calls++; return calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(texts.map(() => new Float32Array(384)));
  } });
  const runtime = new HostEmbeddingRuntime(context, undefined, { admitted: () => admitted });
  const home = { sessionId, machineId, epoch: 2, moveId: null, updatedAt: 1 };
  const gate: AdmissionGate = { inspect: () => ({ kind: admitted ? "ordinary" : "control-only", home, blockers: [] }),
    refreshInitialHome: async () => gate.inspect(), whenSettled: async () => gate.inspect(), close: async () => { admitted = false; },
    freeze: async () => { admitted = false; }, unfreeze: async () => { admitted = true; } };
  const inert = { async pause() {}, async resume() {} }, producers = createProducerDrain({ usage: inert, embeddings: runtime, organism: inert, others: [] });
  const ports: FreezePorts = { gate, journal: openFreezeJournal(join(root, "roam", "journal.db")), stores: [worktree],
    expectedStores: ["worktree:fixture:workspace"], intercom: fixtureIntercom(sessionId), ...producers, async inspect() { return { blockers: [], file, cwd: root, leaf: "leaf-1", owner: null }; },
    async ingestThrough() {}, async authorizeAbort() { return { home, cancelledMoveId: "move-1" }; }, onHubRestored() { return () => {}; } };
  const operation: Operation = { id: "freeze-embedding", kind: "session-freeze", machineId, expectedEpoch: 2, args: { sessionId, moveId: "move-1" } };
  runtime.start();
  try {
    await vi.advanceTimersByTimeAsync(5000); expect(finish).toBeDefined();
    await freezeParticipant(operation, ports);
    finish([new Float32Array(384)]); await vi.advanceTimersByTimeAsync(30000);
    expect(getVectorState(repo)).toMatchObject({ mapped: 0, pending: 1 });
    expect(calls).toBe(1);
    await unfreezeParticipant({ ...operation, id: "abort-embedding", kind: "session-unfreeze" }, ports);
    await vi.advanceTimersByTimeAsync(5002);
    expect(getVectorState(repo)).toMatchObject({ mapped: 1, pending: 0 });
    expect(calls).toBe(2);
  } finally { await runtime.stop(); }
}, 10000);

it("does not overlap ticks or discard inference completed after the setup deadline", async () => {
  const { repo } = tierDbs(); addMemory(repo, "repo", { category: "insight", content: "fixture" });
  let finish!: (vectors: Float32Array[]) => void;
  provider.get = async () => ({ model: "fixture", dim: 384, embed: () => new Promise(resolve => { finish = resolve; }) });
  pi = host(); await pi.emit("session_start", context()); await vi.advanceTimersByTimeAsync(5000);
  await vi.advanceTimersByTimeAsync(30000);
  expect(provider.calls).toBe(1);
  finish([new Float32Array(384)]); await vi.advanceTimersByTimeAsync(0);
  expect(getVectorState(repo)).toMatchObject({ mapped: 1, pending: 0 });
});

it("does not start a timer in a child even if it later becomes a parent", async () => {
  const { repo } = tierDbs(); addMemory(repo, "repo", { category: "insight", content: "fixture" });
  vi.stubEnv("PI_SUBAGENT_CHILD", "1"); pi = host(); await pi.emit("session_start", context());
  vi.stubEnv("PI_SUBAGENT_CHILD", "0"); await vi.advanceTimersByTimeAsync(15000);
  expect(getVectorState(repo)).toMatchObject({ mapped: 0, pending: 1 });
});

it("rechecks the child guard on each tick", async () => {
  const { repo } = tierDbs(); addMemory(repo, "repo", { category: "insight", content: "fixture" });
  pi = host(); await pi.emit("session_start", context()); vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  await vi.advanceTimersByTimeAsync(5000); expect(getVectorState(repo)).toMatchObject({ mapped: 0, pending: 1 });
});

it("uses an unreferenced timer and backs off without rewriting the registry or DB", async () => {
  const { repo } = tierDbs();
  const runtime = new HostEmbeddingRuntime(context, async () => null);
  const timers = vi.spyOn(globalThis, "setTimeout");
  runtime.start();
  try {
    const timer = timers.mock.results[0].value as ReturnType<typeof setTimeout>;
    expect(timer.hasRef()).toBe(false);
    const before = repo.pragma("data_version");
    const global = openGlobal();
    const registry = global.prepare("SELECT last_seen_at FROM projects WHERE project_key = ?").get(root);
    await vi.advanceTimersByTimeAsync(15000);
    expect(repo.pragma("data_version")).toBe(before);
    expect(global.prepare("SELECT last_seen_at FROM projects WHERE project_key = ?").get(root)).toEqual(registry);
    global.close();
    const timerCalls = timers.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(timers.mock.calls.length).toBe(timerCalls);
  } finally { await runtime.stop(); }
});

it("reuses clean missing-vector scans across ticks but rescans on session start and insert errors", async () => {
  const { repo, worktree } = tierDbs();
  const vector = new Float32Array(384); vector[0] = 1;
  upsertVector(repo, "run", "indexed", vector, "fixture");
  upsertVector(worktree, "run", "indexed", vector, "fixture");
  const runtime = new HostEmbeddingRuntime(context, async () => null);
  runtime.start();
  try {
    await vi.advanceTimersByTimeAsync(5002);
    expect(provider.nativeScans).toBe(2);
    await vi.advanceTimersByTimeAsync(70000);
    expect(provider.nativeScans).toBe(2);
  } finally { await runtime.stop(); }
  const next = new HostEmbeddingRuntime(context, async () => null);
  next.start();
  try {
    await vi.advanceTimersByTimeAsync(5002);
    expect(provider.nativeScans).toBe(4);
    const load = vi.spyOn(repo, "loadVec").mockImplementation(() => { throw new Error("fixture native insert failed"); });
    upsertVector(repo, "run", "gap", vector, "fixture"); load.mockRestore();
    await vi.advanceTimersByTimeAsync(15002);
    expect(getVectorState(repo)).toMatchObject({ mapped: 2, indexed: 2, missing: 0 });
    expect(provider.nativeScans).toBeGreaterThan(4);
    const scans = provider.nativeScans;
    await vi.advanceTimersByTimeAsync(70000);
    expect(provider.nativeScans).toBe(scans);
  } finally { await next.stop(); }
});

it("wakes an idle runtime on enqueue and honors embeddings.drain false", async () => {
  const { repo } = tierDbs(); pi = host(); await pi.emit("session_start", context());
  await vi.advanceTimersByTimeAsync(35000);
  addMemory(repo, "repo", { category: "insight", content: "wake" });
  await vi.advanceTimersByTimeAsync(1);
  expect(getVectorState(repo)).toMatchObject({ mapped: 1 });
  controlConfig("set", root, "embeddings.drain", false);
  addMemory(repo, "repo", { category: "insight", content: "disabled" });
  await vi.advanceTimersByTimeAsync(30000);
  expect(getVectorState(repo)).toMatchObject({ mapped: 1, pending: 1 });
  expect(controlDoctor(root).lines.join("\n")).toContain("drain=disabled");
});

it("drains the same repo DB path for a non-git project", async () => {
  rmSync(join(root, ".git"), { recursive: true, force: true });
  vi.stubEnv("GIT_CEILING_DIRECTORIES", resolve(root, ".."));
  const repo = openDbAt(join(paths.projectRoot(root), "repo.db"), "repo"); dbs.push(repo);
  addMemory(repo, "repo", { category: "insight", content: "non git fixture" });
  pi = host(); await pi.emit("session_start", context()); await vi.advanceTimersByTimeAsync(5000);
  expect(getVectorState(repo)).toMatchObject({ mapped: 1, pending: 0 });
  expect(controlDoctor(root).lines.join("\n")).toMatch(/vector recall \(repo\).*mapped=1/);
});

it("skips SQLITE_BUSY promptly on its own short-timeout connection", async () => {
  const { repo } = tierDbs(); addMemory(repo, "repo", { category: "insight", content: "busy" });
  pi = host(); await pi.emit("session_start", context());
  repo.exec("BEGIN IMMEDIATE");
  const before = realPerformance.now();
  try { await vi.advanceTimersByTimeAsync(5000); }
  finally { repo.exec("ROLLBACK"); }
  expect(realPerformance.now() - before).toBeLessThan(800);
  expect(getVectorState(repo)).toMatchObject({ mapped: 0, pending: 1 });
  await vi.advanceTimersByTimeAsync(6000);
  expect(getVectorState(repo)).toMatchObject({ mapped: 1, pending: 0 });
});

it("never infers legacy global rows and drops them during one-time repair", async () => {
  tierDbs(); const global = openGlobal(); dbs.push(global);
  global.exec("CREATE TABLE embed_queue(id INTEGER PRIMARY KEY, owner_kind TEXT, owner_id TEXT, text TEXT, enqueued_at INTEGER, tries INTEGER)");
  global.exec("INSERT INTO embed_queue VALUES (1, 'memory', 'legacy', 'fixture', 1, 0)");
  pi = host(); await pi.emit("session_start", context()); await vi.advanceTimersByTimeAsync(15000);
  expect(provider.calls).toBe(0);
  expect(global.prepare("SELECT COUNT(*) AS n FROM embed_queue").get()).toEqual({ n: 0 });
});

it("ignores an overlapping scheduler callback independently of the queue lease", async () => {
  const { repo } = tierDbs(); addMemory(repo, "repo", { category: "insight", content: "overlap" });
  const timers = vi.spyOn(globalThis, "setTimeout");
  const runtime = new HostEmbeddingRuntime(context, async () => {
    provider.calls++;
    return { model: "fixture", dim: 384, async embed(texts) { return texts.map(() => new Float32Array(384)); } };
  });
  runtime.start();
  const callback = timers.mock.calls[0][0] as () => void;
  clearTimeout(timers.mock.results[0].value);
  try {
    callback(); callback();
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.calls).toBe(1);
    expect(getVectorState(repo)).toMatchObject({ mapped: 1, pending: 0 });
  } finally { await runtime.stop(); }
});

it("does not rediscover git paths on idle host ticks including drain config reads", async () => {
  tierDbs(); pi = host(); await pi.emit("session_start", context());
  const commands = vi.mocked(execFileSync); commands.mockClear();
  await vi.advanceTimersByTimeAsync(5000);
  expect(commands.mock.calls.filter(call => call[0] === "git").length).toBe(0);
});
