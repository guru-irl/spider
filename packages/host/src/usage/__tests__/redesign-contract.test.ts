import { describe, expect, it } from "vitest";
import type { ApiEnvelope, DashboardQueryContext, LaunchOptions, ReaderOptions, TokenTotals } from "../dashboard-contract.js";
import { RESPONSE_CAPS_V4 } from "../dashboard-v4-contract.js";
import type {
  CalibrationData, DashboardApiResponsesV4, DashboardPageContext, DashboardPageMount,
  OverviewDataV4, SessionData, SessionNotFound, SessionsData, StatusData, Value,
} from "../dashboard-v4-contract.js";
import {
  calibrationFixture, envelope, fixtureStateCases, overviewFixture, sessionFixture,
  sessionsFixture, statusFixture,
} from "./fixtures/redesign-contract.js";

const forbidden = new Set([
  "dbPath", "sourceFile", "accountLogin", "owner", "leaseOwner", "leaseToken", "token",
  "promptText", "promptBody", "configurationPath", "configPath", "text", "content",
]);
function safeFinite(value: unknown): void {
  expect(value).not.toBeUndefined();
  if (typeof value === "number") {
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  } else if (typeof value === "string") {
    expect(value).not.toMatch(/(?:\/Users\/|\/home\/|[A-Z]:\\|https?:\/\/|[\u0000-\u001f\u007f]|\u2014)/);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      expect(forbidden.has(key), `private field: ${key}`).toBe(false);
      safeFinite(child);
    }
  }
}
function keys(value: object, expected: string): void {
  expect(Object.keys(value).sort()).toEqual(expected.split(" ").sort());
}
function tokens(value: TokenTotals): void {
  keys(value, "input cacheRead cacheWrite output cacheWrite1h reasoning prompt total");
  expect(value.total).toBe(value.input + value.cacheRead + value.cacheWrite + value.output);
}
function measure(value: Value): void {
  keys(value, "credits tokens calls unpricedCalls");
  tokens(value.tokens);
  expect(value.unpricedCalls).toBeLessThanOrEqual(value.calls);
}
function models(rows: SessionData["models"]): void {
  for (const row of rows) {
    keys(row, "id value share note style");
    measure(row.value);
    expect(row.share).toBeLessThanOrEqual(1);
    keys(row.style, "color shape");
    expect(["circle", "square", "triangle", "diamond"]).toContain(row.style.shape);
  }
}
function flow(data: SessionData["flow"]): void {
  keys(data, "total edges models");
  measure(data.total); models(data.models);
  for (const edge of data.edges) {
    keys(edge, "role model value share"); measure(edge.value);
    expect(edge.share).toBeLessThanOrEqual(1);
  }
  expect(data.edges.reduce((sum, edge) => sum + (edge.value.credits ?? 0), 0)).toBe(data.total.credits);
}
function sessions(data: SessionsData): void {
  keys(data, "rows total offset limit nextOffset summary");
  keys(data.summary, "runs top3Share");
  expect(data.summary.top3Share).toBeLessThanOrEqual(1);
  for (const row of data.rows) {
    keys(row, "id name project lastActive value roles runs"); measure(row.value);
    for (const role of row.roles) {
      keys(role, "role value share runs"); measure(role.value);
      expect(role.share).toBeLessThanOrEqual(1);
    }
    expect(row.roles.reduce((sum, role) => sum + (role.value.credits ?? 0), 0)).toBe(row.value.credits);
  }
}

