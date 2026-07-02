import { Panel, type Component } from "@spider/ui";
import type { MemoryRecord } from "./types.js";
import type { StageResult } from "./staging.js";

const GLYPH = "🕸";

export function renderRememberResult(r: StageResult): Component {
  const body: string[] = [`status: ${r.status}`];
  if (r.uuid) body.push(`uuid: ${r.uuid}`);
  if (r.reason) body.push(`reason: ${r.reason}`);
  return Panel({ title: `${GLYPH} remember`, body });
}

export function renderRecallResult(recs: MemoryRecord[]): Component {
  const body = recs.length
    ? recs.map((r) => `[${r.category}] ${r.content}${r.link ? ` (${r.link})` : ""}`)
    : ["(no matches)"];
  return Panel({ title: `${GLYPH} recall (${recs.length})`, body });
}

export function renderPending(recs: MemoryRecord[]): Component {
  const body = recs.length
    ? recs.map((r) => `[${r.category}] ${r.content} — ${r.uuid}`)
    : ["(nothing pending)"];
  return Panel({ title: `${GLYPH} pending (${recs.length})`, body });
}
