import { fitResultLines, icon, renderErrorResult, statusIcon, type Component, type ThemeAdapter } from "@spider/ui";
import type { MemoryRecord } from "./types";
import type { StageResult } from "./staging";

const plainTheme: ThemeAdapter = { fg: (_token, text) => text, bg: (_token, text) => text, bold: text => text, glyph: icon("text", "spider") };
const uuid = /\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/giu;

export function renderRememberResult(
  r: (Partial<StageResult> & { content?: string; category?: string; scope?: string; source?: string; message?: string; error?: string }) | null | undefined,
  expanded = false,
  theme: ThemeAdapter = plainTheme,
): Component {
  if (r?.error || !r?.status) {
    const message = (r?.error || r?.message || "Remember failed (no status or error message)").replace(uuid, "memory entry");
    return { render: width => renderErrorResult(message, { theme, width, expanded }) };
  }
  const meta = [`status: ${r.status}`];
  if (r.category) meta.push(`category: ${r.category}`);
  if (r.scope) meta.push(`scope: ${r.scope}`);
  if (r.reason && !r.message) meta.push(`reason: ${r.reason.replace(uuid, "memory entry")}`);
  const status = r.status === "active" ? "ok" : r.status === "staged" ? "off" : "warn";
  const body = [` ${statusIcon(theme, status)} ${theme.fg("muted", meta.join(" · "))}`];
  const gutter = ` ${theme.fg("dim", icon(theme.iconStyle, "gutter"))} `;
  if (r.content) {
    const preview = r.content.trim().replace(/\s+/gu, " ");
    body.push(gutter + theme.fg("toolOutput", expanded ? r.content : preview.length > 160 ? preview.slice(0, 159) + "…" : preview));
  }
  if (r.message) {
    // The agent keeps the reviewed-write diagnostic verbatim, including its UUIDs.
    const note = r.message.replace(/(?: as |; uuid: )(?=[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b)[\da-f-]+/giu, "")
      .replace(uuid, "memory entry");
    body.push(gutter + theme.fg("muted", note));
  }
  return { render: width => fitResultLines(body, width, expanded, 3) };
}

export function renderRecallResult(recs: MemoryRecord[], expanded = false): Component {
  const body = recs.length
    ? recs.map(r => ` [${r.category}] ${r.content}${r.link ? ` (${r.link})` : ""}`)
    : [" (no matches)"];
  if (recs.length) body.push(` ${recs.length} match${recs.length === 1 ? "" : "es"}`);
  return { render: width => fitResultLines(body, width, expanded, 3) };
}

export function renderPending(recs: MemoryRecord[], expanded = false, theme: ThemeAdapter = plainTheme): Component {
  const body = recs.length
    ? [` ${theme.fg("muted", `${recs.length} pending`)}`, ...recs.map(r => ` ${statusIcon(theme, "off")} [${r.category}] ${r.content}`)]
    : [" (nothing pending)"];
  return { render: width => fitResultLines(body, width, expanded, 3) };
}
