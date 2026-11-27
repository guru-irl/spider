import { lstat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import { isRoamUuid } from "@spider/db-core/roam/codec";
import type { MachineId } from "@spider/db-core/roam/types";
import { hash, privateDirectory, readPrivateJson, syncStateDirectory, withProcessLock, writePrivateJson } from "@spider/herdr/sessions/registry";
import type { RelocateId, SessionId } from "./types";

const maxBytes = 4096;
export interface AwayHomeFence { machineId: MachineId; epoch: number; moveId: RelocateId }
function fencePath(root: string, sessionId: SessionId): string {
  const file = join(root, "roam", "away-homes", `${hash(sessionId)}.json`);
  assertTestConfigPath(file);
  return file;
}

export function withAwayHomeFenceLock<T>(root: string, sessionId: SessionId, run: () => Promise<T>): Promise<T> {
  fencePath(root, sessionId);
  return withProcessLock(join(root, "roam"), `away-home:${sessionId}`, run, { reclaimReusedOwner: true });
}

export async function readAwayHomeFence(root: string, sessionId: SessionId): Promise<AwayHomeFence | null> {
  const file = fencePath(root, sessionId);
  try {
    const dir = await lstat(dirname(file));
    if (!dir.isDirectory() || (dir.mode & 0o7777) !== 0o700 || typeof process.getuid === "function" && dir.uid !== process.getuid())
      throw new Error("Unsafe away-home fence directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let present = false;
  const raw = await readPrivateJson(file, async handle => {
    present = true;
    const stat = await handle.stat();
    if (stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw new Error("Unsafe away-home fence file");
  }, maxBytes);
  if (!present) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid away-home fence");
  const { machineId, epoch, moveId, version } = raw as Partial<AwayHomeFence> & { version?: unknown };
  if (version !== 1 || !isRoamUuid(machineId) || typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1 ||
      typeof moveId !== "string" || !moveId.startsWith("v0-") || !isRoamUuid(moveId.slice(3)))
    throw new Error("Invalid away-home fence");
  return { machineId, epoch, moveId };
}

/** Call under the fence lock before committing the away home. */
export async function publishAwayHomeFence(root: string, sessionId: SessionId, fence: AwayHomeFence): Promise<void> {
  const file = fencePath(root, sessionId), directory = dirname(file);
  await privateDirectory(directory);
  await writePrivateJson(file, { version: 1, ...fence }, undefined, maxBytes);
  // writePrivateJson syncs the file and its directory. The directory itself may be new.
  await syncStateDirectory(dirname(directory));
}

/** Never remove a fence that another home write published after admission read it. */
export async function clearAwayHomeFence(root: string, sessionId: SessionId, expected: AwayHomeFence): Promise<boolean> {
  return withAwayHomeFenceLock(root, sessionId, async () => {
    const current = await readAwayHomeFence(root, sessionId);
    if (!current) return true;
    if (current.epoch !== expected.epoch || current.machineId !== expected.machineId || current.moveId !== expected.moveId) return false;
    const file = fencePath(root, sessionId);
    await unlink(file);
    await syncStateDirectory(dirname(file));
    return true;
  });
}
