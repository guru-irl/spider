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

export function runSessionSearch(args: any, globalDb: Db | undefined): { text: string; details: SearchResultRow[] } {
  const replica = globalDb ? resolveSessionReplica(globalDb, String(args.session)) : null;
  if (!replica) return { text: "session not found", details: [] };
  try {
    const localMachineId = (globalDb!.prepare("SELECT machine_id FROM roam_meta WHERE id = 1").get() as { machine_id: string } | undefined)?.machine_id;
    return renderRows(searchSession(replica.db, String(args.session), { query: String(args.query ?? ""), limit: args.limit, kinds: args.kinds, localMachineId }));
  } finally { replica.db.close(); }
}

export async function runSearch(args: any, ctx: SearchActionCtx): Promise<{ text: string; details: SearchResultRow[] }> {
  if (args.session !== undefined) return runSessionSearch(args, ctx.globalDb);
  return renderRows(await unifiedSearch({ worktreeDb: ctx.db, repoDb: ctx.repoDb }, {
    query: String(args.query ?? ""), limit: args.limit, kinds: args.kinds,
  }));
}

export function registerSearchAction(
  register: (name: string, handler: (a: any, c: any) => any) => void,
): void {
  register("search", runSearch);
}
