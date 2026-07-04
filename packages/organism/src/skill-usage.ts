import type { Db } from "@spider/db-core";

/** Lifecycle state — ported from `hermes-agent/tools/skill_usage.py` states. */
export type SkillState = "active" | "stale" | "archived";
/** Curation status — staged auto-candidates vs. approved/rejected. */
export type SkillStatus = "active" | "staged" | "rejected";

/** A row of the `skills` table, mapped to camelCase with real booleans. */
export interface SkillRow {
  id: number;
  name: string;
  tier: "baseline" | "project";
  category?: string;
  path?: string;
  state: SkillState;
  status: SkillStatus;
  source: string;
  pinned: boolean;
  protected: boolean;
  useCount: number;
  viewCount: number;
  patchCount: number;
  lastUsedAt?: number;
  lastViewedAt?: number;
  lastPatchedAt?: number;
  candidateBody?: string;
  related?: string[];
  createdAt: number;
  updatedAt?: number;
}

/** Raw snake_case shape as stored in SQLite (int booleans, nullable columns). */
interface RawSkillRow {
  id: number;
  name: string;
  tier: string;
  category: string | null;
  path: string | null;
  state: string;
  status: string;
  source: string;
  pinned: number;
  protected: number;
  use_count: number;
  view_count: number;
  patch_count: number;
  last_used_at: number | null;
  last_viewed_at: number | null;
  last_patched_at: number | null;
  candidate_body: string | null;
  related: string | null;
  created_at: number;
  updated_at: number | null;
}

function opt<T>(v: T | null): T | undefined {
  return v === null ? undefined : v;
}

function parseRelated(raw: string | null): string[] | undefined {
  if (raw === null || raw === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((r): r is string => typeof r === "string");
  } catch {
    /* corrupt JSON → undefined */
  }
  return undefined;
}

function mapRow(r: RawSkillRow): SkillRow {
  const row: SkillRow = {
    id: r.id,
    name: r.name,
    tier: r.tier === "baseline" ? "baseline" : "project",
    state: r.state as SkillState,
    status: r.status as SkillStatus,
    source: r.source,
    pinned: !!r.pinned,
    protected: !!r.protected,
    useCount: r.use_count,
    viewCount: r.view_count,
    patchCount: r.patch_count,
    createdAt: r.created_at,
  };
  const category = opt(r.category);
  if (category !== undefined) row.category = category;
  const path = opt(r.path);
  if (path !== undefined) row.path = path;
  const lastUsedAt = opt(r.last_used_at);
  if (lastUsedAt !== undefined) row.lastUsedAt = lastUsedAt;
  const lastViewedAt = opt(r.last_viewed_at);
  if (lastViewedAt !== undefined) row.lastViewedAt = lastViewedAt;
  const lastPatchedAt = opt(r.last_patched_at);
  if (lastPatchedAt !== undefined) row.lastPatchedAt = lastPatchedAt;
  const candidateBody = opt(r.candidate_body);
  if (candidateBody !== undefined) row.candidateBody = candidateBody;
  const related = parseRelated(r.related);
  if (related !== undefined) row.related = related;
  const updatedAt = opt(r.updated_at);
  if (updatedAt !== undefined) row.updatedAt = updatedAt;
  return row;
}

const SELECT_ALL =
  "SELECT id, name, tier, category, path, state, status, source, pinned, protected, " +
  "use_count, view_count, patch_count, last_used_at, last_viewed_at, last_patched_at, " +
  "candidate_body, related, created_at, updated_at FROM skills";

/**
 * Skill lifecycle usage + staged candidates over the `skills` table.
 *
 * Ports the state/usage semantics of `hermes-agent/tools/skill_usage.py`:
 * `active`/`stale`/`archived` lifecycle states, use/view/patch counters with
 * `last_*_at` timestamps, and `pinned`/`protected` opt-out flags. Adds the
 * staged-candidate flow used by the curator: `stageCandidate` writes a
 * `status='staged'`, `source='auto'` row carrying a `candidate_body`, which is
 * later `approveCandidate`-d (→ active, body cleared) or `rejectCandidate`-ed.
 */
export class SkillStore {
  constructor(private readonly db: Db) {}

