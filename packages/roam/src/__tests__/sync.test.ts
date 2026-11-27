import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, appendFileSync, writeFileSync, chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { replicaPath } from "@spider/db-core/roam/catalog";
import { mapWorkspace } from "@spider/db-core/roam/repo-map";
import { supervisorRetirementLifecycle } from "../participant-supervisor";
import { createProductionRecoveryPorts } from "../recovery-transport";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { createSync } from "../sync";
import { runHub, type HubRuntimePorts } from "../hub";
import { productionObservationFixture } from "./production-observation-fixture";
import { sizedBytes } from "../peer-state";
import * as peerState from "../peer-state";
import * as storeApi from "../stores";
import { sweepStoreArtifacts } from "../cleanup";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { createReplica, scratchDbPath } from "@spider/db-core/testutil";
import { openDb } from "@spider/db-core";
import { exportBatch } from "@spider/db-core/roam/export";
import { assignInitialHome } from "../homes";
import { revokeMachine } from "../revocation";
import { inspectSession } from "../session-file";
import { recoverMirror } from "../mirrors";
import type { ArtifactJournal } from "../journal";
import { addTodo } from "../../../todo/src/store";
import * as staging from "../staging";
import { HerdrError } from "../../../herdr/src/client/parse";
import { network, HUB, BOX, BOX2, BOX3 } from "./sync-fixture";
const fixtures: ReturnType<typeof network>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.close(); });
function fixture(ids?: string[]) { const f = network(ids); fixtures.push(f); vi.spyOn(staging, "defaultStagingRoot").mockReturnValue(f.root); return f; }
function service(f: ReturnType<typeof network>) { return createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores }); }
it("startup pulls before pushing merged changes", async () => {
  const f = fixture(); f.seed(); const order: string[] = [];
  f.hook((_peer, op) => { if (op.args.storeKey === f.remotes.get(BOX)!.worktree.storeKey) { if (op.kind === "export" && order.length === 0) order.push("pull"); if (op.kind === "import") order.push("push"); } });
  const accept = f.stores.accept.bind(f.stores);
  vi.spyOn(f.stores, "accept").mockImplementation(async (key, batch) => { const result = await accept(key, batch); if (key.startsWith("worktree:")) order.push("apply"); return result; });
  const sync = service(f); sync.start(); expect(f.timers.filter(t => !t.cancelled).map(t => t.ms)).toEqual([0]);
  f.timers[0].fn(); const result = await sync.sync(BOX); sync.stop();
  expect(order).toEqual(["pull", "apply", "push"]);
  expect(result.every(row => row.code === 0)).toBe(true);
  expect(f.global.db.prepare("SELECT machine_id,epoch FROM session_homes").all()).toEqual([{ machine_id: BOX, epoch: 1 }]);
  expect(f.remotes.get(BOX)!.global.db.prepare("SELECT machine_id,epoch FROM session_homes").all()).toEqual([{ machine_id: BOX, epoch: 1 }]);
  const directories = [...f.stores.batchDirectories(), ...f.remotes.get(BOX)!.stores.batchDirectories()];
  expect(directories.flatMap(directory => existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".ndjson")) : [])).toEqual([]);
  for (const call of f.calls.filter(call => call.operation.kind === "import")) {
    const pool = staging.openOutgoingStaging(f.root, f.config.limits, false);
    expect(pool.inspect(call.operation.args.artifactId as string).current).toBeNull(); pool.close();
  }
  const before = f.stores.openStore(f.remotes.get(BOX)!.worktree.storeKey).db.prepare("SELECT count(*) AS n FROM roam_changes").get();
  await sync.sync();
  expect(f.stores.openStore(f.remotes.get(BOX)!.worktree.storeKey).db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual(before);
}, 5000);
it("publishes a peer observation only after that peer's sync has committed", async () => {
  const f = fixture(); f.seed();
  const observations: Array<{ machine: string; homes: unknown; codes: number[] }> = [];
  const sync = createSync({ config: f.config, globalDb: f.global.db, transport: f.transport, journal: f.journal, clock: f.clock, stores: f.stores,
    onPeerSync(peer, outcomes) { observations.push({ machine: peer.machineId, homes: f.global.db.prepare("SELECT machine_id FROM session_homes").all(), codes: outcomes.map(row => row.code) }); } });
  await sync.sync(BOX);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ machine: BOX, homes: [{ machine_id: BOX }] });
  expect(observations[0].codes.every(code => code === 0)).toBe(true);
}, 5000);

it("caches observed peer cursors and last sync without inventing connectivity after failure", async () => {
  const f = fixture(); f.seed();
  const sync = service(f);
  expect((await sync.sync(BOX)).every(row => row.code === 0)).toBe(true);
  type Cached = { observation?: { machineId: string; observedAt: number; connected: boolean | null; lastSyncAt: number | null;
    cursors: Array<{ storeKey: string; stream: string; through: number }> } };
  const state = readLocal<Cached>(f.global.db, "sync-peer", BOX);
  expect(state?.observation).toMatchObject({ machineId: BOX, observedAt: f.clock.now(), connected: true, lastSyncAt: f.clock.now() });
  const global = f.stores.openStore("global").db;
  const stream = (global.prepare("SELECT stream_id FROM roam_meta").get() as { stream_id: string }).stream_id;
  const head = (global.prepare("SELECT coalesce(max(seq),0) AS head FROM roam_changes").get() as { head: number }).head;
  expect(state?.observation?.cursors).toContainEqual({ storeKey: "global", stream, through: head });
  f.unavailable.add(BOX);
  expect((await sync.sync(BOX)).some(row => row.code === 3)).toBe(true);
  const failed = readLocal<Cached>(f.global.db, "sync-peer", BOX)?.observation;
  expect(failed).toMatchObject({ connected: null, lastSyncAt: f.clock.now(), cursors: [] });
}, 5000);

it.each([
  ["spawn_failed", "Peer command failed (spawn_failed)"],
  ["cli-exit", "Peer command failed (exit 1)"],
])("sync reports a broken peer %s and clears it after recovery", async (kind, reason) => {
  const f = fixture();
  f.hook(() => { throw new HerdrError(kind, "private fixture value", { exitCode: 1, stderr: "private fixture value" }); });
  const sync = service(f);
  expect(await sync.sync(BOX)).toMatchObject([{ code: 1, reason }]);
  expect(peerState.loadPeerState(f.global.db, BOX, f.config.limits.targetBatchBytes).observation).toMatchObject({ failure: reason });
  f.hook(null);
  expect((await sync.sync(BOX)).every(row => row.code === 0)).toBe(true);
  expect(peerState.loadPeerState(f.global.db, BOX, f.config.limits.targetBatchBytes).observation).toMatchObject({ failure: null });
}, 5000);

