// ─────────────────────────────────────────────────────────
// Unified hybrid FTS+vector search across memory/content/
// sessions/todos, fused with RRF and proximity-reranked.
// ─────────────────────────────────────────────────────────

import type { Db } from "@spider/db-core";
import { ContentStore } from "./content-store";
import { refreshStaleContent } from "./freshness";
import { rrfFuse, proximityRerank } from "./fusion";
import { sanitizeQuery } from "./fts-query";
import { resolveEmbedder, knn } from "@spider/memory";

export type SearchKind = "memory" | "content" | "session" | "todo";

export interface SearchResultRow {
  key: string;
  kind: SearchKind;
  id: string;
  title: string;
  snippet: string;
  rrfScore?: number;
  source?: string;
}

interface Item {
  key: string;
  kind: SearchKind;
  id: string;
  title: string;
  content: string;
  source?: string;
  rank?: number;
}

export interface SearchCtx {
  worktreeDb: Db;  // sessions, content, todos, worktree vector_map
  repoDb: Db;      // memory, repo vector_map
}

export async function unifiedSearch(
  ctx: SearchCtx,
  opts: { query: string; limit?: number; kinds?: SearchKind[] },
): Promise<SearchResultRow[]> {
  const kinds = opts.kinds ?? (["memory", "content", "session", "todo"] as SearchKind[]);
  const limit = opts.limit ?? 10;
  const m = sanitizeQuery(opts.query, "OR");
  if (!m.trim()) return [];

  if (kinds.includes("content")) {
    try {
      refreshStaleContent(new ContentStore(ctx.worktreeDb));
    } catch {
      /* freshness is best-effort; never break search */
    }
  }

  const ftsLists: Item[][] = [];

  if (kinds.includes("content")) {
    try {
      const hits = new ContentStore(ctx.worktreeDb).ftsSearch(opts.query, limit);
      ftsLists.push(
        hits.map((h) => ({
          key: `content:${h.id}`,
          kind: "content" as const,
          id: String(h.id),
          title: h.heading ?? "",
          content: h.chunk,
          source: h.source,
          rank: h.rank,
        })),
      );
    } catch {
      ftsLists.push([]);
    }
  }

  if (kinds.includes("memory")) {
    try {
      const rows = ctx.repoDb
        .prepare(
          "SELECT mem.uuid AS id, mem.category AS category, mem.content AS content, bm25(memory_fts) AS rank " +
            "FROM memory_fts JOIN memory mem ON mem.uuid = memory_fts.uuid " +
            "WHERE memory_fts MATCH ? AND mem.status='active' ORDER BY rank LIMIT ?",
        )
        .all(m, limit) as Array<{ id: string; category: string; content: string; rank: number }>;
      ftsLists.push(
        rows.map((r) => ({
          key: `memory:${r.id}`,
          kind: "memory" as const,
          id: r.id,
          title: r.category,
          content: r.content,
          rank: r.rank,
        })),
      );
    } catch {
      ftsLists.push([]);
    }
  }

  if (kinds.includes("session")) {
    try {
      const rows = ctx.worktreeDb
        .prepare(
          "SELECT sessions_fts.id AS id, sessions_fts.name AS name, sessions_fts.summary AS summary, bm25(sessions_fts) AS rank " +
            "FROM sessions_fts WHERE sessions_fts MATCH ? ORDER BY rank LIMIT ?",
        )
        .all(m, limit) as Array<{ id: string; name: string | null; summary: string | null; rank: number }>;
      ftsLists.push(
        rows.map((r) => ({
          key: `session:${r.id}`,
          kind: "session" as const,
          id: r.id,
          title: r.name ?? "",
          content: r.summary ?? "",
          rank: r.rank,
        })),
      );
    } catch {
      ftsLists.push([]);
    }
  }

  if (kinds.includes("todo")) {
    try {
      const rows = ctx.worktreeDb
        .prepare(
          "SELECT rowid AS id, text AS text, bm25(todos_fts) AS rank " +
            "FROM todos_fts WHERE todos_fts MATCH ? ORDER BY rank LIMIT ?",
        )
        .all(m, limit) as Array<{ id: number; text: string; rank: number }>;
      ftsLists.push(
        rows.map((r) => ({
          key: `todo:${r.id}`,
          kind: "todo" as const,
          id: String(r.id),
          title: r.text,
          content: r.text,
          rank: r.rank,
        })),
      );
    } catch {
      ftsLists.push([]);
    }
  }

  let vecList: Item[] = [];
  // Check both DBs for vectors (each tier has its own vector_map)
  const hasRepoVec = ctx.repoDb.prepare("SELECT 1 FROM vector_map LIMIT 1").get();
  const hasWtVec = ctx.worktreeDb.prepare("SELECT 1 FROM vector_map LIMIT 1").get();
  if (hasRepoVec || hasWtVec) {
    const embedder = await resolveEmbedder();
    if (embedder) {
      const [qv] = await embedder.embed([opts.query]);
      const vecKinds = (["memory", "content", "session"] as const).filter((k) => kinds.includes(k));
      for (const kind of vecKinds) {
        const db = kind === "memory" ? ctx.repoDb : ctx.worktreeDb;
        const hits = knn(db, qv, limit, kind);
        vecList.push(
          ...hits.map((h) => ({
            key: `${h.ownerKind}:${h.ownerId}`,
            kind: h.ownerKind as SearchKind,
            id: h.ownerId,
            title: "",
            content: "",
          })),
        );
      }
    }
  }

  const fused = rrfFuse([...ftsLists, vecList]);

  const hydrated = fused
    .map((it) => {
      if (it.title !== "" || it.content !== "") return it;
      // Vector-only hit — hydrate from the owning table, or drop if gone/inactive.
      if (it.kind === "memory") {
        const row = ctx.repoDb
          .prepare("SELECT category, content FROM memory WHERE uuid = ? AND status='active'")
          .get(it.id) as { category: string; content: string } | undefined;
        if (!row) return null;
        return { ...it, title: row.category, content: row.content };
      }
      if (it.kind === "content") {
        const row = ctx.worktreeDb
          .prepare("SELECT heading, chunk, source FROM content WHERE id = ?")
          .get(Number(it.id)) as { heading: string | null; chunk: string; source: string } | undefined;
        if (!row) return null;
        return { ...it, title: row.heading ?? "", content: row.chunk, source: row.source };
      }
      if (it.kind === "session") {
        const row = ctx.worktreeDb
          .prepare("SELECT name, summary FROM sessions WHERE id = ?")
          .get(it.id) as { name: string | null; summary: string | null } | undefined;
        if (!row) return null;
        return { ...it, title: row.name ?? "", content: row.summary ?? "" };
      }
      if (it.kind === "todo") {
        const row = ctx.worktreeDb.prepare("SELECT text FROM todos WHERE id = ?").get(Number(it.id)) as
          | { text: string }
          | undefined;
        if (!row) return null;
        return { ...it, title: row.text, content: row.text };
      }
      return it;
    })
    .filter((it): it is Item & { rrfScore: number } => it !== null);

  const reranked = proximityRerank(hydrated.slice(0, limit * 2), opts.query).slice(0, limit);

  return reranked.map((it) => ({
    key: it.key,
    kind: it.kind,
    id: it.id,
    title: it.title,
    snippet: it.content.slice(0, 300),
    rrfScore: it.rrfScore,
    source: it.source,
  }));
}
