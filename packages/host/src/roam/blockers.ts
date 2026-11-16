import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Db } from "@spider/db-core";
import type { Blocker } from "@spider/db-core/roam/types";
import { localRunPredicate } from "@spider/db-core/roam/run-origin";
import { storeScope } from "@spider/db-core/roam/codec";
import type { StoreKey } from "@spider/db-core/roam/types";
import { isSessionAddress, parseFederationBrokerMessage, sameAddress, type FederationBlockers, type SessionAddress } from "@spider/intercom/protocol";
import { parseJobJournal, type JournalJob } from "@spider/herdr/jobs/store";
import { needsFailedCleanup } from "@spider/herdr/jobs/cleanup";
import { listPendingPipelines, listSessionBlockers } from "@spider/subagents";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { groupHasLiveMembers, isWellFormedReceipt } from "../../../context/src/background-job.js";

/** These readers belong to one activation and must not stop or change work. */
export interface BlockerActivity {
  busy(): boolean;
  bashRunning(ctx: ExtensionContext): boolean;
  promptOpen(): boolean;
}

/** The adapter has verified terminal settlement, not an early acknowledgement or unknown outcome. */
export interface BridgeSettlement {
  messageId: string;
  kind: "receipt" | "outcome" | "delivered";
}

/** A pending mirror route. Bridge IDs are message IDs; unknown routes may use a stable mirror ID. */
export type LocalRoute = {
  id: string;
  fromSessionId: string | null;
  toSessionId: string | null;
} & ({ route: "local" | "unknown"; settlement?: never } | { route: "bridge"; settlement?: BridgeSettlement });

/** A local background job whose liveness has been observed without signalling it. */
export interface LocalBackgroundJob {
  id: string;
  ownerSessionId: string | null;
  state: "running" | "finished" | "dead" | "unknown";
}

const MAX_LOCAL_JOB_BYTES = 1024 * 1024;

async function readJobJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_LOCAL_JOB_BYTES) throw new Error("Invalid local job file");
    const bytes = Buffer.alloc(MAX_LOCAL_JOB_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_LOCAL_JOB_BYTES) throw new Error("Invalid local job file");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)));
  } finally { await handle.close(); }
}

function processAlive(pid: number): boolean | null {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null; }
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1;
}

/** Read all supplied scratch roots. An unprovable process state remains unknown. */
export async function readLocalBackgroundJobs(scratchRoots: readonly string[]): Promise<readonly LocalBackgroundJob[]> {
  if (!scratchRoots.length) throw new Error("Local job roots are unavailable");
  const jobs: LocalBackgroundJob[] = [];
  for (const root of new Set(scratchRoots)) {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== resolve(root)) throw new Error("Unsafe local job root");
    const bg = join(root, "bg");
    let info;
    try { info = await lstat(bg); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(bg) !== resolve(bg)) throw new Error("Unsafe local job directory");
    for (const entry of await readdir(bg, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) throw new Error("Invalid local job directory");
      const directory = join(bg, entry.name);
      if (await realpath(directory) !== resolve(directory)) throw new Error("Unsafe local job directory");
      let value: unknown;
      try { value = await readJobJson(join(directory, "job.json")); }
      catch { jobs.push({ id: entry.name, ownerSessionId: null, state: "unknown" }); continue; }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        jobs.push({ id: entry.name, ownerSessionId: null, state: "unknown" }); continue;
      }
      const manifest = value as Record<string, unknown>;
      if (manifest.schema !== 1 || manifest.id !== entry.name) {
        jobs.push({ id: entry.name, ownerSessionId: null, state: "unknown" }); continue;
      }
      const ownerSessionId = typeof manifest.ownerSessionId === "string" && manifest.ownerSessionId.length > 0 ? manifest.ownerSessionId : null;
      let receipt: unknown;
      try { receipt = await readJobJson(join(directory, "exit.json")); } catch { /* No valid receipt is not a completed job. */ }
      const finished = isWellFormedReceipt(receipt) ? receipt : undefined;
      const manifestSupervisor = validPid(manifest.supervisorPid) ? manifest.supervisorPid : undefined;
      const receiptSupervisor = validPid(finished?.supervisorPid) ? finished.supervisorPid : undefined;
      const manifestChild = validPid(manifest.childPid) ? manifest.childPid : undefined;
      const receiptChild = validPid(finished?.childPid) ? finished.childPid : undefined;
      const invalidPid = (value: unknown) => value !== undefined && !validPid(value);
      const conflict = invalidPid(manifest.supervisorPid) || invalidPid(manifest.childPid)
        || invalidPid(finished?.supervisorPid) || invalidPid(finished?.childPid)
        || (manifestSupervisor !== undefined && receiptSupervisor !== undefined && manifestSupervisor !== receiptSupervisor)
        || (manifestChild !== undefined && receiptChild !== undefined && manifestChild !== receiptChild);
      const supervisorPid = manifestSupervisor ?? receiptSupervisor, childPid = manifestChild ?? receiptChild;
      let state: LocalBackgroundJob["state"];
      if (conflict) state = "unknown";
      else if (supervisorPid !== undefined) {
        const alive = groupHasLiveMembers(supervisorPid);
        const childGone = childPid === undefined || processAlive(childPid) === false;
        state = alive === true ? "running" : alive === false && childGone ? (finished ? "finished" : "dead") : "unknown";
      } else if (childPid !== undefined && processAlive(childPid) === true) state = "running";
      else state = "unknown";
      jobs.push({ id: entry.name, ownerSessionId, state });
    }
  }
  return jobs.sort((a, b) => a.id.localeCompare(b.id));
}