it.each(["push", "pull"] as const)("sync retains a broken peer diagnosis during artifact %s", async direction => {
  const f = fixture();
  if (direction === "push") {
    f.global.db.prepare("INSERT INTO global_memory(uuid,category,content,created_at) VALUES ('memory-a','insight','portable',1)").run();
    const exec = f.transport.exec.bind(f.transport);
    vi.spyOn(f.transport, "exec").mockImplementation(async (peer, argv, options) => {
      if (argv[1] === "artifact") throw new HerdrError("spawn_failed", "private", { exitCode: 3 });
      return exec(peer, argv, options);
    });
  } else {
    f.seed();
    vi.spyOn(f.transport, "read").mockRejectedValue(new HerdrError("spawn_failed", "private", { exitCode: 3 }));
  }
  const reason = "Peer command failed (spawn_failed)";
  expect(await service(f).sync(BOX)).toContainEqual(expect.objectContaining({ code: 1, reason }));
  expect(peerState.loadPeerState(f.global.db, BOX, f.config.limits.targetBatchBytes).observation).toMatchObject({ failure: reason });
}, 5000);

it("stopping waits for active peer work before stores may be closed", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.hook(async (_peer, op) => { if (op.kind === "stores") { entered(); await gate; } });
  const sync = service(f); sync.start();
  const inFlight = sync.sync(BOX); await started;
  sync.stop();
  let drained = false;
  const idle = sync.drain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  release(); await Promise.all([idle, inFlight]);
  expect(drained).toBe(true);
  expect(f.timers.filter(timer => !timer.cancelled)).toEqual([]);
}, 5000);

it("one unavailable peer does not stall another", async () => {
  const f = fixture([BOX, BOX2]); f.seed(BOX2); f.unavailable.add(BOX);
  const result = await service(f).sync();
  expect(result.some(row => row.code === 3)).toBe(true);
  expect(f.stores.openStore(f.remotes.get(BOX2)!.worktree.storeKey).db.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "session-a" }]);
  expect(f.global.db.prepare("SELECT * FROM session_homes").all()).toEqual([]);
}, 5000);
it("one transfer per peer and at most two peers", async () => {
  const f = fixture([BOX, BOX2, BOX3]); const sync = service(f);
  const active = new Map<string, number>(); let maxConcurrentByPeer = 0, maxConcurrentPeers = 0;
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const both = new Promise<void>(resolve => { entered = resolve; });
  f.hook(async (peer, op) => { if (op.kind !== "stores") return; active.set(peer.machineId, (active.get(peer.machineId) ?? 0) + 1);
    maxConcurrentByPeer = Math.max(maxConcurrentByPeer, active.get(peer.machineId)!); maxConcurrentPeers = Math.max(maxConcurrentPeers, active.size);
    if (active.size === 2) entered(); await pause; active.delete(peer.machineId); });
  const first = sync.sync(BOX); const repeated = sync.sync(BOX); const others = sync.sync(); await both; release(); await Promise.all([first, repeated, others]);
  expect(maxConcurrentByPeer).toBe(1); expect(maxConcurrentPeers).toBe(2);
}, 5000);
it.each(["machineId", "protocol", "schema", "stream"])("handshake mismatch mutates nothing (%s)", async field => {
  const f = fixture(); f.seed(); f.replyHook((_peer, op, bytes) => { if (op.kind !== (field === "stream" ? "inventory" : "stores")) return bytes;
    const reply = JSON.parse(bytes.toString()); reply.value[field] = field === "machineId" ? HUB : field === "stream" ? "invalid-stream" : 99; return Buffer.from(JSON.stringify(reply)); });
  const result = await service(f).sync();
  expect(result.some(row => row.code !== 0)).toBe(true);
  expect(f.global.db.prepare("SELECT * FROM session_homes").all()).toEqual([]);
  expect(f.stores.list(BOX)).toEqual(["global"]);
  expect(f.calls.some(call => call.operation.kind === "export" || call.operation.kind === "import")).toBe(false);
}, 5000);
it("disconnected retries remain independent and capped", async () => {
  const f = fixture(); f.unavailable.add(BOX); const sync = service(f); sync.start();
  const retryDelays: number[] = [];
  for (let i = 0; i < 4; i++) { const timer = f.timers.find(t => !t.cancelled)!; timer.cancelled = true; timer.fn(); await sync.sync(BOX); retryDelays.push(f.timers.filter(t => !t.cancelled).at(-1)!.ms); }
  sync.stop(); expect(retryDelays).toEqual([30_000, 60_000, 120_000, 120_000]);
}, 5000);
it.each([1, 3] as const)("code-%s transport outages back off under a short sync cadence and reset after success", async code => {
  const f = fixture(); f.config.syncMs = 1000; let now = 0;
  f.clock.now = () => now;
  if (code === 1) f.hook(() => { throw new HerdrError("connection-closed", "synthetic outage", { exitCode: 1 }); });
  else f.unavailable.add(BOX);
  const sync = service(f); sync.start();
  const delays: number[] = [];
  for (let i = 0; i < 4; i++) {
    const timer = f.timers.find(row => !row.cancelled)!;
    now += timer.ms; timer.cancelled = true; timer.fn();
    expect(await sync.sync(BOX)).toMatchObject([{ code }]);
    delays.push(f.timers.find(row => !row.cancelled)!.ms);
  }
  expect(delays).toEqual([30_000, 60_000, 120_000, 120_000]);
  f.hook(null); f.unavailable.delete(BOX);
  const reconnect = f.timers.find(row => !row.cancelled)!;
  now += reconnect.ms; reconnect.cancelled = true; reconnect.fn();
  expect((await sync.sync(BOX)).every(row => row.code === 0)).toBe(true);
  expect(f.timers.find(row => !row.cancelled)!.ms).toBe(1000);
  expect(peerState.loadPeerState(f.global.db, BOX, f.config.limits.targetBatchBytes).failures).toBe(0);
  f.unavailable.add(BOX);
  const next = f.timers.find(row => !row.cancelled)!;
  now += next.ms; next.cancelled = true; next.fn();
  expect(await sync.sync(BOX)).toMatchObject([{ code: 3 }]);
  expect(f.timers.find(row => !row.cancelled)!.ms).toBe(30_000);
  sync.stop();
}, 5000);

