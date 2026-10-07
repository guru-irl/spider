import type { Db } from "@spider/db-core";
import type { UsageRoots } from "./discovery.js";
import type { RateVersion } from "./types.js";
import type { BackfillState, UsageProgress } from "./protocol.js";

export type Period = { start: number; end: number };
export type Dimension = "project" | "repo" | "session" | "actor" | "role" | "agent" | "provider"
  | "model" | "requestedModel" | "thinking" | "run" | "runName" | "phase"
  | "parentRun" | "auxPurpose" | "api" | "day";
/** Discovery keys are dimension-scoped opaque ids, except safe stored session/run ids.
 * Unsupported session/run ids carry no key but still count. Their count is informational:
 * a null id with a non-null label has no filter action. A row with null id and null
 * label is a missing value, shown as Unknown and selectable with { field, kind: "missing" }.
 * Never submit a null id or raw null filter.
 * Labels are presentation only,
 * clamped to 160 code points. Paths use ~/ inside home, …/ plus two segments outside.
 * Labels must never become filesystem inputs.
 */
export type FilterValue = { id: string | null; label: string | null; count?: number };
/** Omitted kind is a raw stored-value filter for compatibility. Public discovery consumers
 * must send kind: "id" explicitly, including safe stored session/run ids. Never infer by shape.
 * Missing filters have no value, select SQL NULL (not the literal "Unknown"), and count
 * against the 16-filter cap. Raw null and null-id filters are rejected. */
export type Filter = { field: Dimension; value: string; kind?: "raw" | "id" }
  | { field: Dimension; kind: "missing"; value?: never };
export type Slice = Period & { filters: readonly Filter[] };
export type Page<T> = { rows: readonly T[]; nextCursor: string | null };
export type ApiEnvelope<T> = {
  apiVersion: 1;
  /** Opaque to clients: do not parse or assume a format. Reader revisions use
   * <name>-<uuid>:<n>; bootstrap/unavailable envelopes use <name>:<state>.
   * Instance-scoped call selection, not coordination or counter freshness.
   * Endpoint cursors may freeze separate source generations. */
  revision: string;
  period: Period; generatedAt: number; data: T;
};
export type ApiErrorCode = "invalid-query" | "ledger-changed" | "ledger-unavailable" | "unsupported-schema" | "busy" | "not-found"
  | "identity-unavailable" | "unknown-filter-id" | "unauthorized" | "forbidden" | "method-not-allowed" | "response-limit" | "rate-limited" | "internal";