// These tests catch missing/nullability-breaking DTO fields, private output and shared fixture state.
describe("usage dashboard v4 contract", () => {
  it("five routes have complete finite fixture DTOs", () => {
    const status = statusFixture() satisfies StatusData;
    const overview = overviewFixture() satisfies OverviewDataV4;
    const list = sessionsFixture() satisfies SessionsData;
    const session = sessionFixture() satisfies SessionData;
    const calibration = calibrationFixture() satisfies CalibrationData;
    keys(status, "lastIngestAt collector latestCounterAt serverBuild rateVersions");
    keys(overview, "range bucketSize pace total buckets selectedTotal models unpriced sessions flow");
    keys(overview.range, "range from to tz unit buckets");
    expect(overview.range.range).toBe("7d");
    expect(overview.range.unit).toBe("credits");
    expect(overview.sessions.limit).toBe(10);
    keys(overview.pace, "period used budget allowance scale remaining evenPace projected daysLeft ratePerDay usedSource rateSource counterAvailable overPace overBudget overAtPace");
    keys(overview.pace.period, "start end");
    measure(overview.total); measure(overview.selectedTotal); models(overview.models);
    sessions(overview.sessions); sessions(list); flow(overview.flow);
    for (const bucket of overview.buckets) {
      keys(bucket, "start end key label total models"); measure(bucket.total);
      for (const row of bucket.models) { keys(row, "model value"); measure(row.value); }
    }
    expect(overview.buckets.reduce((sum, bucket) => sum + (bucket.total.credits ?? 0), 0)).toBe(overview.total.credits);
    keys(session, "id name project span total stats runs ownCallBins compaction idleGaps activePeriods models flow");
    keys(session.stats, "runs ownCalls compaction idleGaps");
    keys(session.span!, "start end"); measure(session.total); models(session.models); flow(session.flow);
    for (const run of session.runs) {
      keys(run, "id name role model thinking start end durationMs status value style"); measure(run.value);
      expect(["completed", "cancelled", "failed", "running", null]).toContain(run.status);
    }
    for (const bin of session.ownCallBins) {
      keys(bin, "start end value"); measure(bin.value);
      expect(session.activePeriods).toContainEqual({ start: bin.start, end: bin.end });
    }
    expect(new Set(session.ownCallBins.map(bin => `${bin.start}:${bin.end}`)).size).toBe(session.ownCallBins.length);
    expect(session.ownCallBins.reduce((sum, bin) => sum + bin.value.calls, 0)).toBe(session.stats.ownCalls);
    for (const event of session.compaction) { keys(event, "ts value"); measure(event.value); }
    for (const gap of session.idleGaps) { keys(gap, "start end cacheWriteCredits"); expect(gap.end).toBeGreaterThan(gap.start); }
    for (const period of session.activePeriods) keys(period, "start end");
    keys(calibration, "correction daily intervals rates unpricedModels ingestion errors gaps");
    keys(calibration.correction, "factor publishedEstimate accountCounter coveredHours status");
    keys(calibration.ingestion, "collector lastIngestAt filesTracked callsToday errors");
    keys(calibration.gaps, "unpricedCalls compactionWithoutModel daysWithoutCounter");
    for (const day of calibration.daily) keys(day, "day publishedEstimate counterDelta");
    for (const interval of calibration.intervals) keys(interval, "start end counterDelta publishedEstimate ratio");
    const matched = calibration.intervals[0]!;
    const matchedDays = calibration.daily.filter(day => day.day >= matched.start && day.day < matched.end);
    expect(matchedDays.reduce((sum, day) => sum + (day.publishedEstimate ?? 0), 0)).toBe(matched.publishedEstimate);
    expect(calibration.correction.publishedEstimate).toBe(matched.publishedEstimate);
    expect(calibration.correction.accountCounter).toBe(matched.counterDelta);
    for (const rate of calibration.rates) keys(rate, "model tier abovePromptTokens input cacheRead cacheWrite output sourceDate");
    for (const error of calibration.errors) keys(error, "pathLabel code count lastCheckedAt");
    const responses = {
      "/api/status": envelope(status), "/api/overview": envelope(overview),
      "/api/sessions": envelope(list), "/api/session/<id>": envelope(session),
      "/api/calibration": envelope(calibration),
    } satisfies DashboardApiResponsesV4;
    for (const [path, body] of Object.entries(responses)) {
      keys(body, "apiVersion revision period generatedAt data");
      keys(body.period, "start end"); safeFinite(body);
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(RESPONSE_CAPS_V4[path as keyof typeof RESPONSE_CAPS_V4]);
    }
    expect(RESPONSE_CAPS_V4).toEqual({
      "/api/status": 8192, "/api/overview": 1048576, "/api/sessions": 524288,
      "/api/session/<id>": 2097152, "/api/calibration": 1048576,
    });
  });

  it("fixtures are isolated across calls, nested projections and supplied overrides", () => {
    for (const builder of [statusFixture, overviewFixture, sessionsFixture, sessionFixture, calibrationFixture]) {
      const first = builder(); const second = builder(); const before = JSON.stringify(second);
      function mutate(value: unknown): void {
        if (value === null || typeof value !== "object") return;
        for (const child of Object.values(value)) mutate(child);
        if (Array.isArray(value)) value.push("changed");
        else for (const key of Object.keys(value)) (value as Record<string, unknown>)[key] = null;
      }
      mutate(first);
      expect(JSON.stringify(second)).toBe(before);
      expect(JSON.stringify(builder())).toBe(before);
    }
    const overview = overviewFixture();
    (overview.models[0]!.value.tokens as { input: number }).input = 999;
    expect(overview.flow.models[0]!.value.tokens.input).not.toBe(999);
    const supplied = { rateVersions: ["synthetic-rate"] };
    const overridden = statusFixture(supplied);
    supplied.rateVersions.push("changed");
    expect(overridden.rateVersions).toEqual(["synthetic-rate"]);
    const data = sessionFixture(); const period = { start: 1, end: 2 };
    const wrapped = envelope(data, period);
    data.total.tokens.input = 999; period.start = 999;
    expect(wrapped.data.total.tokens.input).not.toBe(999);
    expect(wrapped.period).toEqual({ start: 1, end: 2 });
  });

  it("fixture states cover every page default and the applicable section 9 states honestly", () => {
    const cases = fixtureStateCases(); const untouched = JSON.stringify(fixtureStateCases());
    const names = cases.map(state => state.name);
    expect(new Set(names).size).toBe(names.length);
    for (const page of ["overview", "session", "calibration"] as const) {
      for (const scenario of ["default", "no-data", "stale", "error"] as const) {
        expect(cases.some(state => state.page === page && state.scenario === scenario)).toBe(true);
      }
    }
    for (const scenario of ["no-budget", "counter-unavailable", "over-pace"] as const) {
      expect(cases.some(state => state.page === "overview" && state.scenario === scenario)).toBe(true);
    }
    expect(cases.some(state => state.page === "calibration" && state.scenario === "counter-unavailable")).toBe(true);
    expect(cases.some(state => state.page === "session" && state.scenario === "unknown-session")).toBe(true);
    for (const state of cases) {
      safeFinite(state);
      expect(Object.keys(state.responses)).toContain("/api/status");
      for (const response of Object.values(state.responses)) {
        expect(response.status === 200 ? "data" in response.body : "error" in response.body).toBe(true);
      }
      const body = state.responses["/api/overview"]?.body;
      if (body && "data" in body && state.page === "overview") {
        const data = body.data as OverviewDataV4;
        if (state.scenario === "no-data") {
          expect(data.total.calls).toBe(0); expect(data.total.credits).toBeNull();
          expect(data.buckets).toEqual([]); expect(data.models).toEqual([]);
          expect(data.sessions.rows).toEqual([]); expect(data.flow.edges).toEqual([]);
          expect(data.pace.allowance).toBeGreaterThan(0);
        }
        if (state.scenario === "no-budget") {
          expect(data.pace.budget).toBeNull(); expect(data.pace.evenPace).toBeNull();
          expect(data.pace.scale).toBe(data.pace.allowance);
        }
        if (state.scenario === "counter-unavailable") {
          expect(data.pace.counterAvailable).toBe(false); expect(data.pace.allowance).toBeNull();
          expect(data.pace.usedSource).toBe("pi"); expect(data.pace.rateSource).toBe("pi");
          expect(data.pace.used).toBeGreaterThan(0);
        }
        if (state.scenario === "over-pace") {
          expect(data.pace.overPace).toBe(true); expect(data.pace.overBudget).toBe(true);
          expect(data.pace.projected).toBeGreaterThan(data.pace.budget!);
          expect(data.pace.overAtPace).toBeGreaterThan(0);
        }
      }
      const detail = state.responses["/api/session/session-garden"]?.body;
      if (detail && "data" in detail && state.scenario === "no-data") {
        const data = detail.data as SessionData;
        expect(data.name).toBe("Garden tools"); expect(data.span).toBeNull();
        expect(data.total.calls).toBe(0); expect(data.runs).toEqual([]);
        expect(data.ownCallBins).toEqual([]); expect(data.compaction).toEqual([]);
        expect(data.idleGaps).toEqual([]); expect(data.activePeriods).toEqual([]);
        expect(data.models).toEqual([]); expect(data.flow.edges).toEqual([]);
      }
      const calBody = state.responses["/api/calibration"]?.body;
      if (calBody && "data" in calBody) {
        const data = calBody.data as CalibrationData;
        if (state.scenario === "no-data") {
          expect(data.daily).toEqual([]); expect(data.intervals).toEqual([]);
          expect(data.correction.factor).toBeNull(); expect(data.ingestion.callsToday).toBe(0);
        }
        if (state.scenario === "counter-unavailable") {
          expect(data.correction.status).toBe("counter-unavailable");
          expect(data.correction.accountCounter).toBeNull(); expect(data.intervals).toEqual([]);
          expect(data.daily.every(day => day.counterDelta === null)).toBe(true);
        }
      }
      const statusBody = state.responses["/api/status"]!.body;
      if (state.scenario === "stale" && "data" in statusBody) {
        expect(statusBody.generatedAt - (statusBody.data as StatusData).lastIngestAt!).toBeGreaterThan(300000);
      }
      if (state.scenario === "error") {
        const failures = Object.values(state.responses).filter(response => response.status >= 500);
        expect(failures.length).toBeGreaterThan(0);
      }
    }
    (cases[0]!.responses["/api/status"]!.body as ApiEnvelope<StatusData>).data.rateVersions = ["changed"];
    expect(JSON.stringify(fixtureStateCases())).toBe(untouched);
  });

  it("session 404 is typed and uses a terminal not-found body", () => {
    const body = { apiVersion: 1, error: { code: "not-found", message: "Session not found" } } satisfies SessionNotFound;
    expect(body.error.message).toBe("Session not found");
    const unknown = fixtureStateCases().find(state => state.scenario === "unknown-session")!;
    expect(unknown.page).toBe("session");
    expect(unknown.responses["/api/session/unknown-session"]).toEqual({ status: 404, body });
  });

  it("reader hooks and browser lifecycle remain optional and type-only", () => {
    // Type-level assignments protect existing reader/launcher callers and the shared page lifecycle.
    const queryHooks = { monthlyBudget: () => 100, viewerSessionId: "session-garden" } satisfies
      Pick<DashboardQueryContext, "monthlyBudget" | "viewerSessionId">;
    const readerHooks = {} satisfies Pick<ReaderOptions, "monthlyBudget">;
    const launchHooks = {} satisfies Pick<LaunchOptions, "openerSessionId">;
    const mount: DashboardPageMount = ctx => {
      const route: DashboardPageContext["route"] = { page: "session", id: "session-garden", unit: "tokens", tz: "UTC" };
      ctx.navigate(route, { replace: true });
      return { async refresh() {}, dispose() {} };
    };
    expect(queryHooks.monthlyBudget()).toBe(100);
    expect(readerHooks).toEqual({}); expect(launchHooks).toEqual({}); expect(typeof mount).toBe("function");
  });
});