it("an identity mismatch cannot reset an outage backoff", async () => {
  const f = fixture(); f.config.syncMs = 1000; f.unavailable.add(BOX);
  const sync = service(f); sync.start();
  expect(await sync.sync(BOX)).toMatchObject([{ code: 3 }]);
  f.unavailable.delete(BOX);
  f.replyHook((_peer, op, bytes) => {
    if (op.kind !== "stores") return bytes;
    const reply = JSON.parse(bytes.toString()); reply.value.machineId = HUB;
    return Buffer.from(JSON.stringify(reply));
  });
  expect(await sync.sync(BOX)).toMatchObject([{ code: 1 }]);
  expect(f.timers.find(row => !row.cancelled)!.ms).toBe(30_000);
  f.replyHook(null);
  expect((await sync.sync(BOX)).every(row => row.code === 0)).toBe(true);
  expect(f.timers.find(row => !row.cancelled)!.ms).toBe(1000);
  sync.stop();
}, 5000);

it.each(["ungathered", "refused", "pending-store"])("an answered round with %s stores resets outage backoff", async kind => {
  const f = fixture(); f.config.syncMs = 120_000; let now = 0;
  f.clock.now = () => now;
  f.unavailable.add(BOX);
  const sync = service(f); sync.start();
  const fire = () => { const timer = f.timers.find(row => !row.cancelled)!; now += timer.ms; timer.cancelled = true; timer.fn(); };
  fire(); expect(await sync.sync(BOX)).toMatchObject([{ code: 3 }]);
  expect(f.timers.find(row => !row.cancelled)!.ms).toBe(30_000);
  f.unavailable.delete(BOX);
  f.replyHook((_peer, op, bytes) => {
    const reply = JSON.parse(bytes.toString());
    if (kind === "ungathered" && op.kind === "stores") reply.value.ungathered = [
      { key: null, scope: "worktree", path: "/home/fixture/missing", code: "missing", check: "stat" }];
    if (kind !== "ungathered" && op.kind === "inventory") { reply.code = kind === "refused" ? 1 : 3; reply.reason = "Roaming capture is unsafe for this store"; reply.value = null; }
    return Buffer.from(JSON.stringify(reply));
  });
  fire(); const results = await sync.sync(BOX);
  if (kind === "ungathered") expect(results).toEqual([]);
  else expect(results).toMatchObject([{ code: kind === "refused" ? 1 : 3, reason: "capture-unsafe" }]);
  expect(f.timers.find(row => !row.cancelled)!.ms).toBe(120_000);
  expect(peerState.loadPeerState(f.global.db, BOX, f.config.limits.targetBatchBytes)).toMatchObject({ failures: 0, observation: { connected: true } });
  sync.stop();
}, 5000);

it.each(["identity", "content"])("an answered %s failure retains its refusal and normal cadence", async failure => {
  const f = fixture(); f.config.syncMs = 1000;
  f.replyHook((_peer, op, bytes) => {
    if (op.kind !== "stores") return bytes;
    const reply = JSON.parse(bytes.toString());
    if (failure === "identity") reply.value.machineId = HUB;
    else reply.value.stores = "not-a-list";
    return Buffer.from(JSON.stringify(reply));
  });
  const sync = service(f); sync.start();
  const timer = f.timers.find(row => !row.cancelled)!; timer.cancelled = true; timer.fn();
  expect(await sync.sync(BOX)).toMatchObject([{ code: 1 }]);
  expect(f.timers.find(row => !row.cancelled)!.ms).toBe(1000);
  expect(peerState.loadPeerState(f.global.db, BOX, f.config.limits.targetBatchBytes).failures).toBe(0);
  expect(f.global.db.prepare("SELECT * FROM session_homes").all()).toEqual([]);
  expect(f.calls.some(call => call.operation.kind === "export" || call.operation.kind === "import")).toBe(false);
  sync.stop();
}, 5000);

