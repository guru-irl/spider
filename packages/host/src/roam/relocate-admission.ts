import type { Db } from "@spider/db-core";
import type { HomeAdmission, HomeStore, RunningHome, SessionId, SessionMachinePorts } from "@spider/roam/relocate/types";
import { resolve } from "node:path";

export async function prepareRelocateAdmission(home: RunningHome, file: string, machine: SessionMachinePorts): Promise<void> {
  const located = await machine.locate(home.machineId, home.sessionId);
  if (!located.ok) throw new Error(located.refusal.code);
  const placement = located.value;
  if (placement.sessionId !== home.sessionId || placement.machineId !== home.machineId || resolve(placement.file) !== resolve(file)) throw new Error("home-conflict");
  const activated = await machine.activate(home, placement);
  if (!activated.ok) throw new Error(activated.refusal.code);
}

/** A failed lookup is never evidence that a session is ordinary legacy work. */
export async function readRelocateAdmission(sessionId: SessionId, db: Db, homes: HomeStore,
  knownManaged: (sessionId: SessionId) => boolean): Promise<HomeAdmission> {
  try {
    const columns = db.prepare("PRAGMA table_info(session_homes)").all() as { name: string }[];
    const hasState = columns.some(column => column.name === "state");
    const row = db.prepare(hasState ? "SELECT state FROM session_homes WHERE session_id=?"
      : "SELECT NULL AS state FROM session_homes WHERE session_id=?").get(sessionId) as { state: unknown } | undefined;
    if (row?.state === null) return { kind: "unmanaged" };
    if (!row) return knownManaged(sessionId) ? { kind: "managed", home: null } : { kind: "unmanaged" };
    return { kind: "managed", home: await homes.read(sessionId) };
  } catch { return { kind: "unavailable" }; }
}
