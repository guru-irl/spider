import type { GraphNode, LearningGraph } from "./learning-graph.js";
import type { SkillRow } from "./skill-usage.js";
import type { DecayResult } from "./curator.js";

/** One-line skill summary for the `skill list` panel. */
function skillLine(s: SkillRow): string {
  const flags: string[] = [s.state, s.status];
  if (s.pinned) flags.push("pinned");
  if (s.protected) flags.push("protected");
  return `- ${s.name} (${flags.join(", ")}, use=${s.useCount})`;
}

/** Render the `skill list` result. */
export function renderSkillList(rows: SkillRow[]): string {
  if (rows.length === 0) return "No skills.";
  return ["## skills 🕸", ...rows.map(skillLine)].join("\n");
}

/** Render a single `skill view` result. */
export function renderSkillView(row: SkillRow | undefined): string {
  if (row === undefined) return "Skill not found.";
  const body = row.candidateBody ?? "";
  const pathLine = row.path !== undefined ? [`path: ${row.path}`] : [];
  return [`## ${row.name}`, skillLine(row), ...pathLine, "", body].join("\n").trimEnd();
}

/** Render a `/learn` distill prompt handoff. */
export function renderDistill(prompt: string): string {
  return prompt;
}

/** Render the `control skill curate` decay result. */
export function renderCurateResult(r: DecayResult & { consolidated?: boolean; consolidateRequested?: boolean }): string {
  const lines = [
    "## curator 🧹",
    `- stale: ${r.toStale.length}`,
    `- archived: ${r.toArchived.length}`,
    `- skipped (pinned/protected): ${r.skipped.length}`,
  ];
  if (r.consolidateRequested) {
    lines.push(r.consolidated ? "- consolidation: ran" : "- consolidation: requested but did not run");
  } else if (r.consolidated) {
    // Defensive: never hide an actual consolidation even if it wasn't (recorded as) requested.
    lines.push("- consolidation: ran");
  }
  return lines.join("\n");
}

/** Compact one-line label for an insights node. */
function nodeLine(n: GraphNode): string {
  return `- [${n.kind}] ${n.label}`;
}

/** Render the `control insights` learning graph. */
export function renderInsights(g: LearningGraph): string {
  const head = `## insights 🕸 — ${g.stats.nodes} nodes · ${g.stats.edges} edges · ${Math.round(g.stats.linkedPct)}% linked`;
  const preview = g.nodes.slice(0, 20).map(nodeLine);
  return [head, ...preview].join("\n");
}
