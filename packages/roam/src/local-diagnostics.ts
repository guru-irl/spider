import { readMoveSetupDiagnostics } from "./setup-diagnostics";
import { inspectLegacyUpgrade, legacyUpgradeDiagnostic } from "./legacy-upgrade";
import { localEntries } from "@spider/db-core/roam/local-state";
import type { V0Refusal } from "./relocate/types";
import { parsePrivateTransferDiagnostic, type PrivateTransferDiagnostic } from "./private-transfer-diagnostics";
import { corePinDiagnostics } from "./core-pin-diagnostics";
import { hubPlistDirectory, hubStartupDiagnostics, inspectHubService, observedHubServiceMode, type HubServiceObservation } from "./hub-service-diagnostics";
import { hubServiceExists, hubServiceFile, hubServiceSelectionMatches, type LaunchdPorts } from "./launchd";
import { inspectSupervisorCorePin } from "./enrollment";
import { hostingWarningDiagnostic, readHostingWarnings } from "./hosting-warning";
import { execFile, execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestConfigPath, SCHEMA_VERSION, type Db } from "@spider/db-core";
import { openRoamStoreReadOnly, type RoamCatalog } from "@spider/db-core/roam/reads";
import { isRoamUuid, storeScope } from "@spider/db-core/roam/codec";
import { readLocal } from "@spider/db-core/roam/local-state";
import type { Scope, StoreKey } from "@spider/db-core/roam/types";
import { createProcessPresence, type PresenceBuild, type PresenceRecord } from "@spider/herdr/sessions/presence";
import { inspectRoamPlacement } from "@spider/herdr/roam-placement";
import { bootIdChanged, inspectIdLock, listPendingIdLocks, localBootId } from "@spider/herdr/sessions/id-lock";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import type { ProcessProbe } from "@spider/herdr/sessions/lease";
import { parseBuildId } from "../../../scripts/build-id.mjs";
import { loadConfig } from "./config";
import { DEFAULT_LIMITS, disabledIntercom, type Diagnostic, type RoamConfig } from "./contracts";
import { doctorLocal, inspectStore, localCaptureRequired, readStatus, type DiagnosticMachine, type DiagnosticPorts, type DiagnosticStore, type LoadedConsumer, type PeerObservation, type RoamStatus, type UsageWorker } from "./diagnostics";
import { listStoreKeys, StoreInventoryError, storeInventoryDiagnostic } from "./store-inventory";
import { openDiagnosticSnapshot } from "./diagnostic-snapshot";
import { readPendingMoves } from "./pending-moves";
import { isPeerFailureReason } from "./peer-errors";
import { RUNNING_INTENT_SOURCE_UNAVAILABLE } from "./supervisor";
import { createRunningIntentAuthority } from "./session-control";
import { inspectIntentReservations, inspectSuspendedIntents } from "./intent";
import { inspectAdoptedOwner } from "./launcher";
import { createIntercomRegistry, isIntercomRevocationComplete, type IntercomPairRecord } from "./intercom-registry";
import { inspectLocalIntercomDoctor } from "./intercom-doctor";
import { publicationDiagnostics } from "./intercom-publication";
import { formatRevocationGates } from "./cause-codes";
import { inspectIntercomReadiness, intercomReadinessDiagnostics, validIntercomReadiness, type IntercomReadiness } from "./intercom-readiness";
import { readPrivateBytes } from "./selected-files";

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
type SupervisorAutostart = "enabled" | "disabled" | "missing" | "unknown";
export async function inspectSupervisorAutostart(): Promise<SupervisorAutostart> {
  const v0 = "spider-roam-supervisor-v0.service", legacy = "spider-roam-supervisor.service";
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const present = (file: string): boolean => {
    try { lstatSync(file); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
  };
  let unit: string | null;
  try {
    unit = present(join(configHome, "systemd", "user", v0)) ? v0
      : present(join(homedir(), ".config", "systemd", "user", legacy)) ? legacy : null;
  } catch { return "unknown"; }
  if (!unit) return "missing";
  return new Promise(resolve => {
    execFile("systemctl", ["--user", "is-enabled", unit], { timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
      const state = stdout.trim();
      if (!error && state === "enabled") resolve("enabled");
      else if (!error && state === "enabled-runtime" || error && error.code === 1 && state === "disabled") resolve("disabled");
      else resolve("unknown");
    });
  });
}
function sessionCommand(id: string, action: "resume" | "stop" = "resume"): string {
  const argument = /^[A-Za-z0-9_][A-Za-z0-9._:-]*$/.test(id) ? id : `'${id.replaceAll("'", "'\\''")}'`;
  return `spider roam ${action} ${id.startsWith("-") ? "-- " : ""}${argument}`;
}
function snapshotProblem(error: unknown): string {
  if (error instanceof StoreInventoryError) return snapshotProblem(error.cause);
  if ((error as NodeJS.ErrnoException)?.code === "diagnostic-snapshot-wal-index-missing") return " The WAL index is missing; the store may be opening or closing. Retry inspection.";
  const message = error instanceof Error ? error.message : "";
  if (/WAL.*commit/i.test(message)) return " The WAL commit boundary is unverified; retry after normal SQLite recovery.";
  if (/store changed/i.test(message)) return " The store changed during inspection; retry.";
  return "";
}
function own(stat: { uid: number }): boolean { return typeof process.getuid !== "function" || stat.uid === process.getuid(); }

function readTargetBuild(url: URL): PresenceBuild | null {
  let fd: number | undefined;
  try {
    fd = openSync(fileURLToPath(url), constants.O_RDONLY | constants.O_NOFOLLOW);
    const buffer = Buffer.alloc(16 * 1024);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    return parseBuildId(buffer.subarray(0, size).toString("utf8"));
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function assertUsageStable(directory: string): void {
  // The launcher publishes intent before its guard and removes startup state only after the lock is ready.
  for (const name of ["lock.json.guard", "startup.json", "replace-intent.json", "replace-intent.json.guard"]) {
    try { lstatSync(join(directory, name)); }
    catch (error) { if (missing(error)) continue; throw error; }
    throw new Error("usage worker startup or replacement is in progress");
  }
}

/** Read only the identity and build fields from the existing usage server lock. */
function readUsageWorker(root: string): UsageWorker | null {
  const directory = join(root, "usage-server"), file = join(directory, "lock.json");
  let fd: number | undefined, directoryPresent = false;
  try {
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !own(parent) || (process.platform !== "win32" && (parent.mode & 0o777) !== 0o700)) throw new Error("unsafe usage directory");
    directoryPresent = true; assertUsageStable(directory);
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || !own(stat) || stat.size > 16_384 ||
        (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)) throw new Error("unsafe usage lock");
    const bytes = Buffer.alloc(16_385), length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 16_384) throw new Error("invalid usage lock");
    const value: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid usage lock");
    const row = value as Record<string, unknown>;
    if (row.version !== 1 || !Number.isSafeInteger(row.pid) || (row.pid as number) <= 0 ||
        !(row.processIdentity === undefined || typeof row.processIdentity === "string") ||
        !(row.serverBuild === undefined || typeof row.serverBuild === "string")) throw new Error("invalid usage lock");
    assertUsageStable(directory);
    return { pid: row.pid as number, processIdentity: typeof row.processIdentity === "string" ? row.processIdentity : null,
      serverBuild: typeof row.serverBuild === "string" ? row.serverBuild : null };
  } catch (error) {
    if (missing(error)) { if (directoryPresent) assertUsageStable(directory); return null; }
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

// A process may exit after the first presence check. Only ESRCH proves it is absent.
function absentOrUnknown(pid: number): ProcessProbe {
  try { process.kill(pid, 0); return { kind: "unknown" }; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? { kind: "absent" } : { kind: "unknown" }; }
}

export async function probeLocal(pid: number, usage: boolean, options: {
  platform?: NodeJS.Platform; ps?: (pid: number, timeoutMs: number) => Promise<string>;
} = {}): Promise<ProcessProbe> {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? { kind: "absent" } : { kind: "unknown" }; }
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return { kind: "absent" };
      if (!fields[19]) return absentOrUnknown(pid);
      return { kind: "live", startIdentity: usage ? fields[19] : `linux:${fields[19]}` };
    } catch { return absentOrUnknown(pid); }
  }
  if (platform === "win32") return absentOrUnknown(pid);
  const ps = options.ps ?? ((id, timeoutMs) => new Promise<string>((done, reject) => {
    execFile("/bin/ps", ["-p", String(id), "-o", "lstart="],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4096, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
      (error, stdout) => error ? reject(error) : done(stdout));
  }));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const start = (await ps(pid, 2000)).trim();
      if (start) return { kind: "live", startIdentity: `${usage ? "ps-utc" : "posix"}:${start}` };
    } catch { /* Retry once if the process still exists. */ }
    if (absentOrUnknown(pid).kind === "absent") return { kind: "absent" };
  }
  return absentOrUnknown(pid);
}

