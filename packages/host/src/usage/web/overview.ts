import type { Period, OverviewData, OverviewBreakdown, UsageMeasure, CalibrationResult, TokenTotals, AicDisplay, DashboardStatus, Page, SourceErrorRow } from "../dashboard-contract.js";
import type { ViewContext, MountedView } from "./views.js";
import { action, element, liveMessage, updateEvidence } from "./dom.js";
import { formatCallEvidence, calibrationText, formatAicDisplay, formatCount, formatEstimatedAic, formatTokens, readableKey, tokenList, numericText, evidenceText, utcTime, periodTimes, formatRatio, signedGap } from "./format.js";
import { chartWithTable, type ChartPoint } from "./charts.js";
import { renderTable, tableRegion } from "./tables.js";
import { shouldStopPolling, canRetry, errorCopy, DashboardClientError } from "./client.js";

function qualifiers(measure: Pick<UsageMeasure, "possibleOverlap" | "possibleUndercount" | "pendingData">): string[] {
  return [measure.possibleOverlap ? "Possible overlap" : "", measure.possibleUndercount ? "Possible undercount" : "", measure.pendingData ? "Pending data" : ""].filter(Boolean);
}
function evidence(measure: UsageMeasure): string {
  return formatCallEvidence(measure);
}
function displayRow(document: Document, label: string, measure: { aicDisplay: AicDisplay; tokens: TokenTotals }, calibration: CalibrationResult, unpriced: number, note: string | HTMLElement): (string | HTMLElement)[] {
  const aic = formatAicDisplay(measure.aicDisplay, unpriced, calibration);
  return [label, numericText(document, aic.primary), numericText(document, aic.secondary), tokenList(document, measure.tokens), typeof note === "string" ? evidenceText(document, note) : note];
}
const columns = ["Observation", "Primary AIC (approximate)", "Published estimate", "Tokens (subsets not additive)", "Evidence"];
function breakdownLabel(row: OverviewBreakdown): string { return row.isOther ? "Other (remaining roles)" : row.label ?? "Unknown"; }
function breakdown(ctx: ViewContext, title: string, rows: readonly OverviewBreakdown[], calibration: CalibrationResult): HTMLElement {
  return tableRegion(ctx.document, renderTable(ctx.document, { caption: title, columns, rows: rows.map(row => displayRow(ctx.document, breakdownLabel(row), row.measure, calibration, row.measure.unpricedCalls, evidence(row.measure))) }));
}
function charts(ctx: ViewContext, data: OverviewData): HTMLElement {
  const root = element(ctx.document, "div", undefined, "small-multiples");
  const draw = (section: string, title: string, rows: readonly { start: number; end: number; label: string; measure: UsageMeasure }[]) => {
    // A series can change basis across days. Separate series keep each axis honest,
    // without scaling, summing or replacing unavailable observations with zero.
    for (const basis of ["calibrated", "back-applied", "published"] as const) {
      const selected = rows.filter(row => row.measure.aicDisplay.basis === basis);
      if (!selected.length) continue;
      const points: ChartPoint[] = selected.map(row => ({ start: row.start, end: row.end, label: row.label, labelDate: "day",
        value: row.measure.aicDisplay.primaryAic, tokens: row.measure.tokens, lowerBound: row.measure.unpricedCalls > 0,
        note: `${formatAicDisplay(row.measure.aicDisplay, row.measure.unpricedCalls, data.calibration).primary} · published estimate ${formatEstimatedAic(row.measure.aicDisplay.publishedAic, row.measure.unpricedCalls).replace(/ published estimate$/, "")} · ${basis === "back-applied" ? "calibrated, back-applied" : basis} · ${evidence(row.measure)}` }));
      root.append(chartWithTable(ctx.document, { view: "overview", section: `${section}:${basis}`, title: `${title} · ${basis === "back-applied" ? "calibrated, back-applied" : basis}`, points,
        calibrationStatus: data.calibration.status, unit: basis === "published" ? "estimated-aic" : basis === "back-applied" ? "back-applied-aic" : "calibrated-aic" }));
    }
  };
  draw("daily-total", "Daily total", data.daily.rows);
  for (const dimension of ["actors", "roles"] as const) {
    for (const row of data[dimension]) {
      const days = data.daily.rows.flatMap(day => {
        const match = day[dimension].find(item => item.label === row.label && item.isOther === row.isOther);
        return match ? [{ start: day.start, end: day.end, label: day.label, labelDate: "day", measure: match.measure }] : [];
      });
      draw(`${dimension}:${JSON.stringify([row.label, row.isOther])}`, `Daily ${dimension === "actors" ? "actor" : "role"} · ${breakdownLabel(row)}`, days);
    }
  }
  return root;
}
function renderOverview(ctx: ViewContext, data: OverviewData): HTMLElement {
  const root = element(ctx.document, "div", undefined, "overview-evidence");
  root.append(element(ctx.document, "p", "AIC is approximate; tokens are recorded.", "muted"));
  const calibrationEvidence = element(ctx.document, "p", undefined, "calibration-evidence");
  calibrationEvidence.append(calibrationText(ctx.document, data.calibration, data.totals.aicDisplay.basis)); root.append(calibrationEvidence);
  root.append(tableRegion(ctx.document, renderTable(ctx.document, { caption: "Selected usage", columns,
    rows: [displayRow(ctx.document, "Selected period", data.totals, data.calibration, data.totals.unpricedCalls, evidence(data.totals))] })));
  root.append(element(ctx.document, "p", "The counter is account-wide and includes other clients. Billing lags and integer quantization limit comparison. Calibration does not prove exact billing or completeness.", "muted"));
  const comparison = data.comparison;
  const comparisonNote = element(ctx.document, "span");
  if (comparison.computed) comparisonNote.append(periodTimes(ctx.document, comparison.start, comparison.end), element(ctx.document, "span", ` · ${evidence(comparison.computed)}`));
  const comparisonRows = comparison.computed ? [displayRow(ctx.document, "Account window (unfiltered)", comparison.computed, data.calibration, comparison.computed.unpricedCalls, comparisonNote)] : [];
  root.append(tableRegion(ctx.document, renderTable(ctx.document, { caption: "Account comparison", columns, rows: comparisonRows })));
  const counterComparison = element(ctx.document, "p");
  counterComparison.append(numericText(ctx.document, comparison.counterAic === null ? "Current account comparison unavailable for this period."
    : `${formatTokens(comparison.counterAic)} AIC counter · published gap ${signedGap(comparison.gap)} · published ${formatRatio(comparison.ratio)}`));
  root.append(counterComparison);
  root.append(breakdown(ctx, "Actors", data.actors, data.calibration), breakdown(ctx, "Roles", data.roles, data.calibration));
  const projected = data.pace.projected;
  root.append(tableRegion(ctx.document, renderTable(ctx.document, { caption: "Month pace", columns, rows: projected ? [displayRow(ctx.document, "Linear month-end projection", projected, data.calibration,
    data.totals.unpricedCalls, ["Linear pace, not a forecast", ...qualifiers(projected)].join(" · "))] : [] })));
  root.append(element(ctx.document, "p", projected ? `Counter month-end pace: ${data.pace.counterAic === null ? "unavailable" : `~${formatTokens(data.pace.counterAic)} AIC`}` : "Month pace unavailable for this period.", "muted"));
  root.append(element(ctx.document, "h2", "Daily observations"), charts(ctx, data));
  return root;
}
function mountHealth(ctx: ViewContext, parent: HTMLElement): { refresh(reset?: boolean, preserveFocus?: boolean): void; dispose(): void; hasFocus(): boolean; suspend(): void } {
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
  async function readErrors(preserveFocus = false): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    ctx.requestStarted?.();
    errorController?.abort(); errorController = new AbortController(); const current = ++errorSequence;
    errorMessage.textContent = "Loading source diagnostics"; if (!preserveFocus || document.activeElement !== retry) { if (document.activeElement === retry) heading.focus(); retry.hidden = true; } next.disabled = back.disabled = true;
    const params = new URLSearchParams({ limit: "200" }); if (cursor) params.set("cursor", cursor);
    try {
      const response = await ctx.client.get<Page<SourceErrorRow>>("/api/source-errors", params, errorController.signal);
      if (disposed || ctx.signal.aborted || current !== errorSequence) return;
      updateEvidence(errors, tableRegion(document, renderTable(document, { caption: "Source diagnostics", columns: ["Source", "Project", "Code", "Count", "Last checked UTC"], rows: response.data.rows.map(row => [row.sourceLabel, row.projectLabel, readableKey(row.code), numericText(document, formatTokens(row.count)), utcTime(document, row.lastCheckedAt)]) })));
      if (document.activeElement === retry) heading.focus(); retry.hidden = true;
      nextCursor = response.data.nextCursor; next.disabled = !nextCursor; back.disabled = !previous.length;
      errorMessage.textContent = response.data.rows.length ? `${formatCount(response.data.rows.length, "source diagnostic")} on this page` : "No source diagnostics recorded.";
    } catch (error) { if (!disposed && !ctx.signal.aborted && current === errorSequence) { errorMessage.textContent = errorCopy(error); retry.hidden = !canRetry(error); } }
  }
  async function refresh(reset: boolean, preserveFocus: boolean): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    statusController?.abort(); errorController?.abort(); ++errorSequence;
    statusController = new AbortController(); const current = ++statusSequence;
    message.textContent = "Loading health";
    try {
      const response = await ctx.client.get<DashboardStatus>("/api/status", new URLSearchParams(), statusController.signal);
      if (disposed || ctx.signal.aborted || current !== statusSequence) return;
      const data = response.data, age = (value: number | null) => value === null ? "unavailable" : `${formatTokens(value / 1000)} s`;
      const timestampLine = (label: string, value: number | null) => {
        const p = element(document, "p"); p.append(element(document, "span", label), value === null ? element(document, "span", "unavailable") : utcTime(document, value)); return p;
      };
      updateEvidence(health,
        element(document, "p", `Ingest role: ${data.ingest.role}`),
        element(document, "p", `Ingest age: ${age(data.ingest.ageMs)} (${data.ingest.stale ? "stale" : "fresh"})`),
        element(document, "p", `Counter age: ${age(data.counter.ageMs)} (${data.counter.availability})`),
        element(document, "p", `Parse errors (recorded): ${formatTokens(data.parseErrors)}`),
        element(document, "p", `Source errors (current): ${formatTokens(data.sourceErrors)}`),
        element(document, "p", `Backfill: ${data.ingest.backfill}${data.ingest.progress ? ` · ${formatTokens(data.ingest.progress.sourcesCompleted)} of ${formatCount(data.ingest.progress.sourcesTotal, "source")}` : ""}`),
        element(document, "p", `Ingest error: ${data.ingest.errorCode === null ? "none" : readableKey(data.ingest.errorCode)}`),
        timestampLine("Last ingest: ", data.ingest.lastIngestAt),
        timestampLine("Counter observed: ", data.counter.ts),
        element(document, "p", `Server ${data.serverBuild} · schema ${data.schemaVersion} · rates ${data.rateVersions.join(", ")}`, "muted"),
      );
      message.textContent = "Health updated"; if (reset) { cursor = undefined; previous.length = 0; }
      if (data.sourceErrors || data.parseErrors) void readErrors(preserveFocus);
      else { errors.replaceChildren(); errorMessage.textContent = "No source diagnostics recorded."; next.disabled = back.disabled = true; if (document.activeElement === retry) heading.focus(); retry.hidden = true; }
    } catch (error) { if (!disposed && !ctx.signal.aborted && current === statusSequence) message.textContent = errorCopy(error); }
  }
  return { suspend() { ++statusSequence; ++errorSequence; statusController?.abort(); errorController?.abort(); next.disabled = !nextCursor; back.disabled = !previous.length; }, refresh(reset = true, preserveFocus = false) { void refresh(reset, preserveFocus); }, hasFocus() { return root.contains(document.activeElement); }, dispose() { disposed = true; ++statusSequence; ++errorSequence; statusController?.abort(); errorController?.abort(); } };
}
export async function mountOverview(ctx: ViewContext): Promise<MountedView> {
  const { document, root } = ctx;
  const section = element(document, "section", undefined, "overview"), heading = element(document, "h1", "Overview");
  heading.setAttribute("tabindex", "-1"); section.append(heading);
  const message = liveMessage(document), content = element(document, "div");
  let disposed = false, sequence = 0, controller: AbortController | undefined;
  let lastActivity = Date.now(), loading = false, shutdown = false, paused = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pinnedPeriod: Period | undefined;
  let cursor: string | undefined; const previous: (string | undefined)[] = [];
  const next = action(document, "Next page", () => { if (!nextCursor) return; previous.push(cursor); cursor = nextCursor; void refresh(false); });
  const back = action(document, "Previous page", () => { cursor = previous.pop(); void refresh(false); });
  let nextCursor: string | null = null;
  const refreshButton = action(document, "Refresh", () => { void refresh(false, true); });
  const retry = action(document, "Retry", () => { void refresh(true); }); retry.hidden = true;
  const clear = action(document, "Clear filters", () => { if (document.activeElement === clear) heading.focus(); if (ctx.clearFilters) ctx.clearFilters(); else ctx.navigate({ view: "overview", filters: [] }); }); clear.hidden = true;
  const controls = element(document, "div", undefined, "view-actions"); controls.append(refreshButton, retry, clear);
  const paging = element(document, "div", undefined, "view-actions"); paging.append(back, next); back.disabled = next.disabled = true;
  section.append(controls, message, content, paging); root.append(section);
  const health = mountHealth(ctx, section);
  async function refresh(reset: boolean, updateHealth = reset, preserveFocus = false): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    if (paused) resume();
    ctx.requestStarted?.();
    if (reset) { cursor = undefined; previous.length = 0; }
    if (updateHealth) health.refresh(reset, preserveFocus);
    controller?.abort(); controller = new AbortController();
    const current = ++sequence; loading = true; if (!preserveFocus || document.activeElement !== clear) clear.hidden = true; message.textContent = "Loading usage"; if (!preserveFocus || document.activeElement !== retry) { if (document.activeElement === retry) heading.focus(); retry.hidden = true; } next.disabled = back.disabled = true;
    const requestPeriod = cursor && pinnedPeriod ? pinnedPeriod : ctx.period;
    const params = new URLSearchParams({ start: String(requestPeriod.start), end: String(requestPeriod.end), filters: JSON.stringify(ctx.filters) });
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await ctx.client.get<OverviewData>("/api/overview", params, controller.signal);
      if (disposed || ctx.signal.aborted || current !== sequence) return;
      if (document.activeElement === retry) heading.focus(); retry.hidden = true;
      shutdown = false;
      updateEvidence(content, renderOverview(ctx, response.data)); pinnedPeriod = response.period; nextCursor = response.data.daily.nextCursor;
      next.disabled = !nextCursor; back.disabled = !previous.length;
      message.replaceChildren(element(document, "span", "Updated "), utcTime(document, response.generatedAt));
    } catch (error) {
      if (disposed || ctx.signal.aborted || current !== sequence) return;
      clear.hidden = !(error instanceof DashboardClientError && error.code === "unknown-filter-id");
      message.textContent = errorCopy(error, ctx); shutdown = shouldStopPolling(error); retry.hidden = !canRetry(error);
    } finally { if (current === sequence) loading = false; }
  }
  const activity = () => { lastActivity = Date.now(); };
  document.addEventListener("keydown", activity); document.addEventListener("pointerdown", activity);
  function resume(): void {
    if (disposed || ctx.signal.aborted) return;
    paused = false; lastActivity = Date.now(); clearInterval(timer);
    timer = setInterval(() => {
    if (!disposed && !shutdown && !loading && document.visibilityState === "visible" && (ctx.idleMs?.() ?? Date.now() - lastActivity) < 300000 && !content.contains(document.activeElement) && !controls.contains(document.activeElement) && !paging.contains(document.activeElement) && !health.hasFocus()) void refresh(false, true);
    }, 60000);
  }
  resume();
  const dispose = () => { if (disposed) return; disposed = true; ++sequence; clearInterval(timer); document.removeEventListener("keydown", activity); document.removeEventListener("pointerdown", activity); controller?.abort(); health.dispose(); ctx.signal.removeEventListener("abort", dispose); };
  ctx.signal.addEventListener("abort", dispose, { once: true });
  if (ctx.signal.aborted) dispose(); else void refresh(true);
  return { dispose, resume, refresh() { if (!loading) void refresh(false, true, true); }, suspend(abort) {
    paused = true; clearInterval(timer); timer = undefined;
    if (abort) { ++sequence; controller?.abort(); health.suspend(); loading = false; next.disabled = !nextCursor; back.disabled = !previous.length; }
  } };
}
