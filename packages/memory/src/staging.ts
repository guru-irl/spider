import type { Db } from "@spider/db-core";
import type { MemoryScope, MemoryRecord, AddMemoryInput } from "./types";
import { firstThreatMessage } from "./scanner";
import { assertWithinCap, DEFAULT_MEMORY_CHAR_CAP } from "./overflow";
import { addMemory, setStatus, isDuplicate, getMemory, removeMemory } from "./store";
import { tableFor, mapRow } from "./internal";
import { shouldCapture } from "./guardrails";

export interface StageResult {
  status: "staged" | "active" | "rejected";
  uuid?: string;
  reason?: string;
}

/**
 * `control memory consolidate` used to return `{ entries: listActive(...), usage:
 * activeCharTotal(...) }` -- a read-only report wearing an action's name: nothing was ever
 * merged, pruned, or rewritten. Free-text memory notes can't be merged deterministically
 * without an LLM (and an LLM-summarisation path is deliberately out of scope -- it would not
 * be testable or predictable), so the honest fix is a rename, not a fake merge: the report
 * lives on as `control memory status`, and the *old* name now fails loudly instead of
 * silently misleading a caller who expects it to free space. Shared by both control-memory
 * call sites (packages/host/src/extension.ts and this package's own actions.ts) so the
 * message can't drift between them.
 */
export const MEMORY_CONSOLIDATE_RENAMED_MESSAGE: string =
  "control memory consolidate was a read-only report (active entries + char usage), not an " +
  "action -- nothing was ever merged, pruned, or rewritten. It has been renamed to control " +
  "memory status. To actually free space, list active uuids with control memory status, " +
  "then remove one with control memory forget <uuid>.";

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
  // "project" is a deprecated alias for "worktree"
  const actualScope = scope === "project" ? "worktree" : scope;
  
  if (actualScope === "repo" || actualScope === "worktree") {
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

/**
 * Deactivate a single memory entry by uuid -- the supported eviction path once a scope's
 * active-char cap is full (previously the only escape was raw SQL against the DB file).
 * Returns the post-removal record (status: 'archived') so a caller can confirm what was
 * removed, or null if no entry with that uuid exists IN THIS SCOPE'S table. Never hard-
 * deletes: delegates to removeMemory (store.ts), which archives the row and strips it from
 * the FTS mirror, matching rejectPending's "never actually delete" contract. Scope safety is
 * structural, not a check performed here: `db` is already the one DB the caller resolved for
 * a single scope (global/repo/worktree each live in a different file/table pairing), so a
 * uuid belonging to a different scope simply is not found -- forgetMemory cannot reach across
 * scopes to delete something even by accident.
 */
export function forgetMemory(db: Db, scope: MemoryScope, uuid: string): MemoryRecord | null {
  const existing = getMemory(db, scope, uuid);
  if (!existing) return null;
  removeMemory(db, scope, uuid);
  return getMemory(db, scope, uuid);
}
