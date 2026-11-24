import type { Db } from "@spider/db-core";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import type { Diagnostic } from "./contracts";
import { moveSetupMessage, parseMoveSetupFailure, type MoveSetupFailure } from "./setup-failure";

interface SetupSnapshot { sessionId: string; failure: MoveSetupFailure; firstAt?: number; lastAt?: number }
const safeSession = (id: unknown): string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id) ? id : "<session>";
const validTime = (time: unknown): time is number => Number.isSafeInteger(time) && (time as number) >= 0 && (time as number) <= 8_640_000_000_000_000;
const instant = "(?:\\d{4}|\\+\\d{6})-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z";
const setupDetails = new RegExp(`^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,255}|<session>)\\.(?: First ${instant}; last ${instant}\\.)?$`);
/** Match the entire generated diagnostic before accepting it from a peer. */
export function isMoveSetupDiagnostic(row: Diagnostic): boolean {
  if (row.severity !== "warning" || row.repairCommand !== "spider roam doctor") return false;
  if (row.reason === "Move setup diagnostic unavailable. Run spider roam doctor and retry setup.") return true;
  const match = /^Move setup failed at ([a-z-]+) \(([A-Za-z0-9_-]+)\)\./.exec(row.reason);
  const failure = match && parseMoveSetupFailure({ stage: match[1], causeCode: match[2] });
  if (!failure) return false;
  const prefix = `${moveSetupMessage(failure)} Session `;
  return row.reason.startsWith(prefix) && setupDetails.test(row.reason.slice(prefix.length));
}
/** The latest failure is machine-local metadata, not portable session content. */
export function recordMoveSetupFailure(db: Db, sessionId: string, failure: MoveSetupFailure | null): void {
  db.transaction(() => {
    const id = safeSession(sessionId), previous = readLocal<SetupSnapshot>(db, "move-setup", "admission");
    if (failure) {
      const safe = parseMoveSetupFailure(failure) ?? { stage: "preparation" as const, causeCode: "setup-unavailable" };
      const now = Date.now();
      const firstAt = previous?.sessionId === id && previous.failure?.stage === safe.stage && previous.failure?.causeCode === safe.causeCode && validTime(previous.firstAt)
        ? previous.firstAt : now;
      writeLocal(db, "move-setup", "admission", { sessionId: id, failure: safe, firstAt, lastAt: now });
    } else if (previous?.sessionId === id) writeLocal(db, "move-setup", "admission", undefined);
  })();
}
export function readMoveSetupDiagnostics(db: Db): Diagnostic[] {
  try {
    const snapshot = readLocal<SetupSnapshot>(db, "move-setup", "admission");
    if (!snapshot) return [];
    const failure = parseMoveSetupFailure(snapshot.failure);
    if (!failure) throw new Error("invalid-setup-diagnostic");
    const times = snapshot.firstAt === undefined && snapshot.lastAt === undefined ? ""
      : validTime(snapshot.firstAt) && validTime(snapshot.lastAt)
        ? ` First ${new Date(snapshot.firstAt).toISOString()}; last ${new Date(snapshot.lastAt).toISOString()}.`
        : null;
    if (times === null) throw new Error("invalid-setup-diagnostic");
    return [{ severity: "warning", reason: `${moveSetupMessage(failure)} Session ${safeSession(snapshot.sessionId)}.${times}`, repairCommand: "spider roam doctor" }];
  } catch { return [{ severity: "warning", reason: "Move setup diagnostic unavailable. Run spider roam doctor and retry setup.", repairCommand: "spider roam doctor" }]; }
}
