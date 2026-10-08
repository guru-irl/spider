import type { ApiEnvelope, ApiErrorBody, Period } from "../../dashboard-contract.js";
import type {
  CalibrationData, DashboardRouteV4, FlowData, ModelRow, OverviewDataV4, Pace,
  SessionData, SessionNotFound, SessionsData, StatusData, Value,
} from "../../dashboard-v4-contract.js";

// Fixed synthetic dates and small invented measures. No ledger, configuration or network access.
const DAY = 86_400_000;
const NOW = Date.UTC(2030, 3, 15);
const FROM = NOW - 7 * DAY;
const FIRST = Date.UTC(2030, 3, 12, 9);
const WORKER = Date.UTC(2030, 3, 13, 10);
const REVIEWER = Date.UTC(2030, 3, 14, 10);
const END = REVIEWER + 20 * 60_000;
const SESSION_ID = "session-garden";

function value(credits: number | null, calls: number): Value {
  return {
    credits, calls, unpricedCalls: 0,
    tokens: { input: 100 * calls, cacheRead: 20 * calls, cacheWrite: 10 * calls,
      output: 30 * calls, cacheWrite1h: null, reasoning: null, prompt: 130 * calls, total: 160 * calls },
  };
}
function modelRows(): ModelRow[] {
  return [
    { id: "model-cedar", value: value(5, 4), share: 0.5, note: "Mostly own and background calls",
      style: { color: "#f8785c", shape: "circle" } },
    { id: "model-maple", value: value(5, 2), share: 0.5, note: "Mostly worker runs",
      style: { color: "#91c7e5", shape: "square" } },
  ];
}
function flowData(): FlowData {
  return {
    total: value(10, 6), models: modelRows(), edges: [
      { role: "own", model: "model-cedar", value: value(2, 2), share: 0.2 },
      { role: "workers", model: "model-maple", value: value(3, 1), share: 0.3 },
      { role: "reviewers", model: "model-cedar", value: value(1, 1), share: 0.1 },
      { role: "compaction", model: "model-maple", value: value(2, 1), share: 0.2 },
      { role: "background", model: "model-cedar", value: value(2, 1), share: 0.2 },
    ],
  };
}
function pace(): Pace {
  return {
    period: { start: Date.UTC(2030, 3, 1), end: Date.UTC(2030, 4, 1) },
    used: 40, budget: 100, allowance: 120, scale: 100, remaining: 60,
    evenPace: 100 * 14 / 30, projected: 70, daysLeft: 16, ratePerDay: 1.875,
    usedSource: "counter", rateSource: "counter", counterAvailable: true,
    overPace: false, overBudget: false, overAtPace: null,
  };
}

