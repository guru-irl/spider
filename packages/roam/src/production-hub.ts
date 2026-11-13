import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assertTestConfigPath, openDbReadOnly } from "@spider/db-core";
import { createAppClient } from "@spider/herdr/client/app";
import { createHcClient, invokeCli } from "@spider/herdr/client/hc";
import { parseHerdrConfig } from "@spider/herdr/config";
import type { HerdrConfig } from "@spider/herdr/contracts";
import { createTerminalRegistry } from "@spider/herdr/sessions/registry";
import { runStandaloneHub, type HubNotice, type HubObservation } from "./hub";
import { createLocalDiagnosticPorts } from "./local-diagnostics";
import { openJournal } from "./journal";
import { loadPeerState } from "./peer-state";
import { openLocalCore } from "./runtime";
import { createTransport } from "./transport";
import type { Clock, Peer } from "./contracts";
import type { ProcessProbe } from "@spider/herdr/sessions/lease";
export function createHubProcessProbe(probe: (pid: number) => Promise<ProcessProbe>, alive: (pid: number) => void = pid => { process.kill(pid, 0); }) {
  return async (pid: number): Promise<ProcessProbe> => {
    try { alive(pid); }
    catch (error) { return ["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") ? { kind: "absent" } : { kind: "unknown" }; }
    return probe(pid);
  };
}

function readOwnedJson(file: string): unknown {
  assertTestConfigPath(file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 ||
      typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Unsafe Herdr configuration");
  return JSON.parse(readFileSync(file, "utf8"));
}
export function loadHerdrConfig(root: string): HerdrConfig {
  const settings = join(root, "config.json");
  const value = existsSync(settings) ? readOwnedJson(settings) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid global configuration");
  const configured = (value as Record<string, unknown>)["herdr.config"];
  if (configured !== undefined && (typeof configured !== "string" || !configured)) throw new Error("Invalid Herdr configuration path");
  const file = configured === undefined ? join(root, "herdr", "config.json") : resolve(root, configured as string);
  const config = parseHerdrConfig(readOwnedJson(file));
  if (resolve(config.globalRoot) !== root) throw new Error("Herdr configuration belongs to another global root");
  return config;
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

export async function startProductionHub(root: string): Promise<{ stop(): Promise<void> }> {
  const core = openLocalCore(root);
  let hc: ReturnType<typeof createHcClient> | undefined;
  try {
    if (!core.config.enabled || core.config.role !== "hub") throw new Error("Hub synchronization is disabled");
    const herdr = loadHerdrConfig(root), env = Object.freeze({ ...process.env });
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
    const observe = async (peer: Peer): Promise<HubObservation> => {
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
        const reached = loadPeerState(core.db, peer.machineId, core.config.limits.targetBatchBytes).observation?.connected === true;
        return { reachability: state === "disconnected" ? "unreachable" : state === "connected" && reached ? "reachable" : "unknown",
          // Phase 3 supplies these observations. Missing sources are not empty inventories.
          readiness: null, suspensions: null };
      } catch { return { reachability: "unknown", readiness: null, suspensions: null }; }
    };
    const hub = await runStandaloneHub({ config: core.config, globalDb: core.db, journal, transport, clock,
      placement: { app: createAppClient({ binary: herdr.app.binary, env }), hc: client,
        registry: createTerminalRegistry(join(root, "herdr")), hcBinary: herdr.core.binary, stateRoot: join(root, "roam", "placement") },
      runtimeRoot: join(root, "roam"), socketPath: join(root, "roam", "hub.sock"),
      identity: { pid: process.pid, startIdentity: self.startIdentity }, probe, observe,
      notices: { publish: notice => nativeNotice("publish", notice.id, noticeText(notice)), clear: id => nativeNotice("clear", id) },
      async homeChangeInProgress() { return homeChangeInProgress(journalFile); },
      // Startup holds the hub lock. The sweep also holds shared transfer slots.
      artifactActive() { return false; },
    });
    let stopped: Promise<void> | undefined;
    return { stop() { return stopped ??= (async () => { try { await hub.stop(); } finally { await client.dispose(); core.close(); } })(); } };
  } catch (error) { await hc?.dispose(); core.close(); throw error; }
}
