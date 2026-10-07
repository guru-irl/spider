import type { UsageMeasure, CalibrationResult } from "../dashboard-contract.js";
import type { CacheData, CacheComponent, CacheWriteSplit } from "../query-cache.js";
import type { ViewContext, MountedView } from "./views.js";
import { action, element } from "./dom.js";
import { chartWithTable } from "./charts.js";
import { dateField, calibrationText, formatAicDisplay, formatEstimatedAic, tokenList, tokenCell } from "./format.js";
import { analysisEvidence, analysisPercent, analysisTable, analysisParams, mountAnalysis, counted, analysisProse } from "./analysis-shared.js";

function splitTable(ctx: ViewContext, title: string, split: CacheWriteSplit): HTMLElement {
  return analysisTable(ctx, title, ["Observation", "Recorded tokens and evidence"], [
    ["5-minute writes", `${counted(split.cacheWrite5m, "token")}`], ["1-hour writes", `${counted(split.cacheWrite1h, "token")}`],
    ["Unknown split", `${counted(split.unknownTokens, "token")}; ${counted(split.unknownCalls, "call")}`],
    ["Known split evidence", `${counted(split.knownTokens, "token")}; ${counted(split.knownCalls, "call")}`],
  ]);
}
const componentNames = { input: "Input", cacheRead: "Cache read", cacheWrite: "Cache write", output: "Output" };
function componentTable(ctx: ViewContext, title: string, components: readonly CacheComponent[], fit: CalibrationResult, unpriced: number): HTMLElement {
  return analysisTable(ctx, title, ["Component", "Primary AIC (approximate)", "Published estimate", "Recorded tokens"], components.map(component => {
    const aic = formatAicDisplay(component.aicDisplay, unpriced, fit);
    return [componentNames[component.tokenType], aic.primary, aic.secondary, `${counted(component.tokens, "token")}`];
  }));
}
function renderCache(ctx: ViewContext, data: CacheData) {
  const { document } = ctx, root = element(document, "div", undefined, "overview-evidence");
  root.append(element(document, "p", "Provisional session observations, not an item-reuse claim. Ongoing or incomplete sessions can gain recorded reads later.", "muted"),
    element(document, "p", `Item reuse: ${data.itemReuse.message}`, "muted"),
    element(document, "p", data.ingestPending ? "Pending ingestion. Session observations are provisional." : "No pending ingestion recorded. Session observations remain provisional.", "muted"));
  const aic = formatAicDisplay(data.totals.aicDisplay, data.totals.unpricedCalls, data.calibration);
  root.append(analysisProse(ctx, calibrationText(document, data.calibration, data.totals.aicDisplay.basis), "calibration-evidence"));
  root.append(analysisTable(ctx, "Selected usage and warmer", ["Observation", "Primary AIC (approximate)", "Published estimate", "Tokens (subsets not additive)", "Evidence"],
    [["Selected usage", data.totals], ["Warmer (subset)", data.warmer]].map(([label, value]) => {
      const measure = value as UsageMeasure, display = formatAicDisplay(measure.aicDisplay, measure.unpricedCalls, data.calibration);
      return [label as string, display.primary, display.secondary, tokenList(document, measure.tokens), analysisEvidence(measure)];
    })));
  root.append(analysisProse(ctx, `Cache hit rate: ${analysisPercent(data.hitRate)} of selected prompt tokens. Warmer shares: prompt ${analysisPercent(data.warmerShare.prompt)}; calls ${analysisPercent(data.warmerShare.calls)}; published AIC ${analysisPercent(data.warmerShare.publishedAic)}. Warmer is a subset, not additional usage.`, "muted"));
  root.append(componentTable(ctx, "Token components", data.components, data.calibration, data.totals.unpricedCalls),
    splitTable(ctx, "Cache write split", data.writeSplit), componentTable(ctx, "Warmer token components", data.warmerComponents, data.calibration, data.warmer.unpricedCalls), splitTable(ctx, "Warmer cache write split", data.warmerWriteSplit));
  const daily = element(document, "div", undefined, "overview-evidence"), sessions = element(document, "div", undefined, "overview-evidence");
  const charts = element(document, "div", undefined, "small-multiples");
  charts.append(chartWithTable(document, { view: "cache", section: "daily-hit-rate", title: "Daily cache hit rate", unit: "percent", points: data.daily.rows.map(day => ({ start: day.start, end: day.end, label: day.label, labelDate: "day", value: day.hitRate === null ? null : day.hitRate * 100, tokens: day.measure.tokens, note: "Cache reads / prompt tokens; daily weighted rate, not item reuse" })) }));
  for (const warmer of [false, true]) for (const basis of ["calibrated", "back-applied", "published"] as const) {
    const rows = data.daily.rows.filter(day => (warmer ? day.warmer : day.measure).aicDisplay.basis === basis);
    if (!rows.length) continue;
    charts.append(chartWithTable(document, { view: "cache", section: `daily:${warmer ? "warmer" : "usage"}:${basis}`, title: `Daily ${warmer ? "warmer" : "usage"} · ${basis === "back-applied" ? "calibrated, back-applied" : basis}`, calibrationStatus: data.calibration.status, unit: basis === "published" ? "estimated-aic" : basis === "back-applied" ? "back-applied-aic" : "calibrated-aic", points: rows.map(day => {
      const measure = warmer ? day.warmer : day.measure;
      return { start: day.start, end: day.end, label: day.label, labelDate: "day", value: measure.aicDisplay.primaryAic, tokens: measure.tokens, lowerBound: measure.unpricedCalls > 0,
        note: `${formatAicDisplay(measure.aicDisplay, measure.unpricedCalls, data.calibration).primary} · ${basis === "back-applied" ? "calibrated, back-applied" : basis} · ${formatEstimatedAic(measure.aicDisplay.publishedAic, measure.unpricedCalls)} · ${analysisEvidence(measure)}` };
    }) }));
  }
  daily.append(charts);
  daily.append(analysisTable(ctx, "Daily cache write split", ["UTC day", "5-minute writes", "1-hour writes", "Unknown split", "Known split evidence"], data.daily.rows.flatMap(day => {
    const warmer = element(document, "span"); warmer.append(dateField(document, day.label), element(document, "span", " · warmer (subset)"));
    return [[dateField(document, day.label), day.writeSplit], [warmer, day.warmerWriteSplit]].map(([label, value]) => {
      const split = value as CacheWriteSplit;
      return [label as HTMLElement, `${counted(split.cacheWrite5m, "token")}`, `${counted(split.cacheWrite1h, "token")}`, `${counted(split.unknownTokens, "token")}; ${counted(split.unknownCalls, "call")}`, `${counted(split.knownTokens, "token")}; ${counted(split.knownCalls, "call")}`];
    });
  })));

  sessions.append(analysisTable(ctx, data.observation, ["Session", "Project", "Primary AIC (approximate)", "Published estimate", "Tokens (subsets not additive)", "Evidence", "Detail"], data.sessionsWithWritesNoReads.rows.map(row => {
    const display = formatAicDisplay(row.measure.aicDisplay, row.measure.unpricedCalls, data.calibration);
    return [row.sessionLabel, row.projectLabel ?? "Unknown", display.primary, display.secondary, tokenCell(document, row.measure.tokens), `Provisional · ${analysisEvidence(row.measure)}`,
      row.sessionId === null ? "No supported session id" : action(document, `Open session: ${row.sessionLabel}`, () => { if (!ctx.signal.aborted) ctx.navigate({ view: "session", id: row.sessionId!, filters: ctx.filters }); })];
  })));
  return { summary: root, panels: [daily, sessions] };
}
export function mountCache(ctx: ViewContext): Promise<MountedView> {
  return mountAnalysis<CacheData>(ctx, { title: "Cache", path: "/api/cache", params: () => analysisParams(ctx), render: data => renderCache(ctx, data),
    pages: [{ title: "Daily cache observations", param: "dailyCursor", next: data => data.daily.nextCursor }, { title: "Session observations", param: "cursor", next: data => data.sessionsWithWritesNoReads.nextCursor }] });
}
