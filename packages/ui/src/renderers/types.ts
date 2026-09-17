import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";

/** Shared render context for every pure spider renderer. */
export interface RenderCtx { theme: ThemeAdapter; width: number; expanded?: boolean; }

export type ExecKind = "exec" | "exec_file" | "batch";
/** Mirrors executor.ts's `ExecOutcome` — see there for the full contract.
 *  Optional so existing/hand-built fixtures that predate this field keep
 *  working (the renderer derives a conservative fallback when absent). */
export type ExecOutcome = "exited" | "signal" | "spawn-error" | "aborted" | "timeout" | "unknown";
export interface ExecDetails {
  kind: ExecKind; commands: string[]; ok: boolean;
  /** `null` means the exit code genuinely is not known yet, OR a KNOWN outcome
   *  (a signal death or spawn error — see `outcome`/`signal`) that legitimately
   *  never had a numeric one to report. Never rendered as `0` either way. The
   *  renderer checks `detached`, then `retained`, then `outcome` (in that
   *  order) before ever falling back to a bare "exit unknown" — see those
   *  fields. */
  exitCode: number | null;
  outLines: number; ms?: number; preview: string[]; indexed?: { source: string; chunks: number };
  /** True while the command is still executing (pi's `options.isPartial`). The exit code is
   *  not known yet, so the status line must not claim one. */
  running?: boolean;
  /** Set when the command was detached at a timeout handoff and is still running
   *  somewhere: the exit code is UNKNOWN, not 0 — a launch is not a success. `pid` is
   *  the supervisor's pid (the process-group leader on POSIX), advisory only.
   *  Also used (see `outcome`) for the genuinely-indeterminate case — the two are
   *  distinguished by `outcome` so the renderer never claims a receipt "appears
   *  when it exits" for an outcome that may already be settled. */
  detached?: { pid?: number; jobId: string; jobDir: string; receipt: string };
  /** I-3: set when the command's OUTCOME is verifiably known (exited, signal
   *  death, spawn error, or aborted) but its job directory was retained anyway
   *  because its process group could not be proven empty (possible live
   *  descendants) — distinct from `detached`, which means the outcome itself
   *  is still unknown. `exitCode`/`ok` above carry the real, known result for
   *  that outcome, which may legitimately still be `null` for a signal death
   *  or spawn error (see `outcome`/`signal`) — never coerce a `null` here into
   *  a fabricated `0`. This field only adds the disclosure that logs/descendants
   *  may still be active. */
  retained?: { jobDir: string; reason?: string; receipt?: string };
  /** C-1: the structured terminal-state discriminator — the renderer keys off
   *  this (not `exitCode === null` alone) to tell a KNOWN signal death/spawn
   *  error/abort apart from a genuinely still-unknown outcome. F-1: for a
   *  `batch` aggregate this is the outcome of whichever entry made the batch
   *  a KNOWN failure via a null exitCode (signal/spawn-error) — never set
   *  when the aggregate failure is a real numeric exit code instead. */
  outcome?: ExecOutcome;
  /** Named signal, present only when `outcome === "signal"`. */
  signal?: string;
  /** C-H2 (batch only): every DISTINCT failure kind present in the batch, in first-seen
   *  order, deduplicated (e.g. `["exit 2", "signal SIGKILL"]`). A single `exitCode`/
   *  `outcome`/`signal` cannot honestly name more than one failure kind at once, so once a
   *  batch has more than one distinct kind, the renderer must fall back to naming every
   *  entry in THIS list instead of the singular fields above (which then may legitimately
   *  be absent/incomplete). Present whenever the batch has at least one failing entry,
   *  even when there is only one distinct kind (in which case the singular fields already
   *  say the same thing and the renderer keeps using them unchanged). */
  failures?: string[];
  /** Count of entries whose exitCode was genuinely unknown (no recognized failure
   *  `outcome`, e.g. `"unknown"`/`"timeout"`, or none at all). NOT limited to "alongside a
   *  real, definite failure elsewhere" — the producer (`render-result.ts`'s `toExecDetails`)
   *  sets this whenever at least one such entry exists, including a batch that is ENTIRELY
   *  indeterminate (no numeric/signal/spawn-error failure anywhere). The renderer discloses
   *  it alongside a named failure (numeric or `failures`) when one is ALSO present, so a
   *  mixed batch never silently launders the unknown entries into the aggregate. */
  unknownCount?: number;
}
export interface IndexDetails {
  kind: "index" | "fetch"; source: string; targets: string[];
  chunks: number; embedded: number; skipped?: number; urls?: string[];
}
export interface MemoryRecordView {
  uuid: string; category: string; content: string; link?: string;
  status: string; source: string; confidence?: number;
}
export interface MemoryCardDetails { mode: "remember" | "recall"; records: MemoryRecordView[]; staged: number; }
export interface TodoItemView { id: number; text: string; done: boolean; }
export interface TodoChecklistDetails { scope: string; items: TodoItemView[]; done: number; total: number; }
export interface RunView { runId: string; name: string; role?: string; status: string; model?: string; steps: number; tokens: number; phase?: string; }
export interface RunResultDetails { runs: RunView[]; pipeline: { from: string; to: string; phase?: string }[]; }
export interface MessageDetails {
  verb: "send" | "ask" | "reply" | "broadcast";
  to?: string; from?: string; kind?: string; body: string; delivered: boolean;
  delivery?: "broker-accepted" | "queued" | "unavailable";
  recipientAcknowledged?: boolean;
  error?: string;
}

