import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { localRunPredicate } from "@spider/db-core/roam/run-origin";
import { openRoamPathReadOnly, roamStorePath } from "@spider/db-core/roam/reads";
import type { StoreKey } from "@spider/db-core/roam/types";
import { groupHasLiveMembers, readManifestSafe, readReceiptSafe } from "../../../context/src/background-job";
import { processStartIdentity } from "@spider/herdr/jobs/handoff";
import { ensurePrivateDirectory } from "@spider/herdr/jobs/store";
import type { RelocateAdapterOptions, SessionId } from "./types";

export async function localWriterBlockers(id: SessionId, checkout: string, stores: readonly StoreKey[], options: RelocateAdapterOptions): Promise<readonly string[]> {
  // An ordinary local project's run rows need not exist in its replica yet.
  const files = new Set([join(checkout, ".spider", "project.db"), ...stores.filter(key => key.startsWith("worktree:")).map(key => roamStorePath(options.globalDb, key))]);
  const blockers: string[] = [];
  for (const file of files) {
    const db = openRoamPathReadOnly(file);
    if (!db) continue;
    try {
      const rows = db.prepare(`SELECT r.id,r.pid FROM runs r WHERE r.session_id=? AND r.status IN ('queued','running','paused') AND ${localRunPredicate(db)} ORDER BY r.id`).all(id) as {id: string; pid: number | null}[];
      for (const row of rows) blockers.push(row.pid ? `PID ${row.pid} (pi)` : `subagent run ${safeName(row.id)} (pi; no PID yet)`);
    } finally { db.close(); }
  }
  blockers.push(...(await inspectLocalBackgroundJobs(id, checkout)).map(job => job.description));
  return [...new Set(blockers)];
}

function safeName(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 96); }
function pid(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value > 1 ? value : undefined; }
function alive(value: number): boolean {
  try { return processStartIdentity(value) !== null; } catch { return true; }
}
async function boundedRecord(file: string): Promise<boolean> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error("Invalid background job record");
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
interface BackgroundJobEvidence {
  id: string;
  description: string;
  excludedRoots: readonly number[];
  complete: boolean;
}

/** Only live or unverified jobs. Their PIDs can exclude trees, never identify a signal target. */
export async function inspectLocalBackgroundJobs(id: SessionId, checkout: string, strict = false): Promise<readonly BackgroundJobEvidence[]> {
  const directory = join(checkout, ".spider", "scratch", "bg");
  if (strict) {
    try { await ensurePrivateDirectory(directory, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  let entries;
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || await realpath(directory) !== directory) throw new Error("Invalid background job directory");
    entries = await readdir(directory, {withFileTypes: true});
  } catch (error) { if (!strict && (error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const blockers: BackgroundJobEvidence[] = [];
  for (const entry of entries) {
    const name = safeName(entry.name);
    const unreadable: BackgroundJobEvidence = { id: name, description: `background job ${name} (owner unavailable)`, excludedRoots: [], complete: false };
    try {
      if (!entry.isDirectory()) throw new Error("Invalid background job entry");
      const manifestFile = join(directory, entry.name, "job.json"), receiptFile = join(directory, entry.name, "exit.json");
      const manifest = await boundedRecord(manifestFile) ? readManifestSafe(manifestFile) : undefined;
      if (!manifest || manifest.schema !== 1 || manifest.id !== entry.name) {
        // A job without readable ownership cannot be ruled out for this session.
        blockers.push(unreadable);
        continue;
      }
      if (typeof manifest.ownerSessionId === "string" && manifest.ownerSessionId && manifest.ownerSessionId !== id) continue;
      const receiptExists = await boundedRecord(receiptFile);
      const receipt = receiptExists ? readReceiptSafe(receiptFile) : undefined;
      const supervisor = pid(manifest.supervisorPid) ?? pid(receipt?.supervisorPid);
      const child = pid(manifest.childPid) ?? pid(receipt?.childPid);
      const pids = [manifest.supervisorPid, receipt?.supervisorPid, manifest.childPid, receipt?.childPid];
      const conflict = pids.some(value => value !== undefined && pid(value) === undefined)
        || (manifest.supervisorPid && receipt?.supervisorPid && manifest.supervisorPid !== receipt.supervisorPid)
        || (manifest.childPid && receipt?.childPid && manifest.childPid !== receipt.childPid);
      const unreadableReceipt = strict && receiptExists && !receipt;
      if (!unreadableReceipt && !conflict && !(supervisor && groupHasLiveMembers(supervisor) !== false) && !(child && alive(child)) && (receipt || supervisor)) continue;
      const executable = Array.isArray(manifest.argv) && typeof manifest.argv[0] === "string" ? safeName(basename(manifest.argv[0])) : "shell";
      blockers.push({ id: name,
        description: supervisor || child ? `PID ${child ?? supervisor} (${executable}; background job ${name})` : `background job ${name} (${executable}; PID unavailable)`,
        excludedRoots: [...new Set(pids.flatMap(value => pid(value) ?? []))],
        complete: Boolean(manifest.ownerSessionId === id && !unreadableReceipt && !conflict && (supervisor || child)),
      });
    } catch (error) {
      if (!strict) throw error;
      blockers.push(unreadable);
    }
  }
  return blockers;
}
