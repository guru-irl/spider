import { openDbAt, type Db } from "@spider/db-core";
import { RunStore, type RunRow } from "./run-store";
import { emitIntent, emitToolResult, emitStatus, emitMessage, emitEscalation } from "./run-events";
import { thinkingFromModel, stripThinkingSuffix } from "./pi-args";
import { genuineCompletion, NO_DELIVERABLE_RESULT } from "./completion-output";

export function isSubagentChild(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return undefined;
}
/** Collapse whitespace and clamp to the existing 100-char summary budget. */
function clampSnippet(s: string): string {
  return s.replace(/\s+/g, " ").slice(0, 100);
}

/** First non-blank line of a (possibly multi-line) script. Strips a trivial leading
 *  `cd <path> &&` so the real command survives — anything more elaborate than that single
 *  safe case (quoted/spaced paths, multiple `&&`, …) is left alone rather than mis-parsed. */
function firstMeaningfulLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const stripped = line.replace(/^cd\s+\S+\s*&&\s*/i, "").trim();
    return stripped || line;
  }
  return "";
}

/** spider is one mega-tool (`{action, ...}`); the generic pick list below has no field for
 *  its actual payload, so it always fell through to `a.action` itself — every call recorded
 *  the useless literal "spider exec". The real content lives in action-specific fields
 *  (`code`, `commands`, `path`, …), so summarise each action from where its payload actually
 *  is instead of the generic pick list. */
function summarizeSpiderCall(a: Record<string, any>): string {
  const action = firstString(a.action);
  if (!action) return "spider";
  if (action === "batch") {
    const commands = Array.isArray(a.commands) ? a.commands : [];
    const first = (commands[0] ?? {}) as Record<string, any>;
    const line = firstString(first.code, first.label, first.language);
    if (!line) return `spider ${action}`;
    const count = commands.length;
    return `spider ${action}: ${clampSnippet(firstMeaningfulLine(line))} (${count} command${count === 1 ? "" : "s"})`;
  }
  // exec_file → path; exec (and anything else) → code, falling back to the same fields the
  // generic pick list below already covers for non-spider tools.
  const value = firstString(a.path, a.code, a.file, a.filePath, a.command, a.pattern, a.query, a.url, a.name);
  return value ? `spider ${action}: ${clampSnippet(firstMeaningfulLine(value))}` : `spider ${action}`;
}

/** A concise label for a tool call from its args (path/command/pattern/…). */
export function summarizeToolArgs(tool: string, args: any): string {
  const a = args && typeof args === "object" ? (args as Record<string, any>) : {};
  if (tool === "spider") return summarizeSpiderCall(a);
  const pick = firstString(a.path, a.file, a.filePath, a.command, a.pattern, a.query, a.url, a.name, a.action);
  return pick ? `${tool} ${pick.replace(/\s+/g, " ").slice(0, 100)}` : tool;
}
function extractText(result: any): string {
  if (typeof result === "string") return result;
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join(" ");
}
function summarizeResult(tool: string, result: any, isError: boolean): string {
  const prev = extractText(result).replace(/\s+/g, " ").trim().slice(0, 120);
  return `${isError ? "✗" : "✓"} ${tool}${prev ? " — " + prev : ""}`;
}
/** Assistant prose (text blocks only) from a finalized message. */
function extractAssistantText(msg: any): string {
  if (!msg || msg.role !== "assistant") return "";
  const content = msg.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("").trim();
  return "";
}

