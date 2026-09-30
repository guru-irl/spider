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

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

const ANSI = /\x1b\[[0-9;]*m/g;

/** Repair model-facing history, including tool results persisted before this extension loaded. */
export function repairBlankToolResults(messages: ContextEvent["messages"]): { messages: ContextEvent["messages"] } | undefined {
  try {
    let changed = false;
    const repaired = messages.map(message => {
      try {
        if (message.role !== "toolResult" || message.isError !== true || !Array.isArray(message.content)) return message;
        const content = message.content;
        // Unknown or malformed blocks are left untouched rather than guessed at.
        if (!content.every(block => block && (block.type === "image" ||
          (block.type === "text" && typeof block.text === "string")))) return message;
        if (content.some(block => block.type === "image")) {
          const withoutBlank = content.filter(block => block.type !== "text" || block.text.trim());
          if (withoutBlank.length === content.length) return message;
          changed = true;
          return { ...message, content: withoutBlank.some(block => block.type === "text")
            ? withoutBlank : [...withoutBlank, { type: "text" as const, text: "(tool error with no message)" }] };
        }
        if (content.some(block => block.type === "text" && block.text.trim())) return message;
        changed = true;
        return { ...message, content: [{ type: "text" as const, text: "(tool error with no message)" }] };
      } catch { return message; }
    });
    return changed ? { messages: repaired } : undefined;
  } catch { return undefined; }
}

/** pi TextContent block (structural — no import needed). */
export interface TextBlock { type: "text"; text: string }
/** Subset of pi's AgentToolResult we produce, plus the isError signal mechanism (B)
 *  needs (see file-header note below and pi-tool-error-contract-report.md). `isError`
 *  is NOT part of pi's real `AgentToolResult` type and is never sent to pi as-is —
 *  extension.ts reads it to call `markToolCallError`, then discards it before handing
 *  the rest to pi's `execute()` contract. */
export interface ToolResult { content: TextBlock[]; details: unknown; isError: boolean }

export function rethrowWithMessage(error: unknown, operation: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.trim()) throw error;
  const kind = error instanceof Error ? error.constructor.name : typeof error;
  throw new Error(`${operation} failed: ${kind} with no message`, { cause: error });
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
}

/** Model text for an empty settled result; derive a short status from exec details when present. */
function emptyResultText(details: unknown, isError: boolean): string {
  if (details && typeof details === "object" && "stdout" in details && "stderr" in details) {
    const exec = details as { outcome?: string; exitCode?: number | null; signal?: string | null };
    if (exec.outcome === "timeout") return "detached at timeout (no output yet; exit status unknown)";
    if (exec.outcome === "aborted") return "aborted (no output)";
    if (exec.outcome === "signal") return `killed by signal ${exec.signal ?? "unknown"} (no output)`;
    if (exec.outcome === "spawn-error") return "spawn error (no output)";
    if (exec.outcome === "unknown") return "outcome unknown (no output)";
    if (typeof exec.exitCode === "number" && exec.exitCode !== 0) return `exit ${exec.exitCode} (no output)`;
    return isError ? "exec failed (no output)" : "(no output)";
  }
  return isError ? "Error (no message)" : "(no message)";
}

/** Edit/write delegates bypass toToolResult. Preserve meaningful results verbatim. */
export function ensureNonEmptyToolContent(result: null | undefined): { content: TextBlock[]; details: Record<string, never> };
export function ensureNonEmptyToolContent<T extends { content?: Array<{ type: string; text?: string }>; isError?: boolean }>(result: T): T;
export function ensureNonEmptyToolContent<T extends { content?: Array<{ type: string; text?: string }>; isError?: boolean }>(result: T | null | undefined): T | { content: TextBlock[]; details: Record<string, never> } {
  if (result == null) return { content: [{ type: "text", text: "(no message)" }], details: {} };
  const content = result.content ?? [];
  if (content.some(block => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0)) return result;
  const fallback = result.isError ? "Error (no message)" : "(no message)";
  const textBlocks = content.filter(block => block.type === "text");
  return {
    ...result,
    content: textBlocks.length
      ? content.map(block => block.type === "text" ? { ...block, text: fallback } : block)
      : [...content, { type: "text", text: fallback }],
  } as T;
}

// --- Mechanism (B): isError correlation store ------------------------------------
// pi's `ToolDefinition.execute()` contract has no `isError` field (returning one on
// the resolved value is inert — pi's runtime never reads it; see the contract report
// §1). The only way to set `ToolResultMessage.isError` while preserving `content`/
// `details` is a `pi.on("tool_result", ...)` handler returning `{isError:true, ...}`
// (routing/index.ts). This module-level store is the same-process handoff from
// extension.ts's `execute()` (which computes the real isError via `toToolResult`) to
// that hook, keyed by `toolCallId` with an activation owner, never a scalar, because pi documents/
// traces that `tool_result` may interleave under parallel tool execution (a scalar
// would let one call's flag leak onto a different, concurrently-resolving call).
// `consumeToolCallError` deletes on read: one-shot, so a mark never lingers past the
// single `tool_result` event it was meant for.
const erroredCalls = new Map<string, object | undefined>();

/** Release only this activation's marks. Omit ownership only for test reset. */
export function clearToolCallErrors(owner?: object): void {
  if (!owner) { erroredCalls.clear(); return; }
  for (const [id, registeredOwner] of erroredCalls) {
    if (registeredOwner === owner) erroredCalls.delete(id);
  }
}

// A-M3 (branch-review A-architecture.md): if whatever is supposed to drain marks never
// runs at all (e.g. `registerRouting` fails to wire the `tool_result` hook — see
// extension.ts, now surfaced via doctor but still best-effort), every subsequent mark
// just kept accumulating here for the rest of the process lifetime. This cap is a
// backstop against that specific failure mode, independent of whether it's ALSO
// surfaced elsewhere: far above any real number of concurrently in-flight tool calls,
// so it never trims a legitimately busy session, but never unbounded either. Evicts the
// OLDEST marks first (Map iterates in insertion order), on the reasoning that a mark's
// value decays with age — the `tool_result` event it was meant for either already
// consumed it or, past this many other calls, almost certainly never will.
const MAX_ERRORED_CALLS = 500;

/** Record that `toolCallId` resolved to an error result. Called once, from
 *  extension.ts's `execute()`, right after `toToolResult` computes `isError: true`. */
export function markToolCallError(toolCallId: string, owner?: object): void {
  erroredCalls.set(toolCallId, owner);
  while (erroredCalls.size > MAX_ERRORED_CALLS) {
    const oldest = erroredCalls.keys().next().value;
    if (oldest === undefined) break;
    erroredCalls.delete(oldest);
  }
}

/** Consume (delete-on-read) a prior mark for `toolCallId`. Returns `false` — never
 *  throws — for an unmarked, empty, or non-string id, so a defensive `event?.toolCallId`
 *  read at the call site is always safe. */
export function consumeToolCallError(toolCallId: string | null | undefined, owner?: object): boolean {
  if (!toolCallId || (owner && erroredCalls.get(toolCallId) !== owner)) return false;
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
  const cleanText = text.replace(ANSI, "");
  return { content: [{ type: "text", text: cleanText.trim() ? cleanText : emptyResultText(normalizedDetails, isError) }], details: normalizedDetails, isError };
}
