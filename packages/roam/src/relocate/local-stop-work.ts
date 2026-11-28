import { lstat, realpath } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";
import { openDb, openDbReadOnly, type Db } from "@spider/db-core";
import { parseLocationStores } from "@spider/db-core/roam/catalog";
import { localRunPredicate } from "@spider/db-core/roam/run-origin";
import { openRoamPathReadOnly, roamReplicaPath, roamStorePath } from "@spider/db-core/roam/reads";
import type { StoreKey } from "@spider/db-core/roam/types";
import { isHerdrConnectivityFailure } from "@spider/herdr/client/availability";
import { createHcClient } from "@spider/herdr/client/hc";
import { HerdrError, object as parseObject } from "@spider/herdr/client/parse";
import type { HcClient, Owner, TerminalFinish } from "@spider/herdr/contracts";
import { readChildJobJournals } from "@spider/herdr/jobs/handoff";
import { observeJobIdentity } from "@spider/herdr/jobs/identity";
import { createJobStore, ensurePrivateDirectory, jobJournalRoot, type JobJournal, type JournalJob } from "@spider/herdr/jobs/store";
import { readBoundedFile, sha256, type RuntimeReceipt } from "@spider/herdr/remote/runtime";
import { parseRuntimeReceipt, type RemoteLogLocation } from "@spider/herdr/remote/transfer";
import type { ProcessIdentity } from "@spider/herdr/sessions/lease";
import { readPrivateJson } from "@spider/herdr/sessions/registry";
import { reapStoppedSessionRuns } from "../../../subagents/src/reaper";
import type { RunRow } from "../../../subagents/src/run-store";
import { loadHerdrConfig } from "../host-config";
import { readStopPlacement } from "./local-records";
import { toolPath } from "./launch-environment";
import { insideDirectory } from "./local-process";
import { inspectLocalBackgroundJobs } from "./local-writers";
import type { StopBlocker } from "./session-stop-types";
import type { RelocateAdapterOptions, SessionId } from "./types";

/** A recorded binding is not signal authority until Stop verifies its live terminal and births. */
export interface HostedRunBinding {
  runId: string;
  directory: string;
  address: string;
  publishedAt: number;
  supervisor: ProcessIdentity;
  child: ProcessIdentity;
}
type DurableRunRecord = { hostPid: number | null; binding: HostedRunBinding | null };

export interface StopWorkPorts {
  inventory(id: SessionId): Promise<{ excludedRoots: readonly number[]; complete: boolean }>;
  inspect(id: SessionId): Promise<{ blockers: readonly StopBlocker[]; excludedRoots: readonly number[]; complete: boolean }>;
  hostedRuns(id: SessionId): Promise<readonly HostedRunBinding[]>;
  settleRuns(id: SessionId, proveAbsent: (row: Readonly<RunRow>, durable: DurableRunRecord | null) => Promise<boolean>): Promise<readonly StopBlocker[]>;
  freezeMembership(id: SessionId, epoch: number, beforeWrite: () => Promise<void>): Promise<void>;
}

type JobBlocker = Extract<StopBlocker, { kind: "job" }>;
const check = (reason: string): StopBlocker => ({ kind: "check", reason });
const errorCode = (error: unknown) => (error as { code?: string } | null)?.code;
const safeId = (id: string) => id.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 160);
const storeUnavailable = "A recorded session run store could not be read.";

interface RunStoreLocation { required: boolean; key?: StoreKey }

