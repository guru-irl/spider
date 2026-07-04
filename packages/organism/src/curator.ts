import { basename, join } from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import type { Db } from "@spider/db-core";
import { paths } from "@spider/db-core";
import type { SkillStore } from "./skill-usage.js";
import type { DigestModel } from "./types.js";

/**
 * Skill curator — deterministic decay walk + min-interval gate, plus an
 * opt-in aux-model consolidation pass. Ports `hermes-agent/agent/curator.py`
 * (`apply_automatic_transitions`, `_usage_timestamp`, `_CONSOLIDATION_PROMPT`)
 * onto the spider `skills` + `curator_state` tables.
 *
 * Rules that never change: pinned or protected skills are NEVER transitioned;
 * nothing is ever deleted — the maximum destructive action is archiving (moving
 * the skill directory into `.spider/skills/.archive/`, which is recoverable).
 */
export interface CuratorConfig {
  staleAfterDays: number;
  archiveAfterDays: number;
  minIntervalHours: number;
  consolidate: boolean;
}

/**
 * Spider defaults. Note `minIntervalHours` is 24 (not Hermes' 168); the
 * stale/archive windows match Hermes (`DEFAULT_STALE_AFTER_DAYS=30`,
 * `DEFAULT_ARCHIVE_AFTER_DAYS=90`).
 */
export const CURATOR_DEFAULTS: CuratorConfig = {
  staleAfterDays: 30,
  archiveAfterDays: 90,
  minIntervalHours: 24,
  consolidate: false,
};

export interface DecayResult {
  toStale: string[];
  toArchived: string[];
  skipped: string[];
}

const DAY_MS = 86_400_000;

interface CuratorRow {
  name: string;
  state: string;
  path: string | null;
  pinned: number;
  protected: number;
  use_count: number;
  last_used_at: number | null;
  last_viewed_at: number | null;
  last_patched_at: number | null;
  created_at: number;
}

/**
 * Idle anchor = latest real activity timestamp. Ports `_usage_timestamp`:
 * `max(last_used_at, last_viewed_at, last_patched_at, created_at)`, ignoring
 * nulls. A never-touched skill anchors on `created_at` so new skills don't
 * immediately age out.
 */
function idleAnchor(row: CuratorRow): number {
  let anchor = row.created_at;
  for (const ts of [row.last_used_at, row.last_viewed_at, row.last_patched_at]) {
    if (ts !== null && ts > anchor) anchor = ts;
  }
  return anchor;
}

/**
 * Return whether the curator's deterministic decay is allowed to run now.
 * False when paused, or when less than `minIntervalHours` has elapsed since the
 * last recorded run. True when no state row exists yet (never run).
 */
export function curatorShouldRun(db: Db, now: number, cfg: CuratorConfig): boolean {
  const row = db
    .prepare("SELECT last_run_at, paused FROM curator_state WHERE scope = 'project'")
    .get() as { last_run_at: number | null; paused: number } | undefined;
  if (row === undefined) return true;
  if (row.paused) return false;
  if (row.last_run_at !== null && now - row.last_run_at < cfg.minIntervalHours * 3600 * 1000) {
    return false;
  }
  return true;
}

/**
 * Walk every skill and apply the stale/archive cutoffs based on idle age.
 * Pinned/protected skills are skipped (recorded in `skipped`, never
 * transitioned). Archived skills that have a backing directory (`path`) have
 * their files moved to the recoverable `.archive/` location. Records
 * `curator_state.last_run_at = now` on completion. Never deletes anything.
 */
export function runCuratorDecay(
  db: Db,
  skills: SkillStore,
  now: number,
  cfg: CuratorConfig
): DecayResult {
  const rows = db
    .prepare(
      "SELECT name, state, path, pinned, protected, use_count, " +
        "last_used_at, last_viewed_at, last_patched_at, created_at FROM skills"
    )
    .all() as CuratorRow[];

  const result: DecayResult = { toStale: [], toArchived: [], skipped: [] };
  const staleCutoff = cfg.staleAfterDays * DAY_MS;
  const archiveCutoff = cfg.archiveAfterDays * DAY_MS;
  const cwd = process.cwd();

  for (const row of rows) {
    if (row.pinned || row.protected) {
      result.skipped.push(row.name);
      continue;
    }
    const idleAge = now - idleAnchor(row);

    // Grace floor: a never-used skill (use_count == 0) is not archived before
    // it is at least stale_after_days old — "use=0" is absence of evidence, not
    // evidence of staleness. Ports the curator's never-used guard.
    const neverUsed = row.use_count === 0;
    if (neverUsed && idleAge <= staleCutoff) continue;

    if (idleAge > archiveCutoff) {
      skills.setState(row.name, "archived");
      result.toArchived.push(row.name);
      if (row.path !== null) archiveSkillFiles(row.path, cwd);
    } else if (idleAge > staleCutoff) {
      skills.setState(row.name, "stale");
      result.toStale.push(row.name);
    }
  }

  db.prepare(
    "INSERT INTO curator_state (scope, last_run_at, paused) VALUES ('project', ?, 0) " +
      "ON CONFLICT(scope) DO UPDATE SET last_run_at = excluded.last_run_at"
  ).run(now);

  return result;
}

/**
 * Move a skill directory into the recoverable archive location
 * `<cwd>/.spider/skills/.archive/<basename>`. Never deletes. No-op when the
 * source path does not exist.
 */
export function archiveSkillFiles(skillPath: string, cwd: string): void {
  if (!existsSync(skillPath)) return;
  const archiveDir = join(paths.projectRoot(cwd), "skills", ".archive");
  mkdirSync(archiveDir, { recursive: true });
  renameSync(skillPath, join(archiveDir, basename(skillPath)));
}