/** Clone overrides as well as defaults so no caller-owned nested object is retained. */
export function statusFixture(overrides: Partial<StatusData> = {}): StatusData {
  return structuredClone({
    lastIngestAt: NOW - 60_000, collector: "this-session", latestCounterAt: NOW - 120_000,
    serverBuild: "synthetic-build", rateVersions: ["synthetic-rates-2030-04"], ...overrides,
  } satisfies StatusData);
}
export function sessionsFixture(overrides: Partial<SessionsData> = {}): SessionsData {
  return structuredClone({
    rows: [{ id: SESSION_ID, name: "Garden tools", project: "garden", lastActive: END,
      value: value(10, 6), runs: 2, roles: [
        { role: "own", value: value(2, 2), share: 0.2, runs: 0 },
        { role: "workers", value: value(3, 1), share: 0.3, runs: 1 },
        { role: "reviewers", value: value(1, 1), share: 0.1, runs: 1 },
        { role: "others", value: value(4, 2), share: 0.4, runs: 0 },
      ] }],
    total: 1, offset: 0, limit: 10, nextOffset: null, summary: { runs: 2, top3Share: 1 }, ...overrides,
  } satisfies SessionsData);
}
export function overviewFixture(overrides: Partial<OverviewDataV4> = {}): OverviewDataV4 {
  return structuredClone({
    range: { range: "7d", from: FROM, to: NOW, tz: "UTC", unit: "credits", buckets: [] },
    bucketSize: "day", pace: pace(), total: value(10, 6), selectedTotal: value(10, 6),
    buckets: Array.from({ length: 7 }, (_, index) => {
      const key = FROM + index * DAY;
      const credits = index === 4 ? 4 : index === 5 || index === 6 ? 3 : 0;
      const calls = index === 4 ? 3 : index === 5 ? 1 : index === 6 ? 2 : 0;
      return {
        key, start: key, end: key + DAY, label: `${8 + index} APR`, total: value(credits, calls),
        models: index === 4 ? [{ model: "model-cedar", value: value(4, 3) }]
          : index === 5 ? [{ model: "model-maple", value: value(3, 1) }]
          : index === 6 ? [{ model: "model-cedar", value: value(1, 1) }, { model: "model-maple", value: value(2, 1) }]
          : [],
      };
    }),
    models: modelRows(), unpriced: [], sessions: sessionsFixture(), flow: flowData(), ...overrides,
  } satisfies OverviewDataV4);
}
export function sessionFixture(overrides: Partial<SessionData> = {}): SessionData {
  return structuredClone({
    id: SESSION_ID, name: "Garden tools", project: "garden", span: { start: FIRST, end: END },
    total: value(10, 6), stats: { runs: 2, ownCalls: 2, compaction: 1, idleGaps: 1 },
    runs: [
      { id: "run-build", name: "Build garden tools", role: "worker", model: "model-maple", thinking: "high",
        start: WORKER, end: WORKER + 20 * 60_000, durationMs: 20 * 60_000, status: "completed",
        value: value(3, 1), style: { color: "#91c7e5", shape: "square" } },
      { id: "run-review", name: "Review garden tools", role: "reviewer", model: "model-cedar", thinking: "high",
        start: REVIEWER, end: END, durationMs: 20 * 60_000, status: "completed",
        value: value(1, 1), style: { color: "#f8785c", shape: "circle" } },
    ],
    ownCallBins: [{ start: FIRST, end: FIRST + 11 * 60_000, value: value(2, 2) }],
    compaction: [{ ts: REVIEWER - 30 * 60_000, value: value(2, 1) }],
    idleGaps: [{ start: FIRST + 60_000, end: FIRST + 10 * 60_000, cacheWriteCredits: 0.1 }],
    activePeriods: [{ start: FIRST, end: FIRST + 11 * 60_000 },
      { start: WORKER, end: WORKER + 20 * 60_000 }, { start: REVIEWER - 30 * 60_000, end: END }],
    models: modelRows(), flow: flowData(), ...overrides,
  } satisfies SessionData);
}
export function calibrationFixture(overrides: Partial<CalibrationData> = {}): CalibrationData {
  return structuredClone({
    correction: { factor: 0.5, publishedEstimate: 12, accountCounter: 6, coveredHours: 48, status: "calibrated" },
    daily: [{ day: Date.UTC(2030, 3, 12), publishedEstimate: 8, counterDelta: null },
      { day: Date.UTC(2030, 3, 13), publishedEstimate: 6, counterDelta: 3 },
      { day: Date.UTC(2030, 3, 14), publishedEstimate: 6, counterDelta: 3 }],
    intervals: [{ start: Date.UTC(2030, 3, 13), end: NOW, counterDelta: 6, publishedEstimate: 12, ratio: 0.5 }],
    rates: [
      { model: "model-cedar", tier: "standard", abovePromptTokens: 0,
        input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 8, sourceDate: "2030-04-01" },
      { model: "model-maple", tier: "standard", abovePromptTokens: 0,
        input: 1, cacheRead: 0.1, cacheWrite: null, output: 4, sourceDate: "2030-04-01" },
    ],
    unpricedModels: [],
    ingestion: { collector: "this-session", lastIngestAt: NOW - 60_000, filesTracked: 3, callsToday: 0, errors: 1 },
    errors: [{ pathLabel: "archive/session", code: "parse-error", count: 1, lastCheckedAt: NOW - 60_000 }],
    gaps: { unpricedCalls: 0, compactionWithoutModel: 0, daysWithoutCounter: [Date.UTC(2030, 3, 12)] }, ...overrides,
  } satisfies CalibrationData);
}
export function envelope<T>(data: T, period: Period = { start: FROM, end: NOW }): ApiEnvelope<T> {
  return structuredClone({ apiVersion: 1, revision: "synthetic-revision", period, generatedAt: NOW, data });
}

export type FixtureScenario = "default" | "no-data" | "no-budget" | "counter-unavailable"
  | "over-pace" | "stale" | "unknown-session" | "error";