it("adaptive bytes include lexical apply duration", () => {
  const first = sizedBytes(4 * 1024 * 1024, 500, 250, 4 * 1024 * 1024);
  const unavailable = sizedBytes(first, null, 250, 4 * 1024 * 1024);
  const next = sizedBytes(unavailable, 1000, 250, 4 * 1024 * 1024);
  expect(first).toBe(2 * 1024 * 1024); expect(unavailable).toBe(first); expect(next).toBe(1024 * 1024);
}, 5000);
it("a core restart after a lost import reply retries the same operation across restart", async () => {
  const f = fixture(); f.seed(); let lost = false;
  f.replyHook((_peer, op, bytes) => { if (op.kind === "import" && !lost) { lost = true; throw Object.assign(new Error("core changed"), { code: "core-changed", retryable: true }); } return bytes; });
  const first = await service(f).sync(); expect(first.some(row => row.code === 3)).toBe(true);
  expect(first.find(row => row.code === 3)!.operationId).toBe(f.calls.find(call => call.operation.kind === "import")!.operation.id);
  const result = await service(f).sync(); expect(result.every(row => row.code === 0)).toBe(true);
  const imports = f.calls.filter(call => call.operation.kind === "import");
  expect(imports[0].operation.id).toBe(imports[1].operation.id);
  expect(imports[0].operation.args).toEqual(imports[1].operation.args);
  expect(f.remotes.get(BOX)!.global.db.prepare("SELECT count(*) AS n FROM roam_receipts").get()).toEqual({ n: 1 });
}, 5000);
it("a quarantined store blocks only its session homes, not healthy sessions on other peers", async () => {
  const f = fixture([BOX, BOX2]); f.seed(BOX, "session-a", "quarantined"); f.seed(BOX2, "session-b", "healthy"); f.seed(BOX2, "session-a", "unknown copy");
  f.remotes.get(BOX)!.worktree.db.prepare("UPDATE roam_meta SET roamable=0,problem='quarantined'").run();
  const result = await service(f).sync();
  expect(result.some(row => row.code === 1)).toBe(true);
  expect(f.global.db.prepare("SELECT session_id,machine_id,epoch FROM session_homes ORDER BY session_id").all()).toEqual([
    { session_id: "session-b", machine_id: BOX2, epoch: 1 },
  ]);
  expect(f.remotes.get(BOX2)!.global.db.prepare("SELECT session_id FROM session_homes").all()).toEqual([{ session_id: "session-b" }]);
}, 5000);
it("an unsafe unrelated box registration is skipped and reported without blocking discovery", async () => {
  const f = fixture(); f.seed(); const remote = f.remotes.get(BOX)!;
  const link = join(remote.global.root, "linked.db"); symlinkSync(remote.worktree.db.raw.name, link);
  let problems: unknown[] = [];
  f.replyHook((_peer, operation, bytes) => { if (operation.kind === "stores") problems = JSON.parse(bytes.toString()).value.problems; return bytes; });
  remote.global.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('unsafe',?,?,1,1)").run(remote.global.root, link);
  expect((await service(f).sync()).every(row => row.code === 0)).toBe(true);
  expect(f.global.db.prepare("SELECT session_id FROM session_homes").all()).toEqual([]);
  expect(f.stores.openStore(remote.worktree.storeKey).db.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "session-a" }]);
  expect(f.calls.some(call => call.operation.kind === "export")).toBe(true);
  expect(problems).toContainEqual({ entry: link, reason: "Unsafe or unreadable store skipped" });
}, 5000);
it("a quarantined store does not block a healthy store or trim a singleton row", async () => {
  const f = fixture([BOX, BOX2]); f.seed(BOX); f.seed(BOX2, "session-b", "x".repeat(16_384));
  f.config.limits.targetBatchBytes = 1024;
  f.remotes.get(BOX)!.worktree.db.prepare("UPDATE roam_meta SET roamable=0,problem='quarantined'").run();
  const result = await service(f).sync();
  expect(result.some(row => row.code === 1)).toBe(true);
  expect(f.stores.openStore(f.remotes.get(BOX2)!.worktree.storeKey).db.prepare("SELECT length(text) AS n FROM todos").get()).toEqual({ n: 16_384 });
}, 5000);
it.each(["sha256", "stream", "through", "applyMs"])("invalid peer receipt %s cannot authorize cleanup", async field => {
  const f = fixture(); f.seed();
  f.replyHook((_peer, op, bytes) => { if (op.kind !== "import") return bytes; const reply = JSON.parse(bytes.toString());
    reply.value[field] = field === "through" ? 0 : field === "applyMs" ? -1 : "wrong"; return Buffer.from(JSON.stringify(reply)); });
  const result = await service(f).sync();
  expect(result.some(row => row.code === 1)).toBe(true);
  const state = peerState.loadPeerState(f.global.db, BOX, f.config.limits.targetBatchBytes);
  const pending = Object.values(state.pending).find(row => row.batch !== null)!;
  expect(existsSync(pending.batch!.file)).toBe(true);
  const pool = staging.openOutgoingStaging(f.root, f.config.limits, false);
  expect(pool.inspect(pending.id).current).not.toBeNull(); pool.close();
}, 5000);
it("a lost local apply result reconciles the durable receipt after staging cleanup", async () => {
  const f = fixture(); f.seed(); const record = f.journal.record.bind(f.journal); let lost = false;
  vi.spyOn(f.journal, "record").mockImplementation((id, action, result) => {
    if (id.startsWith("accept-") && action === "done" && !lost) { lost = true; throw new Error("lost result"); }
    record(id, action, result);
  });
  const first = await service(f).sync();
  expect(first.some(row => row.code === 3)).toBe(true);
  const result = await service(f).sync();
  expect(result.every(row => row.code === 0)).toBe(true);
  const target = f.stores.openStore(f.remotes.get(BOX)!.worktree.storeKey).db;
  expect(target.prepare("SELECT count(*) AS n FROM roam_receipts").get()).toEqual({ n: 1 });
}, 5000);
it("restart after source deletion reconciles the committed import", async () => {
  const f = fixture(); f.seed(); let saved: peerState.PeerState | null = null;
  const save = peerState.savePeerState;
  vi.spyOn(peerState, "savePeerState").mockImplementation((db, machine, state) => {
    if (Object.values(state.pending).some(row => row.batch && row.batch.header.count > 0)) saved = structuredClone(state);
    save(db, machine, state);
  });
  await service(f).sync(); expect(saved).not.toBeNull();
  writeLocal(f.global.db, "sync-peer", BOX, saved);
  const importsBefore = f.calls.filter(call => call.operation.kind === "import").length;
  const result = await service(f).sync();
  expect(result.every(row => row.code === 0)).toBe(true);
  expect(f.calls.filter(call => call.operation.kind === "import")).toHaveLength(importsBefore);
}, 5000);
it.each(["pending", "split", "accept"] as const)("a pull resumes without lost or repeated changes when mapping publishes at %s", async point => {
  const f = fixture(); f.seed();
  expect((await service(f).sync()).every(row => row.code === 0)).toBe(true);
  expect(f.calls).toEqual([]);
  f.seed(BOX, "session-b", "second");
  const remote = f.remotes.get(BOX)!, key = remote.worktree.storeKey;
  const checkout = join(f.global.root, "mapped-pull"); mkdirSync(checkout, { mode: 0o700 });
  const map = () => mapWorkspace(f.global.db, { repoKey: "fixture-repo", workspaceId: "workspace-0", path: checkout });
  let changed = false;
  const accept = f.stores.accept.bind(f.stores);
  if (point !== "split") vi.spyOn(f.stores, "accept").mockImplementation(async (store, batch) => {
    if (store === key && !changed) {
      changed = true;
      if (point === "pending") throw Object.assign(new Error("apply busy"), { retryable: true });
      await map();
    }
    return accept(store, batch);
  });
  if (point === "split") {
    let armed = false;
    f.hook(async (_peer, operation) => {
      if (operation.kind === "export" && operation.args.storeKey === key) armed = true;
      if (operation.kind === "split" && armed && !changed) { changed = true; await map(); }
    });
  }
  await service(f).sync();
  if (point === "pending") await map();
  expect((await service(f).sync()).every(row => row.code === 0)).toBe(true);
  const db = f.stores.openStore(key).db;
  expect(db.prepare("SELECT uuid,text FROM todos ORDER BY uuid").all()).toEqual([
    { uuid: "todo-session-a", text: "portable" }, { uuid: "todo-session-b", text: "second" },
  ]);
  expect(db.prepare("SELECT count(*) AS n,count(DISTINCT change_id) AS unique_count FROM roam_changes").get()).toEqual({ n: 4, unique_count: 4 });
  expect(peerState.loadPeerState(f.global.db, BOX, 4096).pending).toEqual({});
}, 5000);
it("a pending push resumes from a replaced peer store's cursor without duplicate changes", async () => {
  const f = fixture(); f.seed(); await service(f).sync(); f.seed(BOX, "session-b", "second");
  const remote = f.remotes.get(BOX)!, key = remote.worktree.storeKey;
  let failed = false;
  f.hook((_peer, operation) => { if (operation.kind === "import" && operation.args.storeKey === key && !failed) { failed = true; throw new Error("import not delivered"); } });
  expect((await service(f).sync()).some(row => row.code === 3)).toBe(true);
  const replica = replicaPath(remote.global.db, key);
  mkdirSync(dirname(replica), { recursive: true, mode: 0o700 });
  await remote.worktree.db.raw.backup(replica); chmodSync(replica, 0o600);
  const checkout = join(remote.global.root, "replacement"); mkdirSync(checkout, { mode: 0o700 });
  await mapWorkspace(remote.global.db, { repoKey: "fixture-repo", workspaceId: "workspace-0", path: checkout });
  expect((await service(f).sync()).every(row => row.code === 0)).toBe(true);
  expect(remote.stores.openStore(key).db.prepare("SELECT uuid FROM todos ORDER BY uuid").all()).toEqual([
    { uuid: "todo-session-a" }, { uuid: "todo-session-b" },
  ]);
  expect(remote.stores.openStore(key).db.prepare("SELECT count(*) AS n FROM roam_receipts WHERE peer_machine=?").get(HUB)).toEqual({ n: 1 });
  expect(peerState.loadPeerState(f.global.db, BOX, 4096).pending).toEqual({});
}, 5000);
it("mapping during an uncertain push finishes the old import before resending the mapped stream", async () => {
  const f = fixture(); f.seed(); let lost = false;
  f.replyHook((_peer, op, bytes) => { if (op.kind === "import" && typeof op.args.storeKey === "string" && op.args.storeKey.startsWith("worktree:") && !lost) {
    lost = true; throw Object.assign(new Error("core changed"), { retryable: true }); } return bytes; });
  await service(f).sync();
  const target = join(f.global.root, "mapped"); mkdirSync(target, { mode: 0o700 });
  await mapWorkspace(f.global.db, { repoKey: "fixture-repo", workspaceId: "workspace-0", path: target });
  const result = await service(f).sync();
  expect(result.every(row => row.code === 0)).toBe(true);
  const imports = f.calls.filter(call => call.operation.kind === "import" && call.operation.args.storeKey === f.remotes.get(BOX)!.worktree.storeKey);
  expect(imports[0].operation.id).toBe(imports[1].operation.id);
  expect(f.remotes.get(BOX)!.worktree.db.prepare("SELECT uuid FROM todos").all()).toEqual([{ uuid: "todo-session-a" }]);
}, 5000);
it("a crash after receipt leaves a sweepable source without losing retry evidence", async () => {
  const f = fixture(); f.seed(); const remove = storeApi.removeOutgoing; let interrupted = false;
  vi.spyOn(storeApi, "removeOutgoing").mockImplementation((root, id, config, verified) => {
    if (root === f.root && !interrupted) { interrupted = true; throw new Error("interrupted cleanup"); }
    remove(root, id, config, verified);
  });
  await service(f).sync();
  const state = peerState.loadPeerState(f.global.db, BOX, f.config.limits.targetBatchBytes);
  const pending = Object.values(state.pending).find(row => row.batch !== null)!;
  expect(f.journal.read(`import-${pending.id}`).some(row => row.action === "done")).toBe(true);
  expect(existsSync(pending.batch!.file)).toBe(true);
  const importsBefore = f.calls.filter(call => call.operation.kind === "import").length;
  sweepStoreArtifacts(f.stores, f.config, { now: Date.now() + f.config.limits.retentionMs + 1000, referenced: () => false, active: () => false });
  expect(existsSync(pending.batch!.file)).toBe(false);
  expect((await service(f).sync()).every(row => row.code === 0)).toBe(true);
  expect(f.calls.filter(call => call.operation.kind === "import")).toHaveLength(importsBefore + 1);
}, 5000);
it("observed origins are gathered before any initial assignment", async () => {
  const f = fixture([BOX, BOX2]); f.seed(BOX); f.seed(BOX2);
  await service(f).sync();
  expect(f.global.db.prepare("SELECT machine_id,epoch,move_id FROM session_homes").all()).toEqual([{ machine_id: "", epoch: 1, move_id: null }]);
}, 5000);
it("conflicting copies of one store retain both observed unassigned origins", async () => {
  const f = fixture([BOX, BOX2]);
  const first = f.remotes.get(BOX)!.worktree, second = f.remotes.get(BOX2)!.worktree;
  second.db.prepare("UPDATE roam_meta SET store_key=?").run(first.storeKey); second.storeKey = first.storeKey;
  f.seed(BOX); f.seed(BOX2);
  await service(f).sync();
  expect(f.global.db.prepare("SELECT machine_id,epoch FROM session_homes").all()).toEqual([{ machine_id: "", epoch: 1 }]);
}, 5000);
it("global batches apply before worktree batches consult the current home", async () => {
  const f = fixture(); f.seed(); const remote = f.remotes.get(BOX)!;
  const homeSource = createReplica("global", HUB);
  try {
    homeSource.db.prepare("UPDATE roam_meta SET capture_enabled=1").run(); assignInitialHome(homeSource.db, "session-a", BOX, HUB);
    const batch = await exportBatch(homeSource.db, { after: 0, targetBytes: 4096, batchId: "home-batch" }, { encode: (_entity, body) => body });
    await remote.stores.accept("global", batch);
    const target = f.stores.openStore(remote.worktree.storeKey).db; addTodo(target, "session-a", "unlogged local copy");
    const result = await service(f).sync();
    expect(result.every(row => row.code === 0)).toBe(true);
    expect(target.prepare("SELECT uuid,text FROM todos").all()).toEqual([{ uuid: "todo-session-a", text: "portable" }]);
  } finally { homeSource.close(); }
}, 5000);
it("receipted transfers release artifact journal references on both machines", async () => {
  const f = fixture(); f.seed(); await service(f).sync();
  const exported = f.calls.find(call => call.operation.kind === "export" && call.operation.args.storeKey === f.remotes.get(BOX)!.worktree.storeKey)!;
  expect((f.journal as ArtifactJournal).hasArtifactReference(exported.operation.id)).toBe(false);
  expect((f.remotes.get(BOX)!.ports.journal as ArtifactJournal).hasArtifactReference(exported.operation.id)).toBe(false);
  const imported = f.calls.find(call => call.operation.kind === "import")!;
  expect((f.journal as ArtifactJournal).hasArtifactReference(imported.operation.args.artifactId as string)).toBe(false);
  expect((f.remotes.get(BOX)!.ports.journal as ArtifactJournal).hasArtifactReference(imported.operation.args.artifactId as string)).toBe(false);
}, 5000);
it("read-only remote calls never accumulate journal operations after failures", async () => {
  const f = fixture(); f.seed(); const sync = service(f);
  await sync.sync(); f.unavailable.add(BOX); await sync.sync(); f.unavailable.delete(BOX); await sync.sync();
  for (const root of [f.global.root, f.remotes.get(BOX)!.global.root]) {
    const db = openDb(join(root, "roam", "journal.db"));
    try { expect(db.prepare("SELECT kind FROM roam_operations WHERE kind IN ('stores','inventory','cursor','receipt','split')").all()).toEqual([]); }
    finally { db.close(); }
  }
}, 5000);
it("count-zero batches produce no import or receipt", async () => {
  const f = fixture(); const result = await service(f).sync();
  expect(result.every(row => row.code === 0)).toBe(true);
  expect(f.calls.filter(call => call.operation.kind === "import")).toEqual([]);
  expect(f.global.db.prepare("SELECT * FROM roam_receipts").all()).toEqual([]);
}, 5000);

