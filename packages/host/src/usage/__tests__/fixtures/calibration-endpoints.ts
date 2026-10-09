// Test-only endpoint adapter preserving calibration engine differential coverage.
import type { InternalCalibrationService } from "../../calibration.js";
import type { AicDisplay, CalibrationResult, CalibrationService, DashboardQueryContext } from "../../dashboard-contract.js";

export type AnalysisFit = { calibration: CalibrationResult; basis: AicDisplay["basis"] };
/** Exact endpoint batch; only endpoints before the earliest fit can be back-applied. */
export function analysisFits(ctx: DashboardQueryContext, ends: readonly number[]): AnalysisFit[] {
  const points = ends.map(end => Math.max(0, Math.min(end, ctx.now()) - 1));
  const unique = [...new Set(points)];
  let fits: readonly CalibrationResult[];
  if (unique.length <= 200) fits = ctx.calibration.atMany(unique, ctx.calibrationMode);
  else fits = historyFits(ctx, unique);
  let earliest: CalibrationResult | undefined;
  const byEnd = new Map(unique.map((end, i) => {
    let calibration = fits[i]!, basis: AicDisplay["basis"] = calibration.status === "calibrated" ? "calibrated" : "published";
    if (ctx.calibrationMode !== "off" && calibration.status !== "calibrated") {
      earliest ??= ctx.calibration.earliest(ctx.calibrationMode);
      if (earliest.status === "calibrated" && earliest.windowEnd !== null && end < earliest.windowEnd) { calibration = earliest; basis = "back-applied"; }
    }
    return [end, { calibration, basis }] as const;
  }));
  return points.map(point => byEnd.get(point)!);
}
function hasHistory(service: CalibrationService): service is InternalCalibrationService {
  return "windows" in service && typeof service.windows === "function";
}
/** Internal endpoint lookup. History fits can be shared; callers must treat them as read-only. */
export function historyFits(ctx: DashboardQueryContext, unique: readonly number[]): readonly CalibrationResult[] {
  if (!unique.length) return [];
  if (!hasHistory(ctx.calibration)) {
    const fits: CalibrationResult[] = [];
    for (let i = 0; i < unique.length; i += 200) fits.push(...ctx.calibration.atMany(unique.slice(i, i + 200), ctx.calibrationMode));
    return fits;
  }
  const sorted = [...unique].sort((a, b) => a - b);
  const windows = ctx.calibration.windows({ start: sorted[0]!, end: sorted.at(-1)! }, ctx.calibrationMode);
  const byPoint = new Map<number, CalibrationResult>();
  let cursor = 0;
  for (const point of sorted) {
    while (cursor + 1 < windows.length && windows[cursor + 1]!.from <= point) cursor++;
    byPoint.set(point, windows[cursor]!.calibration);
  }
  const fits = unique.map(point => byPoint.get(point)!);
  return fits;
}
