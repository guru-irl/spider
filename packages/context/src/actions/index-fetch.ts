import { ContentStore } from "../content-store.js";
import { enqueueEmbed } from "@spider/memory";
import type { Db } from "@spider/db-core";

export interface IndexCtx {
  db: Db;
  cwd: string;
}

export async function runIndex(args: any, ctx: IndexCtx) {
  const store = new ContentStore(ctx.db);
  const res = store.indexContent({ content: args.content, path: args.path, source: args.source });
  const sel = ctx.db.prepare("SELECT chunk FROM content WHERE id = ?");
  for (const id of res.ids) {
    const row = sel.get(id) as { chunk: string } | undefined;
    if (row) enqueueEmbed(ctx.db, "content", String(id), row.chunk);
  }
  return { text: `indexed ${res.chunkCount} chunk(s) under "${res.source}"`, details: res };
}

export function registerIndexActions(register: (name: string, handler: (a: any, c: any) => any) => void) {
  register("index", runIndex);
}
