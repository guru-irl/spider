import { getBinding, openGlobalReadOnly, openDbReadOnlyAt, repoRoot, paths, type Db } from "@spider/db-core";
import { assembleSnapshotFromRecords, listActive, type SnapshotResult } from "@spider/memory";
import { join } from "node:path";
import { controlConfig } from "./control";

export interface InjectionSnapshot extends SnapshotResult {
  errors: { global?: string; repo?: string; config?: string };
  capped: boolean;
}

const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);

/** The hook and doctor read the same files, with no migrations or registry writes.
 *  Each tier is independent: a broken file cannot hide another tier's active rows. */
export function readInjectionSnapshot(cwd: string, sessionId?: string): InjectionSnapshot {
  const errors: InjectionSnapshot["errors"] = {};
  let target = cwd;
  let globalDb: Db | undefined;
  const active: Parameters<typeof assembleSnapshotFromRecords>[0] = {};
  try {
    globalDb = openGlobalReadOnly();
    if (globalDb) {
      if (sessionId) {
        try { target = getBinding(globalDb, sessionId) ?? cwd; }
        catch { /* An older global DB may have memory but no session_bindings table. */ }
      }
      active.global = listActive(globalDb, "global");
    }
  } catch (e) {
    errors.global = errorMessage(e);
  } finally {
    globalDb?.close();
  }

  let repoDb: Db | undefined;
  try {
    repoDb = openDbReadOnlyAt(join(repoRoot(target) ?? paths.projectRoot(target), "repo.db"));
    if (repoDb) active.repo = listActive(repoDb, "repo");
  } catch (e) {
    errors.repo = errorMessage(e);
  } finally {
    repoDb?.close();
  }

  let cap: number | undefined;
  try {
    const value = controlConfig("get", target, "memory.snapshotCharCap");
    if (value !== undefined && value !== "unlimited") {
      const parsed = typeof value === "number" || typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value) : NaN;
      if (Number.isFinite(parsed) && parsed >= 0) cap = parsed;
      else errors.config = `memory.snapshotCharCap invalid (${String(value)}), ignored`;
    }
  } catch (e) {
    errors.config = `memory.snapshotCharCap unreadable: ${errorMessage(e)}`;
  }
  return { ...assembleSnapshotFromRecords(active, { charCap: cap }), errors, capped: cap !== undefined };
}
