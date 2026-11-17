import { constants } from "node:fs";
import { chmod, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import type { ProcessIdentity } from "@spider/db-core/roam/types";
import { hash, jsonFiles, privateDirectory, readPrivateJson, withProcessLock, writePrivateJson } from "@spider/herdr/sessions/registry";
import type { HostIntent } from "./contracts";

export type Supervision =
  | { kind: "idle"; nextAttemptAt: number | null }
  | { kind: "launching"; operationId: string; phase: "reserved" | "invoking" }
  | { kind: "live"; identity: ProcessIdentity; stableSince: number };
export interface IntentState { intent: HostIntent; failures: readonly number[]; supervision: Supervision }
export interface VersionedIntent { version: number; value: IntentState }
export type IntentUpdate = { kind: "updated"; version: number } | { kind: "stale"; currentVersion: number | null };
export interface IntentStore {
  list(): Promise<readonly string[]>;
  get(id: string): Promise<VersionedIntent | null>;
  update(id: string, expectedVersion: number | null, next: IntentState): Promise<IntentUpdate>;
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const optionalTime = (value: unknown) => value === null || time(value);
function validate(id: string, value: unknown): asserts value is IntentState {
  if (!text(id) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hosting intent");
  const state = value as IntentState, intent = state.intent, run = state.supervision;
  if (!intent || intent.sessionId !== id || !Number.isSafeInteger(intent.epoch) || intent.epoch < 1 ||
      !["running", "stopped"].includes(intent.desired) || !(intent.suspended === null || text(intent.suspended)) ||
      !text(intent.file) || !isAbsolute(intent.file) || !text(intent.cwd) || !isAbsolute(intent.cwd) ||
      !(intent.moveId === null || text(intent.moveId)) || !Array.isArray(state.failures) || !state.failures.every(time) ||
      !run || typeof run !== "object") throw new Error("Invalid hosting intent");
  if (run.kind === "idle" && optionalTime(run.nextAttemptAt)) return;
  if (run.kind === "launching" && typeof run.operationId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(run.operationId) &&
      (run.phase === "reserved" || run.phase === "invoking")) return;
  if (run.kind === "live" && run.identity && text(run.identity.bootId) && Number.isSafeInteger(run.identity.pid) &&
      run.identity.pid > 0 && text(run.identity.startTime) && time(run.stableSince)) return;
  throw new Error("Invalid hosting supervision state");
}

function owned(info: Awaited<ReturnType<typeof lstat>>): boolean {
  return process.platform === "win32" || typeof process.getuid !== "function" || info.uid === process.getuid();
}
async function directory(path: string, privateMode: boolean): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info)) throw new Error("Unsafe hosting state directory");
  if (privateMode && process.platform !== "win32" && (info.mode & 0o7777) !== 0o700) await chmod(path, 0o700);
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}

/** Metadata and JSON must describe one inode, not two versions of an atomic write. */
async function readIntentJson(path: string, repairMode: boolean): Promise<{ record: unknown } | null> {
  const replaced = new Error("Hosting state file replaced during read");
  for (let attempt = 0; ; attempt++) {
    let opened = false;
    try {
      const record = await readPrivateJson(path, async handle => {
        opened = true;
        const info = await handle.stat();
        const unsafe = () => new Error(`Unsafe hosting state file (regular=${info.isFile()}, symlink=${info.isSymbolicLink()}, links=${info.nlink}, owned=${owned(info)}, mode=${(info.mode & 0o7777).toString(8)})`);
        if (!info.isFile() || info.isSymbolicLink() || !owned(info)) throw unsafe();
        // A rename can detach the inode after lookup. Never trust it; reopen the pathname.
        if (info.nlink === 0) throw replaced;
        if (info.nlink !== 1) throw unsafe();
        if (process.platform !== "win32" && (info.mode & 0o7777) !== 0o600) {
          if (!repairMode) throw unsafe();
          await handle.chmod(0o600);
        }
      });
      return opened ? { record } : null;
    } catch (error) { if (error !== replaced || attempt >= 2) throw error; }
  }
}

