import { expect, it } from "vitest";
import { measureFromRow } from "../dashboard-selection.js";
import { calibrationFallback } from "../calibration.js";
import { emptyMeasureRow } from "./fixtures/overview-v2-frozen.js";
import type { CalibrationResult, DashboardQueryContext } from "../dashboard-contract.js";

it("all AIC displays share calibration fallback", () => {
  const calibrated: CalibrationResult = { ...calibrationFallback(), status: "calibrated", factor: 0.56 };
  const row = { ...emptyMeasureRow, calls: 2, pricedCalls: 1, unpricedCalls: 1, aic: 1000, input: 10, cacheRead: 20, cacheWrite: 30, output: 10,
    aicInput: 1000, piCost: 3, possibleOverlap: 1, possibleUndercount: 1, pendingData: 1 };
  const ctx = {} as DashboardQueryContext;
  const measure = measureFromRow(ctx, row, calibrated);
  expect(measure.aicDisplay).toEqual({ primaryAic: 560, publishedAic: 1000, basis: "calibrated" });
  expect(measure).toMatchObject({ aic: 1000, aicComponents: { input: 1000 }, calls: 2, unpricedCalls: 1, piCost: 3,
    tokens: { prompt: 60, total: 70 }, possibleOverlap: true, possibleUndercount: true, pendingData: true });
  for (const status of ["uncalibrated", "implausible", "off"] as const) {
    expect(measureFromRow(ctx, row, { ...calibrated, status }).aicDisplay).toEqual({ primaryAic: 1000, publishedAic: 1000, basis: "published" });
  }
  expect(measureFromRow(ctx, { ...row, aic: null, pricedCalls: 0 }, calibrated).aicDisplay).toEqual({ primaryAic: null, publishedAic: null, basis: "calibrated" });
  expect(measureFromRow(ctx, { ...row, aic: 0 }, calibrated).aicDisplay.primaryAic).toBe(0);
});