export function makeChildReporter(db: Db, ctx: { runId: string; sessionId: string }) {
  const store = new RunStore(db);
  /**
   * Ownership guard for INCIDENT-premature-run-finalization.md — shared by EVERY
   * mutating method below, not only `onShutdown`. `runs.pid` is written by the PARENT
   * synchronously right after spawning the real child (`runner.ts` sets it immediately
   * once `spawn()` resolves a pid, long before the child's own extensions could possibly
   * finish loading), so by the time a genuine child reaches ANY event here a foreign
   * process cannot yet have beaten it to a matching pid.
   *
   * Gating `onShutdown` alone (the original fix) left every OTHER path open:
   * `attachChildReporter` performs no ownership check of its own, so a pid-MISMATCHED
   * process — e.g. a vitest worker spawned by a subagent's own `npm test` verification
   * gate, which INHERITS PI_SUBAGENT_CHILD/PI_SPIDER_DB_PATH/PI_SUBAGENT_RUN_ID — could
   * still attach and call `onTurn`/`onModel` (rewriting a live run's `step_count`/`model`)
   * or `onMessage` (injecting a `message` run_event). Because `genuineCompletion`
   * (completion-output.ts) takes the MOST RECENT `message` run_event, the genuine owner
   * would then hand out the foreign process's mid-stream sentence as its own final
   * result — the incident's exact symptom, reproduced on a row whose pid is correct.
   *
   * The row is re-read FRESH on every call (never a decision cached at attach time), so a
   * pid recorded by the parent AFTER this reporter attached (a startup race) still closes
   * the window on the very next event, not only at shutdown.
   *
   * NULL-pid / no-row policy: ACCEPT (do not gate on it). Rows spawned via the async path
   * (`runner.ts`'s `runAsync` — the ACTUAL path exploited by this incident; the real
   * leaked rows' PIDs, 49643/49644, were live OS pids, never NULL) always have `pid` set
   * immediately after spawn, well before their own child could plausibly reach any event,
   * so that is the case that matters in production and it is fully covered below.
   * Refusing on NULL/missing was considered and rejected: `runForeground`-spawned rows
   * (single sync mode, each chain step, parallel's foreground fallback) never get a `pid`
   * at all and rely on the child's own reporter to self-report exactly like this; and it
   * would fail a pre-existing, intentionally in-process fixture that already relies on
   * this attach-without-a-recorded-pid shape (`child-terminal-message.test.ts`, out of
   * scope for this incident).
   *
   * What is ACTUALLY unprotected (this replaces a narrower, materially incomplete claim
   * that used to live only on `onShutdown` and implied NULL-pid rows were the sole gap):
   * a row that no process has EVER recorded a pid for — a raw/manual insert, or any
   * event fired in the narrow window before a pid lands at all. That is exactly the
   * NULL-pid set above, nothing more — every row that DOES carry a live, mismatched pid
   * is now refused on every write this reporter can make, not only on finalize.
   */
  function isForeignRow(row: RunRow | undefined): boolean {
    return !!row && row.pid !== null && row.pid !== process.pid;
  }
  return {
    onToolStart(tool: string, summary?: string, payload?: unknown): void {
      if (isForeignRow(store.get(ctx.runId))) return;
      emitIntent(db, { ...ctx, tool, summary, payload });
    },
    onToolEnd(tool: string, summary?: string, payload?: unknown): void {
      if (isForeignRow(store.get(ctx.runId))) return;
      emitToolResult(db, { ...ctx, tool, summary, payload });
    },
    /** Preserve the full prose even when it carries an escalation. The final report
     *  used to disappear whenever one warning line was present, exposing an old preamble. */
    onMessage(text: string, metadata?: { stopReason?: string; errorMessage?: string }): void {
      if (isForeignRow(store.get(ctx.runId))) return;
      const lines = text.split('\n');
      const nonBlank = lines.filter(line => line.trim());
      const escalationOnly = nonBlank.length > 0 && nonBlank.every(line => /^ESCALATION\[(blocked|question|warning)\]:\s*.+$/i.test(line));
      emitMessage(db, { ...ctx, summary: text, payload: { text, ...metadata, escalationOnly } });
      for (const line of lines) {
        const match = /^ESCALATION\[(blocked|question|warning)\]:\s*(.+)$/i.exec(line);
        if (match) {
          const severity = match[1].toLowerCase() as "blocked" | "question" | "warning";
          emitEscalation(db, { ...ctx, severity, summary: match[2].trim() });
        }
      }
    },
    onStatus(status: string, summary?: string): void {
      if (isForeignRow(store.get(ctx.runId))) return;
      emitStatus(db, { ...ctx, status, summary });
    },
    /** pi fires turn_start with a 0-based turnIndex; persist turns as step_count. */
    onTurn(turns: number): void {
      if (isForeignRow(store.get(ctx.runId))) return;
      store.updateProgress(ctx.runId, { stepCount: turns });
    },
    /** Record the child's actual model once (subagents spawned without an explicit
     *  model would otherwise show '—' in the UI). */
    onModel(model: string): void {
      if (isForeignRow(store.get(ctx.runId))) return;
      // The reported id may carry a thinking suffix (e.g. "prov/opus:high"); keep the model
      // column clean and record the child's real thinking level when present.
      const th = thinkingFromModel(model);
      store.updateProgress(ctx.runId, { model: stripThinkingSuffix(model), ...(th ? { thinking: th } : {}) });
    },
    onShutdown(status: "done" | "error" | "interrupted", result?: string): void {
      const before = store.get(ctx.runId);
      if (!before || ["done", "failed", "cancelled"].includes(before.status)) return;
      // Same ownership rule as every write above — applied to the row already fetched for
      // the terminal-status check, so this is not a second read or a second source of
      // truth. See `isForeignRow`'s doc comment (above, in this function) for the full
      // incident writeup and the NULL-pid policy.
      if (isForeignRow(before)) return;
      let runStatus: "done" | "failed" | "cancelled" = status === "done" ? "done" : status === "error" ? "failed" : "cancelled";
      let finalResult = result;
      // An explicit, non-blank result is a direct claim from the caller — trust it as-is
      // (mirrors decideOutcome's precedence rule in runner.ts). The real child sequence
      // never passes one (attachChildReporter calls onShutdown("done") bare), so this is
      // the branch that actually runs in production: a clean shutdown signal is necessary
      // but NOT sufficient for "done" — it must be cross-checked against a genuine
      // deliverable, and no unresolved blocked/question escalation more recent than it (a
      // warning never blocks completion). Without this check, a child that
      // escalated/blocked and then exited cleanly was recorded done with result=null —
      // reported SUCCESS with nothing delivered.
      if (runStatus === "done" && (result == null || result.trim().length === 0)) {
        const completion = genuineCompletion(db, ctx.runId);
        if (completion.done) {
          // The actual deliverable lives in the message run_events, not a caller-supplied
          // RunRow.result. Backfill it so it survives as the canonical result for anything
          // reading the row later (chains' {previous}, notifications, …).
          finalResult = completion.result;
        } else {
          runStatus = "failed";
          finalResult = completion.reason ?? NO_DELIVERABLE_RESULT;
        }
      }
      if (runStatus === "failed" && !finalResult?.trim()) finalResult = "Child ended with an error and no terminal report.";
      store.finish(ctx.runId, { status: runStatus, result: finalResult });
      const recorded = store.get(ctx.runId);
      if (recorded && recorded.status !== before.status) {
        emitStatus(db, { ...ctx, status: recorded.status, summary: recorded.result ?? undefined });
      }
    },
  };
}

