import { execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@spider/db-core";
import { openRoamStoreReadOnly, type RoamCatalog } from "@spider/db-core/roam/reads";
import { isRoamUuid, storeScope } from "@spider/db-core/roam/codec";
import { readLocal } from "@spider/db-core/roam/local-state";
import type { Scope, StoreKey } from "@spider/db-core/roam/types";
import { createProcessPresence, type PresenceBuild, type PresenceRecord } from "@spider/herdr/sessions/presence";
import { inspectRoamPlacement } from "@spider/herdr/roam-placement";
import { listPendingIdLocks } from "@spider/herdr/sessions/id-lock";
import type { ProcessProbe } from "@spider/herdr/sessions/lease";
import { parseBuildId } from "../../../scripts/build-id.mjs";
import { loadConfig } from "./config";
import { DEFAULT_LIMITS, type Diagnostic, type RoamConfig } from "./contracts";
import { doctorLocal, inspectStore, readStatus, type DiagnosticMachine, type DiagnosticPorts, type DiagnosticStore, type LoadedConsumer, type PeerObservation, type RoamStatus, type UsageWorker } from "./diagnostics";
import { listStoreKeys } from "./store-inventory";
import { openDiagnosticSnapshot } from "./diagnostic-snapshot";
import { isPeerFailureReason } from "./peer-errors";
import { RUNNING_INTENT_SOURCE_UNAVAILABLE } from "./supervisor";
import { inspectIntentReservations } from "./intent";

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function snapshotProblem(error: unknown): string {
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

function probeLocal(pid: number, usage: boolean): ProcessProbe {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? { kind: "absent" } : { kind: "unknown" }; }
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return { kind: "absent" };
      if (!fields[19]) return { kind: "unknown" };
      return { kind: "live", startIdentity: usage ? fields[19] : `linux:${fields[19]}` };
    }
    if (process.platform === "win32") return { kind: "unknown" };
    const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", timeout: 1000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim();
    return start ? { kind: "live", startIdentity: `${usage ? "ps-utc" : "posix"}:${start}` } : { kind: "unknown" };
  } catch { return { kind: "unknown" }; }
}

