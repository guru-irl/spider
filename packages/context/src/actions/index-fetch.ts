import { ContentStore } from "../content-store";
import { enqueueEmbed } from "@spider/memory";
import type { Db } from "@spider/db-core";
import { fetchAndConvert } from "../fetch";

export interface IndexCtx {
  db: Db;
  cwd: string;
}

export async function runIndex(args: any, ctx: IndexCtx): Promise<{ text: string; details: any }> {
  const store = new ContentStore(ctx.db);
  const res = store.indexContent({ content: args.content, path: args.path, source: args.source });
  const sel = ctx.db.prepare("SELECT chunk FROM content WHERE id = ?");
  for (const id of res.ids) {
    const row = sel.get(id) as { chunk: string } | undefined;
    if (row) enqueueEmbed(ctx.db, "content", String(id), row.chunk);
  }
  return { text: `indexed ${res.chunkCount} chunk(s) under "${res.source}"`, details: res };
}

export async function runFetch(args: any, ctx: IndexCtx): Promise<{ text: string; details: { count: number } }> {
  const requests = args.requests ?? (args.url ? [{ url: args.url, source: args.source }] : []);
  const store = new ContentStore(ctx.db);
  const summaries: string[] = [];
  for (const req of requests) {
    const { markdown, source } = await fetchAndConvert(req.url, req.source, {
      cwd: ctx.cwd,
      ttl: args.ttl,
      force: args.force,
    });
    const res = store.indexContent({ content: markdown, source });
    const sel = ctx.db.prepare("SELECT chunk FROM content WHERE id = ?");
    for (const id of res.ids) {
      const row = sel.get(id) as { chunk: string } | undefined;
      if (row) enqueueEmbed(ctx.db, "content", String(id), row.chunk);
    }
    summaries.push(`${source}: ${res.chunkCount} chunk(s)`);
  }
  return { text: `fetched+indexed ${requests.length} URL(s)\n${summaries.join("\n")}`, details: { count: requests.length } as { count: number } };
}

export function registerIndexActions(register: (name: string, handler: (a: any, c: any) => any) => void): void {
  register("index", runIndex);
  register("fetch", runFetch);
}
