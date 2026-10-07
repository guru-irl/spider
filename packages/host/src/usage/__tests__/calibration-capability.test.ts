import { afterEach, expect, test } from "vitest";
import { createCalibrationService } from "../calibration.js";
import { historyFits, analysisFits } from "../query-cache.js";
import { openDashboardReader } from "../dashboard-reader.js";
import type { CalibrationService } from "../dashboard-contract.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D, type DashboardFixture } from "./fixtures/dashboard-ledger.js";
let f: DashboardFixture;
let reader: ReturnType<typeof openDashboardReader>;
afterEach(() => { reader?.close(); f?.close(); });
// Kills unchecked windows dispatch and fallback batches exceeding the public cap.
test("dense lookup falls back to 200-point calls without a history capability", () => {
  f = createDashboardFixture(false);
  f.ledger.insertCounter({ ts: M, creditsUsed: 0, raw: {} });
  f.ledger.insertCounter({ ts: M + D, creditsUsed: 250, raw: {} });
  f.ledger.apply(dashboardBatch([dashboardCall("fit", { ts: M, price: { status: "priced", aic: 500, components: { input: 500, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } })]));
  reader = openDashboardReader(f.file, { instanceId: "fixture", now: () => M + 3 * D, serverBuild: "fixture", calibrationMode: () => "auto" })!;
  const ctx = reader.snapshot(ctx => ctx);
  {
    const service = createCalibrationService(ctx.db, { revision: () => ctx.revision });
    const batches: number[] = [];
    const double: CalibrationService = {
      current: service.current, at: service.at, earliest: service.earliest, history: service.history,
      atMany(ends, mode) { batches.push(ends.length); return service.atMany(ends, mode); },
    };
    const points = Array.from({ length: 601 }, (_, i) => M + i * D / 300).reverse();
    const want = historyFits(ctx, points);
    expect(historyFits({ ...ctx, calibration: double }, points)).toEqual(want);
    expect(batches).toEqual([200, 200, 200, 1]);
    expect(analysisFits({ ...ctx, calibration: double }, points.map(p => p + 1))).toEqual(analysisFits(ctx, points.map(p => p + 1)));
  }
});
