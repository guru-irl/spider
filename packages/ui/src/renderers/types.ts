import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";
import { icon, type IconRole, type IconStyle } from "../icons.js";

/** Active SGR at the end of a marker; closed attributes must not leak into its text. */
function sgrCodes(marker: string): string {
  const active = new Map<string, string>();
  for (const match of marker.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const parts = match[1].split(";").map((part) => Number(part || 0));
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i];
      if (code === 0) active.clear();
      else if (code === 22) { active.delete("1"); active.delete("2"); }
      else if (code === 21) active.delete("1");
      else if ([23, 24, 25, 27, 28, 29].includes(code)) active.delete(String(code - 20));
      else if (code === 39) active.delete("fg");
      else if (code === 49) active.delete("bg");
      else if (code === 38 || code === 48) {
        const length = parts[i + 1] === 5 ? 3 : parts[i + 1] === 2 ? 5 : 1;
        if (length > 1 && i + length <= parts.length) {
          active.set(code === 38 ? "fg" : "bg", parts.slice(i, i + length).join(";"));
          i += length - 1;
        }
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) active.set("fg", String(code));
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) active.set("bg", String(code));
      else if ([1, 2, 3, 4, 5, 7, 8, 9].includes(code)) active.set(String(code), String(code));
    }
  }
  return [...active.values()].map((code) => `\x1b[${code}m`).join("");
}

// Both icon styles participate in wrapping. Match glyphs as alternatives, and keep the
// bare ✗ and ⚠ for legacy output.
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&");
const markerGlyphs = (["spider", "task", "result", "failure", "warning", "success", "question", "running", "open", "paused", "active", "todoDone", "todoFailed", "todoPending", "content", "todo", "bullet", "message"] as const)
  .flatMap(role => [icon("text", role), icon("nerd", role).trimEnd()]).map(escapeRegExp).join("|");
const messageChars = [icon("text", "message"), icon("nerd", "message")].join("").replace(/[\\\]\-^]/g, "\\$&");
const resultPrefix = new RegExp(`^([ \\t]*(?:(?:\\d+\\.[ \\t]+)?(?:[│✓✗⚠●○■◆▪▣•·\\-*]|${markerGlyphs})(?:[ \\t]*[→◆▪▣${messageChars}])?[ \\t]+|\\[[^\\]\\n]+\\][ \\t]+|\\d+\\.[ \\t]+|[ \\t]+))`, "u");

/** Detail rows start at the title text, after the logo and its separator. */
export function cardDetailIndent(style: IconStyle | undefined): string {
  return " ".repeat(visibleWidth(` ${icon(style, "spider")} `));
}

/** Fit result rows at the final render boundary, preserving ANSI state across wraps. */
export function fitResultLines(lines: readonly string[], width: number, expanded: boolean, hangingIndent?: number): string[] {
  const w = Math.max(1, width);
  return lines.flatMap((line) => {
    if (!expanded) return [truncateToWidth(line, w, "…")];
    if (hangingIndent !== undefined && !line.includes("\n") && visibleWidth(line) <= w) return [line];
    // Locate the visible marker first; ANSI spans inside its styling do not count as cells.
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    let prefix = resultPrefix.exec(plain)?.[1];
    // A long bracketed label should not consume the width available for the text.
    if (prefix && /^[ \t]*\[[^\]\n]+\][ \t]+$/u.test(prefix) && w - visibleWidth(prefix) < 20) {
      prefix = hangingIndent === undefined ? undefined : /^[ \t]+/u.exec(plain)?.[0];
    }
    const prefixWidth = prefix ? visibleWidth(prefix) : 0;
    const indentWidth = hangingIndent === undefined ? prefixWidth
      : Math.max(hangingIndent, visibleWidth(/^[ \t]*/u.exec(plain)![0]));
    const reserved = Math.max(prefix ? visibleWidth(prefix) : 0, indentWidth);
    if (prefix && reserved < w) {
      let end = 0;
      let visible = 0;
      while (visible < prefix.length) {
        const sgr = /^\x1b\[[0-9;]*m/.exec(line.slice(end))?.[0];
        if (sgr) end += sgr.length;
        else {
          const char = String.fromCodePoint(line.codePointAt(end)!);
          end += char.length;
          visible += char.length;
        }
      }
      const marker = line.slice(0, end);
      const indent = " ".repeat(indentWidth);
      const state = sgrCodes(marker);
      return wrapTextWithAnsi(state + line.slice(end), w - reserved)
        .map((row, i) => (i === 0 ? marker + row.slice(state.length) : indent + row));
    }
    return wrapTextWithAnsi(line, w);
  }).map(line => truncateToWidth(line, w, ""));
}
/** Keep full expanded content; retain the caller's collapsed truncation suffix. */
export function trimResultLine(line: string, width: number, expanded: boolean, suffix = ""): string {
  return expanded ? line : truncateToWidth(line, width, suffix);
}

