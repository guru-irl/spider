import { afterEach, beforeEach, expect, it } from "vitest";
import { createCalibrationService } from "../calibration.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_DAY as DAY, DASHBOARD_MONTH as START, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

// Reviewer: an invalid snapshot must never be the earliest anchor. Hand values:
// daily pairs d1..d7 each 1000 AIC / 500 delta; d0->d1 delta 20000 keeps every window through d7 implausible.
// d7.5 is invalid (entitlement -1). The next valid anchor d8 has window [d1, d8]: 144 h, 3000 / 6000 = 0.5.
let f: DashboardFixture;
beforeEach(() => { f = createDashboardFixture(false); });
afterEach(() => { f.close(); });
it("earliest never anchors on an invalid snapshot", () => {
  const calls = [];
  for (let d = 0; d < 8; d++) calls.push(dashboardCall(`c${d}`, { ts: START + d * DAY + 1000, price: { status: "priced", aic: 1000, components: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "r", tier: "r", confidence: "estimated" } }));
  f.ledger.apply(dashboardBatch(calls));
  const ins = f.db.prepare("INSERT INTO counter_snapshots(ts,credits_used,entitlement,account_login,reset_date,raw) VALUES (?,?,?,'a','R','{}')");
  const c = (ts: number, credits: number, entitlement: number | null = null) => ins.run(ts, credits, entitlement);
  c(START, 0); c(START + DAY, 20000);
  for (let d = 2; d <= 7; d++) c(START + d * DAY, 20000 + (d - 1) * 500);
  c(START + 7.5 * DAY, 23000, -1); c(START + 8 * DAY, 23000);
  const s = createCalibrationService(f.db, { revision: () => "e3" });
  expect(s.at(START + 7.5 * DAY, "auto").windowEnd).toBe(START + 7 * DAY);
  expect(s.earliest("auto")).toMatchObject({ status: "calibrated", windowEnd: START + 8 * DAY, coveredHours: 144, computedAic: 6000, counterDelta: 3000, factor: 0.5 });
});