function serviceExecutables(root: string, directory: string | null | undefined = hubPlistDirectory()): { label: string; file: string }[] {
  if (!directory) return [];
  const mode = observedHubServiceMode(root, directory);
  const scoped = hubServiceFile(root, directory, mode);
  const file = mode || existsSync(scoped) || !hubServiceExists(root, directory) ? scoped : join(directory, "com.spider.roam.hub.plist");
  assertTestConfigPath(file);
  let text: string;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !own(stat) || stat.size > 128 * 1024) throw new Error("unsafe service definition");
    text = readFileSync(file, "utf8");
  } catch (error) { if (missing(error)) return []; throw error; }
  const array = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
  if (!array) throw new Error("invalid service definition");
  const values = [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => match[1]
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
  if (values.length < 2 || values.slice(0, 2).some(value => !isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value))) throw new Error("invalid service arguments");
  return [{ label: "Node", file: values[0] }, { label: "CLI", file: values[1] }];
}

function localOnly(machine: DiagnosticMachine): void {
  if (machine.peer) throw new Error("remote diagnostics require a transport");
}

/** The remote-machine ports are deliberately unavailable until the transport wiring supplies them. */
export function createLocalDiagnosticPorts(root: string, stores: readonly DiagnosticStore[], bundleUrl: URL = new URL("../extension.js", import.meta.url), hubPlistDir?: string | null): DiagnosticPorts {
  const presence = createProcessPresence(join(root, "herdr"));
  return {
    targetBuild: readTargetBuild(bundleUrl),
    async listPresence(machine) { localOnly(machine); return presence.list(); },
    async probeProcess(machine, pid) { localOnly(machine); return probeLocal(pid, false); },
    async usageWorker(machine) { localOnly(machine); return readUsageWorker(root); },
    async probeUsage(machine, pid) { localOnly(machine); return probeLocal(pid, true); },
    async bundledSqlite(machine) {
      localOnly(machine);
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(":memory:");
      try { return (db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version; }
      finally { db.close(); }
    },
    async sqliteCli(machine) {
      localOnly(machine);
      try { return execFileSync("sqlite3", ["--version"], { encoding: "utf8", timeout: 2000, maxBuffer: 1024 }).trim(); }
      catch { return null; }
    },
    async listExecutables(machine) { localOnly(machine); return serviceExecutables(root, hubPlistDir); },
    async executable(machine, file) {
      localOnly(machine);
      try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) return false; accessSync(file, constants.X_OK); return true; }
      catch { return false; }
    },
    async stores() { return stores; },
  };
}

export interface ConsumerSnapshot {
  presence: Array<{ record: PresenceRecord; probe: ProcessProbe }>;
  worker: { record: UsageWorker; probe: ProcessProbe } | null;
  bundled: string; cli: string | null;
  executables: Array<{ label: string; file: string; available: boolean }>;
}
export async function inspectLocalConsumers(root: string, machineId: string, bundleUrl?: URL, hubPlistDir?: string | null): Promise<ConsumerSnapshot> {
  const ports = createLocalDiagnosticPorts(root, [], bundleUrl, hubPlistDir);
  const machine = { machineId, label: "local machine", peer: null };
  const records = await ports.listPresence(machine);
  const presence = await Promise.all(records.map(async record => ({ record, probe: await ports.probeProcess(machine, record.pid) })));
  const record = await ports.usageWorker(machine);
  const worker = record === null ? null : { record, probe: await ports.probeUsage(machine, record.pid) };
  const bundled = await ports.bundledSqlite(machine), cli = await ports.sqliteCli(machine);
  const executables = await Promise.all((await ports.listExecutables(machine)).map(async item => ({
    ...item, available: await ports.executable(machine, item.file),
  })));
  return { presence, worker, bundled, cli, executables };
}

