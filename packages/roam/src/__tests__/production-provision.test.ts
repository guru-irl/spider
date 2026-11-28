import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@spider/db-core";
import type { Journal, Transport } from "../contracts";
import type { JsonObject } from "@spider/db-core/roam/types";
import { DEFAULT_LIMITS } from "../contracts";
import { readLocalIdentity } from "../runtime";
import { bootstrapPeer } from "./bootstrap-fixture";
import * as composition from "../production-provision";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const create = (composition as { createProductionProvisionPorts?: (input: unknown) => import("../provision-contracts").ProvisionPorts }).createProductionProvisionPorts;
  expect(create).toBeTypeOf("function");
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "production-provision-")); roots.push(root); const roam = join(root, "roam"); mkdirSync(roam, { mode: 0o700 });
  const machineId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  writeFileSync(join(roam, "machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  writeFileSync(join(roam, "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId, hubMachineId: machineId, peers: [], coreUnit: "herdr-core.service" }), { mode: 0o600 });
  const records = new Map<string, Array<{ action: string; result: JsonObject }>>();
  const journal: Journal = { begin: () => ({ kind: "new", result: null }), record(id, action, result) {
    records.set(id, [...(records.get(id) ?? []), { action, result }]);
  }, read: id => records.get(id) ?? [] };
  const transport: Transport = { async resolve(peer) { return peer; }, async bootstrapProbe() { throw new Error("unexpected probe"); },
    async exec() { throw new Error("unexpected exec"); }, async run() { throw new Error("unexpected run"); }, async read() { throw new Error("unexpected read"); }, async write() { throw new Error("unexpected write"); } };
  const core = { local: "fixture-local-core", remote: "fixture-core" }, claims: typeof core[] = [], participation: boolean[] = [];
  const previews: { home: string; core: typeof core }[] = [];
  const port = { transport, async probeAgentDirectory() { return { status: "default" as const, core }; },
    async previewSettings(_peer: unknown, home: string, _entries: unknown, _maximum: number, fence: typeof core) {
      previews.push({ home, core: fence }); return { fingerprint: "a".repeat(64), changedKeys: ["theme"] };
    },
    async claimIdentity(_peer: unknown, _id: string, value: typeof core) { claims.push(value); return { machineId: bootstrapPeer.machineId, coreId: "fixture-core" }; },
    async executeProvision(_peer: unknown, request: Record<string, unknown>) {
      expect(request.action).toBe("roaming-enabled");
      expect(records.get(String(request.operationId))?.some(row => row.action === "provision-consent" && row.result.approved === true &&
        row.result.machineId === bootstrapPeer.machineId && row.result.enabled === request.enabled)).toBe(true);
      participation.push(request.enabled as boolean); return { enabled: request.enabled };
    }, async launchRelease() { return { terminal: "box-1.invalid/t1" }; } };
  const options = { identity: { pid: process.pid, startIdentity: "fixture" }, probe: async () => ({ kind: "live" as const, startIdentity: "fixture" }) };
  const ports = create!({ root, hubMachineId: machineId, peer: bootstrapPeer, operationId: "op-1", transport: port, journal, limits: DEFAULT_LIMITS,
    source: { agentRoot: root, releaseFile: join(root, "release.tgz"), piProviders: [] },
    destination: { home: "/home/fixture", agentDir: "/home/fixture/.pi/agent", npmPrefix: "/home/fixture/.local", supervisor: "/home/fixture/.local/supervisor.mjs" },
    release: { pi: "1.2.0", intercom: "spider-owned", spiderSha256: "a".repeat(64), nodeRange: "22.23.4 || 26.4.0" },
    present: async () => {}, confirm: async () => true, report: async () => {}, resources: async () => ({}), bootId: async () => "fixture", lockOptions: options });
  return { root, roam, machineId, ports, transport, core, claims, participation, previews };
}

