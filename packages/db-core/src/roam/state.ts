import type { Db } from "../db";
import type { Home, MachineId, SessionState } from "./types";

export function readSessionState(db: Db, sessionId: string): SessionState | null {
  const row = db.withRetry(() => db.prepare("SELECT session_id, epoch, state, move_id, freeze_seq FROM roam_sessions WHERE session_id = ?")
    .get(sessionId)) as { session_id: string; epoch: number; state: SessionState["state"]; move_id: string | null; freeze_seq: number | null } | undefined;
  return row ? { sessionId: row.session_id, epoch: row.epoch, state: row.state, moveId: row.move_id, freezeSeq: row.freeze_seq } : null;
}

/** Call while holding the worktree write transaction. */
export function assertTodoHome(db: Db, sessionId: string, localMachine: MachineId, home: Home | null): void {
  const state = readSessionState(db, sessionId);
  if (!state && !home) return;
  if (!state || state.state !== "active") throw new Error("Cannot write todos outside the active session home");
  const meta = db.prepare("SELECT store_key, capture_enabled, importing, roamable, problem FROM roam_meta WHERE id = 1").get() as
    { store_key: string | null; capture_enabled: number; importing: number; roamable: number; problem: string | null };
  if (!meta.store_key || meta.capture_enabled !== 1 || meta.importing !== 0 || meta.roamable !== 1 || meta.problem !== null) {
    throw new Error("Cannot write todos while roaming capture is unsafe");
  }
  if (home) {
    if (home.sessionId !== sessionId || !home.machineId || home.machineId !== localMachine || home.epoch !== state.epoch) {
      throw new Error("Cannot write todos outside the session home");
    }
  } else {
    const origin = db.prepare("SELECT origin_machine FROM sessions WHERE id = ?").get(sessionId) as { origin_machine: string } | undefined;
    if (!origin || origin.origin_machine !== localMachine || state.epoch !== 1) {
      throw new Error("Cannot verify the session home");
    }
  }
}