function disabledConfig(): RoamConfig {
  return { enabled: false, role: "hub", machineId: "", hubMachineId: "", peers: [], discoveryRoots: [], coreUnit: "",
    syncMs: 120_000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
}

function openOwned(file: string): Db | undefined {
  try {
    const parent = lstatSync(dirname(file)), stat = lstatSync(file);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || !own(parent) || !own(stat) ||
        realpathSync(dirname(file)) !== dirname(file)) throw new Error("unsafe store path");
    return openDiagnosticSnapshot(file);
  } catch (error) { if (missing(error)) return undefined; throw error; }
}

/** Open stable copies of registered stores; missing sources are never created. */
function openLocalInventory(input: { root: string }) {
  if (!isAbsolute(input.root)) throw new Error("The roaming root must be absolute");
  let root = resolve(input.root);
  try { root = realpathSync(root); } catch (error) { if (!missing(error)) throw error; }
  const configFile = join(root, "roam", "config.json");
  const config = existsSync(configFile) ? loadConfig(configFile) : disabledConfig();
  const stores: DiagnosticStore[] = [], opened = new Map<string, Db>(), inventory: Diagnostic[] = [];
  const origins = new WeakMap<Db, string>();
  const open = (file: string): Db | undefined => {
    const source = resolve(file), db = openOwned(source);
    if (db) origins.set(db, source);
    return db;
  };
  const severity = localCaptureRequired(config) ? "block" : "warning", problems = new Set<string>();
  const readOptions = { globalPath: join(root, "spider.db"), open, onProblem(entry: string, error?: unknown) {
    if (problems.has(entry)) return;
    problems.add(entry);
    const diagnostic = storeInventoryDiagnostic(entry, error, "warning");
    inventory.push({ ...diagnostic, reason: diagnostic.reason + snapshotProblem(error) });
  } };
  const add = (file: string, scope: Scope, label: string): void => {
    let db: Db | undefined;
    try {
      db = open(file);
      if (!db) return;
      const source = origins.get(db)!;
      if (opened.has(source)) { db.close(); return; }
      let key = label;
      if (Number(db.pragma("user_version")) === 14) {
        const meta = db.prepare("SELECT store_key FROM roam_meta WHERE id=1").get() as { store_key: string | null } | undefined;
        if (meta?.store_key) key = meta.store_key;
      }
      opened.set(source, db);
      stores.push({ key, scope, db });
    } catch (error) { db?.close(); inventory.push({ severity: scope === "global" ? severity : "warning", reason: `${label}: cannot inspect the registered store ${file.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 512)}.${snapshotProblem(error)}`, repairCommand: null }); }
  };
  try {
    add(join(root, "spider.db"), "global", "global");
    const global = stores.find(store => store.scope === "global")?.db;
    if (global && Number(global.pragma("user_version")) <= 14) {
      const projects = global.prepare("SELECT project_key,db_path,git_common_dir FROM projects ORDER BY project_key").all() as
        { project_key: string; db_path: string; git_common_dir: string | null }[];
      for (const project of projects) {
        add(project.db_path, "worktree", `project ${project.project_key}`);
        if (project.git_common_dir) add(join(project.git_common_dir, "spider", "repo.db"), "repo", `repository ${project.project_key}`);
      }
      if (Number(global.pragma("user_version")) === 14) {
        for (const key of listStoreKeys(global, readOptions)) {
          if (key === "global") continue;
          let db: Db | undefined;
          try {
            db = openRoamStoreReadOnly(global, key as StoreKey, readOptions);
            if (!db) continue;
            const source = origins.get(db)!;
            if (opened.has(source)) { db.close(); continue; }
            opened.set(source, db);
            stores.push({ key, scope: key.startsWith("repo:") ? "repo" : "worktree", db });
          } catch (error) { db?.close(); inventory.push({ severity: "warning", reason: `${key}: cannot inspect the mapped store.${snapshotProblem(error)}`, repairCommand: null }); }
        }
      }
    }
    return { root, config, stores, inventory, close() { for (const db of opened.values()) db.close(); } };
  } catch (error) {
    for (const db of opened.values()) db.close();
    throw error;
  }
}

interface DoctorProject { project_key: string; db_path: string; git_common_dir: string | null }
type DoctorCatalog = RoamCatalog;

function readDoctorCatalog(db: Db, projects: DoctorProject[], globalPath: string): DoctorCatalog {
  const meta = db.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id: string } | undefined;
  if (!meta) throw new Error("Missing store inventory identity");
  const prefix = "spider-local:mapping-redirect:";
  return {
    globalPath, machine: meta.machine_id, projects,
    repos: db.prepare("SELECT repo_key,path FROM roam_repo_maps").all() as DoctorCatalog["repos"],
    worktrees: db.prepare("SELECT repo_key,workspace_id,path FROM roam_workspace_maps").all() as DoctorCatalog["worktrees"],
    redirects: db.prepare("SELECT peer_stream FROM roam_cursors WHERE peer_machine = '' AND substr(peer_stream,1,?) = ?")
      .all(prefix.length, prefix) as DoctorCatalog["redirects"],
  };
}

function hostingWarningDiagnostics(db: Db): Diagnostic[] {
  return readHostingWarnings(db).map(warning => hostingWarningDiagnostic(warning.sessionId, warning));
}

/** Read hosting warnings even when hub scheduling is disabled. */
export function localHostingWarningDiagnostics(root: string): Diagnostic[] {
  let db: Db | undefined;
  try { db = openOwned(join(root, "spider.db")); return db ? hostingWarningDiagnostics(db) : []; }
  catch { return [{ severity: "warning", reason: "Cannot inspect hosting warnings.", repairCommand: null }]; }
  finally { db?.close(); }
}