export type ApiErrorBody = { apiVersion: 1; error: { code: ApiErrorCode; message: string } };
export type CalibrationResult = {
  status: "calibrated" | "uncalibrated" | "implausible" | "off";
  factor: number | null; windowStart: number | null; windowEnd: number | null;
  coveredHours: number; computedAic: number; counterDelta: number; unpricedCalls: number;
  method: "trailing-7d-ratio";
};
export type AicDisplay = {
  primaryAic: number | null; publishedAic: number | null;
  /** Selects the primary estimate's basis, never a claim of exact billing.
   * Back-applied uses the earliest calibrated fit only when the period endpoint is before that fit's anchor;
   * otherwise windows without a fit use published, with their uncalibrated or implausible status.
   * Label back-applied values "calibrated, back-applied". Evidence is hoisted once per response.
   */
  basis: "calibrated" | "back-applied" | "published";
};
export type CalibrationHistoryPoint = { day: number; calibration: CalibrationResult };
export interface CalibrationService {
  current(mode: "auto" | "off"): CalibrationResult;
  at(windowEnd: number, mode: "auto" | "off"): CalibrationResult;
  /** Earliest accepted snapshot-window fit, or an explicit published fallback if none exists. */
  earliest(mode: "auto" | "off"): CalibrationResult;
  atMany(windowEnds: readonly number[], mode: "auto" | "off"): readonly CalibrationResult[];
  history(period: Period, page: { limit: number; cursor?: string }, mode: "auto" | "off"): Page<CalibrationHistoryPoint>;
}
export type TokenTotals = {
  input: number; cacheRead: number; cacheWrite: number; output: number;
  cacheWrite1h: number | null; reasoning: number | null; prompt: number; total: number;
};
export type UsageMeasure = {
  calls: number; pricedCalls: number; unpricedCalls: number; aggregateCalls: number;
  tokens: TokenTotals;
  /** Stored published estimate: null without priced evidence, 0 for priced zero, a lower bound when unpricedCalls > 0. */
  aic: number | null; aicDisplay: AicDisplay;
  aicComponents: { input: number | null; cacheRead: number | null; cacheWrite: number | null; output: number | null };
  piCost: number | null; possibleOverlap: boolean; possibleUndercount: boolean; pendingData: boolean;
  /** Data uncertainty: overlap or undercount. False does not mean AIC is exact; all AIC remains approximate. */
  estimated: boolean;
};
export type SeriesPoint = Period & { label: string; measure: UsageMeasure };
export type CompositionAvailability = {
  status: "unavailable"; phase: 2; reason: "not-built"; message: "Not available yet (Phase 2)";
};
export interface CompositionProvider {
  availability(slice: Slice & { sessionId?: string; runId?: string }): CompositionAvailability;
}
export type DashboardIngestState = {
  role: "owner" | "follower" | "inactive" | "standby";
  lastIngestAt: number | null; backfill: BackfillState; progress?: UsageProgress; errorCode: string | null;
};
export type DashboardCounter = {
  ts: number | null; creditsUsed: number | null; entitlement: number | null;
  remaining: number | null; resetDate: string | null; ageMs: number | null;
  availability: "available" | "stale" | "unavailable"; nextPollAt: number | null;
};
export type DashboardStatus = {
  serverBuild: string; schemaVersion: number; rateVersions: readonly string[];
  calls: number; sources: number; parseErrors: number; sourceErrors: number;
  ingest: DashboardIngestState & { ageMs: number | null; stale: boolean };
  counter: DashboardCounter;
};
export type OverviewBreakdown = { label: string | null; isOther: boolean; measure: UsageMeasure };
export type OverviewDay = SeriesPoint & { actors: readonly OverviewBreakdown[]; roles: readonly OverviewBreakdown[] };
export type OverviewComparison = Period & {
  counterAic: number | null; computed: UsageMeasure | null; gap: number | null; ratio: number | null;
};
export type OverviewData = {
  /** Response-level calibration result. Whether a displayed value is back-applied
   * comes from that value's `aicDisplay.basis`; daily and comparison evidence may differ. */
  calibration: CalibrationResult;
  totals: UsageMeasure; actors: readonly OverviewBreakdown[]; roles: readonly OverviewBreakdown[];
  daily: Page<OverviewDay>; comparison: OverviewComparison;
  counterObservation: DashboardCounter;
  pace: { projected: Pick<UsageMeasure, "aicDisplay" | "tokens" | "possibleOverlap" | "possibleUndercount" | "pendingData"> | null;
    counterAic: number | null; elapsedFraction: number | null };
};
export type ContextData = {
  contextFillPercent: null;
  contextFillMessage: "Context fill unavailable: historical window not recorded";
  composition: CompositionAvailability; carry: CompositionAvailability; itemReuse: CompositionAvailability;
};
export type SourceErrorRow = { sourceLabel: string; projectLabel: string; code: string; count: number; lastCheckedAt: number };
export type DashboardQueryContext = {
  db: Db; instanceId: string; revision: string; composition: CompositionProvider; now: () => number;
  rates: readonly RateVersion[]; status: () => DashboardStatus;
  calibration: CalibrationService; calibrationMode: "auto" | "off";
};
export type DashboardRoute = { path: string; handle(ctx: DashboardQueryContext, query: URLSearchParams): unknown;
  /** Pure validation/window resolution, including authenticated cursor windows, for the HTTP envelope. */
  resolvePeriod?(query: URLSearchParams, now: number): Period;
};
export interface DashboardReader {
  revision(): string;
  status(): DashboardStatus;
  snapshot<T>(read: (ctx: DashboardQueryContext) => T): T;
  close(): void;
}
export type ReaderOptions = {
  instanceId: string; now: () => number; serverBuild: string; rates?: readonly RateVersion[];
  ingestStatus?: () => DashboardIngestState; calibrationMode: () => "auto" | "off";
};
export type HttpOptions = {
  instanceId: string; serverBuild: string; reader: DashboardReader | undefined;
  routes: readonly DashboardRoute[]; html: string; secret: string;
  retryOpenReader?: () => DashboardReader | undefined; ingestStatus?: () => DashboardIngestState;
  onClose?: () => Promise<void>; now?: () => number; idleMs?: number;
};
export type LaunchOptions = { bundleUrl: string | URL; roots: UsageRoots; lockFile: string; serverBuild: string };
export type IngestOptions = { bundleUrl: string | URL; roots: UsageRoots; onSnapshot?: (state: DashboardIngestState) => void };
export type IngestHandle = { snapshot(): DashboardIngestState; stop(): Promise<void> };

/** Fixed, path-free wire codes; callers must never serialize SQLite error text. */
export class DashboardQueryError extends Error {
  constructor(public readonly code: ApiErrorCode) {
    super(code);
  }
}
