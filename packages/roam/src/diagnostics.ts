import { SCHEMA_VERSION, validateRoamLayout, type Db } from "@spider/db-core";
import type { Home, Scope } from "@spider/db-core/roam/types";
import { readLocal } from "@spider/db-core/roam/local-state";
import type { PresenceBuild, PresenceRecord } from "@spider/herdr/sessions/presence";
import { parseBuildId } from "../../../scripts/build-id.mjs";
import type { ProcessProbe } from "@spider/herdr/sessions/lease";
import type { Diagnostic, Peer, RoamConfig } from "./contracts";

export interface DiagnosticStore { key: string; scope: Scope; db: Db }
export interface DiagnosticMachine { machineId: string; label: string; peer: Peer | null }
export interface UsageWorker { pid: number; processIdentity: string | null; serverBuild: string | null }
export interface LoadedConsumer { machine: string; kind: "pi" | "usage"; pid: number; build: string; roamSchema: number | null }
export interface DiagnosticPorts {
  targetBuild: PresenceBuild | null;
  listPresence(machine: DiagnosticMachine): Promise<readonly PresenceRecord[]>;
  probeProcess(machine: DiagnosticMachine, pid: number): Promise<ProcessProbe>;
  usageWorker(machine: DiagnosticMachine): Promise<UsageWorker | null>;
  probeUsage(machine: DiagnosticMachine, pid: number): Promise<ProcessProbe>;
  bundledSqlite(machine: DiagnosticMachine): Promise<string>;
  sqliteCli(machine: DiagnosticMachine): Promise<string | null>;
  listExecutables(machine: DiagnosticMachine): Promise<readonly { label: string; file: string }[]>;
  executable(machine: DiagnosticMachine, file: string): Promise<boolean>;
  stores(): Promise<readonly DiagnosticStore[]>;
}

function safeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 512);
}