/** Read the latest setup failure without starting a participant. */
export function localMoveSetupDiagnostics(root: string): Diagnostic[] {
  let db: Db | undefined;
  try { db = openOwned(join(root, "spider.db")); return db && Number(db.pragma("user_version")) === SCHEMA_VERSION ? readMoveSetupDiagnostics(db) : []; }
  catch { return [{ severity: "warning", reason: "Move setup diagnostic unavailable. Run spider roam doctor and retry setup.", repairCommand: "spider roam doctor" }]; }
  finally { db?.close(); }
}

/** Explicit private observation only. Ordinary doctor must not publish these codes. */
export function localPrivateTransferDiagnostics(root: string, operationId: string): PrivateTransferDiagnostic[] {
  let db: Db | undefined;
  try {
    db = openOwned(join(root, "roam", "journal.db"));
    if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_operation_actions'").get()) return [];
    const rows = db.prepare("SELECT result_json FROM roam_operation_actions WHERE operation_id=? AND action='move-transfer-diagnostic' ORDER BY seq DESC LIMIT 32")
      .all(operationId) as { result_json: string }[];
    return rows.reverse().flatMap(row => {
      if (row.result_json.length > 1024) return [];
      try { const parsed = parsePrivateTransferDiagnostic(JSON.parse(row.result_json)); return parsed ? [parsed] : []; }
      catch { return []; }
    });
  } finally { db?.close(); }
}

function pendingPublicationDiagnostics(root: string, records: readonly IntercomPairRecord[]): Diagnostic[] {
  if (!records.some(record => record.state === "pending")) return [];
  let journal: Db | undefined;
  try {
    journal = openOwned(join(root, "roam", "journal.db"));
    return journal ? publicationDiagnostics(journal, records) : [];
  } catch { return [{ severity: "warning", reason: "intercom-publication-diagnostics-unavailable: Publication evidence could not be inspected.", repairCommand: null }]; }
  finally { journal?.close(); }
}
/** Read pending publication evidence without starting intercom. */
export async function localPublicationDiagnostics(root: string): Promise<Diagnostic[]> {
  try { return pendingPublicationDiagnostics(root, await createIntercomRegistry(root).list()); }
  catch { return [{ severity: "warning", reason: "intercom-registry-unavailable: Pair enrollment state could not be inspected.", repairCommand: null }]; }
}

/** Disabled doctor inspects store inventory without probing services or move bindings. */
export function localStoreInventoryDiagnostics(root: string): Diagnostic[] {
  let db: Db | undefined;
  const diagnostics: Diagnostic[] = [], seen = new Set<string>();
  try {
    const path = join(root, "spider.db"); db = openOwned(path);
    if (!db || Number(db.pragma("user_version")) !== 14) return diagnostics;
    const projects = db.prepare("SELECT project_key,db_path,git_common_dir FROM projects ORDER BY project_key").all() as DoctorProject[];
    const catalog = readDoctorCatalog(db, projects, path); db.close(); db = undefined;
    listStoreKeys(catalog, { open: openOwned, onProblem(entry, error) {
      if (seen.has(entry)) return; seen.add(entry);
      const diagnostic = storeInventoryDiagnostic(entry, error, "warning");
      diagnostics.push({ ...diagnostic, reason: diagnostic.reason + snapshotProblem(error) });
    } });
  } catch { diagnostics.push({ severity: "warning", reason: "Cannot inspect the local store inventory.", repairCommand: "spider roam doctor" }); }
  finally { db?.close(); }
  return diagnostics;
}

export function isPendingLaunchDiagnostic(row: Diagnostic): boolean {
  return row.reason.startsWith("Session ") && row.reason.includes(": exact launch ") && row.reason.includes(" is pending;") ||
    row.reason === "Cannot inspect pending exact-launch handoffs." || row.reason === "Cannot inspect pending launch reservations.";
}

