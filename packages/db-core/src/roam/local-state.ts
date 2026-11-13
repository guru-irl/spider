import type { Db } from "../db";

// A real peer machine is a UUID. The empty machine is reserved for local metadata.
const machine = "";
const prefix = (kind: string) => `spider-local:${kind}:`;

function localEntriesFromStreams<T>(kind: string, rows: readonly { peer_stream: string }[]): Array<{ key: string; value: T; stream: string }> {
  const start = prefix(kind);
  return rows.map(({ peer_stream }) => {
    const parsed: unknown = JSON.parse(peer_stream.slice(start.length));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string") throw new Error("Invalid local roaming state");
    return { key: parsed[0], value: parsed[1] as T, stream: peer_stream };
  });
}

export function localEntries<T>(db: Db, kind: string): Array<{ key: string; value: T; stream: string }> {
  const start = prefix(kind);
  const rows = db.prepare("SELECT peer_stream FROM roam_cursors WHERE peer_machine = ? AND substr(peer_stream,1,?) = ? ORDER BY peer_stream")
    .all(machine, start.length, start) as Array<{ peer_stream: string }>;
  return localEntriesFromStreams<T>(kind, rows);
}

function localValue<T>(entries: Array<{ key: string; value: T }>, key: string): T | undefined {
  const rows = entries.filter(row => row.key === key);
  if (rows.length > 1) throw new Error("Duplicate local roaming state");
  return rows[0]?.value;
}

export function readLocal<T>(db: Db, kind: string, key: string): T | undefined {
  return localValue(localEntries<T>(db, kind), key);
}

export function readLocalFromStreams<T>(kind: string, key: string, rows: readonly { peer_stream: string }[]): T | undefined {
  return localValue(localEntriesFromStreams<T>(kind, rows), key);
}

/** Call inside a global-store write transaction when coordinating competing writers. */
export function writeLocal<T>(db: Db, kind: string, key: string, value: T | undefined): void {
  const existing = localEntries<T>(db, kind).filter(row => row.key === key);
  if (existing.length > 1) throw new Error("Duplicate local roaming state");
  const stream = value === undefined ? undefined : prefix(kind) + JSON.stringify([key, value]);
  if (existing[0]?.stream === stream) return;
  if (existing[0]) db.prepare("DELETE FROM roam_cursors WHERE peer_machine = ? AND peer_stream = ?").run(machine, existing[0].stream);
  if (stream !== undefined) db.prepare("INSERT INTO roam_cursors(peer_machine,peer_stream,last_seq) VALUES (?, ?, 0)").run(machine, stream);
}
