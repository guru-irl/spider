import type { Db } from "@spider/db-core";
import type { MemoryCategory, MemoryScope, MemoryStatus, MemoryRecord } from "./types";

export function tableFor(scope: MemoryScope): "memory" | "global_memory" {
  // "project" is a deprecated alias for "worktree"; repo and worktree both use "memory"
  const actualScope = scope === "project" ? "worktree" : scope;
  return (actualScope === "repo" || actualScope === "worktree") ? "memory" : "global_memory";
}

export function mapRow(
  scope: MemoryScope,
  row: {
    id: number;
    uuid: string;
    category: string;
    content: string;
    link: string | null;
    status: string;
    source: string;
    confidence: number | null;
    session_id?: string | null;
    created_at: number;
    updated_at: number | null;
  }
): MemoryRecord {
  // "project" is a deprecated alias for "worktree"
  const actualScope = scope === "project" ? "worktree" : scope;
  return {
    id: row.id,
    uuid: row.uuid,
    category: row.category as MemoryCategory,
    content: row.content,
    link: row.link,
    status: row.status as MemoryStatus,
    source: row.source as any,
    confidence: row.confidence,
    sessionId: (actualScope === "repo" || actualScope === "worktree") ? (row.session_id ?? null) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function activeCharTotal(db: Db, scope: MemoryScope): number {
  // "project" is a deprecated alias for "worktree"
  const actualScope = scope === "project" ? "worktree" : scope;
  
  if (actualScope === "repo" || actualScope === "worktree") {
    const result = db.prepare(`
      SELECT COALESCE(SUM(LENGTH(content)), 0) as total
      FROM memory
      WHERE status = 'active'
    `).get() as { total: number };

    return result.total;
  } else {
    const result = db.prepare(`
      SELECT COALESCE(SUM(LENGTH(content)), 0) as total
      FROM global_memory
      WHERE status = 'active'
    `).get() as { total: number };

    return result.total;
  }
}

export function listActive(
  db: Db,
  scope: MemoryScope,
  opts?: { category?: MemoryCategory; limit?: number }
): MemoryRecord[] {
  const category = opts?.category;
  const limit = opts?.limit;

  // "project" is a deprecated alias for "worktree"; repo and worktree both use the "memory" table
  const actualScope = scope === "project" ? "worktree" : scope;

  if (actualScope === "repo" || actualScope === "worktree") {
    let sql = `
      SELECT id, uuid, category, content, link, status, source, confidence, session_id, created_at, updated_at
      FROM memory
      WHERE status = 'active'
    `;
    const params: any[] = [];

    if (category) {
      sql += ` AND category = ?`;
      params.push(category);
    }

    sql += ` ORDER BY created_at DESC`;

    if (limit) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map((row) => mapRow(scope, row));
  } else {
    let sql = `
      SELECT id, uuid, category, content, link, scope, status, source, confidence, created_at, updated_at
      FROM global_memory
      WHERE status = 'active'
    `;
    const params: any[] = [];

    if (category) {
      sql += ` AND category = ?`;
      params.push(category);
    }

    sql += ` ORDER BY created_at DESC`;

    if (limit) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map((row) => mapRow(scope, row));
  }
}