export async function localPendingLaunchDiagnostics(input: {
  root: string; machineId: string; currentCore?: () => Promise<string | null>;
  launchRecovery?: { bootId(): Promise<string>; probe(pid: number): Promise<ProcessProbe> };
}): Promise<Diagnostic[]> {
  const root = input.root, severity = "block";
  const inventory: Diagnostic[] = [];
  const reportedHandoffs = new Set<string>();
  let coreObservation: Promise<string | null> | undefined, pinStatus: ReturnType<typeof inspectSupervisorCorePin> | undefined;
  const currentCore = () => coreObservation ??= Promise.resolve().then(() => input.currentCore?.() ?? null).catch(() => null);
  try {
    const pending = await listPendingIdLocks(join(root, "herdr"));
    let core: string | null = null;
    if (pending.length && input.currentCore) core = await currentCore();
    for (const handoff of pending) {
      const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
      const detail = !input.currentCore ? "core identity has not been checked"
        : !core || !handoff.coreId ? "core identity is unavailable"
        : core !== handoff.coreId ? "destination core changed"
        : "awaiting reconciliation";
      const local = { machineId: input.machineId, label: "local machine", peer: null };
      const recovery = input.launchRecovery ?? { bootId: localBootId, probe: (pid: number) => createLocalDiagnosticPorts(root, []).probeProcess(local, pid) };
      let launcher = "launcher exit evidence is unavailable";
      try {
        const lock = await inspectIdLock(join(root, "herdr"), handoff.sessionId), boot = await recovery.bootId();
        if (lock?.pendingOperationId === handoff.operationId && lock.bootId && boot) {
          const owner = bootIdChanged(lock.bootId, boot) ? { kind: "absent" as const } : await recovery.probe(lock.identity.pid);
          launcher = owner.kind === "absent" || owner.kind === "live" && owner.startIdentity !== lock.identity.startIdentity ? "launcher exited"
            : owner.kind === "live" ? "launcher is alive" : launcher;
        }
      } catch { /* Missing process evidence remains blocking. */ }
      reportedHandoffs.add(`${handoff.sessionId}\0${handoff.operationId}`);
      inventory.push({ severity: "block", reason: `Session ${safe(handoff.sessionId)}: exact launch ${safe(handoff.operationId)} is pending; ${detail}; ${launcher}. Inspect the launcher PID and boot ID and the operation-labelled terminal on the destination; stop retries only after exit is proved.`,
        repairCommand: sessionCommand(handoff.sessionId, "stop") });
    }
  } catch { inventory.push({ severity, reason: "Cannot inspect pending exact-launch handoffs.", repairCommand: null }); }
  try {
    for (const reservation of await inspectIntentReservations(root)) {
      if (reportedHandoffs.has(`${reservation.sessionId}\0${reservation.operationId}`)) continue;
      const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
      const local = { machineId: input.machineId, label: "local machine", peer: null };
      const recovery = input.launchRecovery ?? { bootId: localBootId, probe: (pid: number) => createLocalDiagnosticPorts(root, []).probeProcess(local, pid) };
      const owner = await inspectAdoptedOwner({ root: join(root, "herdr"), sessionId: reservation.sessionId, operationId: reservation.operationId,
        file: reservation.file, leases: createSessionLeases(join(root, "herdr")), ...recovery });
      const session = `Session ${safe(reservation.sessionId)}: exact launch ${safe(reservation.operationId)}`;
      const stop = sessionCommand(reservation.sessionId, "stop");
      switch (owner.kind) {
        case "exited":
          inventory.push({ severity: "warning", reason: `${session} exited before readiness was recorded.`,
            repairCommand: owner.released ? stop : sessionCommand(reservation.sessionId) });
          break;
        case "live":
          inventory.push({ severity, reason: `${session} is pending; the adopted owner is still running. Close that session through its supported shutdown path, then run ${stop}.`, repairCommand: null });
          break;
        case "lease-live":
          inventory.push({ severity, reason: `${session} is pending; the file lease is still held by a live process. Close its session through its supported shutdown path, then run ${stop}.`, repairCommand: null });
          break;
        case "unavailable":
          inventory.push({ severity, reason: `${session} is pending; the owner's status is unavailable. Restore local process and boot identity inspection, then run ${stop}.`, repairCommand: null });
          break;
        case "missing": {
          if (reservation.phase === "reserved") {
            inventory.push({ severity, reason: `${session} is pending; the launch has not been invoked. Stop cancels this reservation without launching.`, repairCommand: stop });
            break;
          }
          pinStatus ??= inspectSupervisorCorePin(root, process.env);
          const pinRepair = corePinDiagnostics(pinStatus, input.machineId)[0];
          if (pinRepair && pinStatus !== "core-pin-unreachable") {
            inventory.push({ severity, reason: `${session} is pending; ${pinRepair.reason}`, repairCommand: pinRepair.repairCommand });
            break;
          }
          const core = await currentCore();
          const detail = !input.currentCore ? "core identity has not been checked. Start the pinned core through its supported startup path and inspect the operation-labelled terminal and ownership records before stopping again."
            : !core || pinStatus === "core-pin-unreachable" ? "core identity is unavailable. Start the pinned core through its supported startup path, then inspect the operation-labelled terminal and ownership records before stopping again."
            : "adopted-owner evidence is unavailable; the pinned core is available. Inspect the operation-labelled terminal, ID lock and file lease on the destination and restore ownership evidence before stopping again.";
          inventory.push({ severity, reason: `${session} is pending; ${detail}`, repairCommand: null });
          break;
        }
      }
    }
  } catch { inventory.push({ severity, reason: "Cannot inspect pending launch reservations.", repairCommand: null }); }
  return inventory.map(row => row.repairCommand?.startsWith("spider roam stop ")
    ? { ...row, reason: `${row.reason} Run this repair command on the Mac hub.` } : row);
}

export function localHubServiceDiagnostics(root: string, launchd?: Pick<LaunchdPorts, "plistDir" | "serviceHome">): Diagnostic[] {
  const directory = launchd?.plistDir ?? hubPlistDirectory();
  if (!directory) return [];
  try {
    const matches = hubServiceSelectionMatches(root, directory, process.env, launchd?.serviceHome, observedHubServiceMode(root, directory));
    return matches === false ? [{ severity: "warning", reason: "hub-core-selection-mismatch: The hub service selects a different core. Run spider roam enable again from the intended environment.", repairCommand: "spider roam enable" }] : [];
  } catch {
    return [{ severity: "warning", reason: "hub-core-selection-unavailable: Cannot inspect the hub service core selection.", repairCommand: null }];
  }
}

export function localPendingMoveDiagnostics(root: string): Diagnostic[] {
  const inventory: Diagnostic[] = [], moves = readPendingMoves(join(root, "roam", "journal.db"));
  if (moves === null) inventory.push({ severity: "warning", reason: "pending-moves-unavailable: Cannot inspect pending moves.", repairCommand: "spider roam doctor" });
  else for (const move of moves) inventory.push({ severity: "block", reason: `move-pending: Move ${move.operationId} is pending at ${move.step}.${move.detail ? ` ${move.detail}` : ''}`, repairCommand: move.repairCommand });
  return inventory;
}