export function resultTrimmer(expanded: boolean): (line: string, width: number, suffix?: string) => string {
  return (line, width, suffix = "") => trimResultLine(line, width, expanded, suffix);
}

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
  /** Captured tail in stdout-then-stderr order, populated only for expanded completed results. */
  expandedOutput?: { rows: { text: string; stream: "stdout" | "stderr" }[]; hidden: number;
    partial?: { line: number; shownBytes: number; totalBytes: number } };
  /** True while the command is still executing (pi's `options.isPartial`). The exit code is
   *  not known yet, so the status line must not claim one. */
  running?: boolean;
  /** True when a foreground timeout occurred before the result was returned. */
  timedOut?: boolean;
  /** True when a mixed batch includes a timed-out entry with unknown outcome. */
  timedOutUnknown?: boolean;
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
export type TodoChecklistDetails =
  | { kind: "item"; item: TodoItemView }
  | { kind: "removed"; item: TodoItemView; sessionName?: string }
  | { kind: "cleared"; removed: number; kept?: number }
  | { kind: "list"; groups: { label?: string; current?: boolean; items: TodoItemView[] }[] }
  | { kind: "sessions"; sessions: { label: string; done: number; total: number; current: boolean }[] };
export interface RunView { runId: string; name: string; role?: string; status: string; model?: string; steps: number; tokens: number; phase?: string; }
export interface RunResultDetails { runs: RunView[]; pipeline: { from: string; to: string; phase?: string }[]; }
export interface MessageDetails {
  verb: "send" | "ask" | "reply" | "broadcast";
  to?: string; from?: string; targetName?: string; kind?: string; body: string; delivered: boolean;
  delivery?: "child-accepted" | "broker-accepted" | "queued" | "unavailable" | "delivered" | "accepted but not confirmed" | "no reply yet, delivery unknown" | "refused";
  transformed?: boolean;
  recipientAcknowledged?: boolean;
  error?: string;
}

type St = "ok" | "fail" | "warn" | "on" | "off" | "paused";
const ICON: Record<St, { role: IconRole; token: string }> = {
  ok: { role: "success", token: "success" }, fail: { role: "failure", token: "error" }, warn: { role: "warning", token: "warning" },
  on: { role: "running", token: "accent" }, off: { role: "open", token: "muted" }, paused: { role: "paused", token: "muted" },
};

/** Status glyph in its semantic color (glyph + color, never color-only). */
export function statusIcon(theme: ThemeAdapter, status: St): string {
  const s = ICON[status];
  return theme.fg(s.token, icon(theme.iconStyle, s.role));
}

/** `label value` on one line, width-guaranteed (value right-truncated). */
export function kv(theme: ThemeAdapter, label: string, value: string, width: number): string {
  if (width < 3) return truncateToWidth(label, width, "");
  return truncateToWidth(`${theme.fg("muted", label)} ${theme.fg("text", value)}`, width, "");
}

/** A logo-ruled titled card for standalone overlays mounted via ctx.ui.custom.
 *  Do not use in tool results: the call line already supplies a title.
 *  See docs/output-ui-guidelines.md. Every returned line is ≤ width visible cells. */
export function card(theme: ThemeAdapter, title: string, lines: string[], width: number): string[] {
  const head = `${theme.fg("accent", icon(theme.iconStyle, "spider"))} ${theme.bold(theme.fg("accent", title))} `;
  const fill = Math.max(0, width - visibleWidth(head));
  const rule = truncateToWidth(head + theme.fg("dim", "─".repeat(fill)), width, "");
  const out = [rule];
  for (const l of lines) out.push(truncateToWidth(l, width, ""));
  return out;
}

/** A glyph-free section rule for grouping lines inside a tool-result body: `label ─────`.
 *  It adds structure without repeating the tool title. See docs/output-ui-guidelines.md. */
export function sectionRule(theme: ThemeAdapter, label: string, width: number): string {
  const head = `${theme.fg("muted", label)} `;
  const fill = Math.max(0, width - visibleWidth(head));
  return truncateToWidth(head + theme.fg("dim", "─".repeat(fill)), width, "");
}
