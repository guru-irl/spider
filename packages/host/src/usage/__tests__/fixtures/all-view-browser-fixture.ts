import type { DashboardBrowserPage } from "./dashboard-browser-fixture.js";
import type { ApiEnvelope, OverviewData, UsageMeasure, CalibrationResult, ContextData } from "../../dashboard-contract.js";
import type { CacheData } from "../../query-cache.js";
import type { RatesData } from "../../query-rates.js";
import type { ReconciliationData } from "../../query-reconciliation.js";
import type { ExplorerData } from "../../query-explorer.js";
import type { DetailData, DetailCall } from "../../query-detail.js";
import type { DashboardRoute } from "../../../../../../scripts/usage-dashboard-screenshot.mjs";
export const acceptanceStates = ["calibrated", "back-applied", "off", "unavailable"] as const;
export function allViewPage(base: DashboardBrowserPage, state: typeof acceptanceStates[number]): DashboardBrowserPage {
  const source = JSON.parse(base.routes["/api/overview"]!.body as string) as ApiEnvelope<OverviewData>;
  const { period } = source;
  const fit: CalibrationResult = { ...source.data.calibration, status: state === "off" ? "off" : state === "unavailable" ? "uncalibrated" : "calibrated",
    factor: state === "off" || state === "unavailable" ? null : 2,
    ...(state === "off" ? { windowStart: null, windowEnd: null, coveredHours: 0, computedAic: 0, counterDelta: 0, unpricedCalls: 0 } : {}) };
  const measure = (original: UsageMeasure): UsageMeasure => ({ ...original, aicDisplay: { ...original.aicDisplay,
    basis: state === "off" || state === "unavailable" ? "published" : state,
    primaryAic: state === "off" || state === "unavailable" ? original.aicDisplay.publishedAic : original.aicDisplay.primaryAic } });
  // Walk the entire DTO, including comparison, actor/role breakdowns and pace.
  const remap = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(remap);
    const object = value as Record<string, unknown>;
    if ("aicDisplay" in object) return measure(value as UsageMeasure);
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, remap(child)]));
  };
  source.data = remap(source.data) as OverviewData;
  const totals = measure(source.data.totals), daily = source.data.daily.rows.map(row => ({ ...row, label: new Date(row.start).toISOString().slice(0, 10), measure: measure(row.measure) }));
  const unavailable = { status: "unavailable", phase: 2, reason: "not-built", message: "Not available yet (Phase 2)" } as const;
  const context: ContextData = { contextFillPercent: null, contextFillMessage: "Context fill unavailable: historical window not recorded", composition: unavailable, carry: unavailable, itemReuse: unavailable };
  const split = { cacheWrite5m: 0, cacheWrite1h: 0, knownTokens: 0, knownCalls: 0, unknownTokens: 0, unknownCalls: 0 };
  const components = (["input", "cacheRead", "cacheWrite", "output"] as const).map(tokenType => ({ tokenType, tokens: totals.tokens[tokenType], aicDisplay: totals.aicDisplay }));
  const cache: CacheData = { ingestPending: false, writeSplit: split, warmerWriteSplit: split, calibration: fit, totals, warmer: totals, hitRate: 0, components, warmerComponents: components,
    warmerShare: { prompt: 0, calls: 0, publishedAic: 0 }, daily: { rows: daily.map(row => ({ ...row, hitRate: 0, warmer: row.measure, components, warmerComponents: components, writeSplit: split, warmerWriteSplit: split })), nextCursor: null },
    sessionsWithWritesNoReads: { rows: [], nextCursor: null }, observation: "Sessions with writes and no recorded reads", itemReuse: unavailable };
  const versions = ["synthetic-v1", "synthetic-v2", "synthetic-v3"];
  const rates: RatesData = { calibration: fit, periodCalibration: fit, totals, versions: versions.map(id => ({ id, effectiveFrom: "2026-01-01", sourceAsOf: "2026-01-01", source: "Synthetic public rates", confidence: "estimated" })),
    rates: { rows: versions.map((version, i) => ({ modelKey: "v1_model", version, model: "synthetic-model", aliases: ["synthetic-alias"], validUntil: i === 0 ? "2026-01-02" : null, tier: "standard", abovePromptTokens: 0, usdPerMillion: { input: 1 + i, cacheRead: 0.1, cacheWrite: 1, output: 5 } })), nextCursor: null },
    storedRateVersions: versions, storedRateVersionsTruncated: false, unpricedModels: { rows: [], nextCursor: null }, factorHistory: { rows: daily.map(row => ({ day: row.start, calibration: fit })), nextCursor: null }, factorHistoryEnabled: state !== "off", nextCursor: null };
  const reconciliation: ReconciliationData = { periods: { rows: daily.map(row => ({ start: row.start, end: row.end, bucketStart: row.start, bucketEnd: row.end, coverage: 1, coveredMs: row.end - row.start, resetAnchors: 0, exclusions: {}, counterStart: row.start, counterEnd: row.end,
    status: "compared", counterAic: 20, computed: row.measure, gap: 20 - row.measure.aicDisplay.publishedAic!, ratio: row.measure.aicDisplay.publishedAic! / 20,
    calibratedAic: fit.status === "calibrated" ? row.measure.aicDisplay.primaryAic : null, calibratedGap: fit.status === "calibrated" ? 20 - row.measure.aicDisplay.primaryAic! : null, calibratedRatio: fit.status === "calibrated" ? row.measure.aicDisplay.primaryAic! / 20 : null, ratioReason: null, calibration: fit })), nextCursor: null }, counterGranularityAic: 1, billingLagCaveat: "billing-lag-minutes", caveats: [] };
  const explorer: ExplorerData = { groupBy: ["model"], calibration: fit, totals, rows: [{ key: ["v1_model"], labels: ["Synthetic model"], measure: totals }], nextCursor: null };
  const call: DetailCall = { id: "call-fixture", ts: period.start + 1000, sessionId: "session-fixture", runId: "run-fixture", parentRunId: "parent-fixture",
    project: { key: "v1_project", label: "Synthetic project" }, repo: null, actor: "subagent", role: "worker", agent: "Synthetic worker", runName: "Synthetic run", phase: "build", auxPurpose: null, provider: "synthetic", model: "synthetic-model", requestedModel: null, thinking: "high", api: "synthetic-api", latencyMs: 0, aggregate: false, measure: totals };
  const detail: DetailData = { kind: "session", id: "session-fixture", calibration: fit, totals, timeline: daily, calls: { rows: [call], nextCursor: null },
    links: { rows: [{ kind: "run", id: "child-fixture", label: "Synthetic child", relationship: "child", ongoing: false }], nextCursor: null },
    accounting: { status: "selected", coveringRunId: null, message: "Only globally selected representations are counted; unpriced calls keep unknown AIC." }, ...context };
  const runQuery = new URLSearchParams({ kind: "run", id: "run-fixture", start: String(period.start), end: String(period.end), filters: "[]", limit: "50" });
  const response = (data: unknown): DashboardRoute => ({ body: JSON.stringify({ ...source, data }), contentType: "application/json", ignoreSearch: true });
  return { ...base, routes: { ...base.routes, "/api/overview": response({ ...source.data, calibration: fit, totals, daily: { rows: daily, nextCursor: null } }),
    "/api/context": response(context), "/api/cache": response(cache), "/api/rates": response(rates), "/api/reconciliation": response(reconciliation), "/api/explorer": response(explorer), "/api/filter-values": response({ rows: [{ id: "v1_model", label: "Synthetic model" }], nextCursor: null }), "/api/detail": response(detail), [`/api/detail?${runQuery}`]: response({ ...detail, kind: "run", id: "run-fixture" }), "/api/detail-links": response(detail.links) } };
}