it("composes target-fenced ports, peer locking and durable launcher configuration", async () => {
  const { root, roam, ports, transport, core, claims, participation, previews } = fixture();
  expect(ports.transport).toBe(transport);
  expect(ports.bootstrap.probeAgentDirectory).toBeTypeOf("function");
  expect(await ports.bootstrap.probeAgentDirectory(bootstrapPeer, "/home/fixture")).toEqual({ status: "default", core });
  await expect(ports.bootstrap.probeAgentDirectory({ ...bootstrapPeer, alias: "other.invalid" }, "/home/fixture")).rejects.toThrow();
  await expect(ports.bootstrap.probeAgentDirectory(bootstrapPeer, "/home/other")).rejects.toThrow();
  expect(ports.bootstrap.previewSettings).toBeTypeOf("function");
  expect(await ports.bootstrap.previewSettings(bootstrapPeer, "/home/fixture", [], 1024, core)).toEqual({ fingerprint: "a".repeat(64), changedKeys: ["theme"] });
  await expect(ports.bootstrap.previewSettings({ ...bootstrapPeer, alias: "other.invalid" }, "/home/fixture", [], 1024, core)).rejects.toThrow();
  await expect(ports.bootstrap.previewSettings(bootstrapPeer, "/home/other", [], 1024, core)).rejects.toThrow();
  expect(previews).toEqual([{ home: "/home/fixture", core }]);
  expect(await ports.bootstrap.claimIdentity(bootstrapPeer, "op-1", core)).toEqual({ machineId: bootstrapPeer.machineId, coreId: "fixture-core" });
  expect(claims).toEqual([core]);
  await ports.withPeerLock(bootstrapPeer.machineId, async () => { await ports.persistPeer(bootstrapPeer); });
  expect(readLocalIdentity(root).peers).toEqual([bootstrapPeer]);
  await ports.setParticipation(bootstrapPeer, true);
  expect(participation).toEqual([false]);
  const configFile = join(roam, "config.json"), updated = JSON.parse(readFileSync(configFile, "utf8"));
  writeFileSync(configFile, JSON.stringify({ ...updated, enabled: true }), { mode: 0o600 });
  await ports.setParticipation(bootstrapPeer, false);
  await ports.setParticipation(bootstrapPeer, true);
  await ports.setParticipation(bootstrapPeer, null);
  expect(participation).toEqual([false, false, true]);
}, 5000);

it.each([
  ["incoming moving home", "moving", false, true],
  ["home still assigned to the box", "stopped", true, true],
  ["moving to a different box", "moving", false, false],
  ["no homes in the pre-v0 layout", null, false, false],
  ["enabled hub with no homes", null, false, true, true, false],
  ["unreadable hub store", null, false, true, false, true],
] as const)("checks authoritative homes before replacement: %s", async (_name, state, local, refused, enabled = false, corrupt = false) => {
  const { root, roam, machineId, ports } = fixture();
  if (enabled) {
    const config = JSON.parse(readFileSync(join(roam, "config.json"), "utf8"));
    writeFileSync(join(roam, "config.json"), JSON.stringify({ ...config, enabled: true }), { mode: 0o600 });
  }
  if (corrupt) writeFileSync(join(root, "spider.db"), "not a database", { mode: 0o600 });
  else {
    const db = openDb(join(root, "spider.db"));
    try {
      db.exec("PRAGMA user_version=14; CREATE TABLE roam_meta (id INTEGER, machine_id TEXT); CREATE TABLE session_homes (session_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, epoch INTEGER NOT NULL, move_id TEXT, updated_at INTEGER NOT NULL)");
      db.prepare("INSERT INTO roam_meta VALUES (1, ?)").run(machineId);
      if (state !== null) {
        db.exec("ALTER TABLE session_homes ADD COLUMN state TEXT; ALTER TABLE session_homes ADD COLUMN destination TEXT");
        db.prepare("INSERT INTO session_homes VALUES('fixture-session', ?, 1, 'fixture-move', 1, ?, ?)")
          .run(local ? bootstrapPeer.machineId : machineId, state, state === "moving" ? (refused ? bootstrapPeer.machineId : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb") : null);
      }
    } finally { db.close(); }
  }
  const check = ports.assertCorePinReplaceIdle(bootstrapPeer);
  if (corrupt) await expect(check).rejects.toMatchObject({ code: "core-pin-check-unavailable", message: expect.stringMatching(/hub.*store.*spider roam doctor/i) });
  else if (refused) await expect(check).rejects.toMatchObject({ code: "core-pin-in-use" });
  else await expect(check).resolves.toBeUndefined();
});
