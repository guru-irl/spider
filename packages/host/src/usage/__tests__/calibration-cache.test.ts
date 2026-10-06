import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCalibrationService } from "../calibration.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as START, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

// Reviewer repro: a cached anchor evicted by a later miss in the same batch returns an empty object.
let f: DashboardFixture;
beforeEach(() => { f = createDashboardFixture(false); });
afterEach(() => { vi.restoreAllMocks(); f.close(); });
it("atMany keeps every requested result after 512 cached anchors", () => {
  const H = 3600000;
  const calls = [];
  for (let h = 0; h < 30 * 24; h++) calls.push(dashboardCall(`c${h}`, { ts: START + h * H + 1, price: { status: "priced", aic: 50, components: { input: 50, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "r", tier: "r", confidence: "estimated" } }));
  f.ledger.apply(dashboardBatch(calls));
  const ins = f.db.prepare("INSERT INTO counter_snapshots(ts,account_login,credits_used,reset_date,raw) VALUES (?,?,?,?,'{}')");
  f.db.raw.transaction(() => { for (let h = 0; h <= 30 * 24; h++) ins.run(START + h * H, "a", h * 25, "R"); })();
  const service = createCalibrationService(f.db, { revision: () => "evict" });
  const first = service.at(START + 100 * H, "auto");
  expect(first.status).toBe("calibrated");
  for (let h = 101; h < 101 + 511; h++) service.at(START + h * H, "auto"); // fills the cache to 512 entries
  const [again, fresh] = service.atMany([START + 100 * H, START + 700 * H], "auto");
  expect(fresh!.status).toBe("calibrated");
  expect(again).toEqual(first);
});

// Single-snapshot windows must obey the same bound as windows with evidence.
it("fallback inserts evict old entries without losing this request's results", () => {
  const ins = f.db.prepare("INSERT INTO counter_snapshots(ts,credits_used,raw) VALUES (?,?,'{}')");
  const step = 9 * 86_400_000;
  f.db.raw.transaction(() => {
    ins.run(START, 0); ins.run(START + 86_400_000, 250);
    for (let i = 1; i <= 600; i++) ins.run(START + i * step, 250);
  })();
  f.ledger.apply(dashboardBatch([dashboardCall("original-fit", { ts: START, price: { status: "priced", aic: 500,
    components: { input: 500, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "r", tier: "r", confidence: "estimated" } })]));
  const service = createCalibrationService(f.db, { revision: () => "fallback-evict" });
  const original = service.at(START + 86_400_000, "auto");
  expect(original.status).toBe("calibrated");
  const prepare = vi.spyOn(f.db, "prepare");
  for (let i = 1; i <= 600; i++) service.at(START + i * step, "auto");
  const fits = service.atMany([START + 599 * step, START + 600 * step], "auto");
  expect(fits.map(fit => fit.windowEnd)).toEqual([START + 599 * step, START + 600 * step]);
  expect(fits.every(fit => fit.status === "uncalibrated")).toBe(true);
  expect(prepare.mock.calls.some(([sql]) => sql.includes("calls_period_read"))).toBe(false);
  expect(service.at(START + 86_400_000, "auto")).toEqual(original);
  expect(prepare.mock.calls.filter(([sql]) => sql.includes("calls_period_read"))).toHaveLength(1);
});