/** Read only the owning physical session file. A torn or changing file proves nothing. */
async function recordedCompletions(file: string, sessionId: string): Promise<Set<string>> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Invalid session file");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const recorded = new Set<string>();
    let buffer = "", header = false;
    const line = (text: string) => {
      if (!text.trim()) return;
      const entry: unknown = JSON.parse(text);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid session entry");
      const row = entry as Record<string, unknown>;
      if (!header) {
        if (row.type !== "session" || row.id !== sessionId) throw new Error("Foreign session file");
        header = true; return;
      }
      if (typeof row.type !== "string" || row.type === "session") throw new Error("Invalid session entry");
      if (row.type === "custom_message" && row.customType === "spider.subagent_done") {
        const details = row.details;
        if (!details || typeof details !== "object" || Array.isArray(details)) return;
        const runId = (details as Record<string, unknown>).runId;
        if (typeof runId !== "string" || !runId) return;
        if (typeof row.id !== "string" || !row.id || typeof row.timestamp !== "string"
          || !(row.parentId === null || typeof row.parentId === "string")) throw new Error("Invalid completion entry");
        recorded.add(runId);
      }
    };
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      buffer += decoder.decode(bytes as Buffer, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    }
    buffer += decoder.decode();
    if (buffer) line(buffer);
    if (!header) throw new Error("Missing session header");
    const after = await handle.stat(), path = await lstat(file);
    if (!path.isFile() || path.isSymbolicLink() || path.dev !== before.dev || path.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Session file changed during inspection");
    return recorded;
  } finally { await handle.close(); }
}

export interface BlockerPorts {
  sessionId: string;
  activity: BlockerActivity;
  address: SessionAddress;
  broker(address: SessionAddress): Promise<FederationBlockers>;
  bridge(address: SessionAddress): FederationBlockers | Promise<FederationBlockers>;
  intercom?(): Promise<readonly Blocker[]>;
  localRoutes(): Promise<readonly LocalRoute[]>;
  topLevelJobs(): Promise<readonly JournalJob[]>;
  childJobs(): Promise<readonly JournalJob[]>;
  localJobs(): Promise<readonly LocalBackgroundJob[]>;
}

export function intercomBlockers(address: SessionAddress, value: unknown): readonly Blocker[] {
  const parsed = parseFederationBrokerMessage({ type: "blockers", requestId: "move-inventory", blockers: value });
  if (!isSessionAddress(address) || !parsed || parsed.type !== "blockers") throw new Error("Invalid intercom evidence");
  const observed = parsed.blockers, result: Blocker[] = [];
  const add = (kind: string, id: string, detail: string) => result.push({ kind, id, detail });
  for (const ask of observed.asks) {
    if (sameAddress(ask.to, address)) add("intercom-ask-inbound", ask.id, "An inbound intercom ask is unresolved.");
    if (sameAddress(ask.from, address)) add("intercom-ask-outbound", ask.id, "An outbound intercom ask is unresolved.");
  }
  for (const id of observed.pendingDispatch) add("intercom-dispatch", id, "An intercom dispatch is pending.");
  for (const id of observed.unknownOutcomes) add("intercom-unknown", id, "An intercom dispatch outcome is unknown.");
  for (const id of observed.unobservedReceipts) add("intercom-receipt", id, "An intercom receipt has not been observed.");
  return result;
}