/** Inspect registered local stores without modifying them. */
export async function runLocalDoctor(input: { root: string; bundleUrl?: URL; currentCore?: () => Promise<string | null>; inspectIntercomDoctor?: boolean;
  inspectUpgrade?: boolean;
  hubService?: () => Promise<HubServiceObservation>;
  hubLaunchd?: Pick<LaunchdPorts, "plistDir" | "serviceHome">;
  launchRecovery?: { bootId(): Promise<string>; probe(pid: number): Promise<ProcessProbe> };
  intercomReadiness?: () => Promise<IntercomReadiness>;
  ensureIntercomBroker?: () => Promise<void>;
  supervisorAutostart?: () => Promise<SupervisorAutostart>;
  intercomDoctor?: (input: { root: string; config: RoamConfig; agentDir: string }) => Promise<Diagnostic[]> }): Promise<{ enabled: boolean; diagnostics: readonly Diagnostic[]; consumers: LoadedConsumer[] }> {
  if (!isAbsolute(input.root)) throw new Error("The roaming root must be absolute");
  let root = resolve(input.root);
  try { root = realpathSync(root); } catch (error) { if (!missing(error)) throw error; }
  const configFile = join(root, "roam", "config.json");
  const config = existsSync(configFile) ? loadConfig(configFile) : disabledConfig();
  const required = localCaptureRequired(config), severity = required ? "block" : "warning";
  const inventory: Diagnostic[] = [], storeDiagnostics: Diagnostic[] = [], peerFailures: Diagnostic[] = [], consumers: LoadedConsumer[] = [];
  if (input.inspectUpgrade) inventory.push(legacyUpgradeDiagnostic(await inspectLegacyUpgrade(root)));
  if (config.enabled && config.role === "hub") {
    const directory = input.hubLaunchd?.plistDir;
    const service = await (input.hubService ? input.hubService() : inspectHubService(root, undefined, directory));
    inventory.push(...hubStartupDiagnostics(root, service, directory));
  }
  if (config.role === "hub") inventory.push(...localHubServiceDiagnostics(root, input.hubLaunchd), ...localPendingMoveDiagnostics(root));
  if (config.role === "box") {
    if (config.enabled && (input.supervisorAutostart || process.platform === "linux")) {
      let autostart: SupervisorAutostart = "unknown";
      try { autostart = await (input.supervisorAutostart ?? inspectSupervisorAutostart)(); } catch { /* An unavailable observation is not proof. */ }
      if (autostart === "disabled") inventory.push({ severity: "warning", reason: "supervisor-autostart-disabled: Supervisor autostart is disabled. Run spider roam enable locally on this box.", repairCommand: "spider roam enable" });
      else if (autostart === "missing") inventory.push({ severity: "warning", reason: "supervisor-not-installed: No roaming supervisor is installed. Run spider roam enable locally on this box.", repairCommand: "spider roam enable" });
      else if (autostart === "unknown") inventory.push({ severity: "warning", reason: "supervisor-autostart-unavailable: Supervisor autostart cannot be verified. Check the supervisor unit and systemd user service.", repairCommand: null });
    }
    inventory.push(...corePinDiagnostics(inspectSupervisorCorePin(root, process.env), config.machineId));
    inventory.push({ severity: "info", reason: `Recorded core unit ${config.coreUnit ?? "unavailable"} (diagnostic only).`, repairCommand: null });
    try {
      const source = openOwned(join(root, "spider.db"));
      if (!source) throw new Error("Participant authority unavailable");
      try { await createRunningIntentAuthority(source).list(); } finally { source.close(); }
    } catch { inventory.push({ severity, reason: `${RUNNING_INTENT_SOURCE_UNAVAILABLE}: Participant intent cannot be read.`, repairCommand: null }); }
  }
  const origins = new WeakMap<Db, string>(), seen = new Set<string>(), problems = new Set<string>();
  const open = (file: string): Db | undefined => {
    const source = resolve(file), db = openOwned(source);
    if (db) origins.set(db, source);
    return db;
  };
  const inspect = (store: DiagnosticStore): void => {
    try { storeDiagnostics.push(...inspectStore(store, required)); }
    catch {
      const label = store.key.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 512);
      storeDiagnostics.push({ severity, reason: `${label}: cannot inspect the store layout.`, repairCommand: null });
    }
  };
  const add = (file: string, scope: Scope, label: string): void => {
    const source = resolve(file);
    if (seen.has(source)) return;
    let db: Db | undefined;
    try {
      db = open(source);
      if (!db) return;
      let key = label;
      if (Number(db.pragma("user_version")) === 14) {
        const meta = db.prepare("SELECT store_key FROM roam_meta WHERE id=1").get() as { store_key: string | null } | undefined;
        if (meta?.store_key) key = meta.store_key;
      }
      seen.add(source);
      inspect({ key, scope, db });
    } catch (error) { inventory.push({ severity: scope === "global" ? severity : "warning", reason: `${label}: cannot inspect the registered store ${file.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 512)}.${snapshotProblem(error)}`, repairCommand: null }); }
    finally { db?.close(); }
  };

  const globalPath = join(root, "spider.db");
  let global: Db | undefined, projects: DoctorProject[] = [], catalogData: DoctorCatalog | undefined;
  try { global = open(globalPath); }
  catch (error) { inventory.push({ severity, reason: `global: cannot inspect the registered store.${snapshotProblem(error)}`, repairCommand: null }); }
  if (global) try {
    try {
      inventory.push(...hostingWarningDiagnostics(global), ...readMoveSetupDiagnostics(global));
    } catch { inventory.push({ severity: "warning", reason: "Cannot inspect hosting warnings.", repairCommand: null }); }
    let version: number | undefined, key = "global";
    try {
      version = Number(global.pragma("user_version"));
      if (version === 14) {
        const meta = global.prepare("SELECT store_key FROM roam_meta WHERE id=1").get() as { store_key: string | null } | undefined;
        if (meta?.store_key) key = meta.store_key;
      }
      seen.add(resolve(globalPath));
      inspect({ key, scope: "global", db: global });
    } catch (error) { inventory.push({ severity, reason: `global: cannot inspect the registered store.${snapshotProblem(error)}`, repairCommand: null }); }
    if (version !== undefined && version <= 14) {
      projects = global.prepare("SELECT project_key,db_path,git_common_dir FROM projects ORDER BY project_key").all() as DoctorProject[];
      if (version === 14) catalogData = readDoctorCatalog(global, projects, globalPath);
    }
    for (const peer of config.peers) try {
      const failure = cachedObservation(global, peer.machineId, Date.now())?.failure;
      if (failure) peerFailures.push({ severity,
        reason: `${peer.alias.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 160)}: ${failure}`, repairCommand: null });
    } catch { /* Invalid cached observations are reported by status. */ }
  } finally { global.close(); }

  for (const project of projects) {
    add(project.db_path, "worktree", `project ${project.project_key}`);
    if (project.git_common_dir) add(join(project.git_common_dir, "spider", "repo.db"), "repo", `repository ${project.project_key}`);
  }
  if (catalogData) {
    const readOptions = { globalPath, open, onProblem(entry: string, error?: unknown) {
      if (problems.has(entry)) return;
      problems.add(entry);
      const diagnostic = storeInventoryDiagnostic(entry, error, "warning");
      inventory.push({ ...diagnostic, reason: diagnostic.reason + snapshotProblem(error) });
    } };
    for (const key of listStoreKeys(catalogData, readOptions)) {
      if (key === "global") continue;
      let db: Db | undefined;
      try {
        db = openRoamStoreReadOnly(catalogData, key as StoreKey, { ...readOptions, open(file) {
          return seen.has(resolve(file)) ? undefined : open(file);
        } });
        if (!db) continue;
        seen.add(origins.get(db)!);
        inspect({ key, scope: key.startsWith("repo:") ? "repo" : "worktree", db });
      } catch (error) { inventory.push({ severity: "warning", reason: `${key}: cannot inspect the mapped store.${snapshotProblem(error)}`, repairCommand: null }); }
      finally { db?.close(); }
    }
  }
  try {
    for (const failure of await inspectRoamPlacement(join(root, "roam", "placement"))) {
      const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
      const detail = failure.status === "uncertain" ? "has an uncertain launch outcome; inspect the local terminals before taking action"
        : failure.status === "retryable" ? "could not start; it will retry on the next reconciliation"
        : "could not start; automatic retries stopped";
      inventory.push({ severity: "warning", reason: `Session ${safe(failure.session)}: proxy ${safe(failure.remote)} ${detail}.`, repairCommand: null });
    }
  } catch { inventory.push({ severity: "warning", reason: "Cannot inspect proxy placement state.", repairCommand: null }); }
  inventory.push(...await localPendingLaunchDiagnostics({ ...input, root, machineId: config.machineId }));
  try {
    for (const suspended of await inspectSuspendedIntents(root)) {
      const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
      const id = suspended.sessionId;
      inventory.push({ severity: "warning", reason: `Session ${safe(id)} is suspended: ${safe(suspended.reason)}.`, repairCommand: sessionCommand(id) });
    }
  } catch { inventory.push({ severity, reason: "Cannot inspect suspended hosting intents.", repairCommand: null }); }
  try {
    const records = await createIntercomRegistry(root).list();
    inventory.push(...pendingPublicationDiagnostics(root, records));
    let snapshot: Db | undefined;
    const localPairs = records.filter(record => [record.pair.source.machineId, record.pair.target.machineId].includes(config.machineId));
    const fences = new Map<string, { edgeEpoch: string; fenceId: string }>();
    try {
      snapshot = openDiagnosticSnapshot(join(root, "roam", "intercom", "queue.db"));
      if (snapshot) for (const row of snapshot.prepare("SELECT peer,edge_epoch,fence_id FROM intercom_pair_fences").all() as Array<{ peer: string; edge_epoch: string; fence_id: string }>) fences.set(row.peer, { edgeEpoch: row.edge_epoch, fenceId: row.fence_id });
    } catch { inventory.push({ severity: "block", reason: "intercom-fence-unavailable: Durable pair fences could not be inspected.", repairCommand: null }); }
    finally { snapshot?.close(); }
    for (const record of records) {
      if (record.fenceId && record.revocationEpoch && isIntercomRevocationComplete(record, {
        fenceId: record.fenceId, edgeEpoch: record.revocationEpoch,
      })) continue;
      const pair = record.pair, peer = pair.source.machineId === config.machineId ? pair.target.machineId : pair.target.machineId === config.machineId ? pair.source.machineId : null;
      const fence = peer === null ? undefined : fences.get(peer);
      const completed = !record.cleanupReason && record.fenceId === fence?.fenceId && (record.state === "revoked" && (record.revocationEpoch ?? pair.edgeEpoch) === fence?.edgeEpoch || (record.state === "pending" || record.state === "cancelled") && pair.edgeEpoch !== fence?.edgeEpoch);
      if (fence && !completed && fence.edgeEpoch !== (record.revocationEpoch ?? pair.edgeEpoch)) {
        const repairCommand = `spider roam intercom revoke ${pair.pairId} --fence-epoch ${fence.edgeEpoch}`;
        inventory.push({ severity: "block", reason: `intercom-fence-mismatch: Pair ${pair.pairId} does not match the current fence. On the hub, run ${repairCommand} with both boxes reachable to stop the pair units and confirm closure of the historical fence.`, repairCommand });
      }
      const gap = fence !== undefined && !completed && record.state !== "revoking";
      const reason = gap || record.state === "revoking" && !record.cleanupReason ? "intercom-revocation-unconfirmed" : record.cleanupReason;
      if (!reason || !gap && !["revoking", "revoked"].includes(record.state)) continue;
      const unconfirmed = reason === "intercom-revocation-unconfirmed";
      inventory.push({ severity: unconfirmed ? "block" : "warning", reason: unconfirmed
        ? `${reason}: Pair ${pair.pairId}: Box A may still reach box B until its pair host is proved stopped.${record.revocationGates?.length ? ` Gates: ${formatRevocationGates(record.revocationGates)}.` : ""} Keep both boxes reachable and run the repair command on the hub to confirm closure.`
        : reason === "intercom-revocation-shared-jobs"
          ? `${reason}: Any live terminal on ${pair.target.alias} blocks route cleanup for ${pair.pairId}, because terminal rows do not identify their owner. Let all live terminals on that core finish, then run the repair command on the hub. Finished terminal history does not block cleanup.`
          : `${reason}: Resource cleanup is pending for ${pair.pairId}. Keep both boxes reachable and run the repair command on the hub; inspect live terminals and the pair-owned resources if it remains pending.`,
        repairCommand: `spider roam intercom revoke ${pair.pairId}` });
    }
    for (const peer of fences.keys()) if (!localPairs.some(record => [record.pair.source.machineId, record.pair.target.machineId].includes(peer))) inventory.push({ severity: "block", reason: `revocation-pending: An unmatched durable fence remains for ${peer}. Keep both boxes reachable. No repair command is available without the pair record; restore it before cleanup.`, repairCommand: null });
  } catch { inventory.push({ severity: "warning", reason: "intercom-registry-unavailable: Pair enrollment state could not be inspected.", repairCommand: null }); }
  const ports = createLocalDiagnosticPorts(root, [], input.bundleUrl, config.role === "hub" ? input.hubLaunchd?.plistDir : null);
  const localDiagnostics = await doctorLocal(config, ports, consumers);
  if (input.inspectIntercomDoctor && config.intercom.enabled) try {
    const inspect = input.intercomDoctor ?? inspectLocalIntercomDoctor;
    inventory.push(...await inspect({ root, config, agentDir: process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent") }));
  } catch { inventory.push({ severity: "warning", reason: "intercom-diagnostics-unavailable: Intercom readiness could not be inspected.", repairCommand: null }); }
  if (input.inspectIntercomDoctor && config.role === "box") {
    try {
      let readiness: IntercomReadiness;
      if (input.intercomReadiness) readiness = await input.intercomReadiness();
      else {
        const bytes = readPrivateBytes(join(root, "roam"), "active-release.json", 4096);
        if (!bytes) throw new Error("active-release-unavailable");
        const release: unknown = JSON.parse(bytes.toString("utf8")); bytes.fill(0);
        if (typeof release !== "string" || !isAbsolute(release) || resolve(release) !== release) throw new Error("active-release-unavailable");
        const layout = release.match(/^(\/.+)\/spider-releases\/[a-f0-9]{64}\/node_modules\/@guru-irl\/spider$/);
        if (!layout) throw new Error("active-release-layout-invalid");
        const home = homedir(), agentDir = process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
        const sdk = join(layout[1], "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
        readiness = await inspectIntercomReadiness({ agentDir, release, sdk, cwd: home, ensureBroker: input.ensureIntercomBroker });
      }
      if (!validIntercomReadiness(readiness)) throw new Error("invalid-intercom-readiness");
      inventory.push(...intercomReadinessDiagnostics(readiness));
    } catch (error) {
      if (input.ensureIntercomBroker) throw error;
      inventory.push({ severity: "block", reason: "intercom-readiness-unavailable: Global settings and broker evidence could not be inspected.", repairCommand: null });
    }
  }
  return { enabled: config.enabled, diagnostics: [...localDiagnostics, ...storeDiagnostics, ...inventory, ...peerFailures], consumers };
}

function cachedObservation(db: Db, machineId: string, now: number): PeerObservation | undefined {
  const state = readLocal<unknown>(db, "sync-peer", machineId);
  if (state === undefined) return undefined;
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid cached peer state");
  const value = (state as { observation?: unknown }).observation;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cached observation");
  const row = value as Record<string, unknown>;
  if (row.machineId !== machineId || !Number.isSafeInteger(row.observedAt) || (row.observedAt as number) < 0 || (row.observedAt as number) > now ||
      !(row.connected === null || typeof row.connected === "boolean") ||
      !(row.lastSyncAt === null || Number.isSafeInteger(row.lastSyncAt) && (row.lastSyncAt as number) >= 0 && (row.lastSyncAt as number) <= now) ||
      !(row.failure === undefined || row.failure === null || isPeerFailureReason(row.failure)) ||
      !Array.isArray(row.cursors)) throw new Error("Invalid cached observation");
  const seen = new Set<string>();
  const cursors = row.cursors.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid cached cursor");
    const cursor = item as Record<string, unknown>;
    if (typeof cursor.storeKey !== "string" || typeof cursor.stream !== "string" || !isRoamUuid(cursor.stream) ||
        !Number.isSafeInteger(cursor.through) || (cursor.through as number) < 0) throw new Error("Invalid cached cursor");
    storeScope(cursor.storeKey);
    const identity = `${cursor.storeKey}\u0000${cursor.stream}`;
    if (seen.has(identity)) throw new Error("Duplicate cached cursor");
    seen.add(identity);
    return { storeKey: cursor.storeKey, stream: cursor.stream, through: cursor.through as number };
  });
  return { machineId, observedAt: row.observedAt as number, connected: row.connected as boolean | null,
    lastSyncAt: row.lastSyncAt as number | null, cursors, failure: typeof row.failure === "string" ? row.failure : null };
}

/** Read only local, previously observed state; never contact or start a peer. */
export function runLocalStatus(input: { root: string; now?: number }): RoamStatus {
  const local = openLocalInventory(input), now = input.now ?? Date.now();
  let journal: Db | undefined;
  try {
    const severity = localCaptureRequired(local.config) ? "block" : "warning";
    const global = local.stores.find(store => store.scope === "global")?.db;
    const usable = local.stores.filter(store => {
      if (Number(store.db.pragma("user_version")) === 14) return true;
      local.inventory.push({ severity, reason: `${store.key}: cannot report cached status for this store schema.`, repairCommand: null });
      return false;
    });
    const globalDb = global && usable.some(store => store.db === global) ? global : null;
    const observations: PeerObservation[] = [];
    if (globalDb) for (const peer of local.config.peers) try {
      const observation = cachedObservation(globalDb, peer.machineId, now);
      if (observation) observations.push(observation);
    } catch { local.inventory.push({ severity: "warning", reason: `${peer.alias}: cached observation is invalid.`, repairCommand: null }); }
    let journalAvailable = true;
    try { journal = openOwned(join(local.root, "roam", "journal.db")); }
    catch { journalAvailable = false; local.inventory.push({ severity, reason: "Cannot inspect the local operation journal.", repairCommand: null }); }
    const status = readStatus(local.config, { globalDb, stores: usable, journalDb: journal ?? null, now, observations,
      inventoryComplete: local.inventory.length === 0, journalAvailable });
    status.diagnostics.push(...local.inventory);
    if (globalDb) try {
      const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
      for (const {key,value} of localEntries<Partial<V0Refusal> | null>(globalDb, "relocate-supervisor-refusal")) {
        if (typeof value?.code !== "string" || typeof value.message !== "string" || typeof value.nextStep !== "string") continue;
        status.diagnostics.push({ severity: "warning", repairCommand: null,
          reason: `Last supervisor refusal for ${safe(key)} (${safe(value.code)}): ${safe(value.message)} ${safe(value.nextStep)}` });
      }
    } catch {
      status.diagnostics.push({ severity: "warning", repairCommand: "spider roam doctor", reason: "Cannot read the last supervisor refusals." });
    }
    return status;
  } finally { journal?.close(); local.close(); }
}