it("revoked peers receive retire-only without any accepted sync cursor", async () => {
  const f = fixture();
  const db = openDb(join(f.global.root, "roam", "journal.db"));
  try {
    revokeMachine(db, BOX);
    const actions: string[] = [];
    const sync = createSync({ config: f.config, globalDb: f.global.db, stores: f.stores, journal: f.journal, transport: f.transport, clock: f.clock,
      revocationDb: db, async retireOnly(_peer, reply) { actions.push(reply.kind); } });
    const results = await sync.sync(BOX);
    expect(results[0].reason).toBe("machine-revoked");
    expect(actions).toEqual(["retire-only"]);
    expect(f.calls).toEqual([]);
    expect(await sync.barriers(BOX, [])).toBe(false);
    expect(f.global.db.prepare("SELECT * FROM roam_cursors").all()).toEqual([]);
  } finally { db.close(); }
}, 5000);

it("every peer sync mirrors only verified complete appended lines", async () => {
  const f = fixture();
  const sourceFile = join(f.global.root, "mirror-source.jsonl"), root = join(f.global.root, "mirrors");
  const home = assignInitialHome(f.global.db, "mirrored-session", BOX, HUB);
  if (home === "conflict") throw new Error("invalid fixture");
  mkdirSync(root);
  const header = JSON.stringify({ type: "session", version: 3, id: "mirrored-session", timestamp: "2026-01-01T00:00:00Z", cwd: f.global.root }) + "\n";
  const message = (id: string, parentId: string | null) => JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: id, timestamp: 1 } }) + "\n";
  writeFileSync(sourceFile, header + message("first", null), { mode: 0o600 });
  const sync = createSync({ config: f.config, globalDb: f.global.db, stores: f.stores, journal: f.journal, transport: f.transport, clock: f.clock,
    mirrors: { root, homes: () => [home], source: async () => inspectSession(sourceFile, "mirrored-session") } });
  expect((await sync.sync(BOX)).every(row => row.code === 0)).toBe(true);
  expect((await recoverMirror({ sessionId: home.sessionId, epoch: 1, machineId: BOX, root })).sha256).toBe((await inspectSession(sourceFile, home.sessionId)).sha256);
  appendFileSync(sourceFile, message("next", "first"));
  expect((await sync.sync(BOX)).every(row => row.code === 0)).toBe(true);
  expect((await recoverMirror({ sessionId: home.sessionId, epoch: 1, machineId: BOX, root })).sha256).toBe((await inspectSession(sourceFile, home.sessionId)).sha256);
  appendFileSync(sourceFile, '{"type":');
  expect((await sync.sync(BOX)).some(row => row.code !== 0)).toBe(true);
  expect((await recoverMirror({ sessionId: home.sessionId, epoch: 1, machineId: BOX, root })).size).toBe(Buffer.byteLength(header + message("first", null) + message("next", "first")));
}, 5000);

