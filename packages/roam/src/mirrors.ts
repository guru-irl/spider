import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import type { Journal, Limits, SessionManifest } from "./contracts";
import { DEFAULT_LIMITS } from "./contracts";
import { isMachineId } from "./machine-id";
import { inspectSession } from "./session-file";
import { hash, privateDirectory, readPrivate, syncStagingDirectory } from "./staging";

interface MirrorVersion { size: number; sha256: string; leaf?: string }
interface MirrorState {
  version: 1;
  sessionId: string;
  epoch: number;
  machineId: string;
  committed: MirrorVersion;
  pending: MirrorVersion | null;
}
const EMPTY_SHA256 = createHash("sha256").digest("hex");
const SHA256 = /^[a-f0-9]{64}$/;

function refuse(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
function regular(file: string): Stats | null {
  let stat: Stats;
  try { stat = lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== "win32" && uid !== undefined && stat.uid !== uid) {
    refuse("mirror-unsafe-path", "Unsafe mirror file or owner");
  }
  return stat;
}
function writeAll(fd: number, bytes: Buffer): void {
  for (let at = 0; at < bytes.length;) {
    const count = writeSync(fd, bytes, at, bytes.length - at);
    if (count <= 0) throw new Error("Short mirror write");
    at += count;
  }
}
function digestPrefix(file: string, length: number, allowAppend = false): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd), digest = createHash("sha256"), bytes = Buffer.allocUnsafe(64 * 1024);
    if (!before.isFile() || length < 0 || length > before.size) refuse("mirror-truncated", "Mirror prefix is incomplete");
    for (let at = 0; at < length;) {
      const count = readSync(fd, bytes, 0, Math.min(bytes.length, length - at), at);
      if (!count) refuse("mirror-truncated", "Mirror prefix is incomplete");
      digest.update(bytes.subarray(0, count)); at += count;
    }
    const after = fstatSync(fd), named = lstatSync(file);
    if (!named.isFile() || named.dev !== before.dev || named.ino !== before.ino || after.size < length || !allowAppend && (after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)) refuse("mirror-source-changed", "Mirror source changed while reading");
    return digest.digest("hex");
  } finally { closeSync(fd); }
}
function version(value: unknown): value is MirrorVersion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.size) && (row.size as number) >= 0 && typeof row.sha256 === "string" && SHA256.test(row.sha256) &&
    (row.leaf === undefined || typeof row.leaf === "string" && row.leaf.trim().length > 0);
}
function loadState(file: string, sessionId: string, epoch: number, machineId: string): MirrorState | null {
  const stat = regular(file);
  if (!stat) return null;
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) refuse("mirror-unsafe-path", "Unsafe mirror checkpoint mode");
  let value: unknown;
  try { value = JSON.parse(readPrivate(file, Buffer.byteLength(JSON.stringify(sessionId)) + 8192).toString("utf8")); }
  catch { refuse("mirror-checkpoint-invalid", "Invalid mirror checkpoint"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("mirror-checkpoint-invalid", "Invalid mirror checkpoint");
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || state.sessionId !== sessionId || state.epoch !== epoch || !isMachineId(state.machineId) ||
      !version(state.committed) || !(state.pending === null || version(state.pending))) {
    refuse("mirror-checkpoint-invalid", "Invalid mirror checkpoint");
  }
  if (state.machineId !== machineId) refuse("mirror-machine-changed", "Mirror epoch belongs to a different machine");
  const committed = state.committed as MirrorVersion, pending = state.pending as MirrorVersion | null;
  if (committed.size === 0 && committed.sha256 !== EMPTY_SHA256 || pending && pending.size < committed.size) {
    refuse("mirror-checkpoint-invalid", "Invalid mirror checkpoint");
  }
  return state as unknown as MirrorState;
}
function saveState(file: string, state: MirrorState): void {
  regular(file);
  const temporary = join(dirname(file), `.${randomUUID()}.state-part`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    writeAll(fd, Buffer.from(`${JSON.stringify(state)}\n`));
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, file);
    syncStagingDirectory(dirname(file));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Copy a suffix from the exact observed source while hashing the complete source. */
function stageSuffix(source: SessionManifest, start: number, end: number, directory: string, allowAppend = false): string {
  const temporary = join(directory, `.${randomUUID()}.suffix-part`);
  const input = openSync(source.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    const before = fstatSync(input);
    if (!before.isFile() || (allowAppend ? before.size < source.size : before.size !== source.size) || start < 0 || end < start || end > source.size) {
      refuse("mirror-source-changed", "Mirror source changed");
    }
    output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    if (process.platform !== "win32") fchmodSync(output, 0o600);
    const digest = createHash("sha256"), bytes = Buffer.allocUnsafe(64 * 1024);
    for (let at = 0; at < source.size;) {
      const count = readSync(input, bytes, 0, Math.min(bytes.length, source.size - at), at);
      if (!count) refuse("mirror-source-changed", "Mirror source changed");
      const chunk = bytes.subarray(0, count); digest.update(chunk);
      const from = Math.max(start, at), through = Math.min(end, at + count);
      if (from < through) writeAll(output, chunk.subarray(from - at, through - at));
      at += count;
    }
    const after = fstatSync(input), named = lstatSync(source.file);
    if (!named.isFile() || named.dev !== before.dev || named.ino !== before.ino || after.size < source.size || !allowAppend && (after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) || digest.digest("hex") !== source.sha256) {
      refuse("mirror-source-changed", "Mirror source changed");
    }
    fsyncSync(output); closeSync(output); output = undefined;
    return temporary;
  } catch (error) {
    if (output !== undefined) { closeSync(output); output = undefined; }
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  } finally { closeSync(input); }
}

export interface MirrorPrefix { size: number; sha256: string }
export interface MirrorSource extends SessionManifest { transfer?: { mode: "full" | "append" | "unchanged"; reason: string; bytes: number } }
/** Freeze only the observed prefix, not a live file's later appends. The output contains only new bytes. */
export function exportMirrorRange(source: SessionManifest, prefix: MirrorPrefix | null, root: string): {
  file: string | null; offset: number; mode: "full" | "append" | "unchanged"; reason: string;
} {
  if (prefix !== null && !version(prefix)) throw new Error("mirror-prefix-invalid");
  const matched = prefix !== null && prefix.size <= source.size && digestPrefix(source.file, prefix.size, true) === prefix.sha256;
  const offset = matched ? prefix.size : 0;
  if (matched && offset === source.size && prefix.sha256 === source.sha256) return { file: null, offset, mode: "unchanged", reason: "mirror-unchanged" };
  privateDirectory(root);
  return { file: stageSuffix(source, offset, source.size, root, true), offset, mode: matched ? "append" : "full", reason: prefix && !matched ? "mirror-source-rewritten" : matched ? "mirror-appended" : "mirror-initial-copy" };
}

function makeReadOnly(file: string): void {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (process.platform !== "win32") fchmodSync(fd, 0o400); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function appendSuffix(mirror: string, suffix: string, priorSize: number): void {
  const input = openSync(suffix, constants.O_RDONLY | constants.O_NOFOLLOW);
  let access: number | undefined, output: number | undefined, writable = false;
  try {
    access = openSync(mirror, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(access);
    if (!before.isFile() || before.size !== priorSize) refuse("mirror-changed", "Mirror changed before append");
    if (process.platform !== "win32") { fchmodSync(access, 0o600); writable = true; }
    output = openSync(mirror, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    const target = fstatSync(output);
    if (!target.isFile() || target.dev !== before.dev || target.ino !== before.ino || target.size !== priorSize) {
      refuse("mirror-changed", "Mirror changed before append");
    }
    // Open descriptors retain write access after the private file becomes read-only again.
    if (writable) { fchmodSync(access, 0o400); fsyncSync(access); writable = false; }
    const size = fstatSync(input).size, bytes = Buffer.allocUnsafe(64 * 1024);
    try {
      for (let at = 0; at < size;) {
        const count = readSync(input, bytes, 0, Math.min(bytes.length, size - at), at);
        if (!count) refuse("mirror-source-changed", "Staged mirror suffix changed");
        writeAll(output, bytes.subarray(0, count)); at += count;
      }
      fsyncSync(output);
    } catch (error) {
      ftruncateSync(output, priorSize); fsyncSync(output);
      throw error;
    }
  } finally {
    try {
      if (writable && access !== undefined) { fchmodSync(access, 0o400); fsyncSync(access); }
    } finally {
      if (output !== undefined) closeSync(output);
      if (access !== undefined) closeSync(access);
      closeSync(input);
    }
  }
}

/** Recover the last acknowledged prefix without needing the source machine. */
export async function recoverMirror(
  input: { sessionId: string; epoch: number; machineId: string; root: string; limits?: Readonly<Limits> },
): Promise<SessionManifest> {
  const { sessionId, epoch, machineId, root } = input;
  if (!sessionId || !Number.isSafeInteger(epoch) || epoch < 1 || !isMachineId(machineId) ||
      !isAbsolute(root) || resolve(root) !== root) refuse("mirror-invalid-input", "Invalid mirror recovery input");
  assertTestConfigPath(root);
  privateDirectory(root);
  return withProcessLock(root, `mirror:${sessionId}:${epoch}`, async () => {
    const directory = join(root, hash(Buffer.from(sessionId)));
    privateDirectory(directory);
    const mirror = join(directory, `${epoch}.jsonl`), checkpoint = join(directory, `${epoch}.state.json`);
    const state = loadState(checkpoint, sessionId, epoch, machineId);
    if (!state) refuse("mirror-checkpoint-missing", "Mirror has no checkpoint");
    if (!state.committed.size) refuse("mirror-no-committed-prefix", "Mirror has no committed session");
    const limit = (input.limits ?? DEFAULT_LIMITS).sessionBytes;
    if (!Number.isSafeInteger(limit) || limit <= 0 || state.committed.size > limit) refuse("mirror-size-limit", "Mirror exceeds session size limit");
    const stat = regular(mirror);
    if (!stat || stat.size < state.committed.size || digestPrefix(mirror, state.committed.size) !== state.committed.sha256) {
      refuse("mirror-checkpoint-mismatch", "Committed mirror prefix does not match its checkpoint");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) refuse("mirror-unsafe-path", "Unsafe mirror mode");
    if (stat.size > state.committed.size) {
      const access = openSync(mirror, constants.O_RDONLY | constants.O_NOFOLLOW);
      let output: number | undefined, writable = false;
      try {
        const before = fstatSync(access);
        if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size ||
            before.mtimeMs !== stat.mtimeMs || before.ctimeMs !== stat.ctimeMs) refuse("mirror-changed", "Mirror changed before recovery");
        if (process.platform !== "win32") { fchmodSync(access, 0o600); writable = true; }
        output = openSync(mirror, constants.O_WRONLY | constants.O_NOFOLLOW);
        const target = fstatSync(output);
        if (!target.isFile() || target.dev !== before.dev || target.ino !== before.ino || target.size !== before.size) {
          refuse("mirror-changed", "Mirror changed before recovery");
        }
        if (writable) { fchmodSync(access, 0o400); writable = false; }
        ftruncateSync(output, state.committed.size);
        fsyncSync(output);
      } finally {
        try { if (writable) { fchmodSync(access, 0o400); fsyncSync(access); } }
        finally { if (output !== undefined) closeSync(output); closeSync(access); }
      }
    } else if (process.platform !== "win32" && (stat.mode & 0o222) !== 0) makeReadOnly(mirror);
    const result = await inspectSession(mirror, sessionId, state.committed.leaf, input.limits);
    if (result.size !== state.committed.size || result.sha256 !== state.committed.sha256) {
      refuse("mirror-checkpoint-mismatch", "Recovered mirror does not match its checkpoint");
    }
    if (state.pending) saveState(checkpoint, { ...state, pending: null });
    return { ...result, artifactId: `mirror-${hash(Buffer.from(JSON.stringify([sessionId, epoch])))}` };
  });
}

/** Append only verified complete source snapshots. A pending checkpoint permits retry after interruption. */
export async function appendMirror(
  input: { sessionId: string; epoch: number; source: SessionManifest; root: string; operationId: string; limits?: Readonly<Limits> },
  journal: Journal,
): Promise<SessionManifest> {
  const { sessionId, epoch, source, root, operationId } = input;
  if (!sessionId || !Number.isSafeInteger(epoch) || epoch < 1 || !isAbsolute(root) || resolve(root) !== root ||
      source.sessionId !== sessionId || typeof operationId !== "string" || !operationId) {
    refuse("mirror-invalid-input", "Invalid mirror input");
  }
  if (!journal.lookupOperation) refuse("mirror-journal-unavailable", "Journal cannot inspect the operation");
  const operation = journal.lookupOperation(operationId);
  if (!operation) refuse("mirror-operation-unknown", "Mirror operation has not begun");
  if (operation.state === "done") refuse("mirror-operation-complete", "Mirror operation already completed");
  if (!isMachineId(operation.machineId) || operation.state !== "pending") refuse("mirror-journal-unavailable", "Invalid journal operation");
  assertTestConfigPath(root);
  const observed = await inspectSession(source.file, sessionId, source.leaf, input.limits);
  if (observed.size !== source.size || observed.sha256 !== source.sha256 || observed.cwd !== source.cwd) {
    refuse("mirror-source-changed", "Mirror source changed");
  }
  const directory = join(root, hash(Buffer.from(sessionId)));
  const mirror = join(directory, `${epoch}.jsonl`), checkpoint = join(directory, `${epoch}.state.json`);
  journal.record(operationId, "mirror-append-intent", { file: mirror, sessionId, epoch, machineId: operation.machineId,
    size: source.size, sha256: source.sha256 });
  privateDirectory(root);
  return withProcessLock(root, `mirror:${sessionId}:${epoch}`, async () => {
    const currentOperation = journal.lookupOperation!(operationId);
    if (!currentOperation) refuse("mirror-operation-unknown", "Mirror operation has not begun");
    if (currentOperation.state === "done") refuse("mirror-operation-complete", "Mirror operation already completed");
    if (currentOperation.state !== "pending" || currentOperation.machineId !== operation.machineId) {
      refuse("mirror-journal-unavailable", "Mirror operation changed while waiting for the lock");
    }
    privateDirectory(directory);
    let state = loadState(checkpoint, sessionId, epoch, operation.machineId);
    let stat = regular(mirror);
    if (!state) {
      if (stat) refuse("mirror-checkpoint-missing", "Existing mirror has no checkpoint");
      state = { version: 1, sessionId, epoch, machineId: operation.machineId,
        committed: { size: 0, sha256: EMPTY_SHA256 }, pending: { size: source.size, sha256: source.sha256, leaf: source.leaf } };
      saveState(checkpoint, state);
    }
    if (!stat && state.committed.size !== 0) refuse("mirror-truncated", "Previously committed mirror is missing");
    if (stat && (stat.size < state.committed.size || digestPrefix(mirror, state.committed.size) !== state.committed.sha256)) {
      refuse("mirror-truncated", "Previously committed mirror changed");
    }
    if (stat && process.platform !== "win32" && (stat.mode & 0o077) !== 0) refuse("mirror-unsafe-path", "Unsafe mirror mode");

    const finishPending = async (): Promise<void> => {
      const pending = state!.pending;
      if (!pending) return;
      stat = regular(mirror);
      const size = stat?.size ?? 0;
      if (size < state!.committed.size || size > pending.size || source.size < pending.size ||
          digestPrefix(source.file, pending.size) !== pending.sha256 ||
          stat && digestPrefix(mirror, size) !== digestPrefix(source.file, size)) {
        refuse("mirror-prefix-changed", "Mirror source or pending prefix changed");
      }
      if (size < pending.size) {
        const suffix = stageSuffix(source, size, pending.size, directory);
        try {
          const checked = await inspectSession(source.file, sessionId, source.leaf, input.limits);
          if (checked.size !== source.size || checked.sha256 !== source.sha256) refuse("mirror-source-changed", "Mirror source changed");
          if (!stat) {
            makeReadOnly(suffix);
            if (regular(mirror)) refuse("mirror-changed", "Mirror appeared during creation");
            linkSync(suffix, mirror); unlinkSync(suffix); syncStagingDirectory(directory);
          } else appendSuffix(mirror, suffix, size);
        } finally { if (existsSync(suffix)) unlinkSync(suffix); }
      } else if (stat) makeReadOnly(mirror);
      const completed = regular(mirror);
      if (!completed || completed.size !== pending.size || digestPrefix(mirror, completed.size) !== pending.sha256) {
        refuse("mirror-prefix-changed", "Mirror snapshot did not verify");
      }
      await inspectSession(mirror, sessionId, pending.leaf, input.limits);
      state = { ...state!, committed: pending, pending: null };
      saveState(checkpoint, state);
    };

    await finishPending();
    stat = regular(mirror);
    if (!stat || stat.size !== state.committed.size || digestPrefix(mirror, stat.size) !== state.committed.sha256) {
      refuse("mirror-truncated", "Previously committed mirror changed");
    }
    if (source.size < stat.size || digestPrefix(source.file, stat.size) !== state.committed.sha256) {
      refuse("mirror-prefix-changed", "Mirror source prefix changed");
    }
    if (source.size > stat.size) {
      state = { ...state, pending: { size: source.size, sha256: source.sha256, leaf: source.leaf } };
      saveState(checkpoint, state);
      await finishPending();
    }
    stat = regular(mirror);
    if (stat && process.platform !== "win32" && (stat.mode & 0o222) !== 0) makeReadOnly(mirror);
    const result = await inspectSession(mirror, sessionId, source.leaf, input.limits);
    if (result.size !== source.size || result.sha256 !== source.sha256) refuse("mirror-prefix-changed", "Mirror snapshot did not verify");
    if (state.committed.leaf !== source.leaf) {
      state = { ...state, committed: { ...state.committed, leaf: source.leaf } };
      saveState(checkpoint, state);
    }
    journal.record(operationId, "mirror-append-complete", { file: mirror, sessionId, epoch, machineId: operation.machineId,
      size: result.size, sha256: result.sha256 });
    return { ...result, artifactId: source.artifactId };
  });
}