export function attachChildReporter(pi: any): (() => void) | undefined {
  if (!isSubagentChild()) return undefined;
  const dbPath = process.env.PI_SPIDER_DB_PATH;
  const runId = process.env.PI_SUBAGENT_RUN_ID;
  if (!dbPath || !runId) return undefined;
  let db: Db;
  try {
    db = openDbAt(dbPath, "project");
  } catch {
    return undefined;
  }
  // Tag run_events with the OWNING spider session so the UI's per-session bus filter
  // keeps them. The parent passes PI_SPIDER_SESSION_ID; getSessionName() throws under
  // headless -p --mode json, and the runId fallback would be filtered out by the UI.
  let sessionId = process.env.PI_SPIDER_SESSION_ID ?? "";
  if (!sessionId) {
    sessionId = runId;
    try {
      const n = typeof pi?.getSessionName === "function" ? pi.getSessionName() : undefined;
      if (n) sessionId = n;
    } catch {
      // no resolvable session in child mode; runId is a fine stable key
    }
  }
  const rep = makeChildReporter(db, { runId, sessionId });
  const offs: Array<() => void> = [];
  const wire = (evt: string, fn: (e: any, ctx?: any) => void) => {
    try {
      const off = pi.on(evt, fn);
      if (typeof off === "function") offs.push(off);
    } catch {
      // ignore wiring failures
    }
  };
  let modelSeen = false;
  const captureModel = (evtCtx: any) => {
    if (modelSeen) return;
    try {
      // Event handlers get an ExtensionContext whose CURRENT model is the `.model` property
      // (getModel() lives on a different ctx shape); fall back to getModel() defensively.
      const m = evtCtx?.model ?? (typeof evtCtx?.getModel === "function" ? evtCtx.getModel() : undefined);
      if (m?.id) { rep.onModel(String(m.id)); modelSeen = true; }
    } catch { /* model not resolvable yet */ }
  };
  // Track the most recent assistant turn's provider outcome. `stopReason` is the
  // documented, structural signal for "this turn ended in a provider error/abort"
  // (session-format.md) — NOT a natural-language guess. It is intentionally reset to
  // "ok" on every subsequent successful turn, so a transient abort/error that the agent
  // recovers from and continues past (e.g. a compaction retry) does not poison the
  // final outcome; only the LAST turn before shutdown decides.
  let lastTurnOutcome: "ok" | "error" | "aborted" = "ok";
  let lastTurnErrorMessage: string | undefined;
  wire("tool_execution_start", (e) => rep.onToolStart(e?.toolName, summarizeToolArgs(e?.toolName, e?.args), { id: e?.toolCallId }));
  wire("tool_execution_end", (e) => rep.onToolEnd(e?.toolName, summarizeResult(e?.toolName, e?.result, !!e?.isError), { id: e?.toolCallId, isError: !!e?.isError }));
  wire("message_end", (e) => {
    const msg = e?.message;
    if (msg?.role !== "assistant") return;
    const text = extractAssistantText(msg);
    rep.onMessage(text, {
      stopReason: typeof msg.stopReason === "string" ? msg.stopReason : "unknown",
      errorMessage: typeof msg.errorMessage === "string" ? msg.errorMessage : undefined,
    });
    if (msg.stopReason === "error") {
      lastTurnOutcome = "error";
      lastTurnErrorMessage = typeof msg.errorMessage === "string" ? msg.errorMessage : text || "Child provider request failed.";
    } else if (msg.stopReason === "aborted") {
      lastTurnOutcome = "aborted";
      lastTurnErrorMessage = typeof msg.errorMessage === "string" ? msg.errorMessage : "Child provider request was aborted.";
    } else {
      lastTurnOutcome = "ok";
      lastTurnErrorMessage = undefined;
    }
  });
  wire("turn_start", (e, ctx) => { rep.onTurn((e?.turnIndex ?? 0) + 1); captureModel(ctx); });
  wire("agent_start", (_e, ctx) => { rep.onStatus("running"); captureModel(ctx); });
  wire("session_shutdown", () => {
    try {
      // A provider error/abort on the LAST turn is a definitive "not successful" signal —
      // report it as such regardless of a clean process exit code. Otherwise defer to
      // onShutdown's own genuineCompletion check (real deliverable + no unresolved
      // blocked/question escalation) to decide done vs. failed.
      if (lastTurnOutcome === "error" || lastTurnOutcome === "aborted") {
        rep.onShutdown("error", lastTurnErrorMessage);
      } else {
        rep.onShutdown("done");
      }
    } finally {
      try {
        db.close();
      } catch {
        // ignore close failures
      }
    }
  });
  return () => {
    for (const off of offs) {
      try {
        off();
      } catch {
        // ignore unsubscribe failures
      }
    }
  };
}