function serviceExecutables(): { label: string; file: string }[] {
  const file = join(homedir(), "Library", "LaunchAgents", "com.spider.roam.hub.plist");
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
export function createLocalDiagnosticPorts(root: string, stores: readonly DiagnosticStore[], bundleUrl: URL = new URL("../extension.js", import.meta.url)): DiagnosticPorts {
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
    async listExecutables(machine) { localOnly(machine); return serviceExecutables(); },
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
export async function inspectLocalConsumers(root: string, machineId: string, bundleUrl?: URL): Promise<ConsumerSnapshot> {
  const ports = createLocalDiagnosticPorts(root, [], bundleUrl);
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
    syncMs: 120_000, limits: DEFAULT_LIMITS };
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
  const severity = config.enabled ? "block" : "warning", problems = new Set<string>();
  const readOptions = { globalPath: join(root, "spider.db"), open, onProblem(entry: string, error?: unknown) {
    if (problems.has(entry)) return;
    problems.add(entry);
    const label = /^(?:repo:|worktree:)/.test(entry) ? entry.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 512) : "a registered or replica";
    inventory.push({ severity, reason: `Cannot inspect ${label} store.${snapshotProblem(error)}`, repairCommand: null });
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
    } catch (error) { db?.close(); inventory.push({ severity, reason: `${label}: cannot inspect the registered store.${snapshotProblem(error)}`, repairCommand: null }); }
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
          } catch (error) { db?.close(); inventory.push({ severity, reason: `${key}: cannot inspect the mapped store.${snapshotProblem(error)}`, repairCommand: null }); }
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

/** Inspect registered local stores without modifying them. */
export async function runLocalDoctor(input: { root: string; bundleUrl?: URL; currentCore?: () => Promise<string | null> }): Promise<{ enabled: boolean; diagnostics: readonly Diagnostic[]; consumers: LoadedConsumer[] }> {
  if (!isAbsolute(input.root)) throw new Error("The roaming root must be absolute");
  let root = resolve(input.root);
  try { root = realpathSync(root); } catch (error) { if (!missing(error)) throw error; }
  const configFile = join(root, "roam", "config.json");
  const config = existsSync(configFile) ? loadConfig(configFile) : disabledConfig();
  const severity = config.enabled ? "block" : "warning";
  const inventory: Diagnostic[] = [], storeDiagnostics: Diagnostic[] = [], peerFailures: Diagnostic[] = [], consumers: LoadedConsumer[] = [];
  if (config.role === "box") inventory.push({ severity, reason: `${RUNNING_INTENT_SOURCE_UNAVAILABLE}: Hosting is fenced until participant intent is available.`, repairCommand: null });
  const origins = new WeakMap<Db, string>(), seen = new Set<string>(), problems = new Set<string>();
  const open = (file: string): Db | undefined => {
    const source = resolve(file), db = openOwned(source);
    if (db) origins.set(db, source);
    return db;
  };
  const inspect = (store: DiagnosticStore): void => {
    try { storeDiagnostics.push(...inspectStore(store, config.enabled)); }
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
    } catch (error) { inventory.push({ severity, reason: `${label}: cannot inspect the registered store.${snapshotProblem(error)}`, repairCommand: null }); }
    finally { db?.close(); }
  };

  const globalPath = join(root, "spider.db");
  let global: Db | undefined, projects: DoctorProject[] = [], catalogData: DoctorCatalog | undefined;
  try { global = open(globalPath); }
  catch (error) { inventory.push({ severity, reason: `global: cannot inspect the registered store.${snapshotProblem(error)}`, repairCommand: null }); }
  if (global) try {
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
      const label = /^(?:repo:|worktree:)/.test(entry) ? entry.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 512) : "a registered or replica";
      inventory.push({ severity, reason: `Cannot inspect ${label} store.${snapshotProblem(error)}`, repairCommand: null });
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
      } catch (error) { inventory.push({ severity, reason: `${key}: cannot inspect the mapped store.${snapshotProblem(error)}`, repairCommand: null }); }
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
  const reportedHandoffs = new Set<string>();
  try {
    const pending = await listPendingIdLocks(join(root, "herdr"));
    let core: string | null = null;
    if (pending.length && input.currentCore) { try { core = await input.currentCore(); } catch { /* An unavailable core is not proof. */ } }
    for (const handoff of pending) {
      const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
      const detail = !core || !handoff.coreId ? "core identity is unavailable"
        : core !== handoff.coreId ? "destination core changed"
        : "awaiting reconciliation";
      reportedHandoffs.add(`${handoff.sessionId}\0${handoff.operationId}`);
      inventory.push({ severity, reason: `Session ${safe(handoff.sessionId)}: exact launch ${safe(handoff.operationId)} is pending; ${detail}.`, repairCommand: null });
    }
  } catch { inventory.push({ severity, reason: "Cannot inspect pending exact-launch handoffs.", repairCommand: null }); }
  try {
    for (const reservation of await inspectIntentReservations(root)) {
      if (reportedHandoffs.has(`${reservation.sessionId}\0${reservation.operationId}`)) continue;
      const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
      inventory.push({ severity, reason: `Session ${safe(reservation.sessionId)}: exact launch ${safe(reservation.operationId)} is pending; handoff and core evidence are unavailable.`, repairCommand: null });
    }
  } catch { inventory.push({ severity, reason: "Cannot inspect pending launch reservations.", repairCommand: null }); }
  const ports = createLocalDiagnosticPorts(root, [], input.bundleUrl);
  return { enabled: config.enabled, diagnostics: [...await doctorLocal(config, ports, consumers), ...storeDiagnostics, ...inventory, ...peerFailures], consumers };
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
    const severity = local.config.enabled ? "block" : "warning";
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
    status.diagnostics = local.inventory;
    return status;
  } finally { journal?.close(); local.close(); }
}
