import type { Db } from "@spider/db-core";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import type { BatchArtifact, BatchHeader, JsonObject, StoreKey } from "@spider/db-core/roam/types";
import type { PeerObservation } from "./diagnostics";
export interface PendingBatch {
  id: string; key: StoreKey; after: number; targetBytes: number;
  batch: BatchArtifact | null; exported: JsonObject | null;
}
export interface PeerState {
  failures: number; pulled: boolean; targetBytes: number; pending: Record<string, PendingBatch>; observation?: PeerObservation;
  gathered?: Record<string, boolean>; unknownSessions?: Record<string, string[]>;
}
export function loadPeerState(db: Db, machine: string, initialBytes: number): PeerState {
  return readLocal<PeerState>(db, "sync-peer", machine) ?? { failures: 0, pulled: false, targetBytes: initialBytes, pending: {} };
}
export function savePeerState(db: Db, machine: string, state: PeerState): void {
  db.raw.transaction(() => writeLocal(db, "sync-peer", machine, state)).immediate();
}
export function sizedBytes(previous: number, applyMs: number | null, targetMs: number, ceiling: number): number {
  if (applyMs === null) return previous;
  if (!Number.isFinite(applyMs) || applyMs < 0) throw new Error("Invalid committed apply duration");
  const ratio = applyMs === 0 ? 2 : Math.max(0.5, Math.min(2, targetMs / applyMs));
  return Math.max(1, Math.min(ceiling, Math.floor(previous * ratio)));
}
export function receiptMatches(value: JsonObject, header: BatchHeader, sha256: string): boolean {
  return value.batchId === header.batchId && value.stream === header.senderStream && value.through === header.through && value.sha256 === sha256 &&
    (value.applyMs === null || typeof value.applyMs === "number" && Number.isFinite(value.applyMs) && value.applyMs >= 0);
}
