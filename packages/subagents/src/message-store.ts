import type { Db } from "@spider/db-core";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type MessageRoute = { kind: "local" | "bridge"; messageId: string };
export interface MessageRow {
  id: number;
  fromSession: string | null;
  toSession: string | null;
  kind: string | null;
  body: string | null;
  createdAt: number;
  deliveredAt: number | null;
  readAt: number | null;
  route?: MessageRoute;
}
function routeFile(db: Db, row: MessageRow): string {
  const root = join(dirname(db.raw.name), "intercom-routes");
  try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new Error("Unsafe intercom route directory");
  const digest = createHash("sha256").update(JSON.stringify([db.raw.name, row.id, row.fromSession, row.toSession, row.kind, row.body, row.createdAt])).digest("hex");
  return join(root, `${row.id}-${digest}.json`);
}
function readRoute(db: Db, row: MessageRow): MessageRoute | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(routeFile(db, row), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) return undefined;
    const route = JSON.parse(readFileSync(fd, "utf8"));
    return (route.kind === "local" || route.kind === "bridge") && typeof route.messageId === "string" && route.messageId.length > 0 ? route : undefined;
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}
function writeRoute(db: Db, row: MessageRow, route: MessageRoute): void {
  if (!route.messageId || route.messageId.length > 256 || !["local", "bridge"].includes(route.kind)) throw new Error("Invalid intercom route");
  const file = routeFile(db, row);
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(route)); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export class MessageStore {
  constructor(private db: Db) {}
  enqueue(m: { fromSession?: string; toSession: string; kind?: string; body: string; route?: MessageRoute }): number {
    return this.db.transaction(() => {
      const createdAt = Date.now();
      const result = this.db.prepare(
        `INSERT INTO message_mirror (from_session, to_session, kind, body, created_at)
         VALUES (@fromSession, @toSession, @kind, @body, @createdAt)`
      ).run({ fromSession: m.fromSession ?? null, toSession: m.toSession, kind: m.kind ?? null, body: m.body, createdAt });
      const id = Number(result.lastInsertRowid);
      writeRoute(this.db, { id, fromSession: m.fromSession ?? null, toSession: m.toSession, kind: m.kind ?? null, body: m.body, createdAt, deliveredAt: null, readAt: null }, m.route ?? { kind: "local", messageId: randomUUID() });
      return id;
    })();
  }
  /** Undelivered messages addressed to this session. Missing historical evidence never permits replay. */
  pending(sessionId: string, limit?: number): MessageRow[] {
    const sql = `SELECT * FROM message_mirror WHERE to_session = ? AND delivered_at IS NULL ORDER BY created_at, id${limit ? " LIMIT ?" : ""}`;
    const rows = limit ? this.db.prepare(sql).all(sessionId, limit) : this.db.prepare(sql).all(sessionId);
    return (rows as any[]).map(r => {
      const row: MessageRow = { id: r.id, fromSession: r.from_session, toSession: r.to_session, kind: r.kind, body: r.body, createdAt: r.created_at, deliveredAt: r.delivered_at, readAt: r.read_at };
      return { ...row, route: readRoute(this.db, row) };
    });
  }
  markDelivered(id: number, now?: number): boolean {
    return this.db.prepare("UPDATE message_mirror SET delivered_at = @now WHERE id = @id AND delivered_at IS NULL").run({ id, now: now ?? Date.now() }).changes > 0;
  }
  markRead(id: number, now?: number): boolean {
    return this.db.prepare("UPDATE message_mirror SET read_at = @now WHERE id = @id AND read_at IS NULL").run({ id, now: now ?? Date.now() }).changes > 0;
  }
}
