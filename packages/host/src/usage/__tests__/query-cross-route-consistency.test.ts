import { afterEach, expect, it } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import { queryOverviewV4, querySessions } from "../query-overview-v4.js";
import { querySession } from "../query-session.js";
import { sumValues } from "../query-redesign-shared.js";
import { customRange } from "./fixtures/redesign-range.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D } from "./fixtures/dashboard-ledger.js";
const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); });
it.each(["off", "auto"] as const)("Overview, Sessions and lifetime slices reconcile overlapping synthetic owners (%s)", mode => {
  const f = createDashboardFixture(false); closers.push(f.close);
  f.ledger.apply(dashboardBatch([
    dashboardCall("a-old", { ts: M - D, sessionId: "human-a" }),
    dashboardCall("a-now", { ts: M + D, sessionId: "human-a" }),
    dashboardCall("b-now", { ts: M + D, sessionId: "human-b" }),
    dashboardCall("worker", { ts: M + 3 * D, sessionId: "child", actor: "subagent", runId: "worker" }),
    dashboardCall("a-later", { ts: M + 5 * D, sessionId: "human-a" }),
  ], { sessions: ["human-a", "human-b", "child"].map(id => ({ id, ownerSessionId: id === "child" ? "human-a" : null, name: id, nameSource: "name", project: "Synthetic", nameOrder: 1, firstActivity: null, lastActivity: null })),
    runs: [{ id: "worker", dbPath: "synthetic/runs.db", project: null, repo: null, sessionId: "human-a", parentRunId: null, agent: null, role: "worker", name: "Worker", model: null, thinking: null, phase: null, startedAt: M + 3 * D, endedAt: M + 3 * D + 1, status: "done" }] }));
  f.ledger.insertCounter({ ts: M, creditsUsed: 0, accountLogin: "synthetic", resetDate: "2026-11-01", raw: {} });
  f.ledger.insertCounter({ ts: M + 2 * D, creditsUsed: 1, accountLogin: "synthetic", resetDate: "2026-11-01", raw: {} });
  const reader = openDashboardReader(f.file, { instanceId: "parity", serverBuild: "fixture", now: () => M + 7 * D, calibrationMode: () => mode })!; closers.push(() => reader.close());
  reader.snapshot(ctx => {
    const range = customRange(M, M + 7 * D), all = queryOverviewV4(ctx, range);
    const selected = queryOverviewV4(ctx, { ...range, buckets: [M + D, M + 3 * D] });
    expect(all.total.calls).toBe(4); expect(selected.selectedTotal.calls).toBe(3);
    const sessions = querySessions(ctx, { ...selected.range, sort: "credits", offset: 0, limit: 200 });
    expect(sessions.rows).toEqual(selected.sessions.rows);
    const values = sessions.rows.map(row => row.value);
    expect(selected.selectedTotal).toEqual(sumValues(values));
    expect(selected.flow.total).toEqual(selected.selectedTotal);
    expect(sumValues(selected.models.map(row => row.value))).toEqual(selected.selectedTotal);
    for (const row of sessions.rows) expect(sumValues(row.roles.map(role => role.value))).toEqual(row.value);
    const lifetime = querySession(ctx, "human-a", "UTC");
    expect(lifetime.total.calls).toBe(4); expect(lifetime.span?.start).toBe(M - D);
    expect(lifetime.flow.total).toEqual(lifetime.total);
    expect(sumValues(lifetime.models.map(row => row.value))).toEqual(lifetime.total);
    expect(lifetime.runs[0]!.value.calls).toBe(1);
    expect(querySessions(ctx, { ...range, sort: "credits", offset: 0, limit: 200 }).rows.find(row => row.id === "human-a")!.value.calls).toBe(3);
    expect(selected.total).toEqual(all.total); expect(selected.pace).toEqual(all.pace);
  });
});
