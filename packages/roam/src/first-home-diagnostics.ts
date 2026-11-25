import type { Db } from "@spider/db-core";
import { readLocal } from "@spider/db-core/roam/local-state";
import { isMachineId } from "./machine-id";

export interface FirstHomeWithheld { machineId: string; storeKind: "worktree" | "replica"; storeCheck?: "store-machine-mismatch" }

/** Never retain a store path, key, or exception in a move refusal. */
export function parseFirstHomeWithheld(value: unknown): FirstHomeWithheld | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isMachineId(row.machineId) || !(row.storeKind === "worktree" || row.storeKind === "replica")) return null;
  if (row.storeCheck !== undefined && row.storeCheck !== "store-machine-mismatch") return null;
  return { machineId: row.machineId, storeKind: row.storeKind,
    ...(row.storeCheck === "store-machine-mismatch" ? { storeCheck: row.storeCheck } : {}) };
}

export function readFirstHomeWithheld(db: Db, sessionId: string): FirstHomeWithheld | null {
  try { return parseFirstHomeWithheld(readLocal(db, "first-home-withheld", sessionId)); }
  catch { return null; }
}