export async function inspectBlockers(ctx: ExtensionContext, stores: readonly Db[], ports?: BlockerPorts): Promise<readonly Blocker[]> {
  const result = new Map<string, Blocker>();
  const add = (kind: string, id: string, detail: string) => result.set(JSON.stringify([kind, id]), { kind, id, detail });
  const unavailable = (source: string) => add("blocker-source-unavailable", source, `Cannot inspect ${source} blocker evidence.`);
  const read = <T>(source: string, inspect: () => T): T | undefined => {
    try { const value = inspect(); if (value != null) return value; } catch { /* Missing evidence blocks the move. */ }
    unavailable(source); return undefined;
  };
  const readAsync = async <T>(source: string, inspect: () => T | Promise<T>): Promise<T | undefined> => {
    try { const value = await inspect(); if (value != null) return value; } catch { /* Keep inspecting the other sources. */ }
    unavailable(source); return undefined;
  };
  const boolean = (value: unknown): boolean => { if (typeof value !== "boolean") throw new Error("Invalid boolean evidence"); return value; };
  const array = <T>(value: readonly T[]): readonly T[] => { if (!Array.isArray(value)) throw new Error("Invalid list evidence"); return value; };
  const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const routeKinds = { local: true, bridge: true, unknown: true } satisfies Record<LocalRoute["route"], true>;
  const settlementKinds = { receipt: true, outcome: true, delivered: true } satisfies Record<BridgeSettlement["kind"], true>;
  const settled = (value: unknown, messageId: string): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proof = value as Record<string, unknown>;
    return proof.messageId === messageId && typeof proof.kind === "string" && Object.hasOwn(settlementKinds, proof.kind);
  };
  const routes = (value: readonly LocalRoute[]): readonly LocalRoute[] => {
    for (const route of array(value)) {
      if (!route || !text(route.id) || !Object.hasOwn(routeKinds, route.route)
        || !(route.fromSessionId === null || text(route.fromSessionId)) || !(route.toSessionId === null || text(route.toSessionId))
        || (route.fromSessionId === null && route.toSessionId === null)) throw new Error("Invalid local route");
    }
    return value;
  };
  const journals = (value: readonly JournalJob[]): readonly JournalJob[] => array(value).map(job => {
    const owner = job?.owner?.sessionId;
    if (!text(owner)) throw new Error("Invalid journal owner");
    return parseJobJournal({ version: 1, sessionId: owner, revision: 0, updatedAt: 0, jobs: [job] }, owner).jobs[0]!;
  });
  const localJobs = (value: readonly LocalBackgroundJob[]): readonly LocalBackgroundJob[] => {
    for (const job of array(value)) {
      if (!job || !text(job.id) || !(job.ownerSessionId === null || text(job.ownerSessionId))
        || !["running", "finished", "dead", "unknown"].includes(job.state)) throw new Error("Invalid local job");
    }
    return value;
  };
  const federation = (value: unknown): FederationBlockers => {
    const parsed = parseFederationBrokerMessage({ type: "blockers", requestId: "inventory", blockers: value });
    if (!parsed || parsed.type !== "blockers") throw new Error("Invalid intercom evidence");
    return parsed.blockers;
  };
  const sorted = () => [...result.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const sessionId = read("session", () => ctx.sessionManager.getSessionId());
  if (!sessionId) { unavailable("session"); return sorted(); }

  if (read("pi-state", () => boolean(ctx.isIdle())) === false) add("session-busy", sessionId, "Pi has an active request, retry, or compaction.");
  if (read("pi-state", () => boolean(ctx.hasPendingMessages()))) add("queued-prompt", sessionId, "Pi has a queued prompt or message.");
  if (ctx.mode === "tui" && ctx.hasUI) {
    const draft = read("pi-state", () => {
      const value = ctx.ui.getEditorText();
      if (typeof value !== "string") throw new Error("Invalid editor evidence");
      return value;
    });
    if (draft && draft.length > 0) add("editor-draft", sessionId, "The editor contains a draft.");
  }

  const pending = read("pipelines", () => listPendingPipelines(sessionId));
  const completions = new Map<string, { id: string; name: string | null; agent: string }>();
  if (!stores.length) unavailable("run-stores");
  for (const [index, db] of stores.entries()) {
    const scope = read(`run-store-${index + 1}`, () => {
      const meta = db.prepare("SELECT store_key FROM roam_meta WHERE id=1").get() as { store_key: StoreKey } | undefined;
      if (!meta) throw new Error("Store scope unavailable");
      return storeScope(meta.store_key);
    });
    if (scope !== "worktree") continue;
    const blockers = read(`run-store-${index + 1}`, () => listSessionBlockers(db, sessionId, { pendingPipelines: () => pending ?? [] }));
    for (const blocker of blockers ?? []) add(blocker.kind, blocker.id, blocker.detail);
    const delivered = read(`run-store-${index + 1}`, () => db.prepare(`SELECT r.id, r.name, r.agent FROM runs r
      WHERE r.session_id=? AND ${localRunPredicate(db)} AND EXISTS (
        SELECT 1 FROM run_events e WHERE e.run_id=r.id AND e.type='completion_delivered'
      ) ORDER BY r.id`).all(sessionId) as { id: string; name: string | null; agent: string }[]);
    for (const row of delivered ?? []) if (!completions.has(row.id)) completions.set(row.id, row);
  }
  if (!stores.length) for (const pipeline of pending ?? []) add("pipeline", pipeline.pipelineId, "Pipeline has a pending stage.");
  if (completions.size) {
    let recorded: Set<string> | undefined;
    try {
      const file = ctx.sessionManager.getSessionFile();
      if (file) recorded = await recordedCompletions(file, sessionId);
    } catch { /* Missing or unreadable physical evidence keeps the completion blocked. */ }
    for (const row of completions.values()) if (!recorded?.has(row.id)) {
      add("run-completion", row.id, `Waiting for ${row.name || row.agent || row.id}'s completion notice to be recorded (run ${row.id}).`);
    }
  }

  if (!ports || ports.sessionId !== sessionId || !isSessionAddress(ports.address) || ports.address.sessionId !== sessionId) {
    unavailable("activation"); return sorted();
  }
  if (read("activity", () => boolean(ports.activity.busy()))) add("interactive-activity", sessionId, "A Spider command or overlay is active.");
  if (read("activity", () => boolean(ports.activity.bashRunning(ctx)))) add("direct-shell", sessionId, "A direct shell command is running.");
  if (read("activity", () => boolean(ports.activity.promptOpen()))) add("ui-prompt", sessionId, "A user prompt is open.");

  if (ports.intercom) {
    const snapshot = await readAsync("intercom", async () => {
      const blockers = await ports.intercom!();
      for (const blocker of array(blockers)) if (!blocker || !text(blocker.kind) || !text(blocker.id) || !text(blocker.detail)) throw new Error("Invalid intercom blocker");
      return blockers;
    });
    for (const blocker of snapshot ?? []) add(blocker.kind, blocker.id, blocker.detail);
  } else {
  const broker = await readAsync("broker", async () => federation(await ports.broker(ports.address)));
  const bridge = await readAsync("bridge", async () => federation(await ports.bridge(ports.address)));
  for (const observed of [broker, bridge]) {
    if (!observed) continue;
    for (const blocker of intercomBlockers(ports.address, observed)) add(blocker.kind, blocker.id, blocker.detail);
  }
  }
  const localRoutes = await readAsync("local-routes", async () => routes(await ports.localRoutes()));
  for (const route of localRoutes ?? []) {
    if (route.fromSessionId !== sessionId && route.toSessionId !== sessionId) continue;
    if (route.route === "local") add("intercom-local-route", route.id, "Local intercom mail is pending.");
    if (route.route === "unknown") add("intercom-route-unknown", route.id, "The intercom route is unknown.");
    if (route.route === "bridge" && !settled(route.settlement, route.id)) {
      add("intercom-bridge-route", route.id, `Waiting for bridge message ${route.id} to settle.`);
    }
  }
  const top = await readAsync("top-level-jobs", async () => journals(await ports.topLevelJobs()));
  const children = await readAsync("child-jobs", async () => journals(await ports.childJobs()));
  for (const job of [...(top ?? []), ...(children ?? [])]) {
    if (job.owner.sessionId !== sessionId) continue;
    if (job.uncertain || job.evidenceConflict || job.phase.kind === "finished" && (job.phase.result.reason === "unknown" || !job.output?.complete)) {
      add("remote-receipt", job.id, "The remote job outcome or receipt is unsettled.");
    }
    if ((job.phase.kind !== "finished" && job.phase.kind !== "launch-failed") || needsFailedCleanup(job)) {
      add("remote-job", job.id, job.phase.kind === "launch-failed" ? "Remote job cleanup is still pending." : "A remote job is still active.");
    }
    if (job.phase.kind === "finished" && job.notice !== "observed") add("remote-completion", job.id, "The remote job completion has not been observed.");
  }
  const local = await readAsync("local-jobs", async () => localJobs(await ports.localJobs()));
  for (const job of local ?? []) {
    if (job.ownerSessionId !== null && job.ownerSessionId !== sessionId) continue;
    if (job.state === "running" || job.state === "unknown") add("local-job", job.id,
      job.ownerSessionId === null ? "An unowned local job is running or its status is unknown." : "A local job is running or its status is unknown.");
  }
  return sorted();
}
