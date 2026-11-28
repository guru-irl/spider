import type { Db } from "@spider/db-core";
import type { MachineId } from "@spider/db-core/roam/types";
import { validUnicode } from "@spider/db-core/roam/hlc";
import { parsePlacement } from "./journal";
import type { SessionId, SessionPlacement } from "./types";

interface LocalRow { key: string | null; value: unknown; valid: boolean; stream: string }

const sessionKey = (value: unknown): string | null =>
  validUnicode(value) && value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;

/** Read these stop-path records independently: a broken row must not hide its siblings. */
export function localRecordRows(db: Db, kind: string): LocalRow[] {
  const prefix = `spider-local:${kind}:`;
  const rows = db.prepare("SELECT peer_stream FROM roam_cursors WHERE peer_machine = ? AND substr(peer_stream,1,?) = ? ORDER BY peer_stream")
    .all("", prefix.length, prefix) as Array<{ peer_stream: string }>;
  return rows.map(({ peer_stream: stream }) => {
    const text = stream.slice(prefix.length);
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length === 2 && sessionKey(parsed[0]) !== null)
        return { key: parsed[0] as string, value: parsed[1], valid: true, stream };
    } catch { /* Recover the key independently when the value was truncated. */ }
    const first = /^\s*\[\s*("(?:[^"\\]|\\.)*")/.exec(text);
    let key: string | null = null;
    if (first) {
      try { key = sessionKey(JSON.parse(first[1])); } catch { /* No trustworthy key. */ }
    }
    return { key, value: undefined, valid: false, stream };
  });
}

export function readLocalRecord(db: Db, kind: string, key: string): { value: unknown; corrupt: boolean } {
  const rows = localRecordRows(db, kind);
  const own = rows.filter(row => row.key === key);
  return {
    value: own.length === 1 && own[0].valid ? own[0].value : undefined,
    corrupt: rows.some(row => !row.valid && row.key === null) || own.length > 1 || own.some(row => !row.valid),
  };
}

export function readStopPlacement(db: Db, id: SessionId, machine: MachineId): { placement: SessionPlacement | undefined; corrupt: boolean } {
  const row = readLocalRecord(db, "relocate-managed", id);
  if (row.value === undefined) return { placement: undefined, corrupt: row.corrupt };
  try {
    const placement = parsePlacement(row.value);
    if (placement.sessionId !== id || placement.machineId !== machine) throw new Error("Foreign placement");
    return { placement, corrupt: row.corrupt };
  } catch { return { placement: undefined, corrupt: true }; }
}

/** Replace only rows attributable to this key, leaving unknown and other sessions untouched. */
export function writeLocalRecord(db: Db, kind: string, key: string, value: unknown): void {
  const rows = localRecordRows(db, kind).filter(row => row.key === key);
  const stream = `spider-local:${kind}:` + JSON.stringify([key, value]);
  if (rows.length === 1 && rows[0].stream === stream) return;
  for (const row of rows) db.prepare("DELETE FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?").run("", row.stream);
  db.prepare("INSERT INTO roam_cursors(peer_machine,peer_stream,last_seq) VALUES (?, ?, 0)").run("", stream);
}
