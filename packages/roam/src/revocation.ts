// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { Db } from "@spider/db-core";
import type { MachineId } from "@spider/db-core/roam/types";
import { isMachineId } from "./machine-id";

export type SyncHandshake =
  | { kind: "accepted"; reason: "ok"; machineId: MachineId }
  | { kind: "retire-only"; reason: "machine-revoked"; machineId: MachineId };

function privateJournal(db: Db): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_operations'").get() ||
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_meta'").get())
    throw new Error("Revocations require the private hub journal");
}
export function isRevoked(db: Db, machineId: MachineId): boolean {
  if (!isMachineId(machineId)) throw new Error("Invalid machine identity");
  privateJournal(db);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='roam_machine_revocations'").get()) return false;
  return !!db.prepare("SELECT 1 FROM roam_machine_revocations WHERE machine_id=?").get(machineId);
}
/** No removal or alias-based lookup. This table is outside replication and journal pruning. */
export function revokeMachine(db: Db, machineId: MachineId): void {
  if (!isMachineId(machineId)) throw new Error("Invalid machine identity");
  privateJournal(db);
  db.pragma("synchronous = FULL");
  db.raw.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS roam_machine_revocations (machine_id TEXT PRIMARY KEY NOT NULL)");
    db.prepare("INSERT INTO roam_machine_revocations(machine_id) VALUES (?) ON CONFLICT(machine_id) DO NOTHING").run(machineId);
  }).immediate();
  if (!isRevoked(db, machineId)) throw new Error("Revocation was not persisted");
}
export function syncHandshake(db: Db, machineId: MachineId): SyncHandshake {
  return isRevoked(db, machineId) ? { kind: "retire-only", reason: "machine-revoked", machineId }
    : { kind: "accepted", reason: "ok", machineId };
}
