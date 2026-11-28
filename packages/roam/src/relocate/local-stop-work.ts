import { lstat, realpath } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";
import { openDb, openDbReadOnly, type Db } from "@spider/db-core";
import { parseLocationStores } from "@spider/db-core/roam/catalog";
import { readLocal } from "@spider/db-core/roam/local-state";
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
import { reapStoppedSessionRuns } from "../../../subagents/src/reaper";
import type { RunRow } from "../../../subagents/src/run-store";
import { loadHerdrConfig } from "../host-config";
import { parsePlacement } from "./journal";
import { toolPath } from "./launch-environment";
import { insideDirectory } from "./local-process";
import { inspectLocalBackgroundJobs } from "./local-writers";
import type { StopBlocker } from "./session-stop-types";
import type { RelocateAdapterOptions, SessionId } from "./types";

export interface StopWorkPorts {
  inspect(id: SessionId): Promise<{ blockers: readonly StopBlocker[]; excludedRoots: readonly number[]; complete: boolean }>;
  settleRuns(id: SessionId, proveAbsent: (row: Readonly<RunRow>) => Promise<boolean>): Promise<readonly StopBlocker[]>;
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
    const saved = readLocal<unknown>(globalDb, "relocate-managed", id);
    const placement = saved === undefined ? undefined : parsePlacement(saved);
    if (placement && (placement.sessionId !== id || placement.machineId !== options.config.machineId)) throw new Error("Foreign placement");
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
    async settleRuns(id, proveAbsent) {
      const { files, blockers } = await sessionWorkLocations(id, options);
      for (const [file, store] of files) {
        try {
          const db = await openRunStore(file, store, options, true);
          if (!db) continue;
          try {
            const pending = await reapStoppedSessionRuns({ db, globalDb: options.globalDb, sessionId: id, proveAbsent });
            for (const runId of pending.blockers) blockers.push(check(`Subagent run ${safeId(runId)} has no verified absence.`));
          } finally { db.close(); }
        } catch { blockers.push(check(storeUnavailable)); }
      }
      return [...new Map(blockers.map(blocker => [JSON.stringify(blocker), blocker])).values()];
    },
  };
}
