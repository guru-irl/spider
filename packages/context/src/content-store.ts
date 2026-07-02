import { createHash } from "node:crypto";
import { openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import type { Db } from "@spider/db-core";
import { chunkMarkdown, detectContentType } from "./chunker.js";
import { sanitizeQuery } from "./fts-query.js";

export interface IndexResult {
  source: string;
  chunkCount: number;
  codeChunkCount: number;
  ids: number[];
}

export interface ContentHit {
  id: number;
  source: string;
  path?: string;
  heading?: string;
  chunk: string;
  isCode: boolean;
  rank: number;
  matchLayer: "porter" | "trigram";
}

interface ContentRow {
  id: number;
  source: string;
  path: string | null;
  heading: string | null;
  chunk: string;
  is_code: number;
  rank: number;
}

export class ContentStore {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  indexContent(opts: { content?: string; path?: string; source?: string }): IndexResult {
    const hasContent = typeof opts.content === "string" && opts.content.length > 0;
    if (!hasContent && !opts.path) {
      throw new Error("Either content or path must be provided");
    }

    let text: string;
    if (hasContent) {
      text = opts.content!;
    } else {
      // TOCTOU-safe read: open first, verify it's a regular file via the
      // open fd's stat, then read from that same fd.
      const fd = openSync(opts.path!, "r");
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new Error(`not a regular file: ${opts.path}`);
        text = readFileSync(fd, "utf-8");
      } finally {
        closeSync(fd);
      }
    }

    const source = opts.source ?? opts.path ?? "untitled";
    const hash = createHash("sha256").update(text).digest("hex");
    const chunks = chunkMarkdown(text);

    return this.#db.transaction(() => {
      this.deleteBySource(source); // replace prior chunks for this source
      const ids: number[] = [];
      let codeChunkCount = 0;
      const now = Date.now();
      const insC = this.#db.prepare(
        "INSERT INTO content (source, path, hash, heading, chunk, is_code, created_at) VALUES (?,?,?,?,?,?,?)",
      );
      const insF = this.#db.prepare(
        "INSERT INTO content_fts (rowid, source, heading, chunk) VALUES (?,?,?,?)",
      );
      for (const c of chunks) {
        const isCode = detectContentType(c) === "code" ? 1 : 0;
        if (isCode) codeChunkCount++;
        const info = insC.run(source, opts.path ?? null, hash, c.title, c.content, isCode, now);
        const id = Number(info.lastInsertRowid);
        ids.push(id);
        insF.run(id, source, c.title, c.content);
      }
      return { source, chunkCount: chunks.length, codeChunkCount, ids };
    })();
  }

  ftsSearch(query: string, limit: number, opts?: { source?: string; isCode?: boolean }): ContentHit[] {
    const porterHits = this.#ftsSearchPorter(query, limit, opts);
    if (porterHits.length > 0) return porterHits;
    return this.#ftsSearchTrigram(query, limit, opts);
  }

  #ftsSearchPorter(query: string, limit: number, opts?: { source?: string; isCode?: boolean }): ContentHit[] {
    const q = sanitizeQuery(query, "OR");
    let sql =
      "SELECT content.id, content.source, content.path, content.heading, content.chunk, content.is_code, bm25(content_fts) AS rank " +
      "FROM content_fts JOIN content ON content.id = content_fts.rowid " +
      "WHERE content_fts MATCH ?";
    const params: unknown[] = [q];
    if (opts?.source) {
      sql += " AND content.source LIKE ?";
      params.push(opts.source);
    }
    if (opts?.isCode !== undefined) {
      sql += " AND content.is_code = ?";
      params.push(opts.isCode ? 1 : 0);
    }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    let rows: ContentRow[];
    try {
      rows = this.#db.prepare(sql).all(...params) as ContentRow[];
    } catch {
      // A malformed FTS query must not throw — fall back to no porter hits.
      return [];
    }
    return rows.map((r) => this.#toHit(r, "porter"));
  }

  #ftsSearchTrigram(query: string, limit: number, opts?: { source?: string; isCode?: boolean }): ContentHit[] {
    const terms = query
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3);
    if (terms.length === 0) return [];

    let sql = "SELECT id, source, path, heading, chunk, is_code, 0 AS rank FROM content WHERE (";
    sql += terms.map(() => "chunk LIKE ?").join(" OR ");
    sql += ")";
    const params: unknown[] = terms.map((t) => `%${t}%`);
    if (opts?.source) {
      sql += " AND source LIKE ?";
      params.push(opts.source);
    }
    if (opts?.isCode !== undefined) {
      sql += " AND is_code = ?";
      params.push(opts.isCode ? 1 : 0);
    }
    sql += " LIMIT ?";
    params.push(limit);

    const rows = this.#db.prepare(sql).all(...params) as ContentRow[];
    return rows.map((r) => this.#toHit(r, "trigram"));
  }

  #toHit(r: ContentRow, matchLayer: "porter" | "trigram"): ContentHit {
    return {
      id: r.id,
      source: r.source,
      path: r.path ?? undefined,
      heading: r.heading ?? undefined,
      chunk: r.chunk,
      isCode: r.is_code === 1,
      rank: r.rank,
      matchLayer,
    };
  }

  deleteBySource(source: string): number {
    const rows = this.#db.prepare("SELECT id FROM content WHERE source = ?").all(source) as { id: number }[];
    for (const r of rows) {
      this.#db.prepare("DELETE FROM content_fts WHERE rowid = ?").run(r.id);
    }
    const info = this.#db.prepare("DELETE FROM content WHERE source = ?").run(source);
    return Number(info.changes);
  }

  listStaleSources(): Array<{ source: string; path: string; hash: string }> {
    return this.#db
      .prepare("SELECT DISTINCT source, path, hash FROM content WHERE path IS NOT NULL")
      .all() as Array<{ source: string; path: string; hash: string }>;
  }
}