it("interrupted mirror append retains its caller-owned pending operation across sync retries", async () => {
  const f = fixture(), sourceFile = join(f.global.root, "pending-source.jsonl"), root = join(f.global.root, "mirrors");
  const home = assignInitialHome(f.global.db, "mirrored-session", BOX, HUB);
  if (home === "conflict") throw new Error("invalid fixture");
  writeFileSync(sourceFile, JSON.stringify({ type: "session", version: 3, id: home.sessionId, timestamp: "2026-01-01T00:00:00Z", cwd: f.global.root }) + "\n" + JSON.stringify({ type: "message", id: "first", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "synthetic", timestamp: 1 } }) + "\n", { mode: 0o600 });
  const ids: string[] = [], begin = f.journal.begin, record = f.journal.record;
  f.journal.begin = operation => { if (operation.kind === "sync-mirror") ids.push(operation.id); return begin(operation); };
  let fail = true;
  f.journal.record = (id, action, value) => { if (action === "mirror-append-complete" && fail) { fail = false; throw new Error("append reply lost"); } return record(id, action, value); };
  const ports = { config: f.config, globalDb: f.global.db, stores: f.stores, journal: f.journal, transport: f.transport, clock: f.clock,
    mirrors: { root, homes: () => [home], source: async () => inspectSession(sourceFile, home.sessionId) } };
  expect((await createSync(ports).sync(BOX)).some(row => row.code !== 0)).toBe(true);
  expect((await createSync(ports).sync(BOX)).every(row => row.code === 0)).toBe(true);
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
  expect(f.journal.lookupOperation?.(ids[0])?.state).toBe("done");
}, 5000);

it("revocation during peer resolution blocks the next sync call", async () => {
  const f = fixture(), db = openDb(join(f.global.root, "roam", "journal.db"));
  try {
    const resolve = f.transport.resolve;
    f.transport.resolve = async (...args) => { const peer = await resolve(...args); revokeMachine(db, BOX); return peer; };
    const sync = createSync({ config: f.config, globalDb: f.global.db, stores: f.stores, journal: f.journal, transport: f.transport, clock: f.clock, revocationDb: db });
    expect((await sync.sync(BOX))[0].reason).toBe("machine-revoked");
    expect(f.calls).toEqual([]);
  } finally { db.close(); }
}, 5000);

it("production recovery mirrors peer session bytes through the artifact port on sync", async () => {
  const f = fixture(); f.seed();
  const remote = f.remotes.get(BOX)!, file = join(remote.global.root, "session-a.jsonl");
  const bytes = JSON.stringify({ type: "session", version: 3, id: "session-a", cwd: remote.worktree.root, timestamp: "2026-01-01T00:00:00Z" }) + "\n" +
    JSON.stringify({ type: "message", id: "leaf-a", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "mirrored", timestamp: 1 } }) + "\n";
  writeFileSync(file, bytes, { mode: 0o600 });
  const home = assignInitialHome(f.global.db, "session-a", BOX, HUB);
  if (!home || home === "conflict") throw new Error("fixture home conflict");
  recordLocation(remote.global.db, { sessionId: "session-a", file, cwd: remote.worktree.root, stores: [remote.worktree.storeKey], home });
  const recovery = createProductionRecoveryPorts({ root: f.global.root, config: f.config, globalDb: f.global.db, journal: f.journal, transport: f.transport });
  const sync = createSync({ config: f.config, globalDb: f.global.db, journal: f.journal, transport: f.transport, clock: f.clock, stores: f.stores, ...recovery });
  const outcomes = await sync.sync(BOX);
  expect(outcomes.every(row => row.code === 0)).toBe(true);
  const mirror = await recoverMirror({ root: join(f.global.root, "roam", "mirrors"), sessionId: "session-a", machineId: BOX, epoch: 1 });
  expect(readFileSync(mirror.file, "utf8")).toBe(bytes);
  expect(f.calls.some(row => row.operation.kind === "mirror-export")).toBe(true);
  appendFileSync(file, JSON.stringify({ type: "message", id: "leaf-b", parentId: "leaf-a", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "appended", timestamp: 2 } }) + "\n");
  expect((await sync.sync(BOX)).every(row => row.code === 0)).toBe(true);
  const updated = await recoverMirror({ root: recovery.mirrors.root, sessionId: "session-a", machineId: BOX, epoch: 1 });
  expect(readFileSync(updated.file, "utf8")).toBe(readFileSync(file, "utf8"));
  const committed = readFileSync(updated.file);
  writeFileSync(file, bytes.replace("mirrored", "rewritten"));
  expect(await sync.sync(BOX)).toContainEqual(expect.objectContaining({ code: 1, reason: "mirror-source-rewritten:full-copy" }));
  expect(readFileSync(updated.file)).toEqual(committed);
}, 5000);

