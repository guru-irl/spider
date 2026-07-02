// packages/host/src/result.ts
// Normalize a spider action handler's return value into pi's canonical tool result
// shape. pi's `ToolDefinition.execute` must resolve to `AgentToolResult`:
//   { content: (TextContent | ImageContent)[]; details: T; terminate?: boolean }
// where `content` is the MODEL-FACING payload (text blocks), and TUI rendering is a
// SEPARATE concern (`ToolDefinition.renderResult`, wired in the UI phase). Therefore we
// never render `@spider/ui` Components into `content` — their `render()` emits ANSI theme
// codes, which must not leak into what the model reads. Handlers provide a clean model
// string via `text`; older handlers that only return `{ display, details }` degrade to a
// JSON view of `details` (functional, ANSI-free) until they add a `text` field.

const ANSI = /\x1b\[[0-9;]*m/g;

/** pi TextContent block (structural — no import needed). */
export interface TextBlock { type: "text"; text: string }
/** Subset of pi's AgentToolResult we produce. */
export interface ToolResult { content: TextBlock[]; details: unknown }

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
}

/**
 * Map a handler return (`{ text?, display?, content?, error?, details? }` | string | any)
 * to a pi `AgentToolResult`. Precedence for the model-facing text:
 *   text → content(string) → the raw string → `Error: <error>` → JSON(details) → JSON(whole).
 * ANSI escapes are stripped defensively so nothing color-bearing reaches the model.
 */
export function toToolResult(r: unknown): ToolResult {
  const o = r as Record<string, unknown> | null | undefined;
  let text: string;
  if (o && typeof o.text === "string") text = o.text;
  else if (o && typeof o.content === "string") text = o.content;
  else if (typeof r === "string") text = r;
  else if (o && o.error != null) text = `Error: ${String(o.error)}`;
  else if (o && o.details !== undefined) text = typeof o.details === "string" ? o.details : safeJson(o.details);
  else text = o != null ? safeJson(o) : "";
  return { content: [{ type: "text", text: text.replace(ANSI, "") }], details: o?.details ?? r ?? null };
}
