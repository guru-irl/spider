import { createHash } from "node:crypto";
import type { Db } from "@spider/db-core";
import type { Home, MachineId } from "@spider/db-core/roam/types";
import { isMachineId } from "./machine-id";

export function sessionHome(db: Db, sessionId: string): Home | null | "unknown" {
  try {
    const row = db.prepare("SELECT machine_id,epoch,move_id,updated_at FROM session_homes WHERE session_id=?").get(sessionId) as
      { machine_id: string; epoch: number; move_id: string | null; updated_at: number } | undefined;
    return row?.machine_id ? { sessionId, machineId: row.machine_id, epoch: row.epoch, moveId: row.move_id, updatedAt: row.updated_at } : null;
  } catch { return "unknown"; }
}
function hub(db: Db, machine: MachineId, id: string): void {
  const meta = db.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id: string };
  if (!isMachineId(machine) || meta.machine_id !== machine) throw new Error("Only the hub may change homes");
  if (!id || id.length > 1024 || /[\u0000-\u001f]/.test(id)) throw new Error("Invalid session identity");
}
export function assignInitialHome(db: Db, sessionId: string, originMachine: MachineId, hubMachine: MachineId): Home | "conflict" {
  hub(db, hubMachine, sessionId);
  if (!isMachineId(originMachine)) throw new Error("Invalid origin machine");
  return db.raw.transaction(() => {
    db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES (?,?,1,NULL,?) ON CONFLICT(session_id) DO NOTHING")
      .run(sessionId, originMachine, Date.now());
    const home = sessionHome(db, sessionId);
    if (home === "unknown") throw new Error("Home lookup failed");
    return home ?? "conflict";
  }).immediate();
}
export function markInitialConflict(db: Db, sessionId: string, hubMachine: MachineId): void {
  hub(db, hubMachine, sessionId);
  db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at) VALUES (?,'',1,NULL,?) ON CONFLICT(session_id) DO NOTHING")
    .run(sessionId, Date.now());
}
function argumentsFor(expected: Home, nextMachine: MachineId, moveId: string): string {
  if (!isMachineId(expected.machineId) || !isMachineId(nextMachine) || !Number.isSafeInteger(expected.epoch) || expected.epoch < 1 ||
      expected.epoch === Number.MAX_SAFE_INTEGER || !moveId || moveId.length > 128 || /[\u0000-\u001f]/.test(moveId)) throw new Error("Invalid home arguments");
  return createHash("sha256").update(JSON.stringify([expected.sessionId, expected.machineId, expected.epoch, expected.moveId, nextMachine, moveId])).digest("hex");
}
type Action = { args_digest: string; cancelled: number; committed_home_json: string | null };
function action(db: Db, expected: Home, nextMachine: MachineId, moveId: string): { prior: Action | undefined; digest: string } {
  const digest = argumentsFor(expected, nextMachine, moveId);
  const prior = db.prepare("SELECT args_digest,cancelled,committed_home_json FROM roam_home_actions WHERE move_id=?").get(moveId) as Action | undefined;
  if (prior && prior.args_digest !== digest) throw new Error("Conflicting home action arguments");
  return { prior, digest };
}
export function casHome(db: Db, expected: Home, nextMachine: MachineId, moveId: string, hubMachine: MachineId): Home {
  hub(db, hubMachine, expected.sessionId);
  return db.raw.transaction(() => {
    const { prior, digest } = action(db, expected, nextMachine, moveId);
    if (prior?.cancelled) throw new Error("Home action was cancelled");
    if (prior?.committed_home_json) return JSON.parse(prior.committed_home_json) as Home;
    const current = sessionHome(db, expected.sessionId);
    if (!current || current === "unknown" || current.epoch !== expected.epoch || current.machineId !== expected.machineId || current.moveId !== expected.moveId)
      throw new Error("Home compare-and-swap epoch does not match");
    const home: Home = { sessionId: expected.sessionId, machineId: nextMachine, epoch: expected.epoch + 1, moveId, updatedAt: Date.now() };
    db.prepare("UPDATE session_homes SET machine_id=?,epoch=?,move_id=?,updated_at=? WHERE session_id=?")
      .run(home.machineId, home.epoch, home.moveId, home.updatedAt, home.sessionId);
    db.prepare("INSERT INTO roam_home_actions(move_id,session_id,expected_epoch,args_digest,committed_home_json) VALUES (?,?,?,?,?)")
      .run(moveId, home.sessionId, expected.epoch, digest, JSON.stringify(home));
    return home;
  }).immediate();
}
/** Cancellation is durable even if the corresponding transition never started. */
export function cancelHomeAction(db: Db, expected: Home, nextMachine: MachineId, moveId: string, hubMachine: MachineId): void {
  hub(db, hubMachine, expected.sessionId);
  db.raw.transaction(() => {
    const { prior, digest } = action(db, expected, nextMachine, moveId);
    if (prior?.committed_home_json) throw new Error("Committed home action cannot be cancelled");
    db.prepare("INSERT INTO roam_home_actions(move_id,session_id,expected_epoch,args_digest,cancelled) VALUES (?,?,?,?,1) ON CONFLICT(move_id) DO UPDATE SET cancelled=1")
      .run(moveId, expected.sessionId, expected.epoch, digest);
  }).immediate();
}