it.each([
  ["export-timeout", true], ["export-reset", true], ["export-dns", true], ["export-refused", false],
  ["copy-timeout", true], ["copy-closed", true], ["copy-corrupt", false],
] as const)("mirror %s after inventory preserves connectivity proof and retry cadence", async (kind, outage) => {
  const f = fixture(); f.config.syncMs = 1000; f.config.limits.retryDelaysMs = [];
  const remote = f.remotes.get(BOX)!, file = join(remote.global.root, "session-a.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-a", cwd: remote.worktree.root, timestamp: "2026-01-01T00:00:00Z" }) + "\n" +
    JSON.stringify({ type: "message", id: "leaf-a", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "portable", timestamp: 1 } }) + "\n", { mode: 0o600 });
  const home = assignInitialHome(f.global.db, "session-a", BOX, HUB);
  if (home === "conflict") throw new Error("fixture home conflict");
  recordLocation(remote.global.db, { sessionId: "session-a", file, cwd: remote.worktree.root, stores: [remote.worktree.storeKey], home });
  const recovery = createProductionRecoveryPorts({ root: f.global.root, config: f.config, globalDb: f.global.db, journal: f.journal, transport: f.transport });
  const native = await productionObservationFixture(f.global.root, f.config, f.global.db, f.transport);
  let afterSync!: Parameters<HubRuntimePorts["prepare"]>[0];
  const recoveries: string[] = [], timers: Array<{ ms: number; cancelled: boolean; fn(): void }> = [];
  const sync = createSync({ config: f.config, globalDb: f.global.db, journal: f.journal, stores: f.stores, transport: f.transport,
    clock: f.clock, ...recovery, onPeerSync: (peer, results) => afterSync(peer, results) });
  const hubRoot = mkdtempSync(join(dirname(scratchDbPath("hub")), "hub-"));
  const hub = await runHub({ config: f.config, globalDb: f.global.db, journal: f.journal, runtimeRoot: hubRoot, socketPath: join(hubRoot, "hub.sock"),
    identity: { pid: process.pid, startIdentity: "process-1" }, async probe() { return { kind: "live", startIdentity: "process-1" }; },
    clock: { now: f.clock.now, later(ms, fn) { const timer = { ms, cancelled: false, fn }; timers.push(timer); return () => { timer.cancelled = true; }; } },
    sync, observe: native.observe, async prepare(callback) { afterSync = callback; }, drain: () => sync.drain(), async closeStores() {},
    async recoverPeerMoves(id) { recoveries.push(id); }, async homeChangeInProgress() { return false; },
    placement: { async reconcile() { return { pending: [] }; } }, notices: { async publish() {}, async clear() {} } });
  try {
    f.unavailable.add(BOX); native.setState("unreachable");
    expect(await sync.sync(BOX)).toMatchObject([{ code: 3 }]);
    expect(peerState.loadPeerState(f.global.db, BOX, f.config.limits.targetBatchBytes).failures).toBe(1);
    f.unavailable.delete(BOX); native.setState("connected");
    f.hook((_peer, op) => {
      if (op.kind !== "mirror-export") return;
      if (kind === "export-timeout") throw new HerdrError("cli-timeout", "synthetic timeout");
      if (kind === "export-reset") throw Object.assign(new Error("synthetic reset"), { code: "ECONNRESET" });
      if (kind === "export-dns") throw Object.assign(new Error("synthetic dns failure"), { code: "ENOTFOUND" });
    });
    f.replyHook((_peer, op, bytes) => {
      if (op.kind !== "mirror-export" || kind !== "export-refused") return bytes;
      const reply = JSON.parse(bytes.toString()); reply.code = 1; reply.reason = "mirror-home-changed"; reply.value = null;
      return Buffer.from(JSON.stringify(reply));
    });
    const read = f.transport.read.bind(f.transport);
    vi.spyOn(f.transport, "read").mockImplementation(async (...args) => {
      if (kind === "copy-timeout") throw new HerdrError("cli-timeout", "synthetic timeout");
      if (kind === "copy-closed") throw new HerdrError("connection-closed", "synthetic closed connection", { exitCode: 1 });
      if (kind === "copy-corrupt") return Buffer.from("corrupt");
      return read(...args);
    });
    const results = await sync.sync(BOX);
    expect(results).toContainEqual(expect.objectContaining({ code: outage ? kind === "copy-closed" ? 1 : 3 : 1,
      reason: kind === "copy-closed" ? "Peer command failed (connection-closed)" : kind.startsWith("copy-") ? "Artifact pull is pending" : outage ? "Peer operation is pending reconciliation" : "mirror-home-changed" }));
    expect(f.calls.some(call => call.operation.kind === "inventory")).toBe(true);
    expect(peerState.loadPeerState(f.global.db, BOX, f.config.limits.targetBatchBytes)).toMatchObject({ failures: outage ? 2 : 0 });
    expect(await native.observe(f.peers[0], results)).toMatchObject({ syncVerified: !outage });
    expect(f.timers.find(timer => !timer.cancelled)?.ms).toBe(outage ? 60_000 : 1000);
    const pending = timers.filter(timer => !timer.cancelled && timer.ms === 0);
    expect(pending).toHaveLength(outage ? 0 : 1);
    for (const timer of pending) { timer.cancelled = true; timer.fn(); }
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(recoveries).toEqual(outage ? [] : [BOX]);
  } finally { await hub.stop(); await native.stop(); rmSync(hubRoot, { recursive: true, force: true }); }
}, 5000);

