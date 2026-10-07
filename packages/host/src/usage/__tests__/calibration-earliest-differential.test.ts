import { afterEach, expect, test } from "vitest";
import { createCalibrationService } from "../calibration.js";
import { legacyEarliest } from "./fixtures/calibration-earliest-legacy.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

let f: DashboardFixture;
afterEach(() => f?.close());
function random(seed: number) {
  return () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
}
test("earliest waits for a timestamp group's valid duplicate on the next page", () => {
  f = createDashboardFixture(false);
  const insert = f.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)");
  f.db.raw.transaction(() => {
    for (let i = 0; i <= 510; i++) insert.run(M + Math.floor(i * D / 510), "seat", i === 510 ? 250 : 0, 100000, 90000, "a", "{}");
    insert.run(M + D, "seat", -1, 100000, 90000, "a", "{}"); // row 512
    insert.run(M + D, "seat", 300, 100000, 90000, "a", "{}"); // row 513 wins
    insert.run(M + D + 3600000, "seat", 350, 100000, 90000, "a", "{}");
  })();
  f.ledger.apply(dashboardBatch([dashboardCall("boundary", { ts: M, price: { status: "priced", aic: 500, components: { input: 500, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } })]));
  const fit = createCalibrationService(f.db, { revision: () => "fixture" }).earliest("auto");
  expect(fit).toMatchObject({ status: "calibrated", windowEnd: M + D, coveredHours: 24, computedAic: 500, counterDelta: 300, factor: 0.6 });
  expect(fit).toEqual(legacyEarliest(f.db));
});

// Kills chunk-boundary pair loss, duplicate selection changes, reordered
// rolling arithmetic, retained absence, and caching backwards appends.
test.each([777, 31337, 4242].flatMap(seed => ["none", "start", "late"].map(shape => [seed, shape] as const)))(
  "earliest is bit-identical to the old scan (seed=%s, fit=%s)", (seed, shape) => {
    f = createDashboardFixture(false);
    const r = random(seed), insert = f.db.prepare("INSERT INTO counter_snapshots VALUES (?,?,?,?,?,?,?)");
    let credits = 0, reset = "a";
    const calls: ReturnType<typeof dashboardCall>[] = [];
    f.db.raw.transaction(() => {
      for (let i = 0; i < 1500; i++) {
        const ts = M + i * 600000;
        if (i === 600 || i === 900) { credits = 0; reset += "b"; }
        else credits += shape === "none" || shape === "late" && i < 1100 ? 0 : 5 + r();
        const invalid = i === 509 || i === 700;
        insert.run(ts, "seat", invalid ? -1 : credits, 100000, 90000, reset, "{}");
        // Timestamp groups straddle the 512-row page boundary. Invalid rows
        // cannot replace valid duplicates, regardless of the chunk boundary.
        if (i === 510) for (let j = 0; j < 5; j++) insert.run(ts, "seat", j === 2 ? credits + 1 : -1, 100000, 90000, reset, "{}");
        const aic = 10 + r();
        calls.push(dashboardCall(`seed-${i}`, { ts, price: { status: "priced", aic, components: { input: aic, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } }));
      }
    })();
    f.ledger.apply(dashboardBatch(calls));
    const service = createCalibrationService(f.db, { revision: () => "fixture" });
    const compare = () => expect(service.earliest("auto")).toEqual(legacyEarliest(f.db));
    compare(); compare();
    expect(service.earliest("auto").status).toBe(shape === "none" ? "uncalibrated" : "calibrated");
    insert.run(M + 1600 * 600000, "seat", credits + 5, 100000, 90000, reset, "{}");
    service.windows({ start: M, end: M + 1600 * 600000 }, "auto");
    compare();
    insert.run(M + D, "seat", 200, 100000, 90000, "a", "{}");
    compare(); // backwards append can repair or change the earliest window
    insert.run(M + 1700 * 600000, "seat", -1, 100000, 90000, reset, "{}");
    compare();
  });
