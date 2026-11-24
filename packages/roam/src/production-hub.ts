import { loadHerdrConfig } from "./host-config";
export { loadHerdrConfig } from "./host-config";
import { createProductionRecoveryPorts } from "./recovery-transport";

import { createPendingHandoffControl, pendingHandoffLifecycle } from "./pending-handoff";
import { createRunningIntentAuthority } from "./session-control";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { localBootId } from "@spider/herdr/sessions/id-lock";
import { machineMoveEvidence } from "./machine-move-evidence";
import { openFreezeJournal } from "./journal";
import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertTestConfigPath, openDbReadOnly } from "@spider/db-core";
import { createHcClient, invokeCli } from "@spider/herdr/client/hc";
import { machineRebuilt, machineState } from "@spider/herdr/machine-connections";

import { VIEW_ON_MAC_MESSAGE } from "@spider/herdr/notices";

import { runStandaloneHub, type HubNotice, type HubObservation, type StandaloneHubPorts } from "./hub";
import { createLocalDiagnosticPorts } from "./local-diagnostics";
import { openJournal } from "./journal";
import { remoteHosting } from "./remote-observations";
import { loadPeerState } from "./peer-state";
import { isSyncConnectivityFailure } from "./peer-errors";
import { openLocalCore, readLocalIdentity } from "./runtime";
import { createTransport } from "./transport";
import { createMachineIntercom } from "./intercom-runtime";
import { createProductionIntercomMaintenance } from "./intercom-production";
import type { Clock, PlacementFactory } from "./contracts";
import type { ProcessProbe } from "@spider/herdr/sessions/lease";
export function createHubProcessProbe(probe: (pid: number) => Promise<ProcessProbe>, alive: (pid: number) => void = pid => { process.kill(pid, 0); }) {
  return async (pid: number): Promise<ProcessProbe> => {
    try { alive(pid); }
    catch (error) { return ["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") ? { kind: "absent" } : { kind: "unknown" }; }
    return probe(pid);
  };
}

// The native identifier keeps a retry from adding another delivered notification.
const NOTIFICATION_SCRIPT = `ObjC.import('Foundation');
function run(args) {
  var center = $.NSUserNotificationCenter.defaultUserNotificationCenter;
  var items = center.deliveredNotifications, found = false;
  for (var i = 0; i < items.count; i++) {
    var item = items.objectAtIndex(i);
    if (ObjC.unwrap(item.identifier) === args[1]) {
      found = true; if (args[0] === 'clear') center.removeDeliveredNotification(item);
    }
  }
  if (args[0] === 'publish' && !found) {
    var note = $.NSUserNotification.alloc.init;
    note.identifier = $(args[1]); note.title = $('Spider roaming'); note.informativeText = $(args[2]);
    center.deliverNotification(note);
  }
}`;
function notificationBinary(): string {
  if (!process.env.SPIDER_TEST_FIXTURE_CHECKOUT) return "/usr/bin/osascript";
  const file = process.env.SPIDER_TEST_ROAM_OSASCRIPT;
  if (!file || !isAbsolute(file)) throw new Error("No isolated notification fixture");
  assertTestConfigPath(file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe notification fixture");
  return file;
}
function nativeNotice(action: "publish" | "clear", id: string, text = ""): Promise<void> {
  const binary = notificationBinary();
  return new Promise((done, reject) => execFile(binary, ["-l", "JavaScript", "-e", NOTIFICATION_SCRIPT, "--", action, id, text],
    { timeout: 5000, maxBuffer: 16 * 1024 }, error => error ? reject(error) : done()));
}
function noticeText(notice: HubNotice): string {
  const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
  return notice.kind === "unreachable" ? `Machine ${safe(notice.machineId)} is unreachable.`
    : `Session ${safe(notice.sessionId ?? "unknown")} is suspended on ${safe(notice.machineId)}.`;
}

/** A missing, malformed, or unreadable journal never proves that a home change is absent. */
export function homeChangeInProgress(file: string): boolean | null {
  try {
    const db = openDbReadOnly(file);
    if (!db) return null;
    try {
      if (db.prepare("SELECT 1 FROM roam_operations WHERE result_json IS NULL AND kind IN ('move','claim','recover','freeze','unfreeze','retire','session-start') LIMIT 1").get()) return true;
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='freeze_journal'").get() &&
          db.prepare("SELECT 1 FROM freeze_journal WHERE state IS NULL OR state NOT IN ('complete','aborted') LIMIT 1").get()) return true;
      return false;
    } finally { db.close(); }
  } catch { return null; }
}

export function parseMachineReachability(state: unknown, why?: unknown): HubObservation["reachability"] {
  if (machineRebuilt({ state, why })) return "identity";
  const connection = machineState({ state, why });
  return connection === "disconnected" ? "unreachable" : connection === "connected" ? "reachable" : "unknown";
}