it("production retire-only delivery reaches the surviving supervisor before any peer sync", async () => {
  const f = fixture(), remote = f.remotes.get(BOX)!, events: string[] = [];
  const lifecycle = supervisorRetirementLifecycle(remote.global.root, remote.ports.config, async () => { events.push("stop-sessions"); });
  await lifecycle.start();
  try {
    const db = openDb(join(f.global.root, "roam", "journal.db"));
    try { revokeMachine(db, BOX); } finally { db.close(); }
    const recovery = createProductionRecoveryPorts({ root: f.global.root, config: f.config, globalDb: f.global.db, journal: f.journal, transport: f.transport });
    const reply = recovery.supervisorHandshake(BOX);
    expect(reply).toMatchObject({ kind: "retire-only", machineId: BOX });
    await recovery.retireOnly(f.peers[0], reply as Extract<typeof reply, { kind: "retire-only" }>);
    expect(events).toEqual(["stop-sessions"]);
    expect(f.calls.map(row => row.operation.kind)).toEqual(["supervisor-retire"]);
  } finally { await lifecycle.stop(); }
}, 5000);

it.each(["missing", "corrupt"])("%s mapped scopes defer first homes and writes without stopping other stores", async mode => {
  const f = fixture([BOX, BOX2]); f.seed(BOX, "hidden-session"); f.seed(BOX2, "healthy-session");
  const key = f.remotes.get(BOX)!.worktree.storeKey, sync = service(f);
  f.unavailable.add(BOX2);
  expect((await sync.sync()).some(row => row.code !== 0)).toBe(true);
  expect(f.global.db.prepare("SELECT * FROM session_homes").all()).toEqual([]);
  const existing = f.stores.openStore(key).db;
  expect(existing.prepare("SELECT name FROM sessions WHERE id='hidden-session'").get()).toEqual({ name: "portable" });
  f.unavailable.delete(BOX2); f.calls.length = 0;
  const path = join(f.global.root, "unavailable-checkout");
  if (mode === "corrupt") { mkdirSync(join(path, ".spider"), { recursive: true }); writeFileSync(join(path, ".spider", "project.db"), "not sqlite"); }
  f.remotes.get(BOX2)!.global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','workspace-0',?)").run(path);
  const result = await sync.sync();
  expect(result.every(row => row.code === 0)).toBe(true);
  expect(f.global.db.prepare("SELECT session_id,machine_id FROM session_homes ORDER BY session_id").all()).toEqual([{ session_id: "healthy-session", machine_id: BOX2 }]);
  expect(f.calls.filter(call => call.machine === BOX2 && call.operation.kind === "inventory").map(call => call.operation.args.storeKey)).toContain("global");
  expect(peerState.loadPeerState(f.global.db, BOX2, 4096).gathered?.[key]).toBe(false);
  expect(peerState.loadPeerState(f.global.db, BOX2, 4096).observation?.lastSyncAt).toBeNull();
  expect(f.calls.filter(call => call.operation.args.storeKey === key)).toEqual([]);
  expect(existing.prepare("SELECT name FROM sessions WHERE id='hidden-session'").get()).toEqual({ name: "portable" });
}, 5000);
it("a foreign-machine mapped store stays ungathered and withholds its first home", async () => {
  const f = fixture([BOX, BOX2]), foreign = createReplica("worktree", HUB);
  try {
    f.seed(BOX, "hidden-session"); f.seed(BOX2, "healthy-session");
    const key = f.remotes.get(BOX)!.worktree.storeKey, remote = f.remotes.get(BOX2)!, sync = service(f);
    f.unavailable.add(BOX2);
    expect((await sync.sync()).some(row => row.code !== 0)).toBe(true);
    expect(f.global.db.prepare("SELECT * FROM session_homes").all()).toEqual([]);
    f.unavailable.delete(BOX2); f.calls.length = 0;
    foreign.db.prepare("UPDATE roam_meta SET store_key=NULL WHERE id=1").run();
    remote.global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','workspace-0',?)").run(foreign.root);
    writeLocal(remote.global.db, "mapping-redirect", key, foreign.db.raw.name);
    expect((await sync.sync()).every(row => row.code === 0)).toBe(true);
    expect(f.global.db.prepare("SELECT session_id,machine_id FROM session_homes ORDER BY session_id").all())
      .toEqual([{ session_id: "healthy-session", machine_id: BOX2 }]);
    expect(peerState.loadPeerState(f.global.db, BOX2, 4096).ungathered).toContainEqual({ key, scope: "worktree",
      path: foreign.db.raw.name, code: "uninspectable", check: "store-machine-mismatch" });
    expect(f.calls.filter(call => call.operation.args.storeKey === key)).toEqual([]);
    expect(foreign.db.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get()).toEqual({ machine_id: HUB, store_key: null });
  } finally { foreign.close(); }
}, 5000);

it("one corrupt registered store leaves global and healthy project sync usable", async () => {
  const f = fixture(); f.seed(); const remote = f.remotes.get(BOX)!;
  const file = join(remote.global.root, "corrupt.db"); writeFileSync(file, "not sqlite");
  remote.global.db.prepare("INSERT INTO global_memory(uuid,category,content,created_at) VALUES ('global-readable','insight','global portable',1)").run();
  remote.global.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('broken',?,?,1,1)").run(remote.global.root, file);
  expect((await service(f).sync()).every(row => row.code === 0)).toBe(true);
  expect(f.stores.openStore(remote.worktree.storeKey).db.prepare("SELECT name FROM sessions WHERE id='session-a'").get()).toEqual({ name: "portable" });
  expect(f.calls.filter(call => call.operation.kind === "inventory").map(call => call.operation.args.storeKey)).toContain("global");
  expect(f.global.db.prepare("SELECT content FROM global_memory WHERE uuid='global-readable'").get()).toEqual({ content: "global portable" });
}, 5000);

it("a later peer sync reuses discovery while another peer is transferring", async () => {
  const f = fixture([BOX, BOX2]), sync = service(f);
  let enter!: () => void, release!: () => void, secondEnter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  const secondEntered = new Promise<void>(resolve => { secondEnter = resolve; });
  let holding = false, held = false, overlapped = false;
  f.hook(async (peer, op) => {
    if (peer.machineId === BOX && op.kind === "stores" && holding) overlapped = true;
    if (peer.machineId === BOX && op.kind === "inventory" && !held) { held = true; holding = true; enter(); await paused; holding = false; }
    if (peer.machineId === BOX2 && op.kind === "inventory") secondEnter();
  });
  const first = sync.sync(BOX); await entered;
  const second = sync.sync(BOX2); await secondEntered;
  release(); await Promise.all([first, second]);
  expect(overlapped).toBe(false);
}, 5000);
