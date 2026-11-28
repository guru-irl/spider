import { expect, it } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import * as sessions from "../query-session.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_DAY, DASHBOARD_MONTH, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";

it("selects only this visit's canonical session calls, preserving unknown prices and token components", () => {
  expect(sessions.queryVisitUsage).toBeTypeOf("function");
  const fixture = createDashboardFixture();
  const from = DASHBOARD_MONTH + DASHBOARD_DAY, to = from + 1;
  try {
    fixture.ledger.apply(dashboardBatch([
      dashboardCall("pre-visit", { ts: from - 1 }),
      dashboardCall("next-visit", { ts: to }),
      dashboardCall("other-owner", { ts: from, sessionId: "separate-session" }),
    ]));
    const reader = openDashboardReader(fixture.file, { instanceId: "visit", now: () => DASHBOARD_NOW, serverBuild: "fixture", calibrationMode: () => "off" })!;
    try {
      const visit = reader.snapshot(ctx => sessions.queryVisitUsage(ctx, "parent-session", from, to));
      // Native, detailed child, covering report, unproven overlap, and unpriced warmer.
      // Copied history, the shadowed report, covered detail, and out-of-visit rows do not count.
      expect(visit).toEqual({ credits: 4, calls: 5, unpricedCalls: 1,
        tokens: { input: 50, cacheRead: 100, cacheWrite: 150, output: 50, cacheWrite1h: 25, reasoning: 20, prompt: 300, total: 350 } });
      expect(reader.snapshot(ctx => sessions.queryVisitUsage(ctx, "parent-session", to + 1, to + 2))).toBeNull();
    } finally { reader.close(); }
  } finally { fixture.close(); }
});
