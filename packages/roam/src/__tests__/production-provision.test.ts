import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Journal, Transport } from "../contracts";
import { DEFAULT_LIMITS } from "../contracts";
import { readLocalIdentity } from "../runtime";
import { bootstrapPeer } from "./bootstrap-fixture";
import * as composition from "../production-provision";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("composes target-fenced ports, peer locking and durable launcher configuration", async () => {
  const create = (composition as { createProductionProvisionPorts?: (input: unknown) => import("../provision-contracts").ProvisionPorts }).createProductionProvisionPorts;
  expect(create).toBeTypeOf("function");
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "production-provision-")); roots.push(root); const roam = join(root, "roam"); mkdirSync(roam, { mode: 0o700 });
  const machineId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  writeFileSync(join(roam, "machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  writeFileSync(join(roam, "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId, hubMachineId: machineId, peers: [], coreUnit: "herdr-core.service" }), { mode: 0o600 });
  const journal: Journal = { begin: () => ({ kind: "new", result: null }), record() {}, read: () => [] };
  const transport: Transport = { async resolve(peer) { return peer; }, async bootstrapProbe() { throw new Error("unexpected probe"); },
    async exec() { throw new Error("unexpected exec"); }, async run() { throw new Error("unexpected run"); }, async read() { throw new Error("unexpected read"); }, async write() { throw new Error("unexpected write"); } };
  const core = { local: "fixture-local-core", remote: "fixture-core" }, claims: typeof core[] = [];
  const port = { transport, async probeAgentDirectory() { return { status: "default" as const, core }; },
    async claimIdentity(_peer: unknown, _id: string, value: typeof core) { claims.push(value); return { machineId: bootstrapPeer.machineId, coreId: "fixture-core" }; },
    async executeProvision() { return true; }, async launchRelease() { return { terminal: "box-1.invalid/t1" }; } };
  const options = { identity: { pid: process.pid, startIdentity: "fixture" }, probe: async () => ({ kind: "live" as const, startIdentity: "fixture" }) };
  const ports = create!({ root, hubMachineId: "00000000-0000-4000-8000-000000000001", peer: bootstrapPeer, operationId: "op-1", transport: port, journal, limits: DEFAULT_LIMITS,
    source: { agentRoot: root, releaseFile: join(root, "release.tgz"), piProviders: [] },
    destination: { home: "/home/fixture", agentDir: "/home/fixture/.pi/agent", npmPrefix: "/home/fixture/.local", supervisor: "/home/fixture/.local/supervisor.mjs" },
    unitDir: "/home/fixture/.config/systemd/user", coreUnit: "herdr-core.service", release: { pi: "1.2.0", intercom: "spider-owned", spiderSha256: "a".repeat(64), nodeRange: "22.23.4 || 26.4.0" },
    present: async () => {}, confirm: async () => true, report: async () => {}, resources: async () => ({}), bootId: async () => "fixture", lockOptions: options });
  expect(ports.transport).toBe(transport);
  expect(ports.bootstrap.probeAgentDirectory).toBeTypeOf("function");
  expect(await ports.bootstrap.probeAgentDirectory(bootstrapPeer, "/home/fixture")).toEqual({ status: "default", core });
  await expect(ports.bootstrap.probeAgentDirectory({ ...bootstrapPeer, alias: "other.invalid" }, "/home/fixture")).rejects.toThrow();
  await expect(ports.bootstrap.probeAgentDirectory(bootstrapPeer, "/home/other")).rejects.toThrow();
  expect(await ports.bootstrap.claimIdentity(bootstrapPeer, "op-1", core)).toEqual({ machineId: bootstrapPeer.machineId, coreId: "fixture-core" });
  expect(claims).toEqual([core]);
  await ports.withPeerLock(bootstrapPeer.machineId, async () => { await ports.persistPeer(bootstrapPeer); });
  expect(readLocalIdentity(root).peers).toEqual([bootstrapPeer]);
  expect(ports.systemd.unitDir).toBe("/home/fixture/.config/systemd/user");
}, 5000);
