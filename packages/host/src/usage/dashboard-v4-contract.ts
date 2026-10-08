import type { ApiEnvelope, ApiErrorBody, Period, TokenTotals } from "./dashboard-contract.js";
import type { DashboardClient } from "./web/client.js";

export type { DashboardClient } from "./web/client.js";

/** Wire fields are always present. Unavailable values are null; absent lists are empty.
 * Measures are finite, nonnegative and unrounded. Shares are fractions in [0, 1].
 * Public strings are redacted, never database/source/config paths, account identities,
 * lease owners/tokens or prompt bodies. Correction basis belongs only in Calibration.
 */
export type Unit = "credits" | "tokens";
export type RangePreset = "24h" | "7d" | "30d" | "month" | "custom";
export type RangeQuery = {
  range: RangePreset; from: number; to: number; tz: string; unit: Unit;
  /** Effective aligned, unclipped bucket-start keys, not clipped measure boundaries. */
  buckets: readonly number[];
};
export type SessionSort = "credits" | "last-active" | "runs";
/** Request parsing may omit unit/buckets (credits/no selection); the resolved query is complete. */
export type SessionsQuery = RangeQuery & { sort: SessionSort; offset: number; limit: number };
export type Value = { credits: number | null; tokens: TokenTotals; calls: number; unpricedCalls: number };
export type Role = "own" | "workers" | "reviewers" | "others";
export type FlowRole = "own" | "workers" | "reviewers" | "scouts" | "other-runs" | "compaction" | "background";
export type RunStatus = "completed" | "cancelled" | "failed" | "running";
export type Collector = "this-session" | "another-session" | "dashboard-server" | "none";
export type ModelStyle = { color: string; shape: "circle" | "square" | "triangle" | "diamond" };
export type ModelRow = { id: string; value: Value; share: number; note: string; style: ModelStyle };
export type RoleValue = { role: Role; value: Value; share: number; runs: number };
export type FlowEdge = { role: FlowRole; model: string; value: Value; share: number };
export type FlowData = { total: Value; edges: readonly FlowEdge[]; models: readonly ModelRow[] };
export type Bucket = Period & {
  key: number; label: string; total: Value; models: readonly { model: string; value: Value }[];
};
export type Pace = {
  period: Period; used: number | null; budget: number | null; allowance: number | null;
  scale: number | null; remaining: number | null; evenPace: number | null;
  projected: number | null; daysLeft: number; ratePerDay: number | null;
  usedSource: "counter" | "pi" | "unavailable"; rateSource: "counter" | "pi" | "unavailable";
  counterAvailable: boolean; overPace: boolean; overBudget: boolean; overAtPace: number | null;
};
export type SessionRow = {
  id: string | null; name: string; project: string | null; lastActive: number;
  value: Value; roles: readonly RoleValue[]; runs: number;
};
export type SessionsData = {
  rows: readonly SessionRow[]; total: number; offset: number; limit: number; nextOffset: number | null;
  summary: { runs: number; top3Share: number };
};
export type OverviewDataV4 = {
  range: RangeQuery; bucketSize: "hour" | "day"; pace: Pace; total: Value;
  buckets: readonly Bucket[]; selectedTotal: Value; models: readonly ModelRow[];
  unpriced: readonly { reason: string; calls: number }[]; sessions: SessionsData; flow: FlowData;
};
export type SessionRun = {
  id: string | null; name: string; role: string; model: string | null; thinking: string | null;
  start: number | null; end: number | null; durationMs: number | null;
  /** Unknown legacy terminal status remains null, never guessed. */
  status: RunStatus | null; value: Value; style: ModelStyle | null;
};
/** One own-call aggregate per active period, not a per-call listing. */
export type OwnCallBin = Period & { value: Value };
/** Duration is end - start; no redundant id or period copy. */
export type IdleGap = { start: number; end: number; cacheWriteCredits: number | null };
export type SessionData = {
  id: string; name: string; project: string | null; span: Period | null; total: Value;
  stats: { runs: number; ownCalls: number; compaction: number; idleGaps: number;
    /** Shortest gaps omitted on overflow, never synthetic idle spans. Raw idleGaps includes these. */
    omittedIdleGaps?: { count: number; cacheWriteCredits: number | null } };
  /** Overflow details use adjacent active/compaction bins, omitted gaps or run/model summaries. Stats and totals stay exact. */
  detailsBinned?: boolean;
  runs: readonly SessionRun[]; ownCallBins: readonly OwnCallBin[];
  compaction: readonly { ts: number; value: Value }[]; idleGaps: readonly IdleGap[];
  activePeriods: readonly Period[]; models: readonly ModelRow[]; flow: FlowData;
};
export type SessionNotFound = { apiVersion: 1; error: { code: "not-found"; message: "Session not found" } };
export type StatusData = {
  lastIngestAt: number | null; collector: Collector; latestCounterAt: number | null;
  serverBuild: string; rateVersions: readonly string[];
};
export type CounterInterval = Period & { counterDelta: number; publishedEstimate: number | null; ratio: number | null };
export type RateRowV4 = {
  model: string; tier: string; abovePromptTokens: number; input: number | null;
  cacheRead: number | null; cacheWrite: number | null; output: number | null; sourceDate: string;
};
export type SourceError = { pathLabel: string; code: string; count: number; lastCheckedAt: number };
export type CalibrationData = {
  correction: {
    factor: number | null; publishedEstimate: number | null; accountCounter: number | null;
    coveredHours: number; status: "calibrated" | "back-applied" | "published-only" | "counter-unavailable";
  };
  daily: readonly { day: number; publishedEstimate: number | null; counterDelta: number | null }[];
  intervals: readonly CounterInterval[]; rates: readonly RateRowV4[];
  unpricedModels: readonly { model: string | null; calls: number; reason: string }[];
  ingestion: { collector: Collector; lastIngestAt: number | null; filesTracked: number; callsToday: number; errors: number };
  errors: readonly SourceError[];
  gaps: { unpricedCalls: number; compactionWithoutModel: number; daysWithoutCounter: readonly number[] };
};

