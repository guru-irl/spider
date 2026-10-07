import type { UsageMeasure } from "../dashboard-contract.js";
import type { ViewContext, MountedView } from "./views.js";
import { action, element, updateEvidence } from "./dom.js";
import { renderTable, tableRegion } from "./tables.js";
import { formatTokens, datedText, numericText, evidenceText } from "./format.js";
import { canRetry, DashboardClientError } from "./client.js";
import { createPager } from "./pager.js";
import { chartWithTable, type ChartPoint } from "./charts.js";

const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
export const analysisNumber = (value: number | null): string => value === null ? "unavailable" : decimal.format(value);
export const analysisPercent = (value: number | null): string => value === null ? "unavailable" : `~${decimal.format(value * 100)}%`;
export const counted = (count: number, noun: string): string => `${formatTokens(count)} ${noun}${count === 1 ? "" : "s"}`;
export function analysisEvidence(measure: UsageMeasure): string {
  return [`${counted(measure.calls, "call")}; ${formatTokens(measure.unpricedCalls)} unpriced; ${formatTokens(measure.aggregateCalls)} aggregate`,
    measure.possibleOverlap ? "Possible overlap" : "", measure.possibleUndercount ? "Possible undercount" : "", measure.pendingData ? "Pending data" : ""].filter(Boolean).join(" · ");
}
export function analysisTable(ctx: ViewContext, caption: string, columns: readonly string[], rows: readonly (readonly (string | HTMLElement)[])[]): HTMLElement {
  return tableRegion(ctx.document, renderTable(ctx.document, { caption, columns, rows: rows.map(row => row.map(value => typeof value === "string" ? datedText(ctx.document, value, text => numericText(ctx.document, text)) : value)) }));
}
export function analysisParams(ctx: ViewContext, filters = true): URLSearchParams {
  const params = new URLSearchParams({ limit: "50" });
  if (filters) params.set("filters", JSON.stringify(ctx.filters));
  return params;
}
/** Text-only prose with numeric runs in the dashboard's number face. */
export function analysisProse(ctx: ViewContext, text: string, className = "muted"): HTMLElement {
  const p = element(ctx.document, "p", undefined, className);
  p.append(evidenceText(ctx.document, text));
  return p;
}
export function signedGap(value: number | null): string {
  if (value === null) return "unavailable";
  const rounded = Math.round(Math.abs(value)) * Math.sign(value);
  return `${rounded > 0 ? "+" : ""}${formatTokens(Object.is(rounded, -0) ? 0 : rounded)} AIC`;
}
/** Native signed whole-AIC gaps; geometry uses unrounded DTO values. */
export function gapChart(ctx: ViewContext, title: string, points: readonly ChartPoint[], gapBasis: "published" | "calibrated" | "back-applied" = "published"): HTMLElement {
  return chartWithTable(ctx.document, { view: "reconciliation", section: `gap:${gapBasis}`, title, points, unit: "gap-aic", gapBasis });
}
type Pager<T> = { title: string; param: string; next(data: T): string | null };
/** Shared request fencing and visible/active timer; keyset state belongs to pager.ts. */
export async function mountAnalysis<T>(ctx: ViewContext, options: {
  title: string; path: string; params(): URLSearchParams;
  render(data: T): { summary?: HTMLElement; panels: readonly HTMLElement[] }; pages: readonly Pager<T>[];
  choices?: readonly { label: string; select(): void }[];
}): Promise<MountedView> {
  if (ctx.signal.aborted) return { dispose() {} };
  const { document } = ctx, section = element(document, "section"); section.append(element(document, "h1", options.title));
  const controls = element(document, "div", undefined, "view-actions"), summary = element(document, "div", undefined, "overview-evidence");
  let disposed = false, sequence = 0, controller: AbortController | undefined;
  let lastActivity = Date.now(), loading = false, shutdown = false, paused = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let queuedChoice: number | undefined;
  const pages = options.pages.map((spec, index) => ({ spec, pager: createPager(document, { ...spec, clearFilters: ctx.clearFilters, onLoad() { void refresh(true, index); } }) }));
  const refreshButton = action(document, "Refresh", () => { void refresh(true); }); controls.append(refreshButton);
  function selectChoice(i: number): void {
    if (loading) { queuedChoice = i; return; }
    const choice = options.choices![i]!;
    choice.select(); for (const page of pages) page.pager.reset();
    for (const [index, node] of choices.entries()) node.setAttribute("aria-pressed", String(index === i));
    void refresh(true);
  }
  const choices = (options.choices ?? []).map((choice, i) => {
    const button = action(document, choice.label, () => selectChoice(i));
    button.setAttribute("aria-pressed", String(i === 0)); return button;
  });
  controls.append(...choices); section.append(controls, summary, ...pages.map(p => p.pager.region)); ctx.root.append(section);
  // A joint endpoint may refresh multiple lists, but only the initiating lane
  // speaks or gains a failed target. View-wide actions use the first lane.
  async function refresh(announce: boolean, initiator?: number, preserveFocus = false): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    if (paused) resume();
    ctx.requestStarted?.();
    controller?.abort(); controller = new AbortController(); const current = ++sequence;
    const target = initiator ?? 0;
    loading = true; pages.forEach((page, i) => page.pager.busy(announce && i === target, announce && i !== target, preserveFocus));
    const params = options.params();
    const requests = pages.map(page => {
      const cursorParams = new URLSearchParams();
      return { pin: page.pager.request(cursorParams), cursorParams };
    });
    const pinned = initiator === undefined ? requests.find(request => request.pin)?.pin : requests[target]!.pin;
    const period = pinned ?? ctx.period;
    // One endpoint has one period. Exclude incompatible pinned lanes entirely,
    // including their response panels, rather than send a cursor with another pin.
    const included = requests.map(request => !request.pin || (request.pin.start === period.start && request.pin.end === period.end));
    requests.forEach((request, i) => { if (included[i]) request.cursorParams.forEach((value, key) => params.set(key, value)); });
    params.set("start", String(period.start)); params.set("end", String(period.end));
    try {
      const response = await ctx.client.get<T>(options.path, params, controller.signal);
      if (disposed || ctx.signal.aborted || current !== sequence) return;
      shutdown = false;
      const rendered = options.render(response.data); updateEvidence(summary, ...(rendered.summary ? [rendered.summary] : []));
      pages.forEach((page, i) => {
        if (!included[i]) { page.pager.cancel(); return; }
        updateEvidence(page.pager.content, rendered.panels[i]!);
        page.pager.accept(response.period, page.spec.next(response.data), announce && (initiator === undefined || i === target)); page.pager.complete(response.generatedAt, announce && i === target);
      });
    } catch (error) {
      if (disposed || ctx.signal.aborted || current !== sequence) return;
      // Each cursor in this request may be stale. Clear all affected cursors
      // before the single recovery request, so none is ever resent.
      const resets = pages.map((page, i) => included[i] && page.pager.recover(error));
      const recovered = resets.some(Boolean);
      if (recovered) {
        const titles = pages.filter((_, i) => resets[i]).map(page => page.spec.title);
        const prefix = resets[target] && titles.length === 1 ? "" : `${titles.join(", ")}: `;
        pages[target]!.pager.notice(`${prefix}Page link no longer valid. Showing page 1.`, announce);
        void refresh(announce, initiator); return;
      }
      shutdown = !canRetry(error) || (error instanceof DashboardClientError && ["server-unavailable", "unauthorized"].includes(error.code));
      pages.forEach((page, i) => { if (i === target) page.pager.fail(error, announce); else page.pager.cancel(!announce && included[i] ? error : undefined); });
    } finally {
      if (current === sequence) {
        loading = false;
        if (queuedChoice !== undefined) { const choice = queuedChoice; queuedChoice = undefined; selectChoice(choice); }
      }
    }
  }
  const activity = () => { lastActivity = Date.now(); };
  document.addEventListener("keydown", activity); document.addEventListener("pointerdown", activity);
  const focusedControl = (): boolean => {
    let node = document.activeElement;
    if (!summary.contains(node) && !pages.some(page => page.pager.content.contains(node))) return false;
    while (node && node !== section) {
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(node.tagName.toUpperCase()) || node.getAttribute("contenteditable") === "true") return true;
      node = node.parentElement;
    }
    return false;
  };
  function resume(): void {
    if (disposed || ctx.signal.aborted) return;
    paused = false; lastActivity = Date.now(); clearInterval(timer);
    timer = setInterval(() => {
    const idle = ctx.idleMs?.() ?? Date.now() - lastActivity;
    if (!disposed && !shutdown && !loading && document.visibilityState === "visible" && idle >= 10000 && idle < 300000 && !focusedControl()) void refresh(false);
    }, 60000);
  }
  resume();
  const dispose = () => { if (disposed) return; disposed = true; ++sequence; clearInterval(timer); document.removeEventListener("keydown", activity); document.removeEventListener("pointerdown", activity); controller?.abort(); ctx.signal.removeEventListener("abort", dispose); section.remove(); };
  ctx.signal.addEventListener("abort", dispose, { once: true });
  void refresh(true); return { dispose, resume, refresh() { if (!loading) void refresh(true, undefined, true); }, suspend(abort) {
    paused = true; clearInterval(timer); timer = undefined;
    if (abort) { ++sequence; controller?.abort(); loading = false; pages.forEach(page => page.pager.cancel()); }
  } };
}