/**
 * The consolidation prompt handed to the aux model. Ports
 * `curator.py::_CONSOLIDATION_PROMPT`, retargeting Hermes tool names to spider
 * skill verbs. Umbrella-building pass, not a duplicate-finder: prefer one broad
 * class-level skill with labeled subsections over many narrow siblings.
 */
const CONSOLIDATION_PROMPT =
  "You are running as spider's background skill CURATOR. This is an " +
  "UMBRELLA-BUILDING consolidation pass, not a passive audit and not a " +
  "duplicate-finder.\n\n" +
  "The goal of the skill collection is a LIBRARY OF CLASS-LEVEL INSTRUCTIONS " +
  "AND EXPERIENTIAL KNOWLEDGE. A collection of hundreds of narrow skills where " +
  "each one captures one session's specific bug is a FAILURE of the library — " +
  "not a feature. An agent searching skills matches on descriptions, not on " +
  "exact names; one broad umbrella skill with labeled subsections beats five " +
  "narrow siblings for discoverability.\n\n" +
  "Hard rules — do not violate:\n" +
  "1. DO NOT delete any skill. Archiving (moving the skill's directory into " +
  ".spider/skills/.archive/) is the maximum destructive action. Archives are " +
  "recoverable; deletion is not.\n" +
  "2. DO NOT touch skills shown as pinned=yes. Skip them entirely.\n" +
  "3. DO NOT archive, delete, consolidate, move, or otherwise modify any " +
  "protected skill. These back load-bearing UX and are filtered out of the " +
  "candidate list below.\n" +
  "4. DO NOT use usage counters as a reason to skip consolidation. Judge " +
  "overlap on CONTENT, not on use_count. 'use=0' is neither a reason to keep " +
  "nor a reason to prune.\n" +
  "5. DO NOT reject consolidation on the grounds that 'each skill has a " +
  "distinct trigger'. The right bar is: 'would a human maintainer write this " +
  "as N separate skills, or as one skill with N labeled subsections?' When the " +
  "answer is the latter, merge.\n\n" +
  "How to work:\n" +
  "1. Scan the full candidate list. Identify PREFIX CLUSTERS (skills sharing a " +
  "first word or domain keyword).\n" +
  "2. For each cluster with 2+ members, pick (or create) the UMBRELLA CLASS " +
  "and absorb the siblings into it.\n" +
  "3. Every absorbed sibling is archived (never deleted).\n\n" +
  "When done, emit a machine-readable JSON object EXACTLY of this shape (and " +
  "nothing else that would break JSON parsing):\n" +
  "{\n" +
  '  "consolidations": [ { "from": "<old-skill>", "into": "<umbrella>", "reason": "<why>" } ],\n' +
  '  "prunings": [ { "name": "<skill>", "reason": "<why archived with no merge target>" } ]\n' +
  "}\n" +
  "Every skill you archive MUST appear in exactly one of the two lists. Leave a " +
  "list empty ([]) if none.";

function readField(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  return (obj as Record<string, unknown>)[key];
}

function nonEmptyStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

/** Tolerant extraction of absorbed/pruned skill names from the model reply. */
function parseAbsorbed(raw: string): { from: string; consolidations: string[] } {
  const text = typeof raw === "string" ? raw : "";
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  const jsonText = fence ? fence[1] : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { from: "", consolidations: [] };
  }
  const absorbed: string[] = [];
  const consolidations: string[] = [];
  const rawCons = readField(parsed, "consolidations");
  if (Array.isArray(rawCons)) {
    for (const entry of rawCons) {
      const from = nonEmptyStr(readField(entry, "from"));
      if (from === undefined) continue;
      absorbed.push(from);
      const into = nonEmptyStr(readField(entry, "into"));
      consolidations.push(into !== undefined ? `${from} -> ${into}` : from);
    }
  }
  const rawPrun = readField(parsed, "prunings");
  if (Array.isArray(rawPrun)) {
    for (const entry of rawPrun) {
      const name = nonEmptyStr(readField(entry, "name"));
      if (name === undefined) continue;
      absorbed.push(name);
      consolidations.push(name);
    }
  }
  return { from: absorbed.join("\n"), consolidations };
}

/**
 * Opt-in aux-model consolidation pass (default off via `cfg.consolidate`). Only
 * agent-created (`source != 'user'`), non-pinned, non-protected skills are
 * candidates. Calls the model with the consolidation prompt, then marks each
 * absorbed/pruned skill `state='archived'` via `setState` (NEVER deletes),
 * re-checking pin/protected before absorbing. Returns the consolidation list.
 */
export async function consolidateSkills(
  skills: SkillStore,
  model: DigestModel,
  cfg: CuratorConfig
): Promise<{ consolidations: string[] }> {
  if (!cfg.consolidate) return { consolidations: [] };

  const candidates = skills
    .list()
    .filter((s) => s.source !== "user" && !s.pinned && !s.protected);
  if (candidates.length === 0) return { consolidations: [] };

  const catalog = candidates
    .map(
      (s) =>
        `- ${s.name} (state=${s.state}, use=${s.useCount}, pinned=${s.pinned ? "yes" : "no"})`
    )
    .join("\n");
  const prompt = `${CONSOLIDATION_PROMPT}\n\nCandidate skills:\n${catalog}`;

  const reply = await model.complete(prompt, []);
  const parsed = parseAbsorbed(reply);
  for (const name of parsed.from.split("\n").filter((n) => n.length > 0)) {
    const current = skills.get(name);
    if (current === undefined) continue;
    // Re-check pin/protected before any absorbing mutation.
    if (current.pinned || current.protected) continue;
    skills.setState(name, "archived");
  }

  return { consolidations: parsed.consolidations };
}