async function openRunStore(file: string, { required, key }: RunStoreLocation, options: RelocateAdapterOptions, writable = false): Promise<Db | undefined> {
  try { await ensurePrivateDirectory(dirname(file), true); }
  catch (error) { if (!required && errorCode(error) === "ENOENT") return undefined; throw error; }
  for (const suffix of ["-wal", "-shm"]) {
    try { if (!(await lstat(file + suffix)).isFile()) throw new Error("Unsafe run store sidecar"); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }
  const busyTimeoutMs = Math.min(1_000, options.limits.readyMs);
  const db = openRoamPathReadOnly(file, writable
    ? path => openDb(path, { fileMustExist: true, checkpointOnClose: false, busyTimeoutMs })
    : path => openDbReadOnly(path, { busyTimeoutMs }));
  if (!db) {
    if (required) throw new Error("Missing recorded run store");
    return undefined;
  }
  try {
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_meta'").get();
    const meta = hasMeta ? db.prepare("SELECT machine_id, store_key FROM roam_meta WHERE id=1").get() as { machine_id: string; store_key: string | null } | undefined : undefined;
    if (hasMeta && meta?.machine_id !== options.config.machineId || key && (!meta || meta.store_key !== null && meta.store_key !== key))
      throw new Error("Run store identity does not match the recorded location");
    return db;
  } catch (error) { db.close(); throw error; }
}

/** A mapped store and its older replica can both contain local run evidence. */
async function sessionWorkLocations(id: SessionId, options: RelocateAdapterOptions) {
  const { globalDb } = options;
  const files = new Map<string, RunStoreLocation>();
  const checkouts = new Set<string>();
  const blockers: StopBlocker[] = [];
  const addStore = (file: string, required: boolean, key?: StoreKey) => {
    const prior = files.get(file);
    if (prior?.key && key && prior.key !== key) throw new Error("Run store has conflicting recorded locations");
    files.set(file, { required: required || prior?.required === true, key: key ?? prior?.key });
  };
  const addCheckout = async (path: string) => {
    try {
      if (!isAbsolute(path) || await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new Error("Unknown checkout");
      checkouts.add(path);
      addStore(join(path, ".spider", "project.db"), false);
    } catch { blockers.push(check("A recorded session checkout could not be inspected.")); }
  };
  try {
    const { placement, corrupt } = readStopPlacement(globalDb, id, options.config.machineId);
    if (corrupt) blockers.push(check("The local session placement could not be read."));
    const row = globalDb.prepare("SELECT cwd, stores_json FROM roam_locations WHERE session_id=?").get(id) as { cwd: string | null; stores_json: string } | undefined;
    const stores = new Set([...(placement?.stores ?? []), ...(row ? parseLocationStores(JSON.parse(row.stores_json), { allowEmpty: true }) : [])]);
    for (const key of stores) {
      if (!key.startsWith("worktree:")) continue; // Only project/worktree stores have runs.
      const separator = key.lastIndexOf(":"), repoKey = key.slice("worktree:".length, separator);
      const map = globalDb.prepare("SELECT path FROM roam_workspace_maps WHERE repo_key=? AND workspace_id=?")
        .get(repoKey, key.slice(separator + 1)) as { path: string } | undefined;
      try {
        const file = roamStorePath(globalDb, key), replica = roamReplicaPath(globalDb, key);
        addStore(file, true, key);
        if (replica !== file) addStore(replica, false, key);
      } catch { blockers.push(check(storeUnavailable)); }
      if (map) await addCheckout(map.path);
    }
    for (const cwd of new Set([placement?.cwd, row?.cwd])) {
      if (cwd == null) continue;
      // A known mapping is still useful if the session's subdirectory vanished.
      const recorded = [...checkouts].some(root => insideDirectory(root, cwd));
      try {
        if (!isAbsolute(cwd)) throw new Error("Non-absolute cwd");
        const actual = await realpath(cwd);
        if ([...checkouts].some(root => insideDirectory(root, actual))) continue;
        const root = (await options.git.run(actual, ["git", "rev-parse", "--show-toplevel"])).toString().trim();
        if (!isAbsolute(root) || !insideDirectory(root, actual)) throw new Error("Invalid checkout root");
        await addCheckout(root);
      } catch (error) {
        if (!recorded || errorCode(error) !== "ENOENT") blockers.push(check("The session working directory could not be located."));
      }
    }
    // An ordinary Mac checkout can have run rows before it has a mapped or
    // catalogued placement. Use its registered project and exact session ID.
    if (!checkouts.size && options.config.role === "hub") {
      const projects = globalDb.prepare("SELECT DISTINCT db_path FROM projects").all() as { db_path: string }[];
      for (const { db_path: file } of projects) {
        try {
          const db = (await openRunStore(file, { required: true }, options))!;
          try {
            if (!db.prepare("SELECT 1 FROM sessions WHERE id=? UNION SELECT 1 FROM runs WHERE session_id=?").get(id, id)) continue;
            addStore(file, true);
            await addCheckout(dirname(dirname(file)));
          } finally { db.close(); }
        } catch { blockers.push(check(storeUnavailable)); }
      }
    }
    if (!checkouts.size) blockers.push(check("No local checkout is recorded for the session."));
    if (![...files.values()].some(store => store.required)) {
      for (const checkout of checkouts) addStore(join(checkout, ".spider", "project.db"), true);
    }
  } catch { blockers.push(check("Session work locations could not be read.")); }
  return { files, checkouts, blockers };
}

function runPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1 && value !== process.pid;
}
function birth(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

const supervisorEvents = "SELECT payload,ts FROM run_events WHERE run_id=? AND session_id=? AND type='child_supervisor' LIMIT 2";
async function readDurableRun(db: Db, row: Readonly<RunRow>, checkouts: ReadonlySet<string>, machineId: string): Promise<DurableRunRecord | null> {
  const events = db.prepare(supervisorEvents).all(row.id, row.session_id) as { payload: string; ts: number }[];
  if (!events.length) return null;
  const record: DurableRunRecord = { hostPid: row.host_pid, binding: null };
  if (events.length !== 1 || row.origin_machine !== machineId || !runPid(row.pid) || !runPid(row.host_pid) ||
      row.pid === row.host_pid || !birth(row.pid_start_time) || !/^[a-zA-Z0-9_-]{1,160}$/.test(row.id)) return record;
  try {
    const { ts, payload } = events[0];
    const event = parseObject(JSON.parse(payload));
    const directory = [...checkouts].map(cwd => join(cwd, ".spider", "scratch", "sa", row.id.slice(0, 12)))
      .find(path => path === event.directory);
    if (event.version !== 1 || !directory || !Number.isSafeInteger(ts) || ts <= 0) return record;
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) return record;
    const state = parseObject(await readPrivateJson(join(directory, "state.json"), async handle => {
      if ((await handle.stat()).uid !== process.getuid?.()) throw new Error("Supervisor state is not owned locally");
    }, 64 * 1024));
    if (state.version !== 1 || state.directory !== directory || state.dbPath !== db.raw.name || state.runId !== row.id ||
        state.sessionId !== row.session_id || state.supervisorPid !== row.host_pid || !birth(state.supervisorStartTime) ||
        state.childPid !== row.pid || state.childStartTime !== row.pid_start_time ||
        typeof state.herdrTerminal !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(state.herdrTerminal)) return record;
    return { ...record, binding: { runId: row.id, directory, address: state.herdrTerminal, publishedAt: ts,
      supervisor: { pid: row.host_pid, startIdentity: state.supervisorStartTime },
      child: { pid: row.pid, startIdentity: row.pid_start_time },
    } };
  } catch { return record; } // A bare host PID can block absence, never authorize a signal.
}

const receiptBound = 64 * 1024;
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const location = (job: JournalJob, requestSha256: string): RemoteLogLocation => ({
  on: job.machine, directory: job.remoteDirectory, jobId: job.id, nonce: job.nonce, requestSha256,
});
type JobReads = Pick<HcClient, "get" | "fileRead">;

/** The monitor writes this file only after digest and output verification. */
async function savedReceipt(job: JournalJob, directory: string): Promise<RuntimeReceipt | null> {
  if (!job.output?.complete) return null;
  await ensurePrivateDirectory(directory, true).catch(error => { if (errorCode(error) !== "ENOENT") throw error; });
  let bytes: Buffer;
  try { bytes = await readBoundedFile(join(directory, "receipt.json"), receiptBound); }
  catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
  const { requestSha256 } = parseObject(JSON.parse(bytes.toString()));
  if (!isDigest(requestSha256)) throw new Error("Invalid collected receipt digest");
  return parseRuntimeReceipt(bytes, location(job, requestSha256));
}

async function remoteReceipt(job: JournalJob, hc: JobReads): Promise<RuntimeReceipt> {
  if (!posix.isAbsolute(job.remoteDirectory) || posix.normalize(job.remoteDirectory) !== job.remoteDirectory ||
      !/^[a-f0-9]{32}$/.test(posix.basename(job.remoteDirectory))) throw new Error("Invalid job runtime directory");
  const read = (file: string) => hc.fileRead(job.machine, posix.join(job.remoteDirectory, file));
  const request = await read("request.json"), requestSha256 = sha256(request);
  const requestIdentity = parseObject(JSON.parse(request.toString()));
  if (requestIdentity.version !== 1 || requestIdentity.jobId !== job.id || requestIdentity.nonce !== job.nonce ||
      requestSha256 !== (await read("request.json.sha256")).toString().trim()) throw new Error("Job request identity changed");
  const receipt = await read("receipt.json");
  if (sha256(receipt) !== (await read("receipt.json.sha256")).toString().trim()) throw new Error("Job receipt digest changed");
  return parseRuntimeReceipt(receipt, location(job, requestSha256));
}

/** Spawn/release failures are reported by the wrapper with its own code. */
function exitConflicts(finish: Pick<TerminalFinish, "exitCode" | "signal"> | null, receipt: RuntimeReceipt): boolean {
  if (!finish || finish.exitCode === null && finish.signal === null) return false;
  const exitCode = receipt.outcome === "spawn-error" ? 127 : receipt.outcome === "release-timeout" ? 124 : receipt.exitCode;
  const signal = receipt.signal ? osConstants.signals[receipt.signal as NodeJS.Signals] : null;
  return finish.exitCode !== exitCode || finish.signal !== signal;
}

async function inspectHerdrJob(job: JournalJob, directory: string, client: () => Promise<JobReads>, timeoutMs: number): Promise<JobBlocker | null> {
  const pending = (cancelFromOwner: boolean): JobBlocker => ({ kind: "job", id: job.id, cancelFromOwner });
  if (job.evidenceConflict || job.localDirectory !== directory) return pending(false);
  // A definite pre-launch failure did not start a payload.
  if (job.phase.kind === "launch-failed" && job.terminalReleased && !job.uncertain) return null;
  if (!/^[a-f0-9]{32}$/.test(job.nonce)) return pending(false);
  // The cancel path selects exclusively by an owned, running journal entry.
  // It still verifies the live terminal itself; this is guidance, not authority.
  const eligible = job.phase.kind === "running" && !job.uncertain;
  try {
    let receipt = await savedReceipt(job, directory);
    let native: Pick<TerminalFinish, "exitCode" | "signal"> | null = null;
    let hc: JobReads | undefined;
    if ("address" in job.phase && !(receipt && job.terminalReleased)) {
      const address = job.phase.address;
      try {
        hc = await client();
        const terminal = await hc.get(address, { timeoutMs });
        if (observeJobIdentity(job, address, terminal).kind !== "matched") return pending(false);
        if (terminal.state === "live") return pending(eligible);
        native = terminal;
      } catch (error) {
        const offline = errorCode(error) === "core-unavailable" || isHerdrConnectivityFailure(error);
        // A collected receipt is durable. A disconnected core is not a
        // contradiction, but a replaced core or mismatched terminal is.
        if (errorCode(error) !== "not_found" && !(receipt && job.phase.kind === "finished" && offline)) throw error;
      }
    }
    if (!receipt) {
      receipt = await remoteReceipt(job, hc ?? await client());
      // Do not accept the read if core replacement could have changed the route.
      await client();
    }
    const savedFinish = job.phase.kind === "finished" && !(job.handoffCancelled && job.phase.result.reason === "cancelled")
      ? job.phase.result : null;
    if (exitConflicts(native, receipt) || exitConflicts(job.originalFinish, receipt) || exitConflicts(savedFinish, receipt)) return pending(false);
    return null;
  } catch (error) { return pending(eligible && errorCode(error) !== "core-mismatch"); }
}

function jobReadConnections(options: RelocateAdapterOptions) {
  const holders = new Map<string, ReturnType<typeof createHcClient>>();
  async function connect({ terminal }: Owner): Promise<JobReads> {
    const { socket, sessionNamespace, coreId } = terminal;
    const key = JSON.stringify([socket, sessionNamespace, coreId]);
    let hc = holders.get(key);
    if (!hc) {
      let config;
      try { config = loadHerdrConfig(options.root); }
      catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      const override = process.env.SPIDER_ROAM_HC;
      if (override && !isAbsolute(override)) throw new Error("Invalid hc path");
      hc = createHcClient({ binary: override || config?.core.binary || "hc", maxReplyBytes: options.limits.replyBytes,
        env: { HOME: process.env.HOME, PATH: toolPath(process.env.PATH, process.execPath), HC_SOCKET: socket, HC_SESSION: sessionNamespace },
      });
      holders.set(key, hc);
    }
    const observed = await hc.identity();
    if (observed.coreId !== coreId || observed.socket !== socket || observed.sessionNamespace !== sessionNamespace)
      throw new HerdrError("core-mismatch", "Herdr job owner core changed");
    return hc;
  }
  return { connect, async close() { await Promise.all([...holders.values()].map(hc => hc.dispose())); } };
}

export function createStopWork(options: RelocateAdapterOptions): StopWorkPorts {
  return {
    async inventory(id) {
      const { checkouts, files, blockers } = await sessionWorkLocations(id, options);
      let complete = !blockers.length;
      const excludedRoots = new Set<number>();
      for (const [file, store] of files) {
        try {
          const db = await openRunStore(file, store, options);
          if (db) try {
            db.prepare(`SELECT id FROM runs r WHERE r.session_id=? AND ${localRunPredicate(db)} LIMIT 1`).get(id);
          } finally { db.close(); }
        } catch { complete = false; }
      }
      // Only local manifests can name a local detached process tree. Herdr
      // job journals are checked separately for exit, not signal authority.
      for (const checkout of checkouts) {
        try {
          for (const job of await inspectLocalBackgroundJobs(id, checkout, true)) {
            complete &&= job.complete;
            for (const pid of job.excludedRoots) excludedRoots.add(pid);
          }
        } catch { complete = false; }
      }
      return { excludedRoots: [...excludedRoots], complete };
    },
    async inspect(id) {
      const { checkouts, files, blockers } = await sessionWorkLocations(id, options);
      let complete = !blockers.length;
      const incomplete = (reason: string) => { complete = false; blockers.push(check(reason)); };
      const excludedRoots = new Set<number>();
      const jobs = new Map<string, JobBlocker>();
      for (const [file, store] of files) {
        try {
          const db = await openRunStore(file, store, options);
          if (db) try { db.prepare("SELECT id FROM runs WHERE session_id=? LIMIT 1").get(id); }
          finally { db.close(); }
        } catch { incomplete(storeUnavailable); }
      }
      for (const checkout of checkouts) {
        try {
          for (const job of await inspectLocalBackgroundJobs(id, checkout, true)) {
            complete &&= job.complete;
            for (const pid of job.excludedRoots) excludedRoots.add(pid);
            jobs.set(job.id, { kind: "job", id: job.id, cancelFromOwner: false });
          }
        } catch { incomplete("Session background job records could not be read."); }
      }

      const root = jobJournalRoot(options.root), sessionId = id as unknown as Owner["sessionId"];
      const journals: JobJournal[] = [];
      try {
        const journal = await createJobStore(root, sessionId).read();
        if (journal.child || journal.jobs.some(job => job.runId !== undefined)) throw new Error("Invalid main job journal");
        journals.push(journal);
      } catch { incomplete("The session's Herdr job journal could not be read."); }
      try {
        journals.push(...await readChildJobJournals(root, { sessionId }, (_error, runId) => {
          incomplete(`Herdr job journal for subagent run ${runId} could not be read.`);
        }, { strict: true }));
      } catch { incomplete("The session's Herdr child journals could not be listed."); }

      const ownedJobs = new Map<string, JournalJob[]>();
      for (const journal of journals) for (const job of journal.jobs) {
        const key = job.id.toLowerCase();
        const group = ownedJobs.get(key);
        if (group) group.push(job);
        else ownedJobs.set(key, [job]);
      }
      const connections = jobReadConnections(options);
      try {
        for (const [job, ...duplicates] of ownedJobs.values()) {
          const directory = join(createJobStore(root, sessionId, job.runId).directory, "logs", job.id);
          const blocker = duplicates.length ? { kind: "job" as const, id: job.id, cancelFromOwner: false }
            : await inspectHerdrJob(job, directory, () => connections.connect(job.owner), options.limits.controlMs);
          if (blocker && !jobs.has(job.id)) jobs.set(job.id, blocker);
        }
      } finally { await connections.close(); }
      return { complete, excludedRoots: [...excludedRoots], blockers: [...jobs.values(), ...blockers] };
    },
    async hostedRuns(id) {
      const { files, checkouts } = await sessionWorkLocations(id, options);
      const bindings: HostedRunBinding[] = [];
      for (const [file, store] of files) {
        try {
          const db = await openRunStore(file, store, options);
          if (!db) continue;
          try {
            const rows = db.prepare(`SELECT r.* FROM runs r WHERE r.session_id=? AND r.pid IS NOT NULL AND ${localRunPredicate(db)}
              AND EXISTS (SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.session_id=r.session_id AND e.type='child_supervisor') ORDER BY r.id`)
              .all(id) as RunRow[];
            for (const row of rows) {
              const record = await readDurableRun(db, row, checkouts, options.config.machineId);
              if (record?.binding) bindings.push(record.binding);
            }
          } finally { db.close(); }
        } catch { /* The absence check reports unreadable stores separately. */ }
      }
      return bindings;
    },
    async settleRuns(id, proveAbsent) {
      const { files, checkouts, blockers } = await sessionWorkLocations(id, options);
      for (const [file, store] of files) {
        try {
          const db = await openRunStore(file, store, options, true);
          if (!db) continue;
          try {
            const pending = await reapStoppedSessionRuns({ db, globalDb: options.globalDb, sessionId: id,
              proveAbsent: async row => proveAbsent(row, await readDurableRun(db, row, checkouts, options.config.machineId)),
            });
            for (const runId of pending.blockers) blockers.push(check(`Subagent run ${safeId(runId)} has no verified absence.`));
          } finally { db.close(); }
        } catch { blockers.push(check(storeUnavailable)); }
      }
      return [...new Map(blockers.map(blocker => [JSON.stringify(blocker), blocker])).values()];
    },
    async freezeMembership(id, epoch, beforeWrite) {
      const { files, blockers } = await sessionWorkLocations(id, options);
      if (blockers.length) throw new Error("Recorded membership locations are unavailable");
      for (const [file, location] of files) {
        const db = await openRunStore(file, location, options, true);
        if (!db) continue;
        try {
          await beforeWrite();
          db.raw.transaction(() => {
            const row = db.prepare("SELECT epoch FROM roam_sessions WHERE session_id=?").get(id) as { epoch: number } | undefined;
            if (row && row.epoch > epoch) throw new Error("Local membership has a newer epoch");
            // No insert or seed: retiring a Stop never reopens admission.
            db.prepare("UPDATE roam_sessions SET epoch=?, state='frozen' WHERE session_id=? AND state IN ('active','frozen') AND epoch<=?")
              .run(epoch, id, epoch);
          }).immediate();
        } finally { db.close(); }
      }
    },
  };
}
