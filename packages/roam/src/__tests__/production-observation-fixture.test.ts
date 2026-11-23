import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import type { RoamConfig } from "../contracts";
import { openJournal } from "../journal";
import { loadPeerState } from "../peer-state";
import { createSync } from "../sync";
import { noChangeSyncFixture, productionObservationFixture } from "./production-observation-fixture";

afterEach(() => vi.restoreAllMocks());

it("a no-change round supplies production sync proof only for a complete successful pull", async () => {
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
    expect(await native.observe(peer, incomplete)).toMatchObject({ reachability: "reachable", syncVerified: false });
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
