import { afterEach, expect, it, vi } from "vitest";
import * as runtime from "../runtime";
import * as hub from "../hub";
import * as hc from "@spider/herdr/client/hc";
import * as diagnostics from "../local-diagnostics";
import * as hostConfig from "../host-config";
import { startProductionHub } from "../production-hub";
import { assignInitialHome } from "../homes";
import { readLocal } from "@spider/db-core/roam/local-state";
import { network, BOX, HUB } from "./sync-fixture";
import type { StandaloneHubPorts } from "../hub";

const fixtures: ReturnType<typeof network>[] = [];
const handles: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => { for (const h of handles.splice(0)) await h.stop(); vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.close(); });

async function observationFixture() {
  const f = network(); fixtures.push(f);
  let state: unknown = "connected", why: unknown, identity = "core-1";
  vi.spyOn(runtime, "openLocalCore").mockReturnValue({ config: f.config, db: f.global.db, close() {} } as never);
  vi.spyOn(hostConfig, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(diagnostics, "createLocalDiagnosticPorts").mockReturnValue({ async probeProcess() { return { kind: "live", startIdentity: "process-1" }; } } as never);
  vi.spyOn(hc, "createHcClient").mockReturnValue({ async identity() { return { coreId: identity }; }, async dispose() {} } as never);
  const cli = vi.spyOn(hc, "invokeCli").mockImplementation(async () => ({ machines: [{ name: f.config.peers[0].alias, state, why }] }) as never);
  let ports: StandaloneHubPorts | undefined;
  vi.spyOn(hub, "runStandaloneHub").mockImplementation(async input => { ports = input; return { async stop() {}, agentPorts: {} as never }; });
  await startProductionHub(f.global.root);
  if (!ports) throw new Error("Hub was not composed");
  const observe = ports.observe;
  return { f, cli, observe, ports, setState(value: unknown, reason?: unknown) { state = value; why = reason; }, replaceIdentity() { identity = "core-2"; } };
}

it("a connected native state clears an outage even when sync refuses content", async () => {
  const h = await observationFixture();
  const { loadPeerState, savePeerState } = await import("../peer-state");
  const saved = loadPeerState(h.f.global.db, BOX, h.f.config.limits.targetBatchBytes);
  saved.observation = { machineId: BOX, observedAt: 1, connected: true, lastSyncAt: 1, cursors: [], failure: null };
  saved.pulled = true;
  savePeerState(h.f.global.db, BOX, saved);
  expect(await h.observe(h.f.config.peers[0], [{ code: 1, reason: "Invalid peer value", operationId: "op-1", home: null, epoch: null, repairCommand: null, value: null }])).toMatchObject({ reachability: "reachable", syncVerified: true });
});

it.each([false, true])("a connected no-change sync verifies moves regardless of missing stores (pulled: %s)", async pulled => {
  const h = await observationFixture();
  const { loadPeerState, savePeerState } = await import("../peer-state");
  const saved = loadPeerState(h.f.global.db, BOX, h.f.config.limits.targetBatchBytes);
  saved.pulled = pulled;
  saved.observation = { machineId: BOX, observedAt: 2, connected: true, lastSyncAt: pulled ? 2 : 1, cursors: [], failure: null };
  savePeerState(h.f.global.db, BOX, saved);
  expect(await h.observe(h.f.config.peers[0], [])).toMatchObject({ reachability: "reachable", syncVerified: true });
});

it("a core identity change during machine inventory remains unknown", async () => {
  const h = await observationFixture();
  h.setState("unreachable");
  h.cli.mockImplementationOnce(async () => { h.replaceIdentity(); return { machines: [{ name: h.f.config.peers[0].alias, state: "unreachable" }] }; });
  expect(await h.observe(h.f.config.peers[0], [])).toEqual({ reachability: "unknown", readiness: null, suspensions: null });
});


it.each([
  ['a different core answers there ("new-core")', "unknown"],
  [undefined, "unreachable"],
  ["network unavailable", "unreachable"],
  ['a different core answers there ("new-core") extra', "unreachable"],
  [42, "unreachable"],
] as const)("classifies native unreachable with reason %j as %s", async (why, reachability) => {
  const h = await observationFixture();
  h.setState("unreachable", why);
  expect(await h.observe(h.f.config.peers[0], [])).toEqual({ reachability, readiness: null, suspensions: null });
});

it("a replaced remote core neither starts nor advances an outage or recovers moves", async () => {
  const h = await observationFixture(), peer = h.f.config.peers[0];
  assignInitialHome(h.f.global.db, "session-1", BOX, HUB);
  const { loadPeerState, savePeerState } = await import("../peer-state");
  const saved = loadPeerState(h.f.global.db, BOX, h.f.config.limits.targetBatchBytes);
  saved.pulled = true;
  saved.observation = { machineId: BOX, observedAt: 1, connected: true, lastSyncAt: 1, cursors: [], failure: null };
  savePeerState(h.f.global.db, BOX, saved);
  let now = 1_000_000, afterSync!: Parameters<hub.HubRuntimePorts["prepare"]>[0];
  const timers: Array<{ at: number; cancelled: boolean; fn(): void }> = [];
  const notices: string[] = [], clears: string[] = [], recoveries: string[] = [];
  const started = await hub.runHub({ ...h.ports, intercom: undefined,
    clock: { now: () => now, later(ms, fn) { const timer = { at: now + ms, cancelled: false, fn }; timers.push(timer); return () => { timer.cancelled = true; }; } },
    sync: { start() {}, stop() {}, async sync() { return []; }, async barriers() { return false; } },
    async prepare(callback) { afterSync = callback; }, async drain() {}, async closeStores() {},
    notices: { async publish(notice) { notices.push(notice.id); }, async clear(id) { clears.push(id); } },
    async recoverPeerMoves(machineId) { recoveries.push(machineId); },
  } as hub.HubRuntimePorts); handles.push(started);
  const observe = () => afterSync(peer, []);
  const status = () => readLocal(h.f.global.db, "hub-peer", BOX);
  const advance = (ms: number) => { now += ms; for (const timer of timers.filter(t => !t.cancelled && t.at <= now)) { timer.cancelled = true; timer.fn(); } };
  h.setState("unreachable", 'a different core answers there ("new-core")');
  await observe();
  expect(status()).toBeUndefined();
  expect(timers.filter(t => !t.cancelled)).toEqual([]);
  expect(notices).toEqual([]);
  h.setState("connected");
  expect(await h.observe(peer, [])).toMatchObject({ reachability: "reachable", syncVerified: true });
  await observe();
  expect(timers.filter(t => !t.cancelled)).toEqual([]);
  expect(recoveries).toEqual([]);
  h.setState("unreachable"); await observe();
  const outage = status();
  expect(timers.filter(t => !t.cancelled)).toHaveLength(1);
  h.setState("unreachable", 'a different core answers there ("new-core")'); await observe();
  expect(status()).toEqual(outage);
  expect(timers.filter(t => !t.cancelled)).toEqual([]);
  advance(600_000); await observe();
  expect(status()).toEqual(outage);
  expect(notices).toEqual([]);
  h.setState("unreachable"); await observe();
  expect(notices).toHaveLength(1);
  const delivered = status();
  h.setState("unreachable", 'a different core answers there ("new-core")'); await observe();
  expect(status()).toEqual(delivered);
  expect(clears).toEqual([]);
  expect(recoveries).toEqual([]);
  expect(timers.filter(t => !t.cancelled)).toEqual([]);
});
