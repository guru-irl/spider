import type { Db } from "@spider/db-core";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import type { Diagnostic } from "./contracts";
import { moveSetupMessage, parseMoveSetupFailure, type MoveSetupFailure } from "./setup-failure";

interface SetupSnapshot { sessionId: string; failure: MoveSetupFailure }
/** The latest failure is machine-local metadata, not portable session content. */
export function recordMoveSetupFailure(db: Db, sessionId: string, failure: MoveSetupFailure | null): void {
  db.transaction(() => {
    if (failure) writeLocal(db, "move-setup", "admission", { sessionId, failure });
    else if (readLocal<SetupSnapshot>(db, "move-setup", "admission")?.sessionId === sessionId) writeLocal(db, "move-setup", "admission", undefined);
  })();
}
export function readMoveSetupDiagnostics(db: Db): Diagnostic[] {
  try {
    const snapshot = readLocal<SetupSnapshot>(db, "move-setup", "admission");
    if (!snapshot) return [];
    const failure = parseMoveSetupFailure(snapshot.failure);
    if (!failure) throw new Error("invalid-setup-diagnostic");
    return [{ severity: "warning", reason: moveSetupMessage(failure), repairCommand: "spider roam doctor" }];
  } catch { return [{ severity: "warning", reason: "Move setup diagnostic unavailable. Run spider roam doctor and retry setup.", repairCommand: "spider roam doctor" }]; }
}
