import type { Db } from "@spider/db-core";
import type { HomeAdmission, HomeStore, SessionId } from "@spider/roam/relocate/types";

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
