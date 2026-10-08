// Legacy response types belong only to the frozen differential oracle.
import type { Period, UsageMeasure, Slice, Page, CalibrationResult, DashboardCounter } from "../../dashboard-contract.js";
export type SeriesPoint = Period & { label: string; measure: UsageMeasure };
export type CompositionAvailability = {
  status: "unavailable"; phase: 2; reason: "not-built"; message: "Not available yet (Phase 2)";
};
export interface CompositionProvider {
  availability(slice: Slice & { sessionId?: string; runId?: string }): CompositionAvailability;
}
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
