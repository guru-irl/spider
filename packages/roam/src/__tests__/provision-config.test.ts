import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Peer } from "../contracts";
import { readLocalIdentity } from "../runtime";
import { bootstrapPeer } from "./bootstrap-fixture";
import * as configModule from "../provision-config";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const options = { identity: { pid: process.pid, startIdentity: "fixture" }, probe: async () => ({ kind: "live" as const, startIdentity: "fixture" }) };
function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "provision-config-")); roots.push(root); const roam = join(root, "roam"); mkdirSync(roam, { mode: 0o700 });
  const machineId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", file = join(roam, "config.json");
  writeFileSync(join(roam, "machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  writeFileSync(file, JSON.stringify({ enabled: false, role: "hub", machineId, hubMachineId: machineId, peers: [], discoveryRoots: [], coreUnit: "herdr-core.service" }), { mode: 0o600 });
  const persist = (configModule as { persistProvisionPeer?: (root: string, peer: Peer, options: unknown) => Promise<void> }).persistProvisionPeer;
  return { root, file, persist };
}

it("persists the absolute pi path once and refuses an alias or identity conflict", async () => {
  const f = fixture(); expect(f.persist).toBeTypeOf("function");
  await f.persist!(f.root, bootstrapPeer, options);
  await f.persist!(f.root, bootstrapPeer, options);
  expect(readLocalIdentity(f.root).peers).toEqual([bootstrapPeer]);
  expect(readLocalIdentity(f.root).peers[0].pi).toBe(bootstrapPeer.pi);
  const before = readFileSync(f.file, "utf8");
  await expect(f.persist!(f.root, { ...bootstrapPeer, machineId: "22222222-2222-4222-8222-222222222222" }, options)).rejects.toThrow();
  await expect(f.persist!(f.root, { ...bootstrapPeer, alias: "box-2.invalid" }, options)).rejects.toThrow();
  expect(readFileSync(f.file, "utf8")).toBe(before);
}, 5000);

it("does not lose an independent peer when two configuration writes overlap", async () => {
  const f = fixture(); expect(f.persist).toBeTypeOf("function");
  const other = { ...bootstrapPeer, alias: "box-2.invalid", machineId: "22222222-2222-4222-8222-222222222222" };
  await Promise.all([f.persist!(f.root, bootstrapPeer, options), f.persist!(f.root, other, options)]);
  expect(readLocalIdentity(f.root).peers.map(peer => peer.alias).sort()).toEqual(["box-1.invalid", "box-2.invalid"]);
}, 5000);