/** Inspect the stored trigger definitions without recording or repairing drift. */
export function inspectStore(store: DiagnosticStore, enabled: boolean): Diagnostic[] {
  const { db, scope } = store;
  const label = safeText(store.key);
  const severity = enabled ? "block" : "warning";
  const version = Number(db.pragma("user_version"));
  if (version !== SCHEMA_VERSION) return [{ severity: version > SCHEMA_VERSION ? "block" : severity,
    reason: `${label}: core schema ${version} is ${version > SCHEMA_VERSION ? "newer than" : "older than"} this build's schema ${SCHEMA_VERSION}.`, repairCommand: null }];
  const meta = db.prepare("SELECT capture_enabled, roamable, problem FROM roam_meta WHERE id = 1").get() as
    { capture_enabled: number; roamable: number; problem: string | null };
  const layout = validateRoamLayout(db, scope, "inspect");
  const result: Diagnostic[] = [];
  if (meta.roamable !== 1) {
    const duplicate = /^Duplicate todo sequence for row IDs ([0-9,]+)(?:;|$)/.exec(meta.problem ?? "");
    const why = duplicate ? `Duplicate todo sequence for row IDs ${duplicate[1]}`
      : /^replica identity requires review(?:;|$)/i.test(meta.problem ?? "") ? "replica identity requires review"
      : /^Roaming trigger layout drift:/.test(meta.problem ?? "") ? "capture trigger layout drift"
      : meta.problem ? "the recorded store problem needs private review" : "no reason was recorded";
    result.push({ severity, reason: `${enabled ? "Store" : "Information: store"} ${label} is not roamable: ${why}${enabled ? "" : " (roaming is disabled)"}.`, repairCommand: null });
  }
  if (layout.triggerDrift.length) {
    const names = layout.triggerDrift.map(name => name.length <= 128 && /^[a-zA-Z0-9_]+$/.test(name) ? name : "[invalid name]").join(", ");
    result.push({ severity, reason: `${label}: Roaming trigger layout drift: ${names}; capture ${meta.capture_enabled === 0 ? "disabled" : "unsafe (still enabled; doctor did not change it)"}`,
      repairCommand: null });
  } else if (layout.diagnostic && meta.roamable === 1) {
    result.push({ severity, reason: `${label}: roaming capture is unsafe; inspect the stored problem.`, repairCommand: null });
  }
  if (scope === "worktree") {
    const late = db.prepare(`SELECT c.writer_session, c.writer_epoch, c.seq FROM roam_changes c
      JOIN roam_sessions s ON s.session_id = c.writer_session
      JOIN roam_meta m ON m.id = 1
      WHERE s.state IN ('frozen','retired') AND s.freeze_seq IS NOT NULL AND c.seq > s.freeze_seq
        AND c.origin_machine = m.machine_id AND c.origin_stream = m.stream_id AND c.writer_epoch IS NOT NULL
      ORDER BY c.seq`).all() as { writer_session: string; writer_epoch: number; seq: number }[];
    for (const row of late) result.push({ severity: "block", reason: `${label}: late local writer for session ${safeText(row.writer_session)} at epoch ${row.writer_epoch} after the freeze barrier at sequence ${row.seq}.`,
      repairCommand: null, writerEpoch: row.writer_epoch });
  } else {
    const table = scope === "global" ? "global_memory" : "memory";
    const memories = db.prepare(`SELECT uuid, content FROM ${table} WHERE machine_id IS NULL AND status = 'active'`).all() as { uuid: string; content: string }[];
    const localPath = /(?:^|[\s"'(`])(?:\/(?:home|Users|opt|var|mnt)\/|~\/|[a-zA-Z]:[\\/])/;
    for (const row of memories) if (localPath.test(row.content)) result.push({ severity: "warning",
      reason: `${label}: memory ${safeText(row.uuid)} may be machine-specific; review its tag before enabling roaming.`, repairCommand: null });
  }
  return result;
}

function localMachine(config: RoamConfig): DiagnosticMachine {
  return { machineId: config.machineId, label: "local machine", peer: null };
}
function enrolledMachines(config: RoamConfig): DiagnosticMachine[] {
  return [localMachine(config), ...config.peers.map(peer => ({ machineId: peer.machineId, label: peer.alias, peer }))];
}
function knownBuild(build: PresenceBuild | null | undefined): build is PresenceBuild {
  if (!build || typeof build.sha !== "string" || typeof build.builtAt !== "string" || typeof build.version !== "string" ||
      typeof build.dirty !== "boolean" || build.sha.length > 40 || build.builtAt.length > 24 || build.version.length > 100) return false;
  const parsed = parseBuildId(`SPIDER_BUILD_ID=${build.sha}${build.dirty ? "-dirty" : ""}@${build.builtAt} v${build.version}`);
  return !!parsed && parsed.sha !== "unknown" && parsed.sha === build.sha && parsed.builtAt === build.builtAt &&
    parsed.version === build.version && parsed.dirty === build.dirty;
}
function sameBuild(actual: PresenceBuild | undefined, target: PresenceBuild): boolean {
  return knownBuild(actual) && actual.sha === target.sha && actual.builtAt === target.builtAt &&
    actual.version === target.version && actual.dirty === target.dirty;
}
function buildLabel(build: PresenceBuild | undefined): string {
  if (!knownBuild(build)) return "unmarked";
  return `${build.sha}${build.dirty ? "-dirty" : ""}@${build.builtAt} v${build.version}`;
}
function usageBuildLabel(value: string | null): string {
  if (typeof value !== "string" || value.length > 100) return "unmarked";
  const parsed = parseBuildId(`SPIDER_BUILD_ID=${value} v0.0.0`);
  return parsed && parsed.sha !== "unknown" && !parsed.dirty && `${parsed.sha}@${parsed.builtAt}` === value ? value : "unmarked";
}
function verifiedProbe(value: unknown): ProcessProbe {
  if (!value || typeof value !== "object") return { kind: "unknown" };
  const probe = value as { kind?: unknown; startIdentity?: unknown };
  if (probe.kind === "absent") return { kind: "absent" };
  if (probe.kind === "live" && typeof probe.startIdentity === "string" && probe.startIdentity.trim()) {
    return { kind: "live", startIdentity: probe.startIdentity };
  }
  return { kind: "unknown" };
}
function sqliteAtLeast(value: string | null, minor: number): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(value.trim());
  if (!match) return false;
  const [major, versionMinor, patch] = match.slice(1).map(Number);
  return [major, versionMinor, patch].every(Number.isSafeInteger) && (major > 3 || major === 3 && versionMinor >= minor);
}

async function inspectMachine(machine: DiagnosticMachine, ports: DiagnosticPorts, requireCapture: boolean, consumers?: LoadedConsumer[]): Promise<Diagnostic[]> {
  const found: Diagnostic[] = [];
  const issue = (reason: string, repairCommand: string | null = null) => found.push({
    reason: `${machine.label}: ${reason}`, severity: requireCapture ? "block" : "warning", repairCommand,
  });
  const target = ports.targetBuild;
  if (!knownBuild(target) || target.dirty) issue("Cannot verify the target release build. Reload after installing a release.", "/reload");
  let records: readonly PresenceRecord[] | undefined;
  try {
    records = await ports.listPresence(machine);
    if (!Array.isArray(records)) throw new Error("invalid presence");
  } catch { issue("Cannot read the process presence inventory. Run spider roam doctor.", "spider roam doctor"); }
  for (const record of records ?? []) {
    if (!record || typeof record !== "object") { issue("Cannot verify a process presence record. Run spider roam doctor.", "spider roam doctor"); continue; }
    if (record.kind === "child") continue;
    if (record.kind !== "top-level" || !Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.startIdentity !== "string" || !record.startIdentity.trim()) {
      issue("Cannot verify a process presence record. Run spider roam doctor.", "spider roam doctor");
      continue;
    }
    let current: ProcessProbe;
    try { current = verifiedProbe(await ports.probeProcess(machine, record.pid)); }
    catch { current = { kind: "unknown" }; }
    if (current.kind === "absent" || current.kind === "live" && current.startIdentity !== record.startIdentity) continue;
    if (current.kind !== "live") { issue(`PID ${record.pid} has uncertain liveness. Run spider roam doctor.`, "spider roam doctor"); continue; }
    const schema = record.capabilities?.roamSchema;
    consumers?.push({ machine: machine.label, kind: "pi", pid: record.pid, build: buildLabel(record.build),
      roamSchema: typeof schema === "number" && Number.isSafeInteger(schema) ? schema : null });
    if (!knownBuild(target) || !sameBuild(record.build, target) || schema !== SCHEMA_VERSION) {
      issue(`PID ${record.pid} loaded build ${buildLabel(record.build)} without the required release or roaming schema ${SCHEMA_VERSION}. Reload it.`, "/reload");
    }
  }
  try {
    const worker = await ports.usageWorker(machine);
    if (worker) {
      if (!Number.isSafeInteger(worker.pid) || worker.pid <= 0) throw new Error("invalid worker");
      let current: ProcessProbe;
      try { current = verifiedProbe(await ports.probeUsage(machine, worker.pid)); }
      catch { current = { kind: "unknown" }; }
      if (current.kind === "unknown" || current.kind === "live" && (typeof worker.processIdentity !== "string" || !worker.processIdentity.trim())) {
        issue(`Usage worker PID ${worker.pid} has uncertain identity. Reload it.`, "/reload");
      } else if (current.kind === "live" && current.startIdentity === worker.processIdentity) {
        consumers?.push({ machine: machine.label, kind: "usage", pid: worker.pid,
          build: usageBuildLabel(worker.serverBuild), roamSchema: null });
        if (!knownBuild(target) || worker.serverBuild !== `${target.sha}@${target.builtAt}`) {
          issue(`Usage worker PID ${worker.pid} has an older or unmarked build. Reload it.`, "/reload");
        }
      }
    }
  } catch { issue("Cannot inspect the usage worker. Run spider roam doctor.", "spider roam doctor"); }
  let bundled: string | null = null, cli: string | null = null;
  try { bundled = await ports.bundledSqlite(machine); } catch { /* Unavailable is incompatible. */ }
  try { cli = await ports.sqliteCli(machine); } catch { /* Unavailable is incompatible. */ }
  if (!sqliteAtLeast(bundled, 42)) issue("Bundled SQLite must be at least 3.42 for roaming capture.");
  const cliFloor = requireCapture ? 42 : 38;
  if (!sqliteAtLeast(cli, cliFloor)) issue(`sqlite3 CLI must be at least 3.${cliFloor} ${requireCapture ? "for roaming capture" : "to write a migrated store"}.`);
  try {
    for (const executable of await ports.listExecutables(machine)) {
      let exists = false;
      try { exists = await ports.executable(machine, executable.file); } catch { /* An unknown path is not verified. */ }
      if (!exists) issue(`${executable.label} executable is missing or inaccessible.`);
    }
  } catch { issue("Cannot inspect service executable paths."); }
  return found;
}

/** Report local compatibility and store health without repairing any data. */
export async function doctorLocal(config: RoamConfig, ports: DiagnosticPorts, consumers?: LoadedConsumer[]): Promise<readonly Diagnostic[]> {
  const diagnostics = await inspectMachine(localMachine(config), ports, config.enabled, consumers);
  let stores: readonly DiagnosticStore[];
  try { stores = await ports.stores(); }
  catch { return [...diagnostics, { severity: config.enabled ? "block" : "warning", reason: "Cannot inspect the local store inventory.", repairCommand: null }]; }
  for (const store of stores) {
    try { diagnostics.push(...inspectStore(store, config.enabled)); }
    catch { diagnostics.push({ severity: config.enabled ? "block" : "warning", reason: `${safeText(store.key)}: cannot inspect the store layout.`, repairCommand: null }); }
  }
  return diagnostics;
}

export interface PeerObservation {
  machineId: string; observedAt: number; connected: boolean | null; lastSyncAt: number | null;
  cursors: readonly { storeKey: string; stream: string; through: number }[];
}
export interface StatusPorts {
  globalDb: Db | null; stores: readonly DiagnosticStore[]; journalDb: Db | null;
  now: number; observations: readonly PeerObservation[]; inventoryComplete?: boolean; journalAvailable?: boolean;
}
export interface RoamStatus {
  enabled: boolean; cached: true; available: boolean; complete: boolean; homes: Home[]; homeConflicts: string[];
  stores: Array<{ key: string; stream: string; head: number; changes: number; logBytes: number | null; versionBytes: number | null; tombstones: number;
    cursors: Array<{ machineId: string; stream: string; through: number }> }>;
  peers: Array<{ machineId: string; alias: string; connected: boolean | null; lastSyncAt: number | null;
    observationAgeMs: number | null; backlog: number | null }>;
  warnings: Array<{ machineId: string; kind: string }>;
  suspensions: Array<{ machineId: string; sessionId: string; epoch: number }>;
  incompleteOperations: Array<{ id: string; machineId: string; kind: string; expectedEpoch: number | null }> | null;
  diagnostics: Diagnostic[];
}

/** Read cached observations and committed rows. Unknown peer positions stay unknown. */
export function readStatus(config: RoamConfig, ports: StatusPorts): RoamStatus {
  const homeRows = ports.globalDb ? ports.globalDb.prepare("SELECT session_id,machine_id,epoch,move_id,updated_at FROM session_homes ORDER BY session_id").all() as
    { session_id: string; machine_id: string; epoch: number; move_id: string | null; updated_at: number }[] : [];
  const homes = homeRows.filter(row => row.machine_id !== "")
    .map(row => ({ sessionId: row.session_id, machineId: row.machine_id, epoch: row.epoch, moveId: row.move_id, updatedAt: row.updated_at }));
  const homeConflicts = homeRows.filter(row => row.machine_id === "").map(row => row.session_id);
  const stores = ports.stores.map(store => {
    const meta = store.db.prepare("SELECT stream_id FROM roam_meta WHERE id=1").get() as { stream_id: string };
    const log = store.db.prepare("SELECT count(*) AS changes,coalesce(max(seq),0) AS head FROM roam_changes").get() as { changes: number; head: number };
    let logBytes: number | null = null, versionBytes: number | null = null;
    try {
      logBytes = (store.db.prepare("SELECT coalesce(sum(pgsize),0) AS bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE tbl_name='roam_changes')").get() as { bytes: number }).bytes;
      versionBytes = (store.db.prepare("SELECT coalesce(sum(pgsize),0) AS bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE tbl_name='roam_versions')").get() as { bytes: number }).bytes;
    } catch { /* Some SQLite builds omit dbstat. */ }
    const tombstones = (store.db.prepare("SELECT count(*) AS count FROM roam_versions WHERE deleted=1").get() as { count: number }).count;
    const cursors = (store.db.prepare("SELECT peer_machine,peer_stream,last_seq FROM roam_cursors WHERE peer_machine != '' ORDER BY peer_machine,peer_stream").all() as
      { peer_machine: string; peer_stream: string; last_seq: number }[]).map(row => ({ machineId: row.peer_machine, stream: row.peer_stream, through: row.last_seq }));
    return { key: store.key, stream: meta.stream_id, head: log.head, changes: log.changes, logBytes, versionBytes, tombstones, cursors };
  });
  const warnings: RoamStatus["warnings"] = [], suspensions: RoamStatus["suspensions"] = [];
  const peers = config.peers.map(peer => {
    const state = ports.globalDb ? readLocal<{ unreachable: { clearing: boolean } | null; suspensions: Array<{ clearing: boolean; sessionId: string; epoch: number }> }>(ports.globalDb, "hub-peer", peer.machineId) : undefined;
    if (state?.unreachable && !state.unreachable.clearing) warnings.push({ machineId: peer.machineId, kind: "unreachable" });
    for (const alert of state?.suspensions ?? []) if (!alert.clearing) suspensions.push({ machineId: peer.machineId, sessionId: alert.sessionId, epoch: alert.epoch });
    const observation = ports.observations.find(row => row.machineId === peer.machineId);
    let backlog: number | null = observation && ports.inventoryComplete !== false ? 0 : null;
    if (observation && backlog !== null) for (const store of stores) {
      const cursor = observation.cursors.find(row => row.storeKey === store.key && row.stream === store.stream);
      if (!cursor || !Number.isSafeInteger(cursor.through) || cursor.through < 0 || cursor.through > store.head) { backlog = null; break; }
      backlog! += store.head - cursor.through;
    }
    const observationAgeMs = observation && Number.isSafeInteger(observation.observedAt) && observation.observedAt <= ports.now
      ? ports.now - observation.observedAt : null;
    return { machineId: peer.machineId, alias: peer.alias, connected: observation?.connected ?? null,
      lastSyncAt: observation?.lastSyncAt ?? null, observationAgeMs, backlog };
  });
  let incompleteOperations: RoamStatus["incompleteOperations"] = ports.journalAvailable === false ? null : [];
  if (ports.journalDb) try {
    incompleteOperations = (ports.journalDb.prepare(
      "SELECT operation_id,machine_id,kind,expected_epoch FROM roam_operations WHERE result_json IS NULL ORDER BY operation_id",
    ).all() as { operation_id: string; machine_id: string; kind: string; expected_epoch: number | null }[])
      .map(row => ({ id: row.operation_id, machineId: row.machine_id, kind: row.kind, expectedEpoch: row.expected_epoch }));
  } catch { incompleteOperations = null; }
  const available = ports.globalDb !== null;
  return { enabled: config.enabled, cached: true, available, complete: available && ports.inventoryComplete !== false && incompleteOperations !== null,
    homes, homeConflicts, stores, peers, warnings, suspensions, incompleteOperations, diagnostics: [] };
}

/** Refuse before any enable effect if a live consumer or writer is incompatible. */
export async function assertCompatibleConsumers(config: RoamConfig, ports: DiagnosticPorts): Promise<void> {
  for (const machine of enrolledMachines(config)) {
    const diagnostics = await inspectMachine(machine, ports, true);
    if (diagnostics.length) throw new Error(diagnostics.map(item => item.reason).join(" "));
  }
}
