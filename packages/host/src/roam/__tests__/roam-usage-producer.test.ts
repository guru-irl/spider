import { fixtureIntercom } from "./intercom-move-fixture.js";
import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReplica } from "@spider/db-core/testutil";
import { openDbAt, paths } from "@spider/db-core";
import { readSessionState } from "@spider/db-core/roam/state";
import type { Home } from "@spider/db-core/roam/types";
import type { Operation } from "@spider/roam/contracts";
import { createBothLocks } from "@spider/roam/session-control";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { createSessionLeases, type ProcessInventoryPorts } from "@spider/herdr/sessions/lease";
import { processStartTime } from "../../../../subagents/src/process-identity.js";
import { MessageStore } from "../../../../subagents/src/message-store.js";
import { authorizeTestBridge, startTestBroker, stopTestBroker } from "../../../../intercom/src/test-support.js";
import { IntercomFederationClient } from "../../../../intercom/src/broker/client.js";
import { createFederation } from "../../../../intercom/src/broker/federation.js";
import { FEDERATION_FEATURE, type FederationBridge } from "@spider/intercom/protocol";
import { buildFixture } from "../../../../../scripts/test-bundle.js";
import { openUsageLedgerReadOnly } from "../../usage/ledger.js";
import { registerUsage, resolveUsageRoots } from "../../usage/mount.js";
import { freezeParticipant, unfreezeParticipant } from "../freeze.js";
import { createLiveFreezePorts } from "../live.js";
import { registerAutoReload } from "../../auto-reload.js";
import { trackReloadActivity } from "../../reload-activity.js";
import { protectAdmissionApi, type AdmissionGate } from "../admission.js";

