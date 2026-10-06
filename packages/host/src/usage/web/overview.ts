import type { OverviewData, OverviewBreakdown, UsageMeasure, CalibrationResult, TokenTotals, AicDisplay, DashboardStatus, Page, SourceErrorRow } from "../dashboard-contract.js";
import type { ViewContext, MountedView } from "./views.js";
import { action, element, liveMessage } from "./dom.js";
import { formatAicDisplay, formatEstimatedAic, formatTokens, tokenObservation } from "./format.js";
import { chartWithTable, type ChartPoint } from "./charts.js";
import { renderTable, tableRegion } from "./tables.js";
import { canRetry, errorCopy, DashboardClientError } from "./client.js";

function qualifiers(measure: Pick<UsageMeasure, "possibleOverlap" | "possibleUndercount" | "pendingData">): string[] {
  return [measure.possibleOverlap ? "Possible overlap" : "", measure.possibleUndercount ? "Possible undercount" : "", measure.pendingData ? "Pending data" : ""].filter(Boolean);
}
function evidence(measure: UsageMeasure): string {
  return [`${formatTokens(measure.calls)} calls; ${formatTokens(measure.unpricedCalls)} unpriced; ${formatTokens(measure.aggregateCalls)} aggregate`, ...qualifiers(measure)].join(" · ");
}
function displayRow(label: string, measure: { aicDisplay: AicDisplay; tokens: TokenTotals }, calibration: CalibrationResult, unpriced: number, note: string): string[] {
  const aic = formatAicDisplay(measure.aicDisplay, unpriced, calibration);
  return [label, aic.primary, aic.secondary, tokenObservation(measure.tokens), note];
}
const columns = ["Observation", "Primary AIC (approximate)", "Published estimate", "Tokens (subsets not additive)", "Evidence"];
function breakdownLabel(row: OverviewBreakdown): string { return row.isOther ? "Other (remaining roles)" : row.label ?? "Unknown"; }
function breakdown(ctx: ViewContext, title: string, rows: readonly OverviewBreakdown[], calibration: CalibrationResult): HTMLElement {
  return tableRegion(ctx.document, renderTable(ctx.document, { caption: title, columns, rows: rows.map(row => displayRow(breakdownLabel(row), row.measure, calibration, row.measure.unpricedCalls, evidence(row.measure))) }));
}
function charts(ctx: ViewContext, data: OverviewData): HTMLElement {
  const root = element(ctx.document, "div", undefined, "small-multiples");
  const draw = (title: string, rows: readonly { start: number; end: number; label: string; measure: UsageMeasure }[]) => {
    // A series can change basis across days. Separate series keep each axis honest,
    // without scaling, summing or replacing unavailable observations with zero.
    for (const basis of ["calibrated", "back-applied", "published"] as const) {
      const selected = rows.filter(row => row.measure.aicDisplay.basis === basis);
      if (!selected.length) continue;
      const points: ChartPoint[] = selected.map(row => ({ start: row.start, end: row.end, label: row.label,
        value: row.measure.aicDisplay.primaryAic, tokens: row.measure.tokens, lowerBound: row.measure.unpricedCalls > 0,
        note: `${formatAicDisplay(row.measure.aicDisplay, row.measure.unpricedCalls, data.calibration).primary} · published estimate ${formatEstimatedAic(row.measure.aicDisplay.publishedAic, row.measure.unpricedCalls).replace(/ published estimate$/, "")} · ${basis === "back-applied" ? "calibrated, back-applied" : basis} · ${evidence(row.measure)}` }));
      root.append(chartWithTable(ctx.document, { title: `${title} · ${basis === "back-applied" ? "calibrated, back-applied" : basis}`, points,
        unit: basis === "published" ? "estimated-aic" : basis === "back-applied" ? "back-applied-aic" : "calibrated-aic" }));
    }
  };
  draw("Daily total", data.daily.rows);
  for (const dimension of ["actors", "roles"] as const) {
    for (const row of data[dimension]) {
      const days = data.daily.rows.flatMap(day => {
        const match = day[dimension].find(item => item.label === row.label && item.isOther === row.isOther);
        return match ? [{ start: day.start, end: day.end, label: day.label, measure: match.measure }] : [];
      });
      draw(`Daily ${dimension === "actors" ? "actor" : "role"} · ${breakdownLabel(row)}`, days);
    }
  }
  return root;
}
function renderOverview(ctx: ViewContext, data: OverviewData): HTMLElement {
  const root = element(ctx.document, "div", undefined, "overview-evidence");
  root.append(element(ctx.document, "p", "AIC is approximate; tokens are recorded. cal = calibrated, ? = unavailable calibration, est = published by config.", "muted"));
  const legend = formatAicDisplay(data.totals.aicDisplay, data.totals.unpricedCalls, data.calibration).legend;
  root.append(element(ctx.document, "p", legend, "calibration-evidence"));
  root.append(tableRegion(ctx.document, renderTable(ctx.document, { caption: "Selected usage", columns,
    rows: [displayRow("Selected period", data.totals, data.calibration, data.totals.unpricedCalls, evidence(data.totals))] })));
  root.append(element(ctx.document, "p", "The counter is account-wide and includes other clients. Billing lags and integer quantization limit comparison. Calibration does not prove exact billing or completeness.", "muted"));
  const comparison = data.comparison;
  const comparisonRows = comparison.computed ? [displayRow("Account window (unfiltered)", comparison.computed, data.calibration, comparison.computed.unpricedCalls,
    `${new Date(comparison.start).toISOString()} to ${new Date(comparison.end).toISOString()} UTC · ${evidence(comparison.computed)}`)] : [];
  root.append(tableRegion(ctx.document, renderTable(ctx.document, { caption: "Account comparison", columns, rows: comparisonRows })));
  root.append(element(ctx.document, "p", comparison.counterAic === null ? "Current account comparison unavailable for this period."
    : `${formatTokens(comparison.counterAic)} AIC counter · published gap ${comparison.gap === null ? "unavailable" : `~${formatTokens(comparison.gap)} AIC`} · published ratio ${comparison.ratio === null ? "unavailable" : `~${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(comparison.ratio)}`}`, "numeric"));
  root.append(breakdown(ctx, "Actors", data.actors, data.calibration), breakdown(ctx, "Roles", data.roles, data.calibration));
  const projected = data.pace.projected;
  root.append(tableRegion(ctx.document, renderTable(ctx.document, { caption: "Month pace", columns, rows: projected ? [displayRow("Linear month-end projection", projected, data.calibration,
    data.totals.unpricedCalls, ["Linear pace, not a forecast", ...qualifiers(projected)].join(" · "))] : [] })));
  root.append(element(ctx.document, "p", projected ? `Counter month-end pace: ${data.pace.counterAic === null ? "unavailable" : `~${formatTokens(data.pace.counterAic)} AIC`}` : "Month pace unavailable for this period.", "muted"));
  root.append(charts(ctx, data));
  return root;
}
function mountHealth(ctx: ViewContext, parent: HTMLElement): { refresh(reset?: boolean): void; dispose(): void; hasFocus(): boolean } {
  const { document } = ctx;
  const root = element(document, "section", undefined, "health-panel"), heading = element(document, "h2", "Ingestion and counter");
  heading.setAttribute("tabindex", "-1"); root.append(heading);
  const health = element(document, "div"), message = liveMessage(document), errors = element(document, "div"), errorMessage = liveMessage(document);
  let disposed = false, statusSequence = 0, errorSequence = 0;
  let statusController: AbortController | undefined, errorController: AbortController | undefined;
  let cursor: string | undefined, nextCursor: string | null = null; const previous: (string | undefined)[] = [];
  const next = action(document, "Next page", () => { if (!nextCursor) return; previous.push(cursor); cursor = nextCursor; void readErrors(); });
  const back = action(document, "Previous page", () => { if (!previous.length) return; cursor = previous.pop(); void readErrors(); });
  const retry = action(document, "Retry", () => { void readErrors(); }); retry.hidden = true;
  const controls = element(document, "div", undefined, "view-actions"); controls.append(back, next, retry); back.disabled = next.disabled = true;
  root.append(health, message, errors, errorMessage, controls); parent.append(root);
  async function readErrors(): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    errorController?.abort(); errorController = new AbortController(); const current = ++errorSequence;
    errorMessage.textContent = "Loading source diagnostics"; if (document.activeElement === retry) heading.focus(); retry.hidden = true; next.disabled = back.disabled = true;
    const params = new URLSearchParams({ limit: "200" }); if (cursor) params.set("cursor", cursor);
    try {
      const response = await ctx.client.get<Page<SourceErrorRow>>("/api/source-errors", params, errorController.signal);
      if (disposed || ctx.signal.aborted || current !== errorSequence) return;
      errors.replaceChildren(tableRegion(document, renderTable(document, { caption: "Source diagnostics", columns: ["Source", "Project", "Code", "Count", "Last checked UTC"], rows: response.data.rows.map(row => [row.sourceLabel, row.projectLabel, row.code, formatTokens(row.count), new Date(row.lastCheckedAt).toISOString()]) })));
      nextCursor = response.data.nextCursor; next.disabled = !nextCursor; back.disabled = !previous.length;
      errorMessage.textContent = response.data.rows.length ? `${response.data.rows.length} source diagnostics on this page` : "No source diagnostics recorded.";
    } catch (error) { if (!disposed && !ctx.signal.aborted && current === errorSequence) { errorMessage.textContent = errorCopy(error); retry.hidden = !canRetry(error); } }
  }
  async function refresh(reset: boolean): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    statusController?.abort(); errorController?.abort(); ++errorSequence;
    statusController = new AbortController(); const current = ++statusSequence;
    message.textContent = "Loading health";
    try {
      const response = await ctx.client.get<DashboardStatus>("/api/status", new URLSearchParams(), statusController.signal);
      if (disposed || ctx.signal.aborted || current !== statusSequence) return;
      const data = response.data, age = (value: number | null) => value === null ? "unavailable" : `${formatTokens(value / 1000)} s`;
      health.replaceChildren(
        element(document, "p", `Ingest role: ${data.ingest.role}`),
        element(document, "p", `Ingest age: ${age(data.ingest.ageMs)} (${data.ingest.stale ? "stale" : "fresh"})`),
        element(document, "p", `Counter age: ${age(data.counter.ageMs)} (${data.counter.availability})`),
        element(document, "p", `Parse errors (recorded): ${formatTokens(data.parseErrors)}`),
        element(document, "p", `Source errors (current): ${formatTokens(data.sourceErrors)}`),
        element(document, "p", `Backfill: ${data.ingest.backfill}${data.ingest.progress ? ` · ${formatTokens(data.ingest.progress.sourcesCompleted)} of ${formatTokens(data.ingest.progress.sourcesTotal)} sources` : ""}`),
        element(document, "p", `Ingest error: ${data.ingest.errorCode ?? "none"}`),
        element(document, "p", `Last ingest UTC: ${data.ingest.lastIngestAt === null ? "unavailable" : new Date(data.ingest.lastIngestAt).toISOString()}`),
        element(document, "p", `Counter observed UTC: ${data.counter.ts === null ? "unavailable" : new Date(data.counter.ts).toISOString()}`),
        element(document, "p", `Server ${data.serverBuild} · schema ${data.schemaVersion} · rates ${data.rateVersions.join(", ")}`, "muted"),
      );
      message.textContent = "Health updated"; if (reset) { cursor = undefined; previous.length = 0; }
      if (data.sourceErrors || data.parseErrors) void readErrors();
      else { errors.replaceChildren(); errorMessage.textContent = "No source diagnostics recorded."; next.disabled = back.disabled = true; retry.hidden = true; }
    } catch (error) { if (!disposed && !ctx.signal.aborted && current === statusSequence) message.textContent = errorCopy(error); }
  }
  return { refresh(reset = true) { void refresh(reset); }, hasFocus() { return root.contains(document.activeElement); }, dispose() { disposed = true; ++statusSequence; ++errorSequence; statusController?.abort(); errorController?.abort(); } };
}
export async function mountOverview(ctx: ViewContext): Promise<MountedView> {
  const { document, root } = ctx;
  const section = element(document, "section", undefined, "overview"), heading = element(document, "h1", "Overview");
  heading.setAttribute("tabindex", "-1"); section.append(heading);
  const message = liveMessage(document), content = element(document, "div");
  let disposed = false, sequence = 0, controller: AbortController | undefined;
  let lastActivity = Date.now(), loading = false, shutdown = false;
  let cursor: string | undefined; const previous: (string | undefined)[] = [];
  const next = action(document, "Next page", () => { if (!nextCursor) return; previous.push(cursor); cursor = nextCursor; void refresh(false); });
  const back = action(document, "Previous page", () => { cursor = previous.pop(); void refresh(false); });
  let nextCursor: string | null = null;
  const refreshButton = action(document, "Refresh", () => { void refresh(true); });
  const retry = action(document, "Retry", () => { void refresh(true); }); retry.hidden = true;
  const clear = action(document, "Clear filters", () => { if (document.activeElement === clear) heading.focus(); if (ctx.clearFilters) ctx.clearFilters(); else ctx.navigate({ view: "overview", filters: [] }); }); clear.hidden = true;
  const controls = element(document, "div", undefined, "view-actions"); controls.append(refreshButton, retry, clear);
  const paging = element(document, "div", undefined, "view-actions"); paging.append(back, next); back.disabled = next.disabled = true;
  section.append(controls, message, content, paging); root.append(section);
  const health = mountHealth(ctx, section);
  async function refresh(reset: boolean, updateHealth = reset): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    if (reset) { cursor = undefined; previous.length = 0; }
    if (updateHealth) health.refresh(reset);
    controller?.abort(); controller = new AbortController();
    const current = ++sequence; loading = true; clear.hidden = true; message.textContent = "Loading usage"; if (document.activeElement === retry) heading.focus(); retry.hidden = true; next.disabled = back.disabled = true;
    const params = new URLSearchParams({ start: String(ctx.period.start), end: String(ctx.period.end), filters: JSON.stringify(ctx.filters) });
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await ctx.client.get<OverviewData>("/api/overview", params, controller.signal);
      if (disposed || ctx.signal.aborted || current !== sequence) return;
      shutdown = false;
      content.replaceChildren(renderOverview(ctx, response.data)); nextCursor = response.data.daily.nextCursor;
      next.disabled = !nextCursor; back.disabled = !previous.length;
      message.textContent = `Updated ${new Date(response.generatedAt).toISOString()} UTC`;
    } catch (error) {
      if (disposed || ctx.signal.aborted || current !== sequence) return;
      clear.hidden = !(error instanceof DashboardClientError && error.code === "unknown-filter-id");
      message.textContent = errorCopy(error, ctx); shutdown = message.textContent === "Run /usage again" || !canRetry(error); retry.hidden = !canRetry(error);
    } finally { if (current === sequence) loading = false; }
  }
  const activity = () => { lastActivity = Date.now(); };
  document.addEventListener("keydown", activity); document.addEventListener("pointerdown", activity);
  const timer = setInterval(() => {
    if (!disposed && !shutdown && !loading && document.visibilityState === "visible" && Date.now() - lastActivity < 300000 && !content.contains(document.activeElement) && !controls.contains(document.activeElement) && !paging.contains(document.activeElement) && !health.hasFocus()) void refresh(false, true);
  }, 60000);
  const dispose = () => { if (disposed) return; disposed = true; ++sequence; clearInterval(timer); document.removeEventListener("keydown", activity); document.removeEventListener("pointerdown", activity); controller?.abort(); health.dispose(); ctx.signal.removeEventListener("abort", dispose); };
  ctx.signal.addEventListener("abort", dispose, { once: true });
  if (ctx.signal.aborted) dispose(); else void refresh(true);
  return { dispose };
}
