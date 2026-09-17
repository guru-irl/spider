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
/** Subset of pi's AgentToolResult we produce, plus the isError signal mechanism (B)
 *  needs (see file-header note below and pi-tool-error-contract-report.md). `isError`
 *  is NOT part of pi's real `AgentToolResult` type and is never sent to pi as-is —
 *  extension.ts reads it to call `markToolCallError`, then discards it before handing
 *  the rest to pi's `execute()` contract. */
export interface ToolResult { content: TextBlock[]; details: unknown; isError: boolean }

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
}

// --- Mechanism (B): isError correlation store ------------------------------------
// pi's `ToolDefinition.execute()` contract has no `isError` field (returning one on
// the resolved value is inert — pi's runtime never reads it; see the contract report
// §1). The only way to set `ToolResultMessage.isError` while preserving `content`/
// `details` is a `pi.on("tool_result", ...)` handler returning `{isError:true, ...}`
// (routing/index.ts). This module-level store is the same-process handoff from
// extension.ts's `execute()` (which computes the real isError via `toToolResult`) to
// that hook, keyed by `toolCallId` — a Set, never a scalar, because pi documents/
// traces that `tool_result` may interleave under parallel tool execution (a scalar
// would let one call's flag leak onto a different, concurrently-resolving call).
// `consumeToolCallError` deletes on read: one-shot, so a mark never lingers past the
// single `tool_result` event it was meant for.
const erroredCalls = new Set<string>();

// A-M3 (branch-review A-architecture.md): if whatever is supposed to drain marks never
// runs at all (e.g. `registerRouting` fails to wire the `tool_result` hook — see
// extension.ts, now surfaced via doctor but still best-effort), every subsequent mark
// just kept accumulating here for the rest of the process lifetime. This cap is a
// backstop against that specific failure mode, independent of whether it's ALSO
// surfaced elsewhere: far above any real number of concurrently in-flight tool calls,
// so it never trims a legitimately busy session, but never unbounded either. Evicts the
// OLDEST marks first (Set iterates in insertion order), on the reasoning that a mark's
// value decays with age — the `tool_result` event it was meant for either already
// consumed it or, past this many other calls, almost certainly never will.
const MAX_ERRORED_CALLS = 500;

/** Record that `toolCallId` resolved to an error result. Called once, from
 *  extension.ts's `execute()`, right after `toToolResult` computes `isError: true`. */
export function markToolCallError(toolCallId: string): void {
  erroredCalls.add(toolCallId);
  while (erroredCalls.size > MAX_ERRORED_CALLS) {
    const oldest = erroredCalls.values().next().value;
    if (oldest === undefined) break;
    erroredCalls.delete(oldest);
  }
}

/** Consume (delete-on-read) a prior mark for `toolCallId`. Returns `false` — never
 *  throws — for an unmarked, empty, or non-string id, so a defensive `event?.toolCallId`
 *  read at the call site is always safe. */
export function consumeToolCallError(toolCallId: string | null | undefined): boolean {
  if (!toolCallId) return false;
  return erroredCalls.delete(toolCallId);
}

/**
 * Map a handler return (`{ text?, display?, content?, error?, details?, isError? }` |
 * string | any) to a pi `AgentToolResult` (+ the `isError` signal above). Precedence
 * for the model-facing text:
 *   text → content(string) → the raw string → `Error: <error>` → JSON(details) → JSON(whole).
 * ANSI escapes are stripped defensively so nothing color-bearing reaches the model.
 * `isError`: an explicit boolean from the handler (the convention `exec`/`exec_file`/
 * `batch`/`kill`/`message` already use) is honored as-is; only when the handler left
 * it `undefined` do we fall back to `error != null` or the live `details.ok === false`
 * convention used by bind, doctor, and memory. Pi themes the tool shell from this flag;
 * without the latter convention those handlers showed a green shell over a `✗` body.
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
  const normalizedDetails = o?.details ?? r ?? null;
  const details = normalizedDetails as Record<string, unknown> | null;
  const detailsFailed = !!details && typeof details === "object" && details.ok === false;
  const isError = !!o && (
    o.isError === true ||
    (o.isError === undefined && (o.error != null || detailsFailed))
  );
  return { content: [{ type: "text", text: text.replace(ANSI, "") }], details: normalizedDetails, isError };
}