const roots: string[] = [], replicas: ReturnType<typeof createReplica>[] = [];
let priorRoot: string | undefined;
afterEach(() => {
  if (priorRoot !== undefined) paths.globalRoot = priorRoot;
  priorRoot = undefined; vi.unstubAllEnvs();
  for (const f of replicas.splice(0)) f.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("stops a real usage-ledger writer during freeze and restores it after abort", async () => {
  const root = mkdtempSync(resolve(".spider/scratch/usage-producer-")); roots.push(root);
  const agentDir = join(root, "agent"), sessions = join(agentDir, "sessions", "fixture"); mkdirSync(sessions, { recursive: true });
  const worktree = createReplica("worktree", "11111111-1111-4111-8111-111111111111"); replicas.push(worktree);
  execFileSync("git", ["init", "-q"], { cwd: worktree.root });
  priorRoot = paths.globalRoot; paths.globalRoot = root; vi.stubEnv("PI_CODING_AGENT_DIR", agentDir); vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const global = openDbAt(join(root, "spider.db"), "global");
  global.prepare("INSERT INTO projects(project_key,real_path,repo_key,db_path,created_at,last_seen_at) VALUES (?,?,NULL,?,1,1)")
    .run(worktree.root, worktree.root, worktree.db.raw.name);
  const messages = new MessageStore(global);
  messages.enqueue({ fromSession: "session-1", toSession: "peer", body: "fixture", route: { kind: "bridge", messageId: "bridge-pending" } });
  worktree.db.prepare("UPDATE roam_meta SET store_key='worktree:fixture:workspace',capture_enabled=1 WHERE id=1").run();
  worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES ('session-1',1,?)").run("11111111-1111-4111-8111-111111111111");
  worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('session-1',2,'active')").run();
  const file = join(sessions, "session.jsonl"), timestamp = "2026-10-04T12:00:00.000Z";
  const message = (id: string, parentId: string | null) => JSON.stringify({ type: "message", id, parentId, timestamp,
    message: { role: "assistant", provider: "github-copilot", model: "fixture", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } }) + "\n";
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: worktree.root, timestamp }) + "\n" + message("first", null));
  const bundle = join(root, "usage-worker.mjs");
  await buildFixture({ stdin: { resolveDir: process.cwd(), sourcefile: "usage-worker-fixture.ts", contents:
    'import { parentPort, workerData } from "node:worker_threads"; import { bootUsageWorker } from "./packages/host/src/usage/worker-entry.ts"; await bootUsageWorker(parentPort, workerData.command);' },
    outfile: bundle, external: ["better-sqlite3", "sqlite-vec"] });
  const hooks = new Map<string, Array<(...args: any[]) => unknown>>();
  const pi = { on(name: string, handler: (...args: any[]) => unknown) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; },
    registerCommand() {}, getSessionName: () => undefined, getThinkingLevel: () => "off" } as unknown as ExtensionAPI;
  const ctx = { cwd: worktree.root, mode: "rpc", hasUI: false, ui: { notify() {} },
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => file, getLeafId: () => "first", getEntries: () => [] },
    isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionContext;
  const emit = async (name: string) => { for (const handler of hooks.get(name) ?? []) await handler({}, ctx); };
  let admitted = true;
  const machine = "11111111-1111-4111-8111-111111111111";
  const home: Home = { sessionId: "session-1", machineId: machine, epoch: 2, moveId: null, updatedAt: 1 };
  const gate: AdmissionGate = { inspect: () => ({ kind: admitted ? "ordinary" : "control-only", home, blockers: [] }),
    refreshInitialHome: async () => gate.inspect(), whenSettled: async () => gate.inspect(), close: async () => { admitted = false; },
    freeze: async () => { admitted = false; }, unfreeze: async () => { admitted = true; } };
  const usage = registerUsage(pi, pathToFileURL(bundle), () => admitted);
  const tracker = trackReloadActivity(pi), reload = registerAutoReload(tracker.pi,
    { url: pathToFileURL(bundle).href, identity: { sha: "test", dirty: false, builtAt: "test", version: "test" } },
    () => false, () => admitted, () => false, tracker.busy, tracker);
  const jobs = join(root, "herdr", "jobs"), scratch = join(root, "scratch");
  mkdirSync(jobs, { recursive: true, mode: 0o700 }); mkdirSync(scratch, { recursive: true });
  const inert = { async pause() {}, async resume() {} };
  const bridgeAdapter: FederationBridge = { async dispatch() { throw new Error("not used"); }, receipt() {}, control() {} };
  const credential = authorizeTestBridge(agentDir, machine);
  const broker = startTestBroker(process.execPath, ["dist/intercom/broker.mjs"],
    { env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, SPIDER_GLOBAL_ROOT: root }, stdio: ["ignore", "pipe", "pipe"] });
  const brokerClient = new IntercomFederationClient(), address = { sessionId: "session-1", scopeId: null };
  const federation = createFederation({ agentDir, locals: () => [address], now: Date.now });
  const registration = { feature: FEDERATION_FEATURE, agentDir, credential, machineId: machine, machineAlias: "fixture.invalid" };
  const unregisterBridge = federation.registerBridge(registration, bridgeAdapter);
  await new Promise<void>((ready, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture broker startup timed out")), 5000);
    broker.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture broker exit ${code}`)); });
    broker.stdout!.on("data", chunk => { if (String(chunk).includes("Intercom broker started")) { clearTimeout(timer); ready(); } });
  });
  await brokerClient.connect(registration, bridgeAdapter);
  let hubAvailable = false, settled = false; const listeners = new Set<() => void>();
  const ports = createLiveFreezePorts({ globalRoot: root, sessionId: "session-1", machineId: machine, context: () => ctx, gate,
    stores: [worktree.db], expectedStores: ["worktree:fixture:workspace"], routeStores: [global], address, intercom: fixtureIntercom("session-1"),
    activity: reload.activity, jobRoots: [jobs], scratchRoots: [scratch], usageRoots: resolveUsageRoots(), usage, embeddings: inert, organism: inert, others: [],
    broker: brokerClient, bridge: address => {
      if (!federation.connected()) throw new Error("bridge unavailable");
      return federation.inspectBlockers(address, { includeExpired: true });
    }, settlement: async query => settled ? { ...query, kind: "receipt" } : null,
    async authorizeAbort() { return hubAvailable ? { home, cancelledMoveId: "move-1" } : null; },
    onHubRestored(listener) { listeners.add(listener); return () => listeners.delete(listener); } });
  const operation: Operation = { id: "freeze-1", kind: "session-freeze", machineId: machine, expectedEpoch: 2, args: { sessionId: "session-1", moveId: "move-1" } };
  const startIdentity = processStartTime(process.pid)!, leases = createSessionLeases(join(root, "herdr"));
  const inventory: ProcessInventoryPorts = { presence: createProcessPresence(leases.root), leases, processes: async () => [],
    probe: async pid => pid === process.pid ? { kind: "live", startIdentity } : { kind: "absent" } };
  const locks = createBothLocks({ root: leases.root, file: async () => file, inventory, identity: { pid: process.pid, startIdentity } });
  try { await locks("session-1", async () => {
    await emit("session_start");
    await vi.waitFor(() => expect(usage.snapshot()?.health?.calls).toBe(1), { timeout: 10000 });
    expect((await ports.inspect()).blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "intercom-bridge-route", id: "bridge-pending" }),
    ]));
    settled = true;
    expect((await ports.inspect()).blockers).toEqual([]);
    const ack = await freezeParticipant(operation, ports);
    expect(ack).toMatchObject({ sessionId: "session-1", leaf: "first" });
    expect(readSessionState(worktree.db, "session-1")?.state).toBe("frozen");
    const append = vi.fn();
    protectAdmissionApi({ appendEntry: append } as unknown as ExtensionAPI, gate).appendEntry("fixture", {});
    expect(append).not.toHaveBeenCalled();
    const ledger = openUsageLedgerReadOnly(join(root, "usage.db"));
    expect(ledger).toBeDefined();
    try {
      const before = ledger!.getImportState(file);
      appendFileSync(file, message("second", "first"));
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(ledger!.health().calls).toBe(1);
      expect(ledger!.getImportState(file)).toEqual(before);
    } finally { ledger!.close(); }
    const abort = { ...operation, id: "abort-1", kind: "session-unfreeze" };
    await expect(unfreezeParticipant(abort, ports)).rejects.toMatchObject({ code: "abort-authorization-pending" });
    expect(readSessionState(worktree.db, "session-1")?.state).toBe("frozen");
    hubAvailable = true; for (const listener of [...listeners]) listener();
    await vi.waitFor(() => expect(readSessionState(worktree.db, "session-1")?.state).toBe("active"), { timeout: 10000 });
    await vi.waitFor(() => expect(usage.snapshot()?.health?.calls).toBe(2), { timeout: 10000 });
    expect(listeners.size).toBe(0);
  }); } finally { await emit("session_shutdown"); unregisterBridge(); await brokerClient.close(); await stopTestBroker(broker); global.close(); }
}, 30000);
