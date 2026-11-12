/*
 * Derived from context-mode by Mert Koseoglu.
 * Copyright 2026 Mert Koseoglu. Licensed under the Elastic License 2.0.
 * Modified for spider. See ../LICENSE for the license terms.
 */

// ─────────────────────────────────────────────────────────
// Unified hybrid FTS+vector search across memory/content/
// sessions/todos, fused with RRF and proximity-reranked.
// ─────────────────────────────────────────────────────────

import type { Db } from "@spider/db-core";
import { ContentStore } from "./content-store";
import { refreshStaleContent } from "./freshness";
import { rrfFuse, proximityRerank } from "./fusion";
import { sanitizeQuery } from "./fts-query";
import { getReadyEmbedder, knn } from "@spider/memory";

export type SearchKind = "memory" | "content" | "session" | "todo" | "run";

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

export function searchSession(db: Db, sessionId: string, opts: { query: string; limit?: number; kinds?: SearchKind[]; localMachineId?: string }): SearchResultRow[] {
  const query = sanitizeQuery(opts.query, "OR");
  const terms = [...query.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  if (!terms.length) return [];
  const kinds = opts.kinds ?? ["session", "todo", "run"];
  const limit = Number.isSafeInteger(opts.limit) && opts.limit! > 0 ? Math.min(opts.limit!, 100) : 10;
  const results: SearchResultRow[] = [];
  if (kinds.includes("session")) {
    const row = db.prepare("SELECT id,parent_session_id,name,reason,started_at,ended_at,summary,origin_machine FROM sessions WHERE id = ?")
      .get(sessionId) as { id: string; parent_session_id: string | null; name: string | null; reason: string | null; started_at: number; ended_at: number | null; summary: string | null; origin_machine: string } | undefined;
    if (row) {
      const lower = terms.map(term => term.toLowerCase());
      const matches = (value: unknown) => value !== null && value !== undefined && lower.some(term => String(value).toLowerCase().includes(term));
      const metadataMatch = Object.values(row).some(matches);
      const hits = db.prepare("SELECT content FROM sessions_fts WHERE sessions_fts MATCH ? AND id = ?").all(query, sessionId) as Array<{ content: string | null }>;
      const transcript = hits.find(hit => matches(hit.content))?.content;
      if (metadataMatch || transcript) {
        const localText = (db.prepare("SELECT 1 FROM sessions_fts WHERE id = ? AND content IS NOT NULL AND content <> '' LIMIT 1").get(sessionId));
        const note = !localText && row.origin_machine && row.origin_machine !== opts.localMachineId ? "Transcript text lives on the origin machine." : "";
        const metadata = [row.summary, row.reason].filter(Boolean).join("\n");
        const details = note ? `${metadata.slice(0, 299 - note.length)}\n${note}` : metadata.slice(0, 300);
        results.push({ key: `session:${row.id}`, kind: "session", id: row.id, title: row.name ?? row.id, snippet: transcript ? transcript.slice(0, 300) : details });
      }
    }
  }
  if (kinds.includes("todo")) {
    const rows = db.prepare("SELECT t.uuid,t.text FROM todos_fts JOIN todos t ON t.id = todos_fts.rowid WHERE todos_fts MATCH ? AND t.session_id = ? LIMIT ?")
      .all(query, sessionId, limit) as Array<{ uuid: string; text: string }>;
    for (const row of rows) results.push({ key: `todo:${row.uuid}`, kind: "todo", id: row.uuid, title: row.text, snippet: row.text.slice(0, 300) });
  }
  if (kinds.includes("run")) {
    const condition = terms.map(() => "instr(lower(search_text), lower(?)) > 0").join(" OR ");
    const runs = db.prepare(`SELECT id,agent,name,task,result FROM (
      SELECT id,agent,name,task,result,coalesce(agent,'') || ' ' || coalesce(name,'') || ' ' || coalesce(task,'') || ' ' || coalesce(result,'') || ' ' || status AS search_text
      FROM runs WHERE session_id = ?
    ) WHERE ${condition} LIMIT ?`).all(sessionId, ...terms, limit) as Array<{ id: string; agent: string; name: string | null; task: string | null; result: string | null }>;
    for (const row of runs) results.push({ key: `run:${row.id}`, kind: "run", id: row.id, title: row.name ?? row.agent, snippet: [row.task, row.result].filter(Boolean).join("\n").slice(0, 300) });
    const events = db.prepare(`SELECT uuid,type,summary,payload FROM (
      SELECT uuid,type,summary,payload,coalesce(type,'') || ' ' || coalesce(tool,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(payload,'') AS search_text
      FROM run_events WHERE session_id = ?
    ) WHERE ${condition} LIMIT ?`).all(sessionId, ...terms, limit) as Array<{ uuid: string; type: string; summary: string | null; payload: string | null }>;
    for (const row of events) results.push({ key: `run-event:${row.uuid}`, kind: "run", id: row.uuid, title: row.type, snippet: [row.summary, row.payload].filter(Boolean).join("\n").slice(0, 300) });
  }
  return results.slice(0, limit);
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
    const embedder = getReadyEmbedder();
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