  upsert(s: {
    name: string;
    tier?: "baseline" | "project";
    category?: string;
    path?: string;
    source?: string;
    protected?: boolean;
  }): SkillRow {
    const now = Date.now();
    const existing = this.get(s.name);
    if (existing === undefined) {
      this.db
        .prepare(
          "INSERT INTO skills (name, tier, category, path, source, protected, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          s.name,
          s.tier ?? "project",
          s.category ?? null,
          s.path ?? null,
          s.source ?? "user",
          s.protected === true ? 1 : 0,
          now
        );
    } else {
      this.db
        .prepare(
          "UPDATE skills SET tier = ?, category = ?, path = ?, source = ?, protected = ?, updated_at = ? " +
            "WHERE name = ?"
        )
        .run(
          s.tier ?? existing.tier,
          s.category ?? existing.category ?? null,
          s.path ?? existing.path ?? null,
          s.source ?? existing.source,
          s.protected === undefined ? (existing.protected ? 1 : 0) : s.protected ? 1 : 0,
          now,
          s.name
        );
    }
    return this.get(s.name)!;
  }

  get(name: string): SkillRow | undefined {
    const r = this.db.prepare(`${SELECT_ALL} WHERE name = ?`).get(name) as RawSkillRow | undefined;
    return r === undefined ? undefined : mapRow(r);
  }

  list(opts?: { state?: SkillState; status?: SkillStatus }): SkillRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts?.state !== undefined) {
      where.push("state = ?");
      args.push(opts.state);
    }
    if (opts?.status !== undefined) {
      where.push("status = ?");
      args.push(opts.status);
    }
    const sql = `${SELECT_ALL}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY name`;
    const rows = this.db.prepare(sql).all(...args) as RawSkillRow[];
    return rows.map(mapRow);
  }

  touch(name: string, kind: "use" | "view" | "patch"): void {
    const now = Date.now();
    const col =
      kind === "use" ? "use_count" : kind === "view" ? "view_count" : "patch_count";
    const tsCol =
      kind === "use" ? "last_used_at" : kind === "view" ? "last_viewed_at" : "last_patched_at";
    this.db
      .prepare(`UPDATE skills SET ${col} = ${col} + 1, ${tsCol} = ?, updated_at = ? WHERE name = ?`)
      .run(now, now, name);
  }

  setState(name: string, state: SkillState): void {
    this.db
      .prepare("UPDATE skills SET state = ?, updated_at = ? WHERE name = ?")
      .run(state, Date.now(), name);
  }

  setPinned(name: string, pinned: boolean): void {
    this.db
      .prepare("UPDATE skills SET pinned = ?, updated_at = ? WHERE name = ?")
      .run(pinned ? 1 : 0, Date.now(), name);
  }

  stageCandidate(c: { name: string; category?: string; body: string; related?: string[] }): SkillRow {
    const now = Date.now();
    const related = c.related !== undefined ? JSON.stringify(c.related) : null;
    const existing = this.get(c.name);
    if (existing === undefined) {
      this.db
        .prepare(
          "INSERT INTO skills (name, category, status, source, candidate_body, related, created_at) " +
            "VALUES (?, ?, 'staged', 'auto', ?, ?, ?)"
        )
        .run(c.name, c.category ?? null, c.body, related, now);
    } else {
      this.db
        .prepare(
          "UPDATE skills SET category = ?, status = 'staged', source = 'auto', " +
            "candidate_body = ?, related = ?, updated_at = ? WHERE name = ?"
        )
        .run(c.category ?? existing.category ?? null, c.body, related, now, c.name);
    }
    return this.get(c.name)!;
  }

  approveCandidate(name: string): SkillRow | null {
    const existing = this.get(name);
    if (existing === undefined) return null;
    this.db
      .prepare(
        "UPDATE skills SET status = 'active', candidate_body = NULL, updated_at = ? WHERE name = ?"
      )
      .run(Date.now(), name);
    return this.get(name)!;
  }

  rejectCandidate(name: string): void {
    this.db
      .prepare("UPDATE skills SET status = 'rejected', updated_at = ? WHERE name = ?")
      .run(Date.now(), name);
  }
}
