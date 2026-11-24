import { afterEach, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { runHub, type HubRuntimePorts } from "../hub";
import { assignInitialHome } from "../homes";
import { readLocal } from "@spider/db-core/roam/local-state";
import { createReplica } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import type { RoamConfig } from "../contracts";
import { openJournal } from "../journal";
import { loadPeerState } from "../peer-state";
import { createSync } from "../sync";
import { noChangeSyncFixture, productionObservationFixture } from "./production-observation-fixture";

afterEach(() => vi.restoreAllMocks());

it("a peer reply supplies production sync proof despite ungathered or refused stores", async () => {
  const machineId = "00000000-0000-4000-8000-000000000001";
  const peer = { machineId: "00000000-0000-4000-8000-000000000002", alias: "box-1.invalid", node: "/home/fixture/node",
    pi: "/home/fixture/pi", cli: "/home/fixture/spider", core: "/home/fixture/core", globalRoot: "/home/fixture/global" };
  const local = createReplica("global", machineId);
  const config: RoamConfig = { enabled: true, role: "hub", machineId, hubMachineId: machineId, peers: [peer],
    discoveryRoots: [], coreUnit: "core", syncMs: 120_000, limits: { ...DEFAULT_LIMITS }, intercom: disabledIntercom() };
  const wire = noChangeSyncFixture(config);
  const native = await productionObservationFixture(local.root, config, local.db, wire.transport);
  const sync = createSync({ config, globalDb: local.db, stores: wire.stores, transport: wire.transport,
    journal: openJournal(join(local.root, "sync.db")), clock: { now: () => 1, later() { return () => {}; } } });
  try {
    expect(await native.observe(peer, [])).toMatchObject({ reachability: "reachable", syncVerified: false });
    wire.setIncomplete(true);
    const incomplete = await sync.sync(peer.machineId);
    expect(incomplete).toEqual([]);
    const readiness = { origin: "hub-operation", opId: "op-1", sessionId: "session-1", epoch: 1,
      cwd: "/home/fixture/work", file: "/home/fixture/session.jsonl", core: "core-1", terminal: "box-1.invalid/t1" };
    wire.setHosting({ readiness: [{ ...readiness, terminal: "t1" }], suspensions: [{ sessionId: "session-1", epoch: 1 }] });
    expect(await native.observe(peer, incomplete)).toMatchObject({ reachability: "reachable", syncVerified: true,
      readiness: [readiness], suspensions: [{ sessionId: "session-1", epoch: 1 }] });
    assignInitialHome(local.db, "session-1", peer.machineId, machineId);
    const root = mkdtempSync(join(resolve(".spider/scratch"), "hosting-"));
    let afterSync!: Parameters<HubRuntimePorts["prepare"]>[0];
    const placements: unknown[] = [], notices: string[] = [], recoveries: string[] = [];
    const timers: Array<{ cancelled: boolean; fn(): void }> = [];
    const hub = await runHub({ config, globalDb: local.db, runtimeRoot: root, socketPath: join(root, "hub.sock"),
      identity: { pid: process.pid, startIdentity: "process-1" }, async probe() { return { kind: "live", startIdentity: "process-1" }; },
      clock: { now: () => 1, later(_ms, fn) { const timer = { cancelled: false, fn }; timers.push(timer); return () => { timer.cancelled = true; }; } }, observe: native.observe,
      async recoverPeerMoves(id) { recoveries.push(id); },
      sync: { start() {}, stop() {}, async sync() { return []; }, async barriers() { return false; } },
      placement: { async reconcile(rows) { placements.push(...rows); return { pending: [] }; } },
      notices: { async publish(notice) { notices.push(notice.kind); }, async clear() {} },
      async homeChangeInProgress() { return false; }, async prepare(callback) { afterSync = callback; },
      async drain() {}, async closeStores() {},
    });
    try {
      await afterSync(peer, incomplete);
      expect(placements).toEqual([readiness]);
      expect(notices).toEqual(["suspended"]);
      expect(readLocal(local.db, "peer-hosting-warnings", peer.machineId)).toEqual([]);
      native.setState("unreachable"); wire.setUnavailable(true);
      const outage = await sync.sync(peer.machineId);
      expect(outage).toMatchObject([{ code: 3 }]);
      await afterSync(peer, outage);
      native.setState("connected"); wire.setUnavailable(false); wire.setStoreRefused(true);
      const storeRefused = await sync.sync(peer.machineId);
      expect(storeRefused).toMatchObject([{ code: 1 }]);
      expect(await native.observe(peer, storeRefused)).toMatchObject({ syncVerified: true, readiness: [readiness] });
      await afterSync(peer, storeRefused);
      expect(placements).toEqual([readiness, readiness]);
      const pending = timers.filter(timer => !timer.cancelled);
      expect(pending).toHaveLength(1);
      pending[0].cancelled = true; pending[0].fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(recoveries).toEqual([peer.machineId]);
      await afterSync(peer, storeRefused);
      expect(timers.filter(timer => !timer.cancelled)).toEqual([]);
      expect(recoveries).toEqual([peer.machineId]);
    } finally { await hub.stop(); rmSync(root, { recursive: true, force: true }); }
    wire.setStoreRefused(false);
    wire.setIncomplete(false); wire.setRefused(true);
    const refused = await sync.sync(peer.machineId);
    expect(refused.some(result => result.code !== 0)).toBe(true);
    expect(await native.observe(peer, refused)).toMatchObject({ reachability: "reachable", syncVerified: false });
    wire.setRefused(false); wire.setReplaced(true);
    const replaced = await sync.sync(peer.machineId);
    expect(replaced.some(result => result.code !== 0)).toBe(true);
    expect(await native.observe(peer, replaced)).toMatchObject({ reachability: "reachable", syncVerified: false });
    wire.setReplaced(false);
    const complete = await sync.sync(peer.machineId);
    expect(complete).toEqual([]);
    expect(loadPeerState(local.db, peer.machineId, config.limits.targetBatchBytes)).toMatchObject({ pulled: true,
      observation: { connected: true, lastSyncAt: 1 } });
    expect(await native.observe(peer, complete)).toMatchObject({ reachability: "reachable", syncVerified: true });
  } finally { sync.stop(); await sync.drain(); await native.stop(); local.close(); }
});
