import type { Db } from "@spider/db-core";
import { resolveSessionReplica } from "@spider/db-core/roam/catalog";
import { searchSession, unifiedSearch, type SearchResultRow } from "../search";

export interface SearchActionCtx {
  db: Db;         // worktree DB
  repoDb: Db;     // repo DB
  globalDb?: Db;
  cwd: string;
}

function renderRows(rows: SearchResultRow[]): { text: string; details: SearchResultRow[] } {
  const text = rows.length
    ? rows.map((r, i) => `${i + 1}. [${r.kind}] ${r.title}\n   ${r.snippet}`).join("\n")
    : "(no results)";
  return { text, details: rows };
}

export function runSessionSearch(args: any, globalDb: Db | undefined, worktreeDb?: Db | (() => Db | undefined)): { text: string; details: SearchResultRow[] } {
  const sessionId = String(args.session);
  const hasTable = (db: Db, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const cataloged = globalDb && hasTable(globalDb, "roam_locations")
    && globalDb.prepare("SELECT 1 FROM roam_locations WHERE session_id=?").get(sessionId);
  const replica = cataloged ? resolveSessionReplica(globalDb!, sessionId) : null;
  if (cataloged && !replica) return { text: "session history unavailable", details: [] };
  const db = replica?.db ?? (typeof worktreeDb === "function" ? worktreeDb() : worktreeDb);
  try {
    if (!db || !replica && !db.prepare(`SELECT 1 FROM sessions WHERE id=?
      UNION ALL SELECT 1 FROM todos WHERE session_id=? UNION ALL SELECT 1 FROM runs WHERE session_id=?
      UNION ALL SELECT 1 FROM run_events WHERE session_id=? LIMIT 1`).get(sessionId, sessionId, sessionId, sessionId))
      return { text: "session not found", details: [] };
    const machineDb = replica ? globalDb! : db;
    const localMachineId = hasTable(machineDb, "roam_meta")
      ? (machineDb.prepare("SELECT machine_id FROM roam_meta WHERE id=1").get() as { machine_id: string } | undefined)?.machine_id : undefined;
    return renderRows(searchSession(db, sessionId, { query: String(args.query ?? ""), limit: args.limit, kinds: args.kinds, localMachineId }));
  } finally { replica?.db.close(); }
}

export async function runSearch(args: any, ctx: SearchActionCtx): Promise<{ text: string; details: SearchResultRow[] }> {
  if (args.session !== undefined) return runSessionSearch(args, ctx.globalDb, ctx.db);
  return renderRows(await unifiedSearch({ worktreeDb: ctx.db, repoDb: ctx.repoDb }, {
    query: String(args.query ?? ""), limit: args.limit, kinds: args.kinds,
  }));
}

export function registerSearchAction(
  register: (name: string, handler: (a: any, c: any) => any) => void,
): void {
  register("search", runSearch);
}
