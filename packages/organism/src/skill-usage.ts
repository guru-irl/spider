import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
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

/** Max length parity with the Agent Skills spec's name limit (pi's loader enforces the same bound). */
const MAX_SKILL_NAME_LENGTH = 64;

/**
 * Validate a skill name against the Agent Skills naming rules (lowercase
 * a-z/0-9/hyphen only, 1-64 chars, no leading/trailing/consecutive hyphens).
 * This charset has no `/`, `.`, `\`, or NUL, so a name that passes here
 * cannot be used to escape `<projectRoot>/.spider/skills/<name>/` via path
 * traversal — the character whitelist IS the traversal guard. Returns an
 * empty array when valid.
 */
export function skillNameErrors(name: string): string[] {
  const errors: string[] = [];
  if (name.length === 0 || name.length > MAX_SKILL_NAME_LENGTH) {
    errors.push(`name must be 1-${MAX_SKILL_NAME_LENGTH} characters (got ${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push("name must contain only lowercase letters, digits, and hyphens");
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push("name must not start or end with a hyphen");
  }
  if (name.includes("--")) {
    errors.push("name must not contain consecutive hyphens");
  }
  return errors;
}

/**
 * Deterministic description policy for a candidate body with no frontmatter
 * of its own: use the first non-blank line (heading markers stripped),
 * trimmed to a safe length. This guarantees pi's loader (which refuses any
 * SKILL.md lacking a non-empty `description`) always has one, without ever
 * fabricating a claim about content that is not in the body.
 */
export function deriveSkillDescription(body: string, name: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const cleaned = (firstLine ?? "").replace(/^#+\s*/, "").trim();
  const base = cleaned.length > 0 ? cleaned : `Distilled project skill: ${name}.`;
  return base.length > 500 ? `${base.slice(0, 497)}...` : base;
}

/**
 * Compose a discoverable SKILL.md: always synthesizes our own frontmatter
 * (`name`, `description`) rather than trusting any frontmatter-shaped text
 * inside an auto-generated `body` — the aux-model prompt asks only for a
 * "SKILL.md body", never for frontmatter, so this is the only place that
 * produces it. `body` becomes the instructions section verbatim.
 */
export function buildSkillMarkdown(name: string, body: string, category?: string): string {
  const description = deriveSkillDescription(body, name);
  const lines = ["---", `name: ${name}`, `description: ${JSON.stringify(description)}`];
  if (category !== undefined && category.length > 0) {
    lines.push("metadata:", `  category: ${JSON.stringify(category)}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}${body.trimEnd()}\n`;
}

export interface ApproveOk { ok: true; row: SkillRow }
export interface ApproveErr { ok: false; error: string }
/** Result of {@link SkillStore.approveCandidate}: fail-closed, never partial. */
export type ApproveResult = ApproveOk | ApproveErr;

export type SkillStageSkipReason = "protected" | "pinned" | "active" | "user-owned" | "duplicate";
/** Result of {@link SkillStore.stageCandidate}: distinguishes a real new write from a no-op. */
export type StageCandidateResult =
  | { outcome: "staged"; row: SkillRow }
  | { outcome: "skipped"; reason: SkillStageSkipReason; row: SkillRow };

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
 * later `approveCandidate`-d (→ materializes `SKILL.md` on disk, row becomes
 * `active`, `path` recorded, `candidate_body` retained so `view` still shows
 * content) or `rejectCandidate`-ed (→ `rejected`, no file ever written).
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

  /**
   * Stage an auto-proposed candidate. Fail-closed against downgrading a
   * skill a human already owns: an existing `pinned`/`protected`/`active`
   * row, or one whose `source` is not `"auto"` (user-owned), is left
   * untouched and reported as `skipped` rather than silently staged over.
   * A byte-identical re-proposal of an already-staged candidate is also
   * `skipped` (`reason: "duplicate"`) so retries cannot inflate counters.
   */
  stageCandidate(c: { name: string; category?: string; body: string; related?: string[] }): StageCandidateResult {
    const existing = this.get(c.name);
    if (existing !== undefined) {
      if (existing.protected) return { outcome: "skipped", reason: "protected", row: existing };
      if (existing.pinned) return { outcome: "skipped", reason: "pinned", row: existing };
      if (existing.status === "active") return { outcome: "skipped", reason: "active", row: existing };
      if (existing.source !== "auto") return { outcome: "skipped", reason: "user-owned", row: existing };
      if (existing.status === "staged" && existing.candidateBody === c.body) {
        return { outcome: "skipped", reason: "duplicate", row: existing };
      }
    }
    const now = Date.now();
    const related = c.related !== undefined ? JSON.stringify(c.related) : null;
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
    return { outcome: "staged", row: this.get(c.name)! };
  }

  /**
   * Approve a staged candidate: validate the name, require staged content,
   * materialize `<projectRoot>/.spider/skills/<name>/SKILL.md` with a
   * no-clobber write, verify the write landed inside the project root (guards
   * a symlinked `.spider`/`skills` directory), and only then flip the DB row
   * to `active` and record its `path`. Never touches an existing `pinned`,
   * `protected`, or already-`active` row. On any failure the row is left
   * exactly as it was (still `staged`, `candidate_body` intact) and an
   * actionable error is returned — never a silent partial activation.
   */
  approveCandidate(name: string, projectRoot: string): ApproveResult {
    const nameErrors = skillNameErrors(name);
    if (nameErrors.length > 0) {
      return { ok: false, error: `invalid skill name "${name}": ${nameErrors.join("; ")}` };
    }
    const existing = this.get(name);
    if (existing === undefined) {
      return { ok: false, error: `no skill candidate named "${name}"` };
    }
    if (existing.protected) {
      return { ok: false, error: `skill "${name}" is protected and cannot be approved over` };
    }
    if (existing.pinned) {
      return { ok: false, error: `skill "${name}" is pinned and cannot be approved over` };
    }
    if (existing.status === "active") {
      return { ok: false, error: `skill "${name}" is already active` };
    }
    if (existing.status !== "staged") {
      return { ok: false, error: `skill "${name}" has no staged candidate (status: ${existing.status})` };
    }
    const body = existing.candidateBody;
    if (body === undefined || body.trim().length === 0) {
      return { ok: false, error: `skill "${name}" has no staged content to approve` };
    }

    const skillDir = join(projectRoot, ".spider", "skills", name);
    const skillFile = join(skillDir, "SKILL.md");
    let realProjectRoot: string;
    try {
      realProjectRoot = realpathSync(projectRoot);
    } catch (err) {
      return { ok: false, error: `failed to resolve project root: ${(err as Error).message}` };
    }
    const prefix = realProjectRoot.endsWith(sep) ? realProjectRoot : `${realProjectRoot}${sep}`;
    // Walk one path segment at a time rather than a single recursive mkdir:
    // if `.spider` or `.spider/skills` is already a symlink pointing outside
    // the project root, this catches it at that segment — BEFORE ever
    // creating anything on the far side of the symlink.
    let current = projectRoot;
    for (const segment of [".spider", "skills", name]) {
      current = join(current, segment);
      try {
        if (existsSync(current)) {
          const real = realpathSync(current);
          if (real !== realProjectRoot && !real.startsWith(prefix)) {
            return { ok: false, error: `refusing to write outside project root: ${real}` };
          }
        } else {
          mkdirSync(current);
        }
      } catch (err) {
        return { ok: false, error: `failed to prepare skill directory: ${(err as Error).message}` };
      }
    }

    const content = buildSkillMarkdown(name, body, existing.category);
    try {
      writeFileSync(skillFile, content, { flag: "wx" });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        return { ok: false, error: `skill file already exists, refusing to overwrite: ${skillFile}` };
      }
      return { ok: false, error: `failed to write skill file: ${(err as Error).message}` };
    }

    this.db
      .prepare("UPDATE skills SET status = 'active', state = 'active', path = ?, updated_at = ? WHERE name = ?")
      .run(skillFile, Date.now(), name);
    return { ok: true, row: this.get(name)! };
  }

  /** Reject a staged candidate: status flips to `rejected`, no file is ever written. */
  rejectCandidate(name: string): SkillRow | undefined {
    const existing = this.get(name);
    if (existing === undefined) return undefined;
    this.db
      .prepare("UPDATE skills SET status = 'rejected', updated_at = ? WHERE name = ?")
      .run(Date.now(), name);
    return this.get(name)!;
  }
}
