import { constants, chmodSync, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { usageProcessIdentity } from "./server-runtime.js";
export const SERVER_RECORD_GRACE_MS = 10_000;

export type UsageServerLock = { version: 1; instanceId: string; pid: number; port: number | null; secret: string; processIdentity?: string; serverBuild?: string };
const invalid = () => new Error("usage-server-record-invalid");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
export function validInstance(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{32}$/.test(value); }
export function validSecret(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value); }
export async function ensurePrivateServerDir(dir: string): Promise<void> {
  if (!isAbsolute(dir)) throw invalid();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw invalid();
  if ((info.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  assertPrivateServerDir(dir);
}
export function assertPrivateServerDir(dir: string): void {
  if (!isAbsolute(dir)) throw invalid();
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) throw invalid();
}
function readRecord(file: string): Record<string, unknown> | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 16_384) throw invalid();
    const bytes = Buffer.alloc(16_385);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 16_384) throw invalid();
    const record: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) throw invalid();
    return record as Record<string, unknown>;
  } catch (error) { if (missing(error)) return undefined; throw invalid(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export async function readServerRecord(file: string): Promise<Record<string, unknown> | undefined> { return readRecord(file); }
export async function readUsageServerLock(file: string): Promise<UsageServerLock | undefined> {
  const record = await readServerRecord(file);
  if (!record || record.version !== 1 || !validInstance(record.instanceId) || !validSecret(record.secret) ||
    !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 ||
    !(record.port === null || Number.isInteger(record.port) && (record.port as number) > 0 && (record.port as number) <= 65535)) return undefined;
  return record as UsageServerLock;
}
export async function writeServerRecord(file: string, record: object, exclusive = false): Promise<void> {
  await ensurePrivateServerDir(dirname(file));
  const bytes = JSON.stringify(record);
  if (Buffer.byteLength(bytes) > 16_384) throw invalid();
  if (!exclusive) try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw invalid();
  } catch (error) { if (!missing(error)) throw invalid(); }
  const temporary = `${file}.${randomBytes(16).toString("hex")}`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    if (exclusive) linkSync(temporary, file); else renameSync(temporary, file);
  } finally { try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; } }
}

