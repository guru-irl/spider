import type { Db } from "@spider/db-core";
import type { MemoryScope, MemoryRecord, AddMemoryInput } from "./types.js";
import { firstThreatMessage } from "./scanner.js";
import { assertWithinCap, DEFAULT_MEMORY_CHAR_CAP } from "./overflow.js";
import { addMemory, setStatus, isDuplicate, getMemory } from "./store.js";
import { tableFor, mapRow } from "./internal.js";
import { shouldCapture } from "./guardrails.js";

export interface StageResult {
  status: "staged" | "active" | "rejected";
  uuid?: string;
  reason?: string;
}

/**
 * Fail-closed write-approval pipeline. Order matters:
 *   1. Scan (strict) — reject before any insert.
 *   2. Guardrail (anti-poisoning) — reject background (auto/import) writes that
 *      fail shouldCapture; USER writes bypass the guardrail entirely.
 *   3. Duplicate check — reject without inserting a new row.
 *   4. Decide staged vs active. source auto/import (or autoStage) always staged.
 * Cap enforcement on active inserts propagates (never swallowed).
 */
export function stageWrite(
  db: Db,
  scope: MemoryScope,
  input: AddMemoryInput,
  opts?: { autoStage?: boolean; cap?: number }
): StageResult {
  // 1. SCAN FIRST — no row inserted on threat.
  const threat = firstThreatMessage(input.content, "strict");
  if (threat) {
    return { status: "rejected", reason: threat };
  }

  // 2. GUARDRAIL (anti-poisoning) — background writes only. User writes bypass.
  if (input.source === "auto" || input.source === "import") {
    const v = shouldCapture(input.category, input.content);
    if (!v.capture) {
      return { status: "rejected", reason: v.reason };
    }
  }

  // 3. DUPLICATE — no new row.
  if (isDuplicate(db, scope, input.category, input.content)) {
    return { status: "rejected", reason: "duplicate" };
  }

  // 4. DECIDE STAGED vs ACTIVE.
  const cap = opts?.cap ?? DEFAULT_MEMORY_CHAR_CAP;
  const forceStage = input.source === "auto" || input.source === "import" || opts?.autoStage === true;

  if (forceStage) {
    // Staged insert bypasses the cap by Task 4 design.
    const rec = addMemory(db, scope, { ...input, status: "staged" }, cap);
    return { status: "staged", uuid: rec.uuid };
  }

  // Active insert runs the cap check; MemoryOverflowError propagates (fail-closed).
  const rec = addMemory(db, scope, { ...input, status: "active" }, cap);
  return { status: "active", uuid: rec.uuid };
}

export function listPending(db: Db, scope: MemoryScope): MemoryRecord[] {
  const table = tableFor(scope);
  if (scope === "project") {
    const rows = db.prepare(`
      SELECT id, uuid, category, content, link, status, source, confidence, session_id, created_at, updated_at
      FROM ${table}
      WHERE status = 'staged'
      ORDER BY created_at DESC
    `).all() as any[];
    return rows.map((row) => mapRow(scope, row));
  } else {
    const rows = db.prepare(`
      SELECT id, uuid, category, content, link, status, source, confidence, created_at, updated_at
      FROM ${table}
      WHERE status = 'staged'
      ORDER BY created_at DESC
    `).all() as any[];
    return rows.map((row) => mapRow(scope, row));
  }
}

export function approvePending(db: Db, scope: MemoryScope, uuid: string): MemoryRecord | null {
  const rec = getMemory(db, scope, uuid);
  if (!rec || rec.status !== "staged") {
    return null;
  }
  // Re-run cap check; MemoryOverflowError propagates ("curate then retry").
  assertWithinCap(db, scope, rec.content.length, DEFAULT_MEMORY_CHAR_CAP);
  setStatus(db, scope, uuid, "active");
  return getMemory(db, scope, uuid);
}

export function rejectPending(db: Db, scope: MemoryScope, uuid: string): void {
  setStatus(db, scope, uuid, "rejected");
}
