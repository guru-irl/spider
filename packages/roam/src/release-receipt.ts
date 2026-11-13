import { randomUUID as releaseUuid } from "node:crypto";
import {
  closeSync as releaseClose, constants as releaseConstants, fchmodSync as releaseChmod, fstatSync as releaseStat,
  fsyncSync as releaseSync, linkSync as releaseLink, lstatSync as releaseLstat, openSync as releaseOpen,
  readFileSync as releaseRead, readdirSync as releaseEntries, realpathSync as releaseRealpath, renameSync as releaseRename,
  unlinkSync as releaseUnlink, writeFileSync as releaseWrite,
} from "node:fs";
import { isAbsolute as releaseAbsolute, join as releaseJoin, resolve as releaseResolve } from "node:path";

export interface ReleaseOwner { pid: number; bootId: string; start: string }
export interface ReleaseKey { directory: string; operationId: string; digest: string }
export interface ReleaseInput extends ReleaseKey { owner: ReleaseOwner }
export interface InstalledRelease { pi: string; cli: string; supervisor: string }
export type ReleaseReason = "installer-interrupted" | "release-install-failed" | "command-failed" | "release-hash-mismatch" | "incomplete-release" | "pi-version-mismatch";
export type ReleaseObservation = { state: "absent" } | { state: "started" } |
  { state: "finished"; value: InstalledRelease } | { state: "failed"; reason: ReleaseReason };
export type ReleaseBegin = { kind: "acquired"; token: string } | { kind: "duplicate"; state: "started" | "finished" | "failed" };
type ReleaseOutcome = { state: "finished"; value: InstalledRelease } | { state: "failed"; reason: ReleaseReason };
type ReleaseLock = { version: 1; operationId: string; digest: string; owner: ReleaseOwner; token: string };
type ReleaseRecord = ReleaseLock & ({ state: "started" } | ReleaseOutcome);

function releaseError(code: string): Error { return Object.assign(new Error("Release receipt is unavailable"), { code }); }
function releaseKey(input: ReleaseKey): void {
  if (!input || typeof input.directory !== "string" || !releaseAbsolute(input.directory) || releaseResolve(input.directory) !== input.directory ||
      typeof input.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.operationId) ||
      typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest)) throw releaseError("invalid-release-request");
  const directory = releaseLstat(input.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || releaseRealpath(input.directory) !== input.directory ||
      typeof process.getuid === "function" && directory.uid !== process.getuid() || (directory.mode & 0o7777) !== 0o700) {
    throw releaseError("unsafe-staging");
  }
}
function releaseOwner(value: unknown): value is ReleaseOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as ReleaseOwner;
  return Object.keys(owner).length === 3 && Number.isSafeInteger(owner.pid) && owner.pid > 0 &&
    typeof owner.bootId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(owner.bootId) &&
    typeof owner.start === "string" && /^[0-9]{1,32}$/.test(owner.start);
}
function releasePath(value: unknown): value is string {
  return typeof value === "string" && releaseAbsolute(value) && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}