/** Shared byte limits for query sizing and authenticated HTTP transport. */
export const RESPONSE_CAPS_V4: Readonly<Record<keyof DashboardApiResponsesV4, number>> = Object.freeze({
  "/api/status": 8 * 1024,
  "/api/overview": 1024 * 1024,
  "/api/sessions": 512 * 1024,
  "/api/session/<id>": 2 * 1024 * 1024,
  "/api/calibration": 1024 * 1024,
});
/** Success bodies, plus the Session route's HTTP 404. Other failures retain ApiErrorBody. */
export type DashboardApiResponsesV4 = {
  "/api/status": ApiEnvelope<StatusData>;
  "/api/overview": ApiEnvelope<OverviewDataV4>;
  "/api/sessions": ApiEnvelope<SessionsData>;
  "/api/session/<id>": ApiEnvelope<SessionData> | SessionNotFound;
  "/api/calibration": ApiEnvelope<CalibrationData>;
};
export type DashboardApiFailureV4 = ApiErrorBody;
export type DashboardRouteV4 =
  | { page: "overview"; query: RangeQuery }
  | { page: "session"; id: string; unit: Unit; tz: string }
  | { page: "calibration" };
export type DashboardPageContext = {
  document: Document; root: HTMLElement; client: DashboardClient;
  route: DashboardRouteV4; signal: AbortSignal;
  /** replace reconciles the hash and remembered Overview without history, remount or refetch. */
  navigate(route: DashboardRouteV4, options?: { replace?: boolean }): void;
  overview: RangeQuery; now(): number; back(): void;
};
export type DashboardPage = { refresh(): Promise<void>; dispose(): void };
export type DashboardPageMount = (ctx: DashboardPageContext) => DashboardPage;
