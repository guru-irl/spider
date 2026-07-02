import type { Db } from "@spider/db-core";
import { randomUUID } from "node:crypto";
import type { MemoryCategory, MemoryScope, MemoryStatus, MemoryRecord, AddMemoryInput } from "./types.js";
import { assertWithinCap, DEFAULT_MEMORY_CHAR_CAP } from "./overflow.js";

function mapRow(row: {
  id: number;
  uuid: string;
  category: string;
  content: string;
  link: string | null;
  status: string;
  source: string;
  confidence: number | null;
  session_id: string | null;
  created_at: number;
  updated_at: number | null;
}): MemoryRecord {
  return {
    id: row.id,
    uuid: row.uuid,
    category: row.category as MemoryCategory,
    content: row.content,
    link: row.link,
    status: row.status as MemoryStatus,
    source: row.source as any,
    confidence: row.confidence,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapGlobalRow(row: {
  id: number;
  uuid: string;
  category: string;
  content: string;
  link: string | null;
  scope: string;
  status: string;
  source: string;
  confidence: number | null;
  created_at: number;
  updated_at: number | null;
}): MemoryRecord {
  return {
    id: row.id,
    uuid: row.uuid,
    category: row.category as MemoryCategory,
    content: row.content,
    link: row.link,
    status: row.status as MemoryStatus,
    source: row.source as any,
    confidence: row.confidence,
    sessionId: null, // global_memory has no session_id
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function addMemory(db: Db, scope: MemoryScope, input: AddMemoryInput, cap: number = DEFAULT_MEMORY_CHAR_CAP): MemoryRecord {
  const uuid = randomUUID();
  const createdAt = Date.now();
  const status = input.status ?? "active";
  const source = input.source ?? "user";
  const link = input.link ?? null;
  const confidence = input.confidence ?? null;
  const sessionId = input.sessionId ?? null;

  // Guard against overflow for active writes
  if (status === "active") {
    assertWithinCap(db, scope, input.content.length, cap);
  }

  if (scope === "project") {
    const insertRecord = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO memory (uuid, category, content, link, status, source, confidence, session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuid, input.category, input.content, link, status, source, confidence, sessionId, createdAt, null);

      // Only mirror to FTS if status is active
      if (status === "active") {
        db.prepare(`
          INSERT INTO memory_fts (uuid, category, content, link)
          VALUES (?, ?, ?, ?)
        `).run(uuid, input.category, input.content, link);
      }

      return {
        id: Number(result.lastInsertRowid),
        uuid,
        category: input.category,
        content: input.content,
        link,
        status,
        source,
        confidence,
        sessionId,
        createdAt,
        updatedAt: null,
      };
    })();

    return insertRecord;
  } else {
    // Global scope: no session_id, no FTS, must set scope='global'
    const result = db.prepare(`
      INSERT INTO global_memory (uuid, category, content, link, scope, status, source, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuid, input.category, input.content, link, "global", status, source, confidence, createdAt, null);

    return {
      id: Number(result.lastInsertRowid),
      uuid,
      category: input.category,
      content: input.content,
      link,
      status,
      source,
      confidence,
      sessionId: null,
      createdAt,
      updatedAt: null,
    };
  }
}

export function getMemory(db: Db, scope: MemoryScope, uuid: string): MemoryRecord | null {
  if (scope === "project") {
    const row = db.prepare(`
      SELECT id, uuid, category, content, link, status, source, confidence, session_id, created_at, updated_at
      FROM memory
      WHERE uuid = ?
    `).get(uuid) as any;

    return row ? mapRow(row) : null;
  } else {
    const row = db.prepare(`
      SELECT id, uuid, category, content, link, scope, status, source, confidence, created_at, updated_at
      FROM global_memory
      WHERE uuid = ?
    `).get(uuid) as any;

    return row ? mapGlobalRow(row) : null;
  }
}

export function listActive(
  db: Db,
  scope: MemoryScope,
  opts?: { category?: MemoryCategory; limit?: number }
): MemoryRecord[] {
  const category = opts?.category;
  const limit = opts?.limit;

  if (scope === "project") {
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
    return rows.map(mapRow);
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
    return rows.map(mapGlobalRow);
  }
}

export function searchMemoryFts(
  db: Db,
  scope: MemoryScope,
  query: string,
  opts?: { category?: MemoryCategory; limit?: number }
): MemoryRecord[] {
  const category = opts?.category;
  const limit = opts?.limit ?? 10;

  if (scope === "project") {
    // Use FTS for project scope
    let sql = `
      SELECT m.id, m.uuid, m.category, m.content, m.link, m.status, m.source, m.confidence, m.session_id, m.created_at, m.updated_at
      FROM memory m
      WHERE m.uuid IN (
        SELECT uuid FROM memory_fts WHERE memory_fts MATCH ?
      )
      AND m.status = 'active'
    `;
    const params: any[] = [query];

    if (category) {
      sql += ` AND m.category = ?`;
      params.push(category);
    }

    sql += ` ORDER BY m.created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map(mapRow);
  } else {
    // Global scope: fallback to LIKE (no FTS table)
    let sql = `
      SELECT id, uuid, category, content, link, scope, status, source, confidence, created_at, updated_at
      FROM global_memory
      WHERE status = 'active'
      AND content LIKE ?
    `;
    const params: any[] = [`%${query}%`];

    if (category) {
      sql += ` AND category = ?`;
      params.push(category);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map(mapGlobalRow);
  }
}

export function setStatus(db: Db, scope: MemoryScope, uuid: string, status: MemoryStatus): void {
  const updatedAt = Date.now();

  if (scope === "project") {
    db.transaction(() => {
      // Get current status to determine FTS sync action
      const current = db.prepare(`SELECT status FROM memory WHERE uuid = ?`).get(uuid) as { status: string } | undefined;
      
      if (!current) return;

      const wasActive = current.status === "active";
      const isActive = status === "active";

      // Update status
      db.prepare(`
        UPDATE memory
        SET status = ?, updated_at = ?
        WHERE uuid = ?
      `).run(status, updatedAt, uuid);

      // Sync FTS
      if (wasActive && !isActive) {
        // Leaving active: remove from FTS
        db.prepare(`DELETE FROM memory_fts WHERE uuid = ?`).run(uuid);
      } else if (!wasActive && isActive) {
        // Entering active: add to FTS
        const rec = db.prepare(`
          SELECT uuid, category, content, link
          FROM memory
          WHERE uuid = ?
        `).get(uuid) as any;
        
        if (rec) {
          db.prepare(`
            INSERT INTO memory_fts (uuid, category, content, link)
            VALUES (?, ?, ?, ?)
          `).run(rec.uuid, rec.category, rec.content, rec.link);
        }
      }
    })();
  } else {
    // Global scope: no FTS to sync
    db.prepare(`
      UPDATE global_memory
      SET status = ?, updated_at = ?
      WHERE uuid = ?
    `).run(status, updatedAt, uuid);
  }
}

export function removeMemory(db: Db, scope: MemoryScope, uuid: string): void {
  // Never hard-delete: archive and remove from FTS
  const updatedAt = Date.now();

  if (scope === "project") {
    db.transaction(() => {
      db.prepare(`
        UPDATE memory
        SET status = 'archived', updated_at = ?
        WHERE uuid = ?
      `).run(updatedAt, uuid);

      // Remove from FTS
      db.prepare(`DELETE FROM memory_fts WHERE uuid = ?`).run(uuid);
    })();
  } else {
    db.prepare(`
      UPDATE global_memory
      SET status = 'archived', updated_at = ?
      WHERE uuid = ?
    `).run(updatedAt, uuid);
  }
}

export function activeCharTotal(db: Db, scope: MemoryScope): number {
  if (scope === "project") {
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

export function isDuplicate(db: Db, scope: MemoryScope, category: MemoryCategory, content: string): boolean {
  if (scope === "project") {
    const result = db.prepare(`
      SELECT COUNT(*) as count
      FROM memory
      WHERE category = ? AND content = ?
    `).get(category, content) as { count: number };

    return result.count > 0;
  } else {
    const result = db.prepare(`
      SELECT COUNT(*) as count
      FROM global_memory
      WHERE category = ? AND content = ?
    `).get(category, content) as { count: number };

    return result.count > 0;
  }
}
