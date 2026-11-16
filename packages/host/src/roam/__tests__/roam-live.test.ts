import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReplica } from "@spider/db-core/testutil";
import { createBothLocks } from "@spider/roam/session-control";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { createSessionLeases, type ProcessInventoryPorts } from "@spider/herdr/sessions/lease";
import { processStartTime } from "../../../../subagents/src/process-identity.js";
import { MessageStore } from "../../../../subagents/src/message-store.js";
import { IntercomFederationClient } from "@spider/intercom/broker/client";
import { createLiveFreezePorts, inspectLiveOwner } from "../live.js";
import type { AdmissionGate } from "../admission.js";

const roots: string[] = [], replicas: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of replicas.splice(0)) f.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("refuses a freeze blocker query without negotiated broker support", async () => {
  const client = new IntercomFederationClient();
  await expect(client.inspectFreezeBlockers({ sessionId: "session-1", scopeId: null })).rejects.toThrow(/unsupported/);
});

it("verifies a live owner using the supplied boot identity", async () => {
  const fixture = createReplica("global", "00000000-0000-4000-8000-000000000001"); replicas.push(fixture);
  const file = join(fixture.root, "session.jsonl"), root = join(fixture.root, "herdr");
  mkdirSync(root, { mode: 0o700 }); writeFileSync(file, "{}");
  const startIdentity = processStartTime(process.pid)!, bootId = async () => "test-boot-identity";
  const leases = createSessionLeases(root), inventory: ProcessInventoryPorts = { presence: createProcessPresence(root), leases,
    processes: async () => [], probe: async pid => pid === process.pid ? { kind: "live", startIdentity } : { kind: "absent" } };
  const locks = createBothLocks({ root, file: async () => file, inventory, identity: { pid: process.pid, startIdentity }, bootId });
  await locks("session-1", async () => {
    expect(await inspectLiveOwner(root, "session-1", file, bootId)).toEqual({ pid: process.pid, startTime: startIdentity, bootId: "test-boot-identity" });
    await expect(inspectLiveOwner(root, "session-1", file, async () => "different-boot")).rejects.toThrow(/ownership/);
  });
});

it("uses held ID and file leases and blocks when broker or bridge evidence is unavailable", async () => {
  const root = mkdtempSync(resolve(".spider/scratch/live-control-")); roots.push(root);
  const f = createReplica("worktree", "11111111-1111-4111-8111-111111111111"); replicas.push(f);
  const global = createReplica("global", f.machineId); replicas.push(global); new MessageStore(global.db);
  f.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  f.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES ('session-1',1,?)").run(f.machineId);
  f.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('session-1',2,'active')").run();
  const file = join(root, "session.jsonl"), scratch = join(root, "scratch"), jobs = join(root, "herdr", "jobs");
  mkdirSync(scratch, { recursive: true }); mkdirSync(jobs, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: f.root }) + "\n" +
    JSON.stringify({ type: "model_change", id: "leaf-1", parentId: null, timestamp: "2026-01-01T00:00:00Z" }) + "\n");
  const home = { sessionId: "session-1", machineId: f.machineId, epoch: 2, moveId: null, updatedAt: 1 };
  const gate: AdmissionGate = { inspect: () => ({ kind: "ordinary", home, blockers: [] }), refreshInitialHome: async () => gate.inspect(),
    whenSettled: async () => gate.inspect(), close: async () => {}, freeze: async () => {}, unfreeze: async () => {} };
  const ctx = { cwd: f.root, mode: "rpc", hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => file, getLeafId: () => "leaf-1", getEntries: () => [] } } as unknown as ExtensionContext;
  const inert = { async pause() {}, async resume() {} }, activity = { busy: () => false, bashRunning: () => false, promptOpen: () => false };
  const usageRoots = { registryDb: join(root, "spider.db"), ledgerFile: join(root, "usage.db"),
    sessionsDir: join(root, "sessions"), authPath: join(root, "auth.json"), leaseDir: join(root, "leases") };
  const input = { globalRoot: root, sessionId: "session-1", machineId: f.machineId, context: () => ctx, gate,
    stores: [f.db], expectedStores: [f.storeKey], routeStores: [global.db], address: { sessionId: "session-1", scopeId: null }, activity,
    jobRoots: [jobs], scratchRoots: [scratch], usageRoots, usage: inert, embeddings: inert, organism: inert, others: [] };
  expect(() => createLiveFreezePorts({ ...input, usageRoots: { ...usageRoots, ledgerFile: join(root, "foreign-usage.db") } })).toThrow(/usage.*root/i);
  expect(() => createLiveFreezePorts({ ...input, usageRoots: { ...usageRoots, registryDb: join(root, "foreign-registry.db") } })).toThrow(/usage.*root/i);
  const live = createLiveFreezePorts(input);
  await expect(live.inspect()).rejects.toThrow(/owner|ownership/i);
  const startIdentity = processStartTime(process.pid)!;
  const leases = createSessionLeases(join(root, "herdr"));
  const inventory: ProcessInventoryPorts = { presence: createProcessPresence(leases.root), leases, processes: async () => [],
    probe: async pid => pid === process.pid ? { kind: "live", startIdentity } : { kind: "absent" } };
  const locks = createBothLocks({ root: leases.root, file: async () => file, inventory, identity: { pid: process.pid, startIdentity } });
  await locks("session-1", async () => {
    const inspected = await live.inspect();
    expect(inspected.owner).toMatchObject({ pid: process.pid, startTime: startIdentity });
    expect(inspected.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "blocker-source-unavailable", id: "broker" }),
      expect.objectContaining({ kind: "blocker-source-unavailable", id: "bridge" }),
    ]));
  });
}, 10000);
