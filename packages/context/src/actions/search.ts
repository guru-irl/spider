import type { Db } from "@spider/db-core";
import { unifiedSearch, type SearchResultRow } from "../search";

export interface SearchActionCtx {
  db: Db;         // worktree DB
  repoDb: Db;     // repo DB
  cwd: string;
}

export async function runSearch(args: any, ctx: SearchActionCtx): Promise<{ text: string; details: SearchResultRow[] }> {
  const rows: SearchResultRow[] = await unifiedSearch({ worktreeDb: ctx.db, repoDb: ctx.repoDb }, {
    query: String(args.query ?? ""),
    limit: args.limit,
    kinds: args.kinds,
  });
  const text = rows.length
    ? rows.map((r, i) => `${i + 1}. [${r.kind}] ${r.title}\n   ${r.snippet}`).join("\n")
    : "(no results)";
  return { text, details: rows };
}

export function registerSearchAction(
  register: (name: string, handler: (a: any, c: any) => any) => void,
): void {
  register("search", runSearch);
}
