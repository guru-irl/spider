import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { FooterTotals } from "./footer-state.js";
import type { CalibrationResult } from "./dashboard-contract.js";
import { calibrationFallback } from "./calibration.js";
import { toAicDisplay } from "./aic-display.js";

export type CounterSnapshotView = { creditsUsed: number; entitlement?: number; ts: number };
export type CounterStateView = {
  availability: "disabled" | "unavailable" | "available";
  snapshot: CounterSnapshotView | null;
};
export type FooterInput = {
  cwd: string;
  branch: string | null;
  sessionName: string | null;
  modelId: string | null;
  /** Caller supplies off for non-reasoning models; the footer always shows it. */
  thinking: string;
  context: { percent: number | null; contextWindow: number } | null;
  autoCompaction?: boolean;
  subscription: boolean;
  totals: FooterTotals;
  calibration?: CalibrationResult;
  counter: CounterStateView;
  statuses: ReadonlyMap<string, string>;
};

function singleLine(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function label(text: string): string {
  return singleLine(stripTerminalSequences(text));
}

/** Matches pi's compact token/window notation, without importing its internals. */
function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function credits(count: number, lowerBound: boolean): string {
  // Floor lower bounds, ignoring floating accumulation noise at display boundaries.
  const tenths = (lowerBound ? Math.floor(count * 10 + 1e-9) : Math.round(count * 10)) / 10;
  if (tenths < 10) return !lowerBound && count > 0 && tenths === 0 ? "<0.1" : tenths.toFixed(1);
  return (lowerBound ? Math.floor(count + 1e-9) : Math.round(count)).toLocaleString("en-US");
}

function leftTruncate(text: string, width: number): string {
  if (width <= 0) return "";
  const length = visibleWidth(text);
  if (length <= width) return text;
  const ellipsis = "...";
  const tail = sliceByColumn(text, length - width + ellipsis.length, Math.max(0, width - ellipsis.length), true);
  if (width <= ellipsis.length || !tail) return "";
  return ellipsis + tail;
}

function heading(input: FooterInput, width: number, theme?: Theme): string {
  const dim = (text: string) => theme ? theme.fg("dim", text) : text;
  const shorten = (text: string, budget: number) => truncateToWidth(dim(text), budget, dim("..."));
  const thinking = label(input.thinking) || "off";
  const suffix = ` · ${thinking}`;
  const model = label(input.modelId ?? "no-model");
  // Even an unexpectedly long model must leave its thinking level visible.
  const right = visibleWidth(suffix) < width
    ? shorten(model, width - visibleWidth(suffix)) + dim(suffix)
    : shorten(thinking, width);
  const budget = width - visibleWidth(right) - 1;
  if (budget <= 0) return right;

  const cwd = label(input.cwd);
  let branch = input.branch ? ` (${label(input.branch)})` : "";
  const name = input.sessionName ? label(input.sessionName) : "";
  const namePart = () => name ? ` • ${name}` : "";
  let cwdBudget = budget - visibleWidth(branch + namePart());
  // A fitting short cwd is useful; an ellipsis without a real character is not.
  const cwdWidth = visibleWidth(cwd);
  const cwdStub = (cells: number) => cells < Math.min(cwdWidth, 4)
    || (cells < cwdWidth && !leftTruncate(cwd, cells));
  // Shorten cwd first, then remove the branch, then give a remaining stub's
  // space and separator back to the name (or leave the left side empty).
  if (cwdStub(cwdBudget)) {
    branch = "";
    cwdBudget = budget - visibleWidth(namePart());
  }
  const left = cwdStub(cwdBudget) && name
    ? shorten(name, budget)
    : dim(leftTruncate(cwd, Math.max(0, cwdBudget)) + branch + namePart());
  return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
}

function stats(input: FooterInput, width: number, theme?: Theme): string {
  const { totals, context } = input;
  const percent = context ? context.percent : 0;
  const percentText = typeof percent === "number" && Number.isFinite(percent) ? `${percent.toFixed(1)}%` : "?";
  const window = tokens(context?.contextWindow ?? 0);
  const contextText = `${percentText}/${window}${input.autoCompaction === true ? " (auto)" : ""}`;
  const unpriced = totals.unpricedEntries > 0;
  const calibration = input.calibration ?? calibrationFallback();
  const display = toAicDisplay(totals.aic, totals.unpricedEntries, calibration);
  const marker = display.basis === "calibrated" ? "cal" : calibration.status === "off" ? "est" : "?";
  const aic = `${display.basis === "calibrated" ? "" : "~"}${credits(display.primaryAic!, unpriced)}${unpriced ? "+" : ""} AIC ${marker}`;
  const items = [contextText, aic];
  if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && totals.latestCacheHitRate !== null) {
    items.push(`CH${totals.latestCacheHitRate.toFixed(1)}%`);
  }
  const snapshot = input.counter.availability === "available" ? input.counter.snapshot : null;
  if (snapshot && typeof snapshot.entitlement === "number" && Number.isFinite(snapshot.entitlement)
    && snapshot.entitlement > 0 && Number.isFinite(snapshot.creditsUsed) && snapshot.creditsUsed >= 0) {
    items.push(`month ${(snapshot.creditsUsed / snapshot.entitlement * 100).toFixed(1)}%`);
  }
  if (totals.input || totals.output) items.push(`↑${tokens(totals.input)} ↓${tokens(totals.output)}`);
  if (totals.cacheRead || totals.cacheWrite) items.push(`R${tokens(totals.cacheRead)} W${tokens(totals.cacheWrite)}`);
  // Drop the entire lowest-priority item. Context alone can also be omitted.
  while (items.length && visibleWidth(items.join(" ")) > width) items.pop();
  return items.map((item, index) => {
    if (!theme) return item;
    if (index === 0 && typeof percent === "number" && percent > 70) {
      return theme.fg(percent > 90 ? "error" : "warning", item);
    }
    return theme.fg("dim", item);
  }).join(" ");
}

function render(input: FooterInput, width: number, theme?: Theme): string[] {
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const lines = [heading(input, columns, theme), stats(input, columns, theme)];
  if (input.statuses.size > 0) {
    const status = Array.from(input.statuses.entries()).sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => singleLine(text)).join(" ");
    lines.push(truncateToWidth(status, columns, "..."));
  }
  return lines;
}

/** Pure layout: no session traversal, pricing, filesystem, database or network. */
export function renderUsageFooter(input: FooterInput, width: number): string[] {
  return render(input, width);
}

export function createUsageFooter(
  getInput: () => FooterInput,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  requestRender: () => void,
): Component & { refresh(): void; dispose(): void } {
  let disposed = false, pending = false;
  let lastWidth: number | undefined;
  let lastLines: string[] | undefined;
  const linesAt = (width: number) => render({ ...getInput(), branch: footerData.getGitBranch(),
    statuses: footerData.getExtensionStatuses() }, width, theme);
  function refresh(): void {
    if (disposed) return;
    if (lastWidth === undefined) {
      if (!pending) { requestRender(); pending = true; }
      return;
    }
    const lines = linesAt(lastWidth);
    if (!lastLines || lines.length !== lastLines.length || lines.some((line, index) => line !== lastLines![index])) {
      requestRender();
      lastLines = lines;
    }
  }
  const unsubscribe = footerData.onBranchChange(refresh);
  return {
    refresh,
    render(width) {
      lastWidth = width; pending = false;
      return lastLines = linesAt(width);
    },
    // Saved lines only gate refresh requests; every render uses live inputs, without history work.
    invalidate() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