/** Read local hosting views without repairing modes or acquiring locks. */
async function inspectIntentViews(globalRoot: string): Promise<IntentState[]> {
  if (!isAbsolute(globalRoot)) throw new Error("Hosting state root must be absolute");
  const root = resolve(globalRoot), roam = join(root, "roam"), base = join(roam, "intents");
  assertTestConfigPath(base);
  try {
    if (await realpath(root) !== root) throw new Error("Unsafe hosting state root");
    for (const [path, privateMode] of [[root, false], [roam, true], [base, true]] as const) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || !owned(info) || privateMode && process.platform !== "win32" && (info.mode & 0o7777) !== 0o700) {
        throw new Error("Unsafe hosting state directory");
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: IntentState[] = [];
  for (const path of await jsonFiles(base)) {
    const record = (await readIntentJson(path, false))?.record as VersionedIntent | null;
    if (!record || !Number.isSafeInteger(record.version) || record.version < 1 || !text(record.value?.intent?.sessionId) ||
        path !== join(base, `${hash(record.value.intent.sessionId)}.json`)) throw new Error("Invalid hosting intent file");
    const id = record.value.intent.sessionId;
    validate(id, record.value);
    result.push(record.value);
  }
  return result;
}

/** Read local reservations without exposing their file contents. */
export async function inspectIntentReservations(globalRoot: string): Promise<Array<{ sessionId: string; file: string; operationId: string; phase: "reserved" | "invoking" }>> {
  return (await inspectIntentViews(globalRoot)).flatMap(({ intent, supervision }) => supervision.kind === "launching"
    ? [{ sessionId: intent.sessionId, file: intent.file, operationId: supervision.operationId, phase: supervision.phase }] : []);
}

export async function inspectSuspendedIntents(globalRoot: string): Promise<Array<{ sessionId: string; reason: string }>> {
  return (await inspectIntentViews(globalRoot)).flatMap(({ intent }) => intent.suspended
    ? [{ sessionId: intent.sessionId, reason: intent.suspended }] : []);
}

/** The files hold local intent and crash history, never homes or terminal placement. */
export function createIntentStore(globalRoot: string, options: { rename?: (source: string, destination: string) => Promise<void> } = {}): IntentStore {
  if (!isAbsolute(globalRoot)) throw new Error("Hosting state root must be absolute");
  const root = resolve(globalRoot), roam = join(root, "roam"), base = join(roam, "intents");
  assertTestConfigPath(base);
  const file = (id: string) => join(base, `${hash(id)}.json`);
  async function prepare(): Promise<void> {
    if (await realpath(root) !== root) throw new Error("Unsafe hosting state root");
    await directory(root, false);
    for (const path of [roam, base]) {
      await privateDirectory(path);
      await directory(path, true);
    }
    await syncDirectory(root);
    await syncDirectory(roam);
  }
  async function read(id: string): Promise<VersionedIntent | null> {
    if (!text(id)) throw new Error("Invalid hosting session ID");
    const path = file(id);
    const snapshot = await readIntentJson(path, true);
    if (!snapshot) return null;
    const record = snapshot.record as VersionedIntent | null;
    if (!record || !Number.isSafeInteger(record.version) || record.version < 1) throw new Error("Invalid hosting intent version");
    validate(id, record.value);
    return record;
  }
  return {
    async list() {
      await prepare();
      const ids: string[] = [];
      for (const path of await jsonFiles(base)) {
        const record = (await readIntentJson(path, true))?.record as VersionedIntent | null;
        if (!record || !text(record.value?.intent?.sessionId) || path !== file(record.value.intent.sessionId)) throw new Error("Invalid hosting intent file");
        const id = record.value.intent.sessionId;
        if (!await read(id)) throw new Error("Hosting intent disappeared during listing");
        ids.push(id);
      }
      return ids.sort();
    },
    async get(id) { await prepare(); return read(id); },
    async update(id, expectedVersion, next) {
      validate(id, next);
      if (!(expectedVersion === null || Number.isSafeInteger(expectedVersion) && expectedVersion > 0)) throw new Error("Invalid hosting intent version");
      await prepare();
      const locks = join(base, "locks"), lock = join(locks, hash(`intent:${id}`));
      for (const path of [locks, lock]) { await privateDirectory(path); await directory(path, true); }
      return withProcessLock(base, `intent:${id}`, async () => {
        await directory(base, true);
        const previous = await read(id), currentVersion = previous?.version ?? null;
        if (currentVersion !== expectedVersion) return { kind: "stale", currentVersion };
        const version = (currentVersion ?? 0) + 1;
        if (!Number.isSafeInteger(version)) throw new Error("Hosting intent version exhausted");
        await writePrivateJson(file(id), { version, value: next }, options.rename);
        await syncDirectory(base);
        return { kind: "updated", version };
      });
    },
  };
}
