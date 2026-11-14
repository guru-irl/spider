import type { Peer } from "../contracts";
import type { Inventory } from "../provision-contracts";

export const bootstrapPeer: Peer = {
  machineId: "00000000-0000-4000-8000-000000000001",
  alias: "box-1.invalid",
  node: "/fixture/node",
  pi: "/home/fixture/.local/bin/pi",
  cli: "/home/fixture/.local/lib/spider/dist/roam/cli.mjs",
  core: "/home/fixture/.local/bin/hc",
  globalRoot: "/home/fixture/.pi/agent/spider",
};

export function healthyInventory(): Inventory {
  return {
    platform: "linux", kernel: "6.8.0", nodeVersion: "26.4.0", nodeAbi: "144", gitVersion: "2.45.0",
    roaming: { rootExists: false, rootSafe: true, identityExists: false, machineId: null },
    systemdUser: true, linger: true,
    core: { unit: "herdr-core.service", unitExists: true, unitOwned: true, socketExists: true, socketOwned: true },
    pi: bootstrapPeer.pi, piVersion: "1.2.0",
    softNofile: 65_536, hardNofile: 65_536, inotifyInstances: 1024, inotifyWatches: 524_288,
    diskFreeBytes: 2_000_000_000,
    spider: { installed: true, version: "0.1.0", nativeModuleReady: true },
    cli: { gh: true, gitIdentity: true, configured: [] },
    auth: {
      pi: { present: true, readable: true, modeSafe: true },
      gh: { present: true, readable: true, modeSafe: true },
      ghSignedIn: true,
    },
  };
}

export function inventoryEnvelope(value: Inventory = healthyInventory()): { version: 1; kind: "inventory"; value: Inventory } {
  return { version: 1, kind: "inventory", value };
}