export type FixtureStateCase = {
  name: string; page: DashboardRouteV4["page"]; scenario: FixtureScenario;
  responses: Readonly<Record<string, { status: number; body: ApiEnvelope<unknown> | ApiErrorBody | SessionNotFound }>>;
};
type Responses = Record<string, { status: number; body: ApiEnvelope<unknown> | ApiErrorBody | SessionNotFound }>;
function emptyFlow(): FlowData { return { total: value(null, 0), edges: [], models: [] }; }
function emptySessions(): SessionsData {
  return sessionsFixture({ rows: [], total: 0, nextOffset: null, summary: { runs: 0, top3Share: 0 } });
}
function stateCase(page: FixtureStateCase["page"], scenario: FixtureScenario): FixtureStateCase {
  let status = statusFixture();
  let overview = overviewFixture();
  let list = sessionsFixture();
  let session = sessionFixture();
  let calibration = calibrationFixture();
  if (scenario === "no-data") {
    status = statusFixture({ lastIngestAt: null, collector: "none" });
    list = emptySessions();
    overview = overviewFixture({ total: value(null, 0), selectedTotal: value(null, 0), buckets: [],
      models: [], unpriced: [], sessions: list, flow: emptyFlow() });
    session = sessionFixture({ span: null, total: value(null, 0), stats: { runs: 0, ownCalls: 0, compaction: 0, idleGaps: 0 },
      runs: [], ownCallBins: [], compaction: [], idleGaps: [], activePeriods: [], models: [], flow: emptyFlow() });
    calibration = calibrationFixture({
      correction: { factor: null, publishedEstimate: null, accountCounter: null, coveredHours: 0, status: "published-only" },
      daily: [], intervals: [], unpricedModels: [], errors: [],
      ingestion: { collector: "none", lastIngestAt: null, filesTracked: 0, callsToday: 0, errors: 0 },
      gaps: { unpricedCalls: 0, compactionWithoutModel: 0, daysWithoutCounter: [] },
    });
  }
  if (scenario === "no-budget") {
    overview.pace = { ...overview.pace, budget: null, scale: overview.pace.allowance,
      remaining: 80, evenPace: null, overPace: false, overBudget: false, overAtPace: null };
  }
  if (scenario === "counter-unavailable") {
    status.latestCounterAt = null;
    overview.pace = { ...overview.pace, used: 10, allowance: null, remaining: 90, projected: 30,
      ratePerDay: 1.25, usedSource: "pi", rateSource: "pi", counterAvailable: false };
    // Preserve an accepted historical factor while honestly omitting absent current counter evidence.
    calibration.correction = { ...calibration.correction, accountCounter: null, status: "counter-unavailable" };
    calibration.daily = calibration.daily.map(day => ({ ...day, counterDelta: null }));
    calibration.intervals = [];
    calibration.gaps.daysWithoutCounter = calibration.daily.map(day => day.day);
  }
  if (scenario === "over-pace") {
    overview.pace = { ...overview.pace, used: 110, remaining: 0, projected: 140,
      overPace: true, overBudget: true, overAtPace: 40 };
  }
  if (scenario === "stale") {
    status.lastIngestAt = NOW - 10 * 60_000;
    calibration.ingestion.lastIngestAt = status.lastIngestAt;
  }
  const responses: Responses = {
    "/api/status": { status: 200, body: envelope(status) },
    "/api/overview": { status: 200, body: envelope(overview) },
    "/api/sessions": { status: 200, body: envelope(list) },
    [`/api/session/${SESSION_ID}`]: { status: 200, body: envelope(session, session.span ?? { start: FROM, end: NOW }) },
    "/api/calibration": { status: 200, body: envelope(calibration) },
  };
  if (scenario === "unknown-session") {
    const body = { apiVersion: 1, error: { code: "not-found", message: "Session not found" } } satisfies SessionNotFound;
    responses["/api/session/unknown-session"] = { status: 404, body };
  }
  if (scenario === "error") {
    const path = page === "session" ? `/api/session/${SESSION_ID}` : `/api/${page}`;
    responses[path] = { status: 503, body: { apiVersion: 1, error: { code: "busy", message: "Usage is temporarily unavailable. Retry." } } };
    if (page === "overview") responses["/api/sessions"] = structuredClone(responses[path]!);
  }
  return { name: `${page}-${scenario}`, page, scenario, responses };
}
/** Fixture-only catalogue. Transport as JSON; browser imports of these types must be erased. */
export function fixtureStateCases(): readonly FixtureStateCase[] {
  return [
    stateCase("overview", "default"), stateCase("overview", "no-data"),
    stateCase("overview", "no-budget"), stateCase("overview", "counter-unavailable"),
    stateCase("overview", "over-pace"), stateCase("overview", "stale"), stateCase("overview", "error"),
    stateCase("session", "default"), stateCase("session", "no-data"),
    stateCase("session", "stale"), stateCase("session", "unknown-session"), stateCase("session", "error"),
    stateCase("calibration", "default"), stateCase("calibration", "no-data"),
    stateCase("calibration", "counter-unavailable"), stateCase("calibration", "stale"), stateCase("calibration", "error"),
  ];
}