function releaseValue(value: unknown): value is InstalledRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as InstalledRelease;
  return Object.keys(row).length === 3 && releasePath(row.pi) && releasePath(row.cli) && releasePath(row.supervisor);
}
function releaseReason(value: unknown): value is ReleaseReason {
  return typeof value === "string" && ["installer-interrupted", "release-install-failed", "command-failed", "release-hash-mismatch", "incomplete-release", "pi-version-mismatch"].includes(value);
}
function releaseReadJson(directory: string, name: string): unknown | null {
  let fd: number;
  try { fd = releaseOpen(releaseJoin(directory, name), releaseConstants.O_RDONLY | releaseConstants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw releaseError("unsafe-staging"); }
  try {
    let info = releaseStat(fd);
    if (info.nlink === 2 && info.isFile() && (typeof process.getuid !== "function" || info.uid === process.getuid())) {
      for (const entry of releaseEntries(directory)) {
        if (!/^\.release-[a-f0-9-]{36}\.tmp$/.test(entry)) continue;
        const path = releaseJoin(directory, entry);
        try {
          const temporary = releaseLstat(path);
          if (temporary.isFile() && temporary.dev === info.dev && temporary.ino === info.ino && temporary.uid === info.uid) releaseUnlink(path);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      info = releaseStat(fd);
    }
    if (!info.isFile() || info.nlink !== 1 || info.size > 16_384 || (info.mode & 0o7777) !== 0o600 ||
        typeof process.getuid === "function" && info.uid !== process.getuid()) throw releaseError("unsafe-staging");
    try { return JSON.parse(releaseRead(fd, "utf8")); } catch { throw releaseError("invalid-release-receipt"); }
  } finally { releaseClose(fd); }
}
function releaseWriteJson(directory: string, name: string, value: unknown, exclusive: boolean): void {
  const temporary = releaseJoin(directory, ".release-" + releaseUuid() + ".tmp"), target = releaseJoin(directory, name);
  const fd = releaseOpen(temporary, releaseConstants.O_WRONLY | releaseConstants.O_CREAT | releaseConstants.O_EXCL | releaseConstants.O_NOFOLLOW, 0o600);
  try {
    try { releaseChmod(fd, 0o600); releaseWrite(fd, JSON.stringify(value)); releaseSync(fd); } finally { releaseClose(fd); }
    if (exclusive) releaseLink(temporary, target); else releaseRename(temporary, target);
    const parent = releaseOpen(directory, releaseConstants.O_RDONLY | releaseConstants.O_DIRECTORY | releaseConstants.O_NOFOLLOW);
    try { releaseSync(parent); } finally { releaseClose(parent); }
  } finally { try { releaseUnlink(temporary); } catch { /* rename already removed the temporary file */ } }
}
type ShortWriteTicket = ReleaseLock & { number: number | null };
function shortWriteTicket(input: ReleaseKey, name: string): ShortWriteTicket | null {
  const raw = releaseReadJson(input.directory, name);
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw releaseError("invalid-release-receipt");
  const value = raw as ShortWriteTicket;
  if (Object.keys(value).length !== 6 || value.version !== 1 || value.operationId !== input.operationId ||
      typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || !releaseOwner(value.owner) ||
      typeof value.token !== "string" || !/^[a-f0-9-]{36}$/.test(value.token) || name !== "write-" + value.token + ".lock" ||
      !(value.number === null || Number.isSafeInteger(value.number) && value.number > 0)) throw releaseError("invalid-release-receipt");
  return value;
}
function removeShortWriteTicket(input: ReleaseKey, token: string): void {
  // Ticket names are never reused, including when a reaper dies before unlink.
  try { releaseUnlink(releaseJoin(input.directory, "write-" + token + ".lock")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const parent = releaseOpen(input.directory, releaseConstants.O_RDONLY | releaseConstants.O_DIRECTORY | releaseConstants.O_NOFOLLOW);
  try { releaseSync(parent); } finally { releaseClose(parent); }
}
/** Nonblocking bakery admission, with one immutable pathname per contender. */
export function beginShortWrite(input: ReleaseInput, probe: (owner: ReleaseOwner) => "live" | "absent" | "unknown"):
  { kind: "acquired"; token: string } | { kind: "busy" } {
  releaseKey(input);
  if (!releaseOwner(input.owner)) throw releaseError("invalid-release-request");
  const token = releaseUuid(), name = "write-" + token + ".lock";
  const ticket: ShortWriteTicket = { version: 1, operationId: input.operationId, digest: input.digest, owner: input.owner, token, number: null };
  const tickets = (): ShortWriteTicket[] => {
    const rows: ShortWriteTicket[] = [];
    for (const entry of releaseEntries(input.directory)) {
      if (!entry.startsWith("write-") || !entry.endsWith(".lock")) continue;
      const other = shortWriteTicket(input, entry);
      if (!other || other.token === token) continue;
      if (probe(other.owner) === "absent") removeShortWriteTicket(input, other.token);
      else rows.push(other);
    }
    return rows;
  };
  let acquired = false;
  try {
    releaseWriteJson(input.directory, name, ticket, true);
    const number = Math.max(0, ...tickets().map(row => row.number ?? 0)) + 1;
    if (!Number.isSafeInteger(number)) throw releaseError("invalid-release-receipt");
    releaseWriteJson(input.directory, name, { ...ticket, number }, false);
    if (tickets().some(row => row.number === null || row.number < number || row.number === number && row.token < token)) return { kind: "busy" };
    acquired = true;
    return { kind: "acquired", token };
  } finally { if (!acquired) removeShortWriteTicket(input, token); }
}
export function endShortWrite(input: ReleaseKey, token: string): void {
  releaseKey(input);
  if (typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token)) return;
  const ticket = shortWriteTicket(input, "write-" + token + ".lock");
  if (ticket) removeShortWriteTicket(input, token);
}

function releaseLock(input: ReleaseKey): ReleaseLock | null {
  const raw = releaseReadJson(input.directory, "release.lock");
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw releaseError("invalid-release-receipt");
  const value = raw as ReleaseLock;
  if (Object.keys(value).length !== 5 || value.version !== 1 || typeof value.operationId !== "string" ||
      typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || !releaseOwner(value.owner) ||
      typeof value.token !== "string" || !/^[a-f0-9-]{36}$/.test(value.token)) throw releaseError("invalid-release-receipt");
  if (value.operationId !== input.operationId || value.digest !== input.digest) throw releaseError("release-arguments-changed");
  return value;
}
function releaseRecord(input: ReleaseKey): ReleaseRecord | null {
  const raw = releaseReadJson(input.directory, "release-receipt.json");
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw releaseError("invalid-release-receipt");
  const value = raw as ReleaseRecord;
  if (value.version !== 1 || typeof value.operationId !== "string" || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) ||
      !releaseOwner(value.owner) || typeof value.token !== "string" || !/^[a-f0-9-]{36}$/.test(value.token)) throw releaseError("invalid-release-receipt");
  if (value.operationId !== input.operationId || value.digest !== input.digest) throw releaseError("release-arguments-changed");
  if (!(value.state === "started" && Object.keys(value).length === 6 || value.state === "finished" && Object.keys(value).length === 7 && releaseValue(value.value) ||
      value.state === "failed" && Object.keys(value).length === 7 && releaseReason(value.reason))) throw releaseError("invalid-release-receipt");
  return value;
}
function releaseRemoveLock(input: ReleaseKey, token: string): void {
  const existing = releaseLock(input);
  if (existing && existing.token === token) {
    try { releaseUnlink(releaseJoin(input.directory, "release.lock")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function releaseObservation(record: ReleaseRecord): ReleaseObservation {
  if (record.state === "finished") return { state: "finished", value: record.value };
  if (record.state === "failed") return { state: "failed", reason: record.reason };
  return { state: "started" };
}

/** An exclusive lock and started receipt precede any installation effects. */
export function beginRelease(input: ReleaseInput): ReleaseBegin {
  releaseKey(input);
  if (!releaseOwner(input.owner)) throw releaseError("invalid-release-request");
  const existing = releaseRecord(input);
  if (existing) return { kind: "duplicate", state: existing.state };
  const token = releaseUuid(), lock: ReleaseLock = { version: 1, operationId: input.operationId, digest: input.digest, owner: input.owner, token };
  try { releaseWriteJson(input.directory, "release.lock", lock, true); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const held = releaseLock(input), receipt = releaseRecord(input);
    if (!held) throw releaseError("invalid-release-receipt");
    if (receipt && receipt.state !== "started") return { kind: "duplicate", state: receipt.state };
    if (receipt && receipt.token !== held.token) throw releaseError("invalid-release-receipt");
    return { kind: "duplicate", state: receipt?.state ?? "started" };
  }
  try {
    const prior = releaseRecord(input);
    if (prior) { releaseRemoveLock(input, token); return { kind: "duplicate", state: prior.state }; }
    releaseWriteJson(input.directory, "release-receipt.json", { ...lock, state: "started" }, true);
    return { kind: "acquired", token };
  } catch (error) { releaseRemoveLock(input, token); throw error; }
}

/** Publish a result before releasing the operation lock. */
export function finishRelease(input: ReleaseInput, token: string, outcome: ReleaseOutcome): void {
  releaseKey(input);
  const lock = releaseLock(input), prior = releaseRecord(input);
  if (!lock || !prior || lock.token !== token || prior.token !== token || prior.state !== "started" ||
      !(outcome.state === "finished" && releaseValue(outcome.value) || outcome.state === "failed" && releaseReason(outcome.reason))) {
    throw releaseError("invalid-release-receipt");
  }
  releaseWriteJson(input.directory, "release-receipt.json", { ...lock, ...outcome }, false);
  releaseRemoveLock(input, token);
}

/** Only proved process absence converts an unfinished installation to failure. */
export function inspectRelease(input: ReleaseKey, probe: (owner: ReleaseOwner) => "live" | "absent" | "unknown"): ReleaseObservation {
  releaseKey(input);
  const lock = releaseLock(input), receipt = releaseRecord(input);
  if (receipt && receipt.state !== "started") return releaseObservation(receipt);
  if (lock && receipt && lock.token !== receipt.token) throw releaseError("invalid-release-receipt");
  const actor = receipt ?? lock;
  if (!actor) return { state: "absent" };
  if (probe(actor.owner) !== "absent") return { state: "started" };
  const latest = releaseRecord(input);
  if (latest && latest.state !== "started") return releaseObservation(latest);
  if (latest && latest.token !== actor.token || receipt && !latest) throw releaseError("invalid-release-receipt");
  const failed: ReleaseRecord = { version: 1, operationId: actor.operationId, digest: actor.digest, owner: actor.owner, token: actor.token,
    state: "failed", reason: "installer-interrupted" };
  releaseWriteJson(input.directory, "release-receipt.json", failed, latest === null);
  if (lock) releaseRemoveLock(input, lock.token);
  return { state: "failed", reason: "installer-interrupted" };
}