/** Dead or recycled owners are stale immediately. Uncertain identities get a grace period. */
export async function reclaimStaleServerRecord(file: string, identity: (pid: number) => Promise<string | undefined>): Promise<boolean> {
  let fd: number | undefined;
  try {
    assertPrivateServerDir(dirname(file));
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()) return false;
    let record: Record<string, unknown> | undefined;
    if (info.size <= 16_384) try {
      const bytes = Buffer.alloc(16_385), length = readSync(fd, bytes, 0, bytes.length, 0);
      const parsed: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) record = parsed as Record<string, unknown>;
    } catch { /* Interrupted or invalid publication has no known owner. */ }
    const createdAt = record?.createdAt;
    const ageFrom = Number.isSafeInteger(createdAt) && (createdAt as number) <= Date.now() ? Math.min(info.mtimeMs, createdAt as number) : info.mtimeMs;
    let confirmedStale = false;
    if (Number.isSafeInteger(record?.pid) && (record!.pid as number) > 0) {
      const pid = record!.pid as number;
      try { process.kill(pid, 0); }
      catch (error) { if (["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) confirmedStale = true; else return false; }
      if (!confirmedStale) {
        const current = await identity(pid);
        if (current && typeof record?.processIdentity === "string") {
          if (current === record.processIdentity) return false;
          confirmedStale = true;
        }
      }
    }
    if (!confirmedStale && Date.now() - ageFrom < SERVER_RECORD_GRACE_MS) return false;
    const latest = lstatSync(file);
    if (latest.dev !== info.dev || latest.ino !== info.ino || latest.mtimeMs !== info.mtimeMs || latest.size !== info.size || latest.nlink !== 1) return false;
    const quarantine = `${file}.reclaim-${randomBytes(16).toString("hex")}`;
    renameSync(file, quarantine);
    const moved = lstatSync(quarantine);
    if (moved.dev !== info.dev || moved.ino !== info.ino || moved.mtimeMs !== info.mtimeMs || moved.size !== info.size || moved.nlink !== 1) {
      // A fresh owner won between the last stat and rename. Restore exclusively,
      // never overwriting another publication or deleting the moved fresh record.
      try { linkSync(quarantine, file); unlinkSync(quarantine); } catch { /* Leave it intact if another owner published. */ }
      return false;
    }
    unlinkSync(quarantine); return true;
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}

/** Called only by a launch-guard holder. Never follow links or sweep fresh publications. */
export async function sweepServerRecordTemps(dir: string): Promise<void> {
  assertPrivateServerDir(dir);
  for (const name of readdirSync(dir)) {
    if (!/^(?:lock\.json|startup\.json|replace-intent\.json)\.[a-f0-9]{32}$/.test(name)) continue;
    const file = `${dir}/${name}`;
    if (Date.now() - lstatSync(file).mtimeMs < SERVER_RECORD_GRACE_MS) continue;
    if (name.startsWith("replace-intent.json.")) {
      let record: Record<string, unknown> | undefined;
      try { record = readRecord(file); } catch { /* Unsafe temp: quarantine without following it. */ }
      await removeServerIntent(file, record);
    } else await reclaimStaleServerRecord(file, usageProcessIdentity);
  }
}
/** The launch guard must be held. Invalid markers are quarantined without following links. */
export async function removeServerIntent(file: string, expected?: Record<string, unknown>): Promise<boolean> {
  try {
    assertPrivateServerDir(dirname(file));
    const info = lstatSync(file);
    if (expected) {
      const record = readRecord(file);
      if (!record || ["instanceId", "pid", "processIdentity", "serverBuild"].some(key => record[key] !== expected[key])) return false;
    } else {
      try { if (readRecord(file)) return false; } catch { /* Invalid marker only. */ }
    }
    const quarantine = `${file}.reclaim-${randomBytes(16).toString("hex")}`;
    renameSync(file, quarantine);
    const moved = lstatSync(quarantine);
    let matches = moved.dev === info.dev && moved.ino === info.ino && moved.mtimeMs === info.mtimeMs && moved.size === info.size;
    if (matches && expected) {
      const record = readRecord(quarantine);
      matches = !!record && ["instanceId", "pid", "processIdentity", "serverBuild"].every(key => record[key] === expected[key]);
    }
    if (!matches) {
      try { linkSync(quarantine, file); unlinkSync(quarantine); } catch { /* Preserve a raced publication. */ }
      return false;
    }
    // Directories are not marker files. Leave nonempty directories intact.
    if (moved.isDirectory()) { rmdirSync(quarantine); } else unlinkSync(quarantine);
    return true;
  } catch { return false; }
}

/** Serialize publishers independently of the launch guard, which may already be busy. */
export async function publishServerIntent(file: string, record: Record<string, unknown>, keep: (current: Record<string, unknown>) => boolean, until: number): Promise<boolean> {
  await ensurePrivateServerDir(dirname(file));
  const guard = `${file}.guard`, instanceId = String(record.instanceId);
  let acquired = false;
  try {
    while (Date.now() < until) {
      try {
        await writeServerRecord(guard, { instanceId, pid: record.pid, processIdentity: record.processIdentity, createdAt: Date.now() }, true);
        acquired = true; break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await reclaimStaleServerRecord(guard, usageProcessIdentity);
        await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(10, until - Date.now()))));
      }
    }
    if (!acquired) throw new Error("usage-server-busy");
    let current: Record<string, unknown> | undefined;
    try { current = readRecord(file); } catch { return false; } // Launch-guarded sweep handles unsafe files.
    if (current && keep(current)) return false;
    const temporary = `${file}.${randomBytes(16).toString("hex")}`;
    try {
      writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      renameSync(temporary, file); return true;
    } finally { try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; } }
  } finally { if (acquired) await removeServerRecord(guard, instanceId); }
}

export async function removeOwnedUsageServerLock(file: string, instanceId: string): Promise<boolean> {
  const guard = `${file}.guard`;
  let acquired = false;
  try {
    assertPrivateServerDir(dirname(file));
    try {
      await writeServerRecord(guard, { version: 1, instanceId, pid: process.pid, processIdentity: await usageProcessIdentity(process.pid) ?? null, createdAt: Date.now() }, true);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readRecord(guard)?.instanceId !== instanceId) return false;
    }
    return await removeServerRecord(file, instanceId);
  } catch { return false; }
  finally { if (acquired) await removeServerRecord(guard, instanceId); }
}
export async function removeServerRecord(file: string, instanceId: string): Promise<boolean> {
  try {
    const record = readRecord(file);
    if (record?.instanceId !== instanceId) return false;
    unlinkSync(file); return true;
  } catch { return false; }
}
