export {
  diffUpstream,
  runUpstreamWatch,
  seedUpstreamRefs,
  markReviewed,
  DEFAULT_UPSTREAM_REFS,
  type GitRunner,
  type UpstreamCheck,
  type CherryCandidate,
  type PackageResult,
  type UpstreamWatchReport,
} from "./upstream-watch.js";

export { baselineSkillsDir, pstackSkillsDir, bundledSkillCollections, projectSkillsDir, contributeSkillPaths, type BundledSkillCollection } from "./skills-dir.js";
export { buildSpiderBlock, SPIDER_BLOCK_START, SPIDER_BLOCK_END, SPIDER_BLOCK_BODY } from "./agentsmd-content.js";
export { upsertManagedBlock, isLegacyFiveToolGuide, writeAgentsMd, defaultAgentsMdPath } from "./agentsmd.js";

import { writeAgentsMd, defaultAgentsMdPath } from "./agentsmd.js";
import { contributeSkillPaths } from "./skills-dir.js";

/** AGENTS.md is written at most once per process (idempotent + best-effort). */
let agentsMdWritten = false;

/** Prepare machine-level context before Pi loads AGENTS.md; this is not session work. */
export function prepareManagedGuidance(opts?: { agentsMdPath?: string; skipAgentsMd?: boolean }): void {
  if (opts?.skipAgentsMd === true || agentsMdWritten) return;
  try {
    writeAgentsMd(opts?.agentsMdPath ?? defaultAgentsMdPath());
    agentsMdWritten = true;
  } catch {
    // AGENTS.md write is best-effort; never break activation.
  }
}

/**
 * Wire `@spider/superpowers` onto a live host: write the spider-managed AGENTS.md
 * block once (unless `skipAgentsMd`), and return a `skillPaths(cwd)` provider the
 * host's `resources_discover` hook contributes (baseline + project tiers).
 *
 * `opts.agentsMdPath` (default `defaultAgentsMdPath()` = `~/.pi/agent/AGENTS.md`)
 * lets tests target a scratch file; `opts.skipAgentsMd` disables the write (the
 * host passes this under vitest so tests never touch the real file).
 */
export function registerSuperpowers(
  _host: { registerAction?: unknown },
  _pi: unknown,
  opts?: { agentsMdPath?: string; skipAgentsMd?: boolean },
): { skillPaths(cwd: string): string[] } {
  prepareManagedGuidance(opts);
  return { skillPaths: (cwd: string): string[] => contributeSkillPaths(cwd) };
}