export async function startProductionHub(root: string, options: { intercomClock?: Clock; moveFactory?: import("./move-runtime-contracts").MoveRuntimeFactory; placementFactory?: PlacementFactory } = {}): Promise<{ stop(): Promise<void> }> {
  const core = openLocalCore(root);
  let hc: ReturnType<typeof createHcClient> | undefined;
  let placement: ReturnType<PlacementFactory> | undefined;
  try {
    if (!core.config.enabled || core.config.role !== "hub") throw new Error("Hub synchronization is disabled");
    const herdr = loadHerdrConfig(root), env = Object.freeze({ ...process.env });
    if (herdr.mode === "core-only") throw new Error(VIEW_ON_MAC_MESSAGE);
    hc = createHcClient({ binary: herdr.core.binary, env });
    const client = hc;
    const transport = createTransport({ binary: herdr.core.binary, env, enrolled: core.config.peers });
    const local = { machineId: core.config.machineId, label: "local machine", peer: null };
    const processPorts = createLocalDiagnosticPorts(root, []);
    const probe = createHubProcessProbe(pid => processPorts.probeProcess(local, pid));
    const self = await probe(process.pid);
    if (self.kind !== "live") throw new Error("Cannot verify the hub process identity");
    const clock: Clock = { now: () => Date.now(), later(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
    const journalFile = join(root, "roam", "journal.db"), journal = openJournal(journalFile);
    const direct = core.config.intercom.routes.filter(route => route.kind === "direct").map(route => route.peer);
    const machineIntercom = core.config.intercom.enabled ? createMachineIntercom({ root, globalDb: core.db, config: core.config, roamingEnabled: () => readLocalIdentity(root).enabled,
      ...machineMoveEvidence({ db: core.db, config: core.config, journal: openFreezeJournal(journalFile), transport }),
      agentDir: herdr.agentDirectory, clock: options.intercomClock ?? clock, env, directPeers: direct, transport: createTransport({ binary: herdr.core.binary, env, enrolled: direct }),
      ...createProductionIntercomMaintenance({ root, config: core.config, binary: herdr.core.binary, env }) }) : undefined;
    const intercom = pendingHandoffLifecycle(root, createPendingHandoffControl({ root: join(root, "herdr"), journal,
      authority: createRunningIntentAuthority(core.db), inventory: { leases: createSessionLeases(join(root, "herdr")), probe },
      identity: { pid: process.pid, startIdentity: self.startIdentity }, bootId: localBootId }), machineIntercom);
    const observe: StandaloneHubPorts["observe"] = async (peer, results) => {
      try {
        const before = await client.identity();
        const value = await invokeCli(herdr.core.binary, ["machine", "ls", "--json"], env);
        const after = await client.identity();
        if (before.coreId !== after.coreId || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unknown core");
        const machines = (value as { machines?: unknown }).machines;
        if (!Array.isArray(machines)) throw new Error("Unknown machines");
        const matches = machines.filter(row => row && typeof row === "object" && !Array.isArray(row) && row.name === peer.alias);
        if (matches.length !== 1) throw new Error("Unknown machine");
        const state = matches[0].state;
        const syncState = loadPeerState(core.db, peer.machineId, core.config.limits.targetBatchBytes);
        const reached = syncState.observation?.connected === true && !results.some(isSyncConnectivityFailure);
        const reachability = parseMachineReachability(state, matches[0].why);
        if (reachability !== "reachable") return { reachability, readiness: null, suspensions: null };
        if (syncState.observation?.connected !== true) return { reachability, syncVerified: false, readiness: null, suspensions: null };
        try { const hosting = await remoteHosting(transport, peer, core.config); return { reachability, syncVerified: reached, ...hosting }; }
        catch { return { reachability, syncVerified: reached, readiness: null, suspensions: null }; }
      } catch { return { reachability: "unknown", readiness: null, suspensions: null }; }
    };
    placement = options.placementFactory?.({ root, globalDb: core.db, config: core.config });
    const hub = await runStandaloneHub({ config: core.config, globalDb: core.db, journal, transport, clock, intercom,
      placement,
      runtimeRoot: join(root, "roam"), socketPath: join(root, "roam", "hub.sock"),
      identity: { pid: process.pid, startIdentity: self.startIdentity }, probe, observe,
      notices: { publish: notice => nativeNotice("publish", notice.id, noticeText(notice)), clear: id => nativeNotice("clear", id) },
      async homeChangeInProgress() { return homeChangeInProgress(journalFile); },
      // Startup holds the hub lock. The sweep also holds shared transfer slots.
      artifactActive() { return false; },
      moveFactory: options.moveFactory,
      ...createProductionRecoveryPorts({ root, config: core.config, globalDb: core.db, journal, transport }),
    });
    let stopped: Promise<void> | undefined;
    return { stop() { return stopped ??= (async () => { try { await hub.stop(); } finally { await placement?.dispose(); await client.dispose(); core.close(); } })(); } };
  } catch (error) { await placement?.dispose(); await hc?.dispose(); core.close(); throw error; }
}

/** The hub obtains exact session bytes using the same authenticated artifact transfer as moves. */
