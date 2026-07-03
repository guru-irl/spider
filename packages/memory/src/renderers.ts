import { Panel, type Component } from "@spider/ui";
import type { MemoryRecord } from "./types";
import type { StageResult } from "./staging";

const GLYPH = "🕸";

export function renderRememberResult(
  r: StageResult & { content?: string; category?: string; scope?: string; source?: string },
): Component {
  const body: string[] = [];
  if (r.content) {
    const preview = r.content.trim().replace(/\s+/g, " ");
    body.push(preview.length > 160 ? preview.slice(0, 159) + "…" : preview);
  }
  const meta: string[] = [`status: ${r.status}`];
  if (r.category) meta.push(`category: ${r.category}`);
  if (r.scope) meta.push(`scope: ${r.scope}`);
  if (r.reason) meta.push(`reason: ${r.reason}`);
  body.push(meta.join("  ·  "));
  // No Panel title — the tool call already renders "🕸 spider · remember"; a second
  // glyph+rule header here was redundant noise.
  return Panel({ body });
}

export function renderRecallResult(recs: MemoryRecord[]): Component {
  const body = recs.length
    ? recs.map((r) => `[${r.category}] ${r.content}${r.link ? ` (${r.link})` : ""}`)
    : ["(no matches)"];
  if (recs.length) body.push(`${recs.length} match${recs.length === 1 ? "" : "es"}`);
  // No Panel title — the tool call already renders "🕸 spider · recall"; a second glyph header
  // here duplicated it (matches the remember treatment).
  return Panel({ body });
}

export function renderPending(recs: MemoryRecord[]): Component {
  const body = recs.length
    ? recs.map((r) => `[${r.category}] ${r.content} — ${r.uuid}`)
    : ["(nothing pending)"];
  return Panel({ title: `${GLYPH} pending (${recs.length})`, body });
}