type St = "ok" | "fail" | "warn" | "on" | "off" | "paused";
const ICON: Record<St, { g: string; token: string }> = {
  ok: { g: "✓", token: "success" }, fail: { g: "✗", token: "error" }, warn: { g: "⚠", token: "warning" },
  on: { g: "●", token: "accent" }, off: { g: "○", token: "muted" }, paused: { g: "■", token: "muted" },
};

/** Status glyph in its semantic color (glyph + color, never color-only). */
export function statusIcon(theme: ThemeAdapter, status: St): string {
  const s = ICON[status];
  return theme.fg(s.token, s.g);
}

/** `label value` on one line, width-guaranteed (value right-truncated). */
export function kv(theme: ThemeAdapter, label: string, value: string, width: number): string {
  if (width < 3) return truncateToWidth(label, width, "");
  return truncateToWidth(`${theme.fg("muted", label)} ${theme.fg("text", value)}`, width, "");
}

/** A 🕸-ruled titled card. OVERLAY-ONLY: use this for standalone surfaces mounted via
 *  ctx.ui.custom (no outer tool shell). NEVER in a tool-result renderer — pi's tool shell
 *  already shows `🕸 spider · <action>`, so a second 🕸 header double-heads the output.
 *  See docs/output-ui-guidelines.md. Every returned line is ≤ width visible cells. */
export function card(theme: ThemeAdapter, title: string, lines: string[], width: number): string[] {
  const head = `${theme.fg("accent", "🕸")} ${theme.bold(theme.fg("accent", title))} `;
  const fill = Math.max(0, width - visibleWidth(head));
  const rule = truncateToWidth(head + theme.fg("dim", "─".repeat(fill)), width, "");
  const out = [rule];
  for (const l of lines) out.push(truncateToWidth(l, width, ""));
  return out;
}

/** A glyph-free section rule for grouping lines INSIDE a tool-result body: `label ─────`
 *  (muted label + dim rule, no 🕸). This is the tool-result counterpart to card() — it adds
 *  structure without repeating the tool shell's header. See docs/output-ui-guidelines.md. */
export function sectionRule(theme: ThemeAdapter, label: string, width: number): string {
  const head = `${theme.fg("muted", label)} `;
  const fill = Math.max(0, width - visibleWidth(head));
  return truncateToWidth(head + theme.fg("dim", "─".repeat(fill)), width, "");
}
