import type { Db } from "@spider/db-core";
import type { Component } from "@spider/ui";
import type { MemoryScope } from "./types";
import type { Embedder } from "./embeddings/embedder";
import { stageWrite, listPending, approvePending, rejectPending } from "./staging";
import { recall } from "./recall";
import { activeCharTotal, listActive } from "./internal";
import { renderRememberResult, renderRecallResult, renderPending } from "./renderers";

export interface MemoryConfig {
  snapshotCharCap?: number;
}

export interface MemoryDeps {
  projectDb: Db;
  globalDb: Db;
  getEmbedder: () => Promise<Embedder | null>;
  config: MemoryConfig;
}

export interface ActionResult {
  display?: Component | string;
  details: unknown;
}

/**
 * Resolve the target DB + scope for a handler call. Prefers a per-call ctx DB
 * (supplied by the host at runtime) and falls back to the closure deps DB (used
 * by the fakePi test, which passes an empty ctx).
 */
function resolveDb(args: any, ctx: any, deps: MemoryDeps): { db: Db; scope: MemoryScope } {
  const scope: MemoryScope = args?.scope === "global" ? "global" : "project";
  const db = scope === "global" ? (ctx?.globalDb ?? deps.globalDb) : (ctx?.db ?? deps.projectDb);
  return { db, scope };
}

export function makeRemember(deps: MemoryDeps) {
  return async (args: any, ctx: any): Promise<ActionResult> => {
    const { db, scope } = resolveDb(args, ctx, deps);
    const source = args?.auto ? "auto" : "user";
    const r = stageWrite(
      db,
      scope,
      { category: args.category, content: args.content, link: args.link ?? null, source },
      {},
    );
    return { display: renderRememberResult(r), details: r };
  };
}

export function makeRecall(deps: MemoryDeps) {
  return async (args: any, ctx: any): Promise<ActionResult> => {
    const { db, scope } = resolveDb(args, ctx, deps);
    const embedder = await deps.getEmbedder();
    const recs = await recall(db, scope, args.query, embedder, {
      category: args.category,
      limit: args.limit,
    });
    return { display: renderRecallResult(recs), details: recs };
  };
}

export function makeControl(deps: MemoryDeps) {
  return async (args: any, ctx: any): Promise<ActionResult> => {
    if (args?.command !== "memory") {
      return { details: { ok: false, note: `unhandled control command: ${args?.command}` } };
    }
    const { db, scope } = resolveDb(args, ctx, deps);
    switch (args?.sub) {
      case "pending": {
        const recs = listPending(db, scope);
        return { display: renderPending(recs), details: recs };
      }
      case "approve": {
        return { details: approvePending(db, scope, args.uuid) };
      }
      case "reject": {
        rejectPending(db, scope, args.uuid);
        return { details: { ok: true, uuid: args.uuid } };
      }
      case "consolidate": {
        // Phase 1: expose active entries + char usage so the model can curate
        // in-turn. No LLM merge here — that is Phase 6.
        const entries = listActive(db, scope);
        const usage = activeCharTotal(db, scope);
        return { details: { entries, usage } };
      }
      default:
        return { details: { ok: false, note: `unhandled memory sub: ${args?.sub}` } };
    }
  };
}
