import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "@spider/db-core";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { exportBatch } from "@spider/db-core/roam/export";
import { catalogReplica } from "@spider/db-core/roam/catalog";
import { handleAgentOperation } from "../agent";
import { stageArtifact } from "../artifacts";
import { assignInitialHome } from "../homes";
import { runHub, runStandaloneHub } from "../hub";
import { requestHubControl } from "../control-socket";
import type { Clock } from "../contracts";
import * as staging from "../staging";
import { rememberRoamSlot } from "@spider/herdr/roam-placement";
import type { HcClient } from "@spider/herdr/contracts";
import type { TerminalRegistry } from "@spider/herdr/sessions/registry";
import { hash } from "@spider/herdr/sessions/registry";
import * as registryApi from "@spider/herdr/sessions/registry";
import * as mappingApi from "@spider/db-core/roam/repo-map";
import * as storeApi from "../stores";
import * as cleanupApi from "../cleanup";
import * as syncApi from "../sync";
import { network, HUB, BOX } from "./sync-fixture";

const handles: Array<{ stop(): Promise<void> }> = [];
const fixtures: Array<ReturnType<typeof network>> = [];
const roots: string[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) await handle.stop();
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0).reverse()) f.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Notice = { id: string; kind: "unreachable" | "suspended"; machineId: string; sessionId?: string };
const ready = { operationId: "op-1", sessionId: "session-1", epoch: 1, cwd: "/fixture/work", file: "/fixture/session.jsonl", core: "remote-core", terminal: "box-1.invalid/t1" };
function fixture() {
  const f = network(); fixtures.push(f);
  vi.spyOn(staging, "defaultStagingRoot").mockReturnValue(f.root);
  const runtimeRoot = mkdtempSync(join(resolve(".spider/scratch"), "hub-")); roots.push(runtimeRoot);
  const socketPath = join(runtimeRoot, "hub.sock");
  let now = 1_000_000;
  const timers: { at: number; delay: number; fn(): void; cancelled: boolean }[] = [];
  const clock: Clock = { now: () => now, later(delay, fn) { const timer = { at: now + delay, delay, fn, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } };
  let reachability: "reachable" | "unreachable" | "unknown" = "reachable";
  let readiness: readonly typeof ready[] | null = [];
  let suspended: readonly { sessionId: string; epoch: number }[] | null = [];
  let pending: readonly string[] = [];
  let failPlacement = false, moving = false, active: boolean | null = false;
  const placements: Array<readonly typeof ready[]> = [];
  const notices: Notice[] = [], clears: string[] = [], publishCalls: string[] = [], notified = new Set<string>();
  const noticeWaiters: Array<() => void> = [];
  const ports = {
    config: f.config, globalDb: f.global.db, journal: f.journal, transport: f.transport, clock,
    runtimeRoot, socketPath,
    identity: { pid: 12345, startIdentity: "fixture-process" },
    async probe() { return { kind: "live" as const, startIdentity: "fixture-process" }; },
    placement: { async reconcile(rows: readonly typeof ready[]) { placements.push([...rows]); if (failPlacement) throw new Error("unknown launch outcome"); return { pending }; } },
    async observe() { return { reachability, readiness, suspensions: suspended }; },
    notices: {
      async publish(notice: Notice) { publishCalls.push(notice.id); if (!notified.has(notice.id)) { notified.add(notice.id); notices.push(notice); for (const waiter of noticeWaiters.splice(0)) waiter(); } },
      async clear(id: string) { clears.push(id); },
    },
    async homeChangeInProgress() { return moving; },
    artifactActive() { return active; },
  };
  async function start() { const hub = await runStandaloneHub(ports); handles.push(hub); return hub; }
  async function request(op: "status" | "sync" | "disable") { return requestHubControl(socketPath, op === "sync" ? { op, machine: BOX } : { op }); }
  function home() { assignInitialHome(f.global.db, "session-1", BOX, HUB); }
  function fire(delay: number) {
    const timer = timers.find(item => !item.cancelled && item.delay === delay);
    if (!timer) throw new Error(`Missing fixture timer ${delay}`);
    timer.cancelled = true; now = timer.at; timer.fn();
  }
  return { f, ports, runtimeRoot, socketPath, timers, placements, notices, clears, publishCalls, start, request, home, fire,
    noticeReady() { return notices.length ? Promise.resolve() : new Promise<void>(resolve => noticeWaiters.push(resolve)); },
    unreachable() { reachability = "unreachable"; f.unavailable.add(BOX); },
    reachable() { reachability = "reachable"; f.unavailable.delete(BOX); },
    unknown() { reachability = "unknown"; },
    setReadiness(rows: readonly typeof ready[] | null) { readiness = rows; },
    setSuspended(rows: readonly { sessionId: string; epoch: number }[] | null) { suspended = rows; },
    setPending(rows: readonly string[]) { pending = rows; },
    setPlacementFailure(value: boolean) { failPlacement = value; },
    setMoving(value: boolean) { moving = value; },
    setActive(value: boolean | null) { active = value; },
    setNow(value: number) { now = value; },
  };
}

it("refuses a staging root that belongs to a different global database", async () => {
  const h = fixture();
  const wrongRoot = join(h.runtimeRoot, "other", "staging");
  vi.mocked(staging.defaultStagingRoot).mockReturnValue(wrongRoot);
  const started = runStandaloneHub(h.ports).then(hub => { handles.push(hub); return hub; });
  await expect(started).rejects.toThrow(/staging root.*global database/i);
  expect(existsSync(wrongRoot)).toBe(false);
  expect(existsSync(h.socketPath)).toBe(false);
}, 5000);

it("second hub refuses the process lock", async () => {
  const h = fixture(); const first = await h.start();
  await expect(h.start()).rejects.toThrow(/lock/i);
  expect((await h.request("status")).code).toBe(0);
  await first.stop();
  const replacement = await h.start();
  expect((await h.request("status")).code).toBe(0);
  await replacement.stop();
}, 5000);

it("uncertain lock ownership blocks startup and proved absence permits recovery", async () => {
  const h = fixture();
  const directory = join(h.runtimeRoot, "locks", hash("roam-hub")); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stale = join(directory, "foreign.json");
  writeFileSync(stale, JSON.stringify({ version: 1, pid: 67890, startIdentity: "other-process", number: 1 }), { mode: 0o600 });
  const probe = async (pid: number) => pid === 12345 ? { kind: "live" as const, startIdentity: "fixture-process" } : { kind: "unknown" as const };
  await expect(runStandaloneHub({ ...h.ports, probe })).rejects.toThrow(/lock|uncertain/i);
  expect(existsSync(stale)).toBe(true);
  expect(existsSync(h.socketPath)).toBe(false);
  const absent = async (pid: number) => pid === 12345 ? { kind: "live" as const, startIdentity: "fixture-process" } : { kind: "absent" as const };
  const hub = await runStandaloneHub({ ...h.ports, probe: absent }); handles.push(hub);
  expect(existsSync(stale)).toBe(false);
  expect((await h.request("status")).code).toBe(0);
}, 5000);

it("failed socket startup releases the lock and leaves a symlink target untouched", async () => {
  const h = fixture(); const target = join(h.runtimeRoot, "target");
  writeFileSync(target, "untouched"); symlinkSync(target, h.socketPath);
  await expect(h.start()).rejects.toThrow(/unsafe|symlink/i);
  expect(readFileSync(target, "utf8")).toBe("untouched");
  unlinkSync(h.socketPath);
  await h.start();
  expect((await h.request("status")).code).toBe(0);
}, 5000);

it("a startup failure is reported only after cleanup releases the lock", async () => {
  const h = fixture(); let entered!: () => void, release!: () => void;
  const cleaning = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const starting = runHub({ ...h.ports, sync: { start() {}, stop() {}, async sync() { return []; }, async barriers() { return false; } },
    async prepare() { throw new Error("fixture startup failure"); }, async drain() {},
    async closeStores() { entered(); await gate; } });
  const failure = starting.then(() => false, () => true);
  await cleaning;
  let settled = false; void failure.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  release(); expect(await failure).toBe(true);
  const hub = await h.start();
  expect((await h.request("status")).code).toBe(0);
  await hub.stop();
}, 5000);

it("hub shutdown waits for an active transfer before closing its stores", async () => {
  const h = fixture(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.f.hook(async (_peer, operation) => { if (operation.kind === "stores") { entered(); await gate; } });
  const hub = await h.start();
  const request = h.request("sync").then(() => "replied", () => "disconnected");
  await started;
  let stopped = false;
  const stopping = hub.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release(); await stopping;
  expect(stopped).toBe(true);
  expect(await request).toBe("disconnected");
  expect(h.f.global.db.prepare("SELECT count(*) AS n FROM session_homes").get()).toEqual({ n: 0 });
}, 5000);

it("unreachable home notifies once and clears on recovery", async () => {
  const h = fixture(); h.home(); h.unreachable();
  const first = await h.start(); await h.request("sync");
  expect(h.notices).toEqual([]);
  h.fire(600_000); await h.noticeReady();
  const noticesAfterTenMinutes = h.notices.filter(notice => notice.kind === "unreachable");
  expect(noticesAfterTenMinutes).toHaveLength(1);
  await first.stop(); await h.start(); await h.request("sync");
  expect(h.notices.filter(notice => notice.kind === "unreachable")).toHaveLength(1);
  h.reachable(); await h.request("sync");
  expect(h.clears).toContain(noticesAfterTenMinutes[0].id);
  expect((await h.request("status")).value).toMatchObject({ warnings: [] });
}, 5000);

it("resumes the unreachable deadline after restart without alerting sessions that have no home", async () => {
  const h = fixture(); h.unreachable();
  const first = await h.start(); await h.request("sync");
  expect(h.timers.filter(timer => timer.delay === 600_000 && !timer.cancelled)).toEqual([]);
  h.home(); await h.request("sync");
  await first.stop(); h.setNow(1_300_000);
  await h.start();
  h.fire(300_000); await h.noticeReady();
  expect(h.notices.filter(notice => notice.kind === "unreachable")).toHaveLength(1);
}, 5000);

it("does not clear an unreachable notice on an unknown observation", async () => {
  const h = fixture(); h.home(); h.unreachable();
  await h.start(); await h.request("sync"); h.fire(600_000); await h.noticeReady();
  h.unknown(); await h.request("sync");
  expect(h.clears).toEqual([]);
  expect((await h.request("status")).value).toMatchObject({ warnings: [{ kind: "unreachable" }] });
}, 5000);

it("disable refuses an in-progress home change", async () => {
  const h = fixture(); h.setMoving(true); await h.start();
  expect(await h.request("disable")).toMatchObject({ code: 1 });
  expect((await h.request("sync")).code).toBe(0);
  h.setMoving(false);
  expect(await h.request("disable")).toMatchObject({ code: 0 });
  expect(await h.request("sync")).toMatchObject({ code: 1 });
}, 5000);

it("disable refuses when a home change cannot be inspected", async () => {
  const h = fixture();
  const hub = await runStandaloneHub({ ...h.ports, async homeChangeInProgress() { return null; } }); handles.push(hub);
  expect(await h.request("disable")).toMatchObject({ code: 1 });
  expect((await h.request("sync")).code).toBe(0);
}, 5000);

it("retains pending placement across restart and reconciles only fresh homed terminals", async () => {
  const h = fixture(); h.home(); h.setReadiness([ready]); h.setPending([ready.terminal]);
  const first = await h.start(); await h.request("sync");
  expect((await h.request("status")).value).toMatchObject({ pending: [{ sessionId: "session-1", terminal: ready.terminal }] });
  await first.stop(); h.unreachable(); await h.start(); await h.request("sync");
  expect(h.placements).toHaveLength(1);
  expect((await h.request("status")).value).toMatchObject({ pending: [{ sessionId: "session-1", terminal: ready.terminal }] });
  h.reachable(); h.setPending([]); await h.request("sync");
  expect(h.placements).toHaveLength(2);
  expect((await h.request("status")).value).toMatchObject({ pending: [] });
}, 5000);

it("places only current homes and retains pending state when readiness is unknown", async () => {
  const h = fixture(); h.home();
  h.setReadiness([{ ...ready, sessionId: "foreign-session" }, { ...ready, epoch: 2 }, { ...ready, terminal: "other.invalid/t1" }]);
  await h.start(); await h.request("sync");
  expect(h.placements[0]).toEqual([]);
  h.setReadiness([ready]); h.setPending([ready.terminal]); await h.request("sync");
  h.setReadiness(null); await h.request("sync");
  expect(h.placements).toHaveLength(2);
  expect((await h.request("status")).value).toMatchObject({ pending: [{ sessionId: "session-1", terminal: ready.terminal }] });
}, 5000);

it("keeps an unknown placement outcome pending for the next reconciliation", async () => {
  const h = fixture(); h.home(); h.setReadiness([ready]); h.setPlacementFailure(true);
  const first = await h.start(); await h.request("sync");
  expect((await h.request("status")).value).toMatchObject({ pending: [{ sessionId: "session-1", terminal: ready.terminal }] });
  await first.stop(); h.setPlacementFailure(false); h.setPending([ready.terminal]);
  await h.start(); await h.request("sync");
  expect((await h.request("status")).value).toMatchObject({ pending: [{ sessionId: "session-1", terminal: ready.terminal }] });
}, 5000);

it("real placement never relaunches an unknown proxy after hub restart", async () => {
  const h = fixture(); h.home(); h.setReadiness([ready]);
  const lock = registryApi.withProcessLock;
  vi.spyOn(registryApi, "withProcessLock").mockImplementation((root, key, operation, options) => lock(root, key, operation,
    key === "roam-placement" ? { ...options, identity: h.ports.identity, probe: h.ports.probe } : options));
  const stateRoot = join(h.runtimeRoot, "placement");
  await rememberRoamSlot(stateRoot, "session-1", { space: "s1", tab: "tb1" } as Parameters<typeof rememberRoamSlot>[2]);
  let launches = 0;
  const hc = {
    async identity() { return { coreId: "local-core" }; },
    async run() { launches++; throw new Error("unknown launch outcome"); },
    events() { return { ready: Promise.resolve(), subscribe(callback: (event: unknown) => void) {
      queueMicrotask(() => callback({ type: "snapshot", terminals: [] })); return () => {};
    } }; },
  } as unknown as HcClient;
  const registry = { async list() { return []; } } as unknown as TerminalRegistry;
  const placement = { app: null, hc, registry, hcBinary: join(h.runtimeRoot, "fixture-hc"), stateRoot };
  const first = await runStandaloneHub({ ...h.ports, placement }); handles.push(first);
  await h.request("sync");
  expect(launches).toBe(1);
  expect((await h.request("status")).value).toMatchObject({ pending: [{ terminal: ready.terminal }] });
  await first.stop();
  const second = await runStandaloneHub({ ...h.ports, placement }); handles.push(second);
  await h.request("sync");
  expect(launches).toBe(1);
  expect((await h.request("status")).value).toMatchObject({ pending: [{ terminal: ready.terminal }] });
}, 5000);

it("prunes a removed session from durable placement state and retains existing and unknown sessions", async () => {
  const h = fixture();
  const key = h.f.remotes.get(BOX)!.worktree.storeKey;
  const worktree = h.f.stores.openStore(key).db;
  worktree.prepare("INSERT INTO sessions(id,name,started_at) VALUES (?,?,1)").run("removed-session", "removed");
  worktree.prepare("INSERT INTO sessions(id,name,started_at) VALUES (?,?,1)").run("kept-session", "kept");
  worktree.prepare("INSERT INTO sessions(id,name,started_at) VALUES (?,?,1)").run("homed-session", "homed");
  h.f.global.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES ('homed-session',?,1,NULL,1)").run(BOX);
  catalogReplica(h.f.global.db, key, worktree);
  worktree.prepare("DELETE FROM sessions WHERE id IN ('removed-session','homed-session')").run();
  catalogReplica(h.f.global.db, key, worktree);
  const stateRoot = join(h.f.global.root, "roam", "placement");
  const slot = { space: "s1", tab: "tb1" } as Parameters<typeof rememberRoamSlot>[2];
  for (const session of ["removed-session", "kept-session", "homed-session", "unknown-session"]) await rememberRoamSlot(stateRoot, session, slot);
  const hc = { async identity() { return { coreId: "local-core" }; } } as unknown as HcClient;
  const registry = { async list() { return []; } } as unknown as TerminalRegistry;
  const placement = { app: null, hc, registry, hcBinary: join(h.runtimeRoot, "fixture-hc"), stateRoot };
  const hub = await runStandaloneHub({ ...h.ports, placement }); handles.push(hub);
  await h.request("sync");
  const state = JSON.parse(readFileSync(join(stateRoot, "roam-placement.json"), "utf8")) as { slots: Array<{ session: string }> };
  expect(state.slots.map(slot => slot.session).sort()).toEqual(["homed-session", "kept-session", "unknown-session"]);
  expect(existsSync(join(h.f.global.root, "roam", "placement", "roam-placement.json"))).toBe(true);
}, 5000);

it("keeps a recreated session even when its catalog still says the store is empty", async () => {
  const h = fixture();
  const key = h.f.remotes.get(BOX)!.worktree.storeKey;
  const worktree = h.f.stores.openStore(key).db;
  worktree.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('recreated','before',1)").run();
  catalogReplica(h.f.global.db, key, worktree);
  worktree.prepare("DELETE FROM sessions WHERE id='recreated'").run();
  catalogReplica(h.f.global.db, key, worktree);
  const stateRoot = join(h.f.global.root, "roam", "placement");
  await rememberRoamSlot(stateRoot, "recreated", { space: "s1", tab: "tb1" } as Parameters<typeof rememberRoamSlot>[2]);
  const hc = { async identity() { return { coreId: "local-core" }; } } as unknown as HcClient;
  const registry = { async list() { return []; } } as unknown as TerminalRegistry;
  const hub = await runStandaloneHub({ ...h.ports, placement: { app: null, hc, registry, hcBinary: join(h.runtimeRoot, "fixture-hc"), stateRoot } }); handles.push(hub);
  worktree.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('recreated','after',2)").run();
  expect(h.f.global.db.prepare("SELECT stores_json FROM roam_locations WHERE session_id='recreated'").get()).toEqual({ stores_json: "[]" });
  await h.request("sync");
  const state = JSON.parse(readFileSync(join(stateRoot, "roam-placement.json"), "utf8")) as { slots: Array<{ session: string }> };
  expect(state.slots.map(slot => slot.session)).toEqual(["recreated"]);
}, 5000);

it("retains a deleted-session slot while a mapped store is unavailable", async () => {
  const h = fixture();
  const key = h.f.remotes.get(BOX)!.worktree.storeKey;
  const worktree = h.f.stores.openStore(key).db;
  worktree.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('possibly-removed','before',1)").run();
  catalogReplica(h.f.global.db, key, worktree);
  worktree.prepare("DELETE FROM sessions WHERE id='possibly-removed'").run();
  catalogReplica(h.f.global.db, key, worktree);
  h.f.global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES (?,?,?)")
    .run("unavailable-repo", "workspace", join(h.runtimeRoot, "missing-checkout"));
  const stateRoot = join(h.f.global.root, "roam", "placement");
  await rememberRoamSlot(stateRoot, "possibly-removed", { space: "s1", tab: "tb1" } as Parameters<typeof rememberRoamSlot>[2]);
  const hc = { async identity() { return { coreId: "local-core" }; } } as unknown as HcClient;
  const registry = { async list() { return []; } } as unknown as TerminalRegistry;
  const hub = await runStandaloneHub({ ...h.ports, placement: { app: null, hc, registry, hcBinary: join(h.runtimeRoot, "fixture-hc"), stateRoot } }); handles.push(hub);
  await h.request("sync");
  const state = JSON.parse(readFileSync(join(stateRoot, "roam-placement.json"), "utf8")) as { slots: Array<{ session: string }> };
  expect(state.slots.map(slot => slot.session)).toEqual(["possibly-removed"]);
}, 5000);

it("suspension emits one durable notice and clears it on a confirmed recovery", async () => {
  const h = fixture(); h.home(); h.setSuspended([{ sessionId: "session-1", epoch: 1 }]);
  const first = await h.start(); await h.request("sync"); await h.request("sync");
  expect(h.notices.filter(notice => notice.kind === "suspended")).toHaveLength(1);
  await first.stop(); await h.start(); await h.request("sync");
  expect(h.notices.filter(notice => notice.kind === "suspended")).toHaveLength(1);
  expect(h.publishCalls).toEqual([h.notices[0].id]);
  h.setSuspended([]); await h.request("sync");
  expect(h.clears).toContain(h.notices[0].id);
  expect((await h.request("status")).value).toMatchObject({ warnings: [] });
}, 5000);

it("retries a lost notification reply with the same durable identity", async () => {
  const h = fixture(); h.home(); h.setSuspended([{ sessionId: "session-1", epoch: 1 }]);
  const publish = h.ports.notices.publish; let lost = true;
  h.ports.notices.publish = async notice => { await publish(notice); if (lost) { lost = false; throw new Error("lost notification reply"); } };
  const first = await h.start(); await h.request("sync");
  expect(h.notices).toHaveLength(1);
  await first.stop(); await h.start(); await h.request("sync");
  expect(h.notices).toHaveLength(1);
  const state = readLocal<{ suspensions: { id: string; delivered: boolean }[] }>(h.f.global.db, "hub-peer", BOX);
  expect(state?.suspensions).toMatchObject([{ id: h.notices[0].id, delivered: true }]);
}, 5000);

it("recovery precedes catalog repair, cleanup, and sync construction and shutdown drains before closing stores", async () => {
  const h = fixture(); const order: string[] = [];
  const resume = mappingApi.resumePendingMappings;
  vi.spyOn(mappingApi, "resumePendingMappings").mockImplementation(async db => { order.push("resume"); await resume(db); });
  const makeStores = storeApi.createStorePort;
  vi.spyOn(storeApi, "createStorePort").mockImplementation((config, db) => {
    order.push("stores"); const stores = makeStores(config, db);
    const recover = stores.recoverCatalog.bind(stores), close = stores.close.bind(stores);
    stores.recoverCatalog = () => { order.push("catalog"); recover(); };
    stores.close = () => { order.push("close"); close(); };
    return stores;
  });
  const sweep = cleanupApi.sweepStoreArtifacts;
  vi.spyOn(cleanupApi, "sweepStoreArtifacts").mockImplementation((...args) => { order.push("sweep"); sweep(...args); });
  const makeSync = syncApi.createSync;
  vi.spyOn(syncApi, "createSync").mockImplementation(args => {
    order.push("create-sync"); const service = makeSync(args);
    const start = service.start.bind(service), stop = service.stop.bind(service), drain = service.drain.bind(service);
    service.start = () => { order.push("start"); start(); };
    service.stop = () => { order.push("stop"); stop(); };
    service.drain = async () => { order.push("drain"); await drain(); };
    return service;
  });
  const hub = await h.start();
  expect(order).toEqual(["resume", "stores", "catalog", "sweep", "create-sync", "start"]);
  await hub.stop();
  expect(order).toEqual(["resume", "stores", "catalog", "sweep", "create-sync", "start", "stop", "drain", "close"]);
}, 5000);

it("startup records failed mappings but resumes other intents before sync", async () => {
  const h = fixture(); const db = h.f.global.db;
  const goodPath = join(h.f.global.root, "checkout"); mkdirSync(goodPath);
  const intent = (repo: string, target: string) => ({ kind: "workspace", identity: JSON.stringify([repo, "workspace"]), target_path: target,
    store_key: `worktree:${repo}:workspace`, command_json: null, attempt_id: `attempt-${repo}` });
  const bad = intent("bad-repo", join(h.f.global.root, "missing")), good = intent("good-repo", goodPath);
  const key = (repo: string) => JSON.stringify(["workspace", JSON.stringify([repo, "workspace"])]);
  writeLocal(db, "mapping-intent", key("bad-repo"), bad);
  writeLocal(db, "mapping-intent", key("good-repo"), good);
  await h.start();
  expect(readLocal(db, "mapping-intent", key("bad-repo"))).toMatchObject(bad);
  expect(readLocal(db, "mapping-failure", key("bad-repo"))).toMatchObject({ storeKey: bad.store_key });
  expect(readLocal(db, "mapping-intent", key("good-repo"))).toBeUndefined();
  expect(db.prepare("SELECT repo_key FROM roam_workspace_maps").all()).toEqual([{ repo_key: "good-repo" }]);
  expect((await h.request("status")).code).toBe(0);
}, 5000);

it("direct agent imports update the hub catalog after commit", async () => {
  const h = fixture(); h.f.seed();
  const source = h.f.remotes.get(BOX)!.worktree;
  const batch = await exportBatch(source.db, { after: 0, targetBytes: 4096, batchId: "direct-import" }, { encode: (_entity, body) => body });
  const sourceRoot = join(source.root, "source-staging");
  const manifest = await stageArtifact(batch.file, "batch", h.f.config.limits, { root: sourceRoot, artifactId: "direct-artifact" });
  const hub = await h.start();
  const incoming = staging.openStaging(hub.agentPorts.root, BOX, h.f.config.limits);
  try {
    incoming.declare(manifest, "direct-transfer");
    for (const chunk of manifest.chunks) incoming.receive(manifest, chunk.index,
      staging.readPrivate(staging.sourceChunk(sourceRoot, manifest.id, chunk.index, chunk.sha256), chunk.rawLength));
    incoming.assemble(manifest);
  } finally { incoming.close(); }
  expect(h.f.global.db.prepare("SELECT session_id FROM roam_locations").all()).toEqual([]);
  const result = await handleAgentOperation({ id: "direct-agent", machineId: HUB, expectedEpoch: null, kind: "import", args: {
    storeKey: source.storeKey, sourceMachine: BOX, transferId: "direct-transfer", artifactId: manifest.id,
    sha256: manifest.sha256, header: { ...batch.header },
  } }, hub.agentPorts);
  expect(result.code).toBe(0);
  expect(h.f.global.db.prepare("SELECT session_id FROM roam_locations").all()).toEqual([{ session_id: "session-a" }]);
}, 5000);

it("startup repairs committed catalog entries before the first sync", async () => {
  const h = fixture();
  const key = h.f.remotes.get(BOX)!.worktree.storeKey;
  h.f.stores.openStore(key).db.prepare("INSERT INTO sessions(id,name,started_at) VALUES ('recovered-session','saved',1)").run();
  expect(h.f.global.db.prepare("SELECT session_id FROM roam_locations").all()).toEqual([]);
  await h.start();
  expect(h.f.global.db.prepare("SELECT session_id FROM roam_locations").all()).toEqual([{ session_id: "recovered-session" }]);
}, 5000);

it("startup sweeps only old artifacts absent from durable sync and activity references", async () => {
  const h = fixture(); const now = Date.now(); h.setNow(now);
  const directory = h.f.stores.batchDirectories()[0]; mkdirSync(directory, { recursive: true, mode: 0o700 });
  const held = join(directory, "11111111-1111-4111-8111-111111111111.ndjson");
  const orphan = join(directory, "22222222-2222-4222-8222-222222222222.ndjson");
  for (const file of [held, orphan]) { writeFileSync(file, "fixture", { mode: 0o600 }); const old = new Date(now - h.f.config.limits.retentionMs - 1000); utimesSync(file, old, old); }
  writeLocal(h.f.global.db, "sync-peer", BOX, { failures: 0, pulled: false, targetBytes: 4096,
    pending: { "push:global": { id: "pending-artifact", key: "global", after: 0, targetBytes: 4096, batch: { file: held }, exported: null } } });
  await h.start();
  expect(existsSync(held)).toBe(true);
  expect(existsSync(orphan)).toBe(false);
}, 5000);

it("startup keeps outgoing artifacts named by pending sync and sweeps unreferenced artifacts", async () => {
  const h = fixture(); const now = Date.now(); h.setNow(now);
  const source = join(h.f.global.root, "payload"); writeFileSync(source, "fixture bytes", { mode: 0o600 });
  await stageArtifact(source, "batch", h.f.config.limits, { root: h.f.root, artifactId: "pending-batch" });
  await stageArtifact(source, "batch", h.f.config.limits, { root: h.f.root, artifactId: "orphan-batch" });
  const quota = openDb(join(h.f.root, "outgoing", "quota.db"));
  try { quota.prepare("UPDATE outgoing_artifacts SET updated=?").run(now - h.f.config.limits.retentionMs - 1000); }
  finally { quota.close(); }
  writeLocal(h.f.global.db, "sync-peer", BOX, { failures: 0, pulled: false, targetBytes: 4096,
    pending: { "push:global": { id: "pending-batch", key: "global", after: 0, targetBytes: 4096, batch: null, exported: null } } });
  await h.start();
  const pool = staging.openOutgoingStaging(h.f.root, h.f.config.limits, false);
  try {
    expect(pool.inspect("pending-batch").current).not.toBeNull();
    expect(pool.inspect("orphan-batch").current).toBeNull();
  } finally { pool.close(); }
}, 5000);

it("startup retains evidence while a journal operation has unknown references", async () => {
  const h = fixture(); const now = Date.now(); h.setNow(now);
  const directory = h.f.stores.batchDirectories()[0]; mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "44444444-4444-4444-8444-444444444444.ndjson");
  writeFileSync(file, "fixture", { mode: 0o600 }); const old = new Date(now - h.f.config.limits.retentionMs - 1000); utimesSync(file, old, old);
  h.f.journal.begin({ id: "unknown-operation", kind: "move", machineId: HUB, expectedEpoch: null, args: {} });
  await h.start();
  expect(existsSync(file)).toBe(true);
}, 5000);

it("startup retains old evidence when journal references are corrupt", async () => {
  const h = fixture(); const now = Date.now(); h.setNow(now);
  const directory = h.f.stores.batchDirectories()[0]; mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "55555555-5555-4555-8555-555555555555.ndjson");
  writeFileSync(file, "fixture", { mode: 0o600 }); const old = new Date(now - h.f.config.limits.retentionMs - 1000); utimesSync(file, old, old);
  h.f.journal.begin({ id: "recorded-operation", kind: "export", machineId: HUB, expectedEpoch: null, args: {} });
  h.f.journal.record("recorded-operation", "done", { ok: true });
  const journal = openDb(join(h.f.global.root, "roam", "journal.db"));
  try { journal.prepare("UPDATE roam_operation_actions SET result_json='invalid'").run(); } finally { journal.close(); }
  await h.start();
  expect(existsSync(file)).toBe(true);
}, 5000);

it("unknown artifact activity retains old evidence", async () => {
  const h = fixture(); const now = Date.now(); h.setNow(now); h.setActive(null);
  const directory = h.f.stores.batchDirectories()[0]; mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "33333333-3333-4333-8333-333333333333.ndjson");
  writeFileSync(file, "fixture", { mode: 0o600 }); const old = new Date(now - h.f.config.limits.retentionMs - 1000); utimesSync(file, old, old);
  await h.start();
  expect(existsSync(file)).toBe(true);
}, 5000);
