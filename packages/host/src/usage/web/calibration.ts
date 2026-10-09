import type { Period } from "../dashboard-contract.js";
import type { CalibrationData, Collector, DashboardPage, DashboardPageContext } from "../dashboard-v4-contract.js";
import { action, element, sectionState, updateEvidence } from "./dom.js";
import { chartPair, creditStep } from "./charts.js";
import { renderTable, tableRegion } from "./tables.js";
import { formatUtcTime } from "./format.js";
import { canRetry, errorCopy, shouldStopPolling } from "./client.js";
import "./calibration.css";

const numbers = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const factor = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ratio = new Intl.NumberFormat("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const precision = (n: number | null, formatter: Intl.NumberFormat) => n === null || !Number.isFinite(n) ? "unavailable" : formatter.format(n);
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const short = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const amount = (n: number | null) => n === null || !Number.isFinite(n) ? "unavailable" : numbers.format(n);
const headline = (n: number | null) => n === null || !Number.isFinite(n) ? "unavailable" : n >= 1000 ? compact.format(n).replace("K", "k") : short.format(n);
const statusLabels: Record<CalibrationData["correction"]["status"], string> = {
  calibrated: "Calibrated", "back-applied": "Back-applied", "published-only": "Published only", "counter-unavailable": "Counter unavailable",
};
const collectors: Record<Collector, string> = { "this-session": "This pi session", "another-session": "Another pi session", "dashboard-server": "Dashboard server", none: "None" };
function utcDay(ts: number): string { return formatUtcTime(ts).replace(/ \d\d:\d\d UTC$/, " UTC"); }
function stamp(document: Document, ts: number | null, day = false): HTMLElement {
  if (ts === null) return element(document, "span", "unavailable");
  const node = element(document, "time", day ? utcDay(ts) : formatUtcTime(ts), "mono");
  node.setAttribute("datetime", new Date(ts).toISOString()); node.setAttribute("title", new Date(ts).toISOString()); return node;
}
function fact(document: Document, label: string, value: string | HTMLElement, note = ""): HTMLElement {
  const node = element(document, "div", undefined, "data-stat");
  node.append(element(document, "span", label, "fact-label"));
  if (typeof value === "string") node.append(element(document, "span", value, value === "unavailable" ? "stat-value unavailable-value" : "stat-value mono")); else node.append(value);
  if (note) node.append(element(document, "small", note)); return node;
}
function section(document: Document, title: string, cls: string): HTMLElement {
  const node = element(document, "section", undefined, cls); node.setAttribute("aria-labelledby", `calibration-${cls}-title`);
  const heading = element(document, "h2", title); heading.id = `calibration-${cls}-title`;
  const head = element(document, "div", undefined, "section-head"); head.append(heading); node.append(head); return node;
}
function bodyEmpty(document: Document, node: HTMLElement, message: string): void {
  const body = element(document, "div"); sectionState(body, "empty", message); node.setAttribute("aria-busy", "false"); node.append(body);
}
function chip(document: Document, label: string, value: string): HTMLElement {
  const node = element(document, "span", undefined, "stat-chip"); node.append(element(document, "span", label), element(document, "span", value, "mono")); return node;
}
function evidenceTable(document: Document, cls: string, caption: string, columns: string[], rows: (string | HTMLElement)[][]): HTMLTableElement {
  const table = renderTable(document, { caption, columns, rows }); table.className += ` ${cls}`; return table;
}
type IntervalExpansion = { count: number | undefined; limit: number };
function dailyChart(document: Document, daily: CalibrationData["daily"]): SVGElement {
  const ns = "http://www.w3.org/2000/svg";
  function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
    const node = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); if (text !== undefined) node.textContent = text; return node;
  }
  const chart = svg("svg", { viewBox: "0 0 1200 284", class: "correction-chart", role: "img" });
  chart.append(svg("title", {}, "Daily published estimate and account counter, credits, UTC"));
  const left = 60, right = 1180, bottom = 236, top = 24;
  const max = Math.max(0, ...daily.flatMap(d => [d.publishedEstimate ?? 0, d.counterDelta ?? 0]));
  const step = creditStep(max), ceiling = step * 3, y = (value: number) => bottom - value / ceiling * (bottom - top), slot = (right - left) / daily.length;
  const axisNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
  chart.append(svg("text", { x: left, y: 15 }, "credits"));
  for (let i = 0; i <= 3; ++i) {
    const value = step * i;
    chart.append(svg("line", { x1: left, x2: right, y1: y(value), y2: y(value), class: "correction-grid" }), svg("text", { x: left - 10, y: y(value) + 4, "text-anchor": "end", class: "correction-axis" }, axisNumber.format(value).replace("K", "k")));
  }
  for (const [index, day] of daily.entries()) {
    const centre = left + (index + 0.5) * slot, width = Math.min(26, slot * 0.22);
    for (const [series, value, x] of [["published", day.publishedEstimate, centre - width - 4], ["counter", day.counterDelta, centre + 4]] as const) {
      if (value === null) {
        chart.append(svg("path", { d: `M${x} ${bottom - 2}h${width}`, class: "correction-gap" }), svg("text", { x: x + width / 2, y: bottom - 10, "text-anchor": "middle", class: "correction-gap-label" }, "gap"));
      } else {
        const bar = svg("path", { d: `M${x} ${bottom}V${y(value)}h${width}V${bottom}Z`, class: `correction-bar ${series}-bar`, "data-series": series, "data-day": day.day, "data-value": value });
        bar.append(svg("title", {}, `${utcDay(day.day)} · ${series === "counter" ? "Account counter" : "Published estimate"}: ${amount(value)} credits`)); chart.append(bar);
      }
    }
    // Avoid overlapping labels for long daily windows; the table retains every date.
    if (index % Math.max(1, Math.ceil(daily.length / 10)) === 0 || index === daily.length - 1) chart.append(svg("text", { x: centre, y: bottom + 27, "text-anchor": "middle", class: "correction-axis" }, utcDay(day.day).replace(/ UTC$/, "")));
  }
  return chart;
}
function correction(document: Document, data: CalibrationData, empty: boolean, root: HTMLElement, expansion: IntervalExpansion, period: Period): HTMLElement {
  if (expansion.count !== data.intervals.length) { expansion.count = data.intervals.length; expansion.limit = 10; }
  const node = section(document, "Correction", "correction-section");
  if (empty) { bodyEmpty(document, node, "No correction data yet."); return node; }
  const c = data.correction, stats = element(document, "div", undefined, "data-stats correction-stats");
  const pill = element(document, "span", statusLabels[c.status], `state-pill status-${c.status}`);
  pill.setAttribute("data-status", c.status);
  const windowHours = Math.max(0, period.end - period.start) / 3_600_000;
  const windowDays = windowHours / 24;
  const windowLabel = c.status === "counter-unavailable" || c.status === "published-only" ? "Published estimate only" : `Trailing ${headline(windowDays)} ${windowDays === 1 ? "day" : "days"}`;
  stats.append(fact(document, "Correction factor", precision(c.factor, factor), "Published × factor"), fact(document, "Published estimate", amount(c.publishedEstimate), "credits · matched intervals"), fact(document, "Account counter", amount(c.accountCounter), "credits · same intervals"), fact(document, "Hours covered", headline(c.coveredHours), `of ${headline(windowHours)} hours`), fact(document, "Status", pill, windowLabel));
  const method = c.status === "counter-unavailable" ? "The account counter is unavailable. Credits use the last accepted factor, or published rates when no factor exists."
    : c.status === "published-only" ? "Credits use published rates without a correction factor."
    : c.status === "back-applied" ? "The earliest accepted factor is applied to earlier usage. Matched counter intervals determine the factor."
    : "Credits use published estimates multiplied by the correction factor. The factor comes from matched counter intervals.";
  const copy = element(document, "p", method, "method-copy");
  if (data.daily.length) {
    const days = [...data.daily].sort((a, b) => a.day - b.day);
    const table = evidenceTable(document, "daily-table", "Daily published estimates and observed account counter deltas, credits (UTC)", ["Day · UTC", "Published estimate", "Account counter"], days.map(d => [stamp(document, d.day, true), amount(d.publishedEstimate), amount(d.counterDelta)]));
    const pair = chartPair(document, { id: "calibration-correction", title: "Correction", svg: dailyChart(document, days), table });
    const [head, graphic, region] = Array.from(pair.children) as HTMLElement[];
    const title = head!.firstElementChild as HTMLElement; title.id = "calibration-correction-section-title";
    const legend = element(document, "div", undefined, "counter-legend");
    legend.append(element(document, "span", "Published estimate", "legend-key published-key"), element(document, "span", "Account counter", "legend-key counter-key"), chip(document, "Time zone", "UTC"));
    graphic!.replaceChildren(legend, ...Array.from(graphic!.children));
    pair.replaceChildren(head!, stats, copy, graphic!, region!); node.replaceChildren(pair);
  } else { node.append(stats, copy); bodyEmpty(document, node, "No daily observations yet."); }
  node.append(element(document, "p", "Observed intervals are grouped by their ending UTC day, not exact calendar-day billing.", "correction-note"));
  const subhead = element(document, "div", undefined, "subsection-head"), summary = element(document, "div", undefined, "summary-chips");
  summary.append(chip(document, "Intervals", amount(data.intervals.length)), chip(document, "Time zone", "UTC")); subhead.append(element(document, "h3", "Counter snapshot intervals"), summary); node.append(subhead);
  if (!data.intervals.length) { bodyEmpty(document, node, "No counter intervals available."); return node; }
  const intervals = [...data.intervals].sort((a, b) => b.end - a.end || b.start - a.start), holder = element(document, "div", undefined, "intervals-holder");
  const note = element(document, "p", "", "interval-note");
  // updateEvidence retains controls. Refreshed callbacks must target the live
  // holder, not the incoming render tree that reconciliation discards.
  function live(cls: string, parent: Element = root): HTMLElement | undefined {
    if ((parent.getAttribute("class") ?? "").split(" ").includes(cls)) return parent as HTMLElement;
    for (const child of Array.from(parent.children)) { const found = live(cls, child); if (found) return found; }
    return undefined;
  }
  const more = action(document, "Show more", () => {
    if (expansion.limit >= intervals.length) return;
    expansion.limit = Math.min(expansion.limit + 10, intervals.length);
    const control = live("intervals-more") as HTMLButtonElement | undefined;
    paint(live("intervals-holder") ?? holder, control ?? more, live("interval-note") ?? note);
    (control ?? more).setAttribute("aria-expanded", "true");
  });
  more.className += " intervals-more";
  more.setAttribute("aria-expanded", String(expansion.limit > 10));
  function paint(target: HTMLElement = holder, control: HTMLButtonElement = more, summary: HTMLElement = note): void {
    const table = evidenceTable(document, "intervals-table", "Counter snapshot intervals, newest first (UTC)", ["Start · UTC", "End · UTC", "Counter delta", "Published estimate", "Ratio"], intervals.slice(0, expansion.limit).map(i => [stamp(document, i.start), stamp(document, i.end), amount(i.counterDelta), amount(i.publishedEstimate), precision(i.ratio, ratio)]));
    updateEvidence(target, tableRegion(document, table));
    const exhausted = expansion.limit >= intervals.length;
    control.setAttribute("aria-disabled", String(exhausted)); control.textContent = exhausted ? `All ${intervals.length} shown` : "Show more";
    summary.textContent = `Newest first. Showing ${Math.min(expansion.limit, intervals.length)} of ${intervals.length} ${intervals.length === 1 ? "interval" : "intervals"}.`;
  }
  paint(); const tableNote = element(document, "div", undefined, "table-note"); if (intervals.length > 10) tableNote.append(more); tableNote.append(note); node.append(holder, tableNote); return node;
}
function rates(document: Document, data: CalibrationData, empty: boolean): HTMLElement {
  const node = section(document, "Rates", "rates-section");
  if (empty) { bodyEmpty(document, node, "No usage data yet."); return node; }
  node.firstElementChild!.append(chip(document, "Unit", "Credits per 1M tokens"));
  if (data.rates.length) node.append(tableRegion(document, evidenceTable(document, "rates-table", "Published rates in credits per 1M tokens", ["Model", "Tier", "Above prompt tokens", "Input", "Cache read", "Cache write", "Output", "Source date"], data.rates.map(r => [r.model, r.tier, amount(r.abovePromptTokens), amount(r.input), amount(r.cacheRead), amount(r.cacheWrite), amount(r.output), r.sourceDate]))));
  else bodyEmpty(document, node, "No published rates available.");
  const unpriced = element(document, "div", undefined, "unpriced-models"); unpriced.append(element(document, "h3", "Unpriced models"));
  if (!data.unpricedModels.length) unpriced.append(element(document, "p", "No unpriced models.", "muted"));
  else unpriced.append(tableRegion(document, evidenceTable(document, "unpriced-table", "Unpriced models", ["Model", "Calls", "Reason"], data.unpricedModels.map(m => [m.model ?? "unavailable", `${amount(m.calls)} ${m.calls === 1 ? "call" : "calls"}`, m.reason]))));
  node.append(unpriced); return node;
}
function ingestion(document: Document, data: CalibrationData, empty: boolean): HTMLElement {
  const node = section(document, "Ingestion", "ingestion-section");
  if (empty) { bodyEmpty(document, node, "No ingestion data yet."); return node; }
  const ingest = data.ingestion, stats = element(document, "div", undefined, "data-stats ingestion-stats");
  stats.append(fact(document, "Collector", element(document, "span", collectors[ingest.collector], "state-pill")), fact(document, "Last ingest", stamp(document, ingest.lastIngestAt)), fact(document, "Files tracked", headline(ingest.filesTracked)), fact(document, "Calls today", headline(ingest.callsToday)), fact(document, "Errors", headline(ingest.errors)));
  node.append(stats, element(document, "h3", "Collection errors", "subsection-title"));
  const errors = element(document, "div", undefined, "errors-list");
  if (!data.errors.length) errors.append(element(document, "p", "No collection errors.", "empty-errors"));
  else errors.append(tableRegion(document, evidenceTable(document, "errors-table", "Collection errors with redacted paths", ["Source", "Code", "Count", "Last checked · UTC"], data.errors.map(e => [e.pathLabel, e.code, amount(e.count), stamp(document, e.lastCheckedAt)]))));
  node.append(errors, element(document, "h3", "Data gaps", "subsection-title"));
  const gaps = element(document, "div", undefined, "data-stats gaps-stats");
  gaps.append(fact(document, "Unpriced calls", headline(data.gaps.unpricedCalls)), fact(document, "Compaction without model", headline(data.gaps.compactionWithoutModel)), fact(document, "Days without counter", headline(data.gaps.daysWithoutCounter.length)));
  node.append(gaps);
  if (data.gaps.daysWithoutCounter.length) {
    const days = element(document, "div", undefined, "counter-gap-days"); for (const day of [...data.gaps.daysWithoutCounter].sort((a, b) => a - b)) days.append(chip(document, "", utcDay(day))); node.append(days);
  }
  return node;
}
function noData(data: CalibrationData): boolean {
  return !data.daily.length && !data.intervals.length && data.correction.publishedEstimate === null && data.correction.accountCounter === null && data.correction.factor === null && !data.unpricedModels.length && !data.errors.length && data.ingestion.lastIngestAt === null && data.ingestion.filesTracked === 0 && data.ingestion.callsToday === 0 && data.ingestion.errors === 0 && data.gaps.unpricedCalls === 0 && data.gaps.compactionWithoutModel === 0 && !data.gaps.daysWithoutCounter.length;
}
export function mountCalibration(ctx: DashboardPageContext): DashboardPage {
  const { document, root } = ctx;
  let disposed = false, generation = 0, active: AbortController | undefined, painted = false;
  const expansion: IntervalExpansion = { count: undefined, limit: 10 };
  const heading = element(document, "div", undefined, "calibration-heading"); heading.append(element(document, "h1", "Calibration & data"));
  root.className += " calibration-page"; root.replaceChildren(heading);
  function stop(): void { active?.abort(); }
  ctx.signal.addEventListener("abort", stop, { once: true });
  async function refresh(): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    const gen = ++generation; active?.abort(); const controller = new AbortController(); active = controller;
    root.setAttribute("aria-busy", "true");
    if (!painted) { const loading = element(document, "div", undefined, "calibration-loading"); sectionState(loading, "loading", "Loading calibration data…"); root.replaceChildren(heading, loading); }
    try {
      const response = await ctx.client.get<CalibrationData>("/api/calibration", new URLSearchParams(), controller.signal);
      if (disposed || ctx.signal.aborted || controller.signal.aborted || generation !== gen) return;
      const data = response.data, empty = noData(data);
      const facts = element(document, "div", undefined, "summary-chips");
      const days = Math.max(0, response.period.end - response.period.start) / 86400000;
      facts.append(chip(document, "Source", data.source), chip(document, "Window", `${headline(days)} ${days === 1 ? "day" : "days"}`));
      heading.replaceChildren(element(document, "h1", "Calibration & data"), facts);
      updateEvidence(root, heading, correction(document, data, empty, root, expansion, response.period), rates(document, data, empty), ingestion(document, data, empty)); painted = true;
    } catch (failure) {
      if (disposed || ctx.signal.aborted || controller.signal.aborted || generation !== gen) return;
      const error = element(document, "div", undefined, "calibration-error"); sectionState(error, "error", errorCopy(failure), canRetry(failure) && !shouldStopPolling(failure) ? () => { void refresh(); } : undefined); root.replaceChildren(heading, error); painted = false;
    } finally { if (!disposed && !ctx.signal.aborted && gen === generation) root.setAttribute("aria-busy", "false"); }
  }
  void refresh();
  return { refresh, dispose() { disposed = true; ++generation; stop(); ctx.signal.removeEventListener("abort", stop); root.className = root.className.replace(/\bcalibration-page\b/g, "").trim(); } };
}
