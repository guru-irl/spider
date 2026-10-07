import { expect, it, vi } from "vitest";
import { DashboardQueryError } from "../dashboard-contract.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { DETAIL_ROUTES } from "../query-detail.js";
import { createDashboardClient } from "../web/client.js";
import { mountDetail } from "../web/detail.js";
import { PlainDocument, button, elements, settle } from "./fixtures/plain-dom.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_MONTH as M, DASHBOARD_DAY as D } from "./fixtures/dashboard-ledger.js";

// Mutation target: paramsFor reading the live period instead of the echoed
// first-page window makes the actual server reject both cursors as invalid-query.
it.each(["calls", "relationships"])("rolling %s page two succeeds with a real pinned query hash", async mode => {
  vi.useFakeTimers();
  const fixture = createDashboardFixture(false); let clock = M + 2 * D;
  const reader = openDashboardReader(fixture.file, { instanceId: "rolling-cursors", now: () => clock, calibrationMode: () => "off", serverBuild: "fixture" })!;
  let view: Awaited<ReturnType<typeof mountDetail>> | undefined;
  try {
    fixture.ledger.apply(dashboardBatch(Array.from({ length: 51 }, (_, i) => dashboardCall(`call-${i}`, { ts: M + D + i, sessionId: "paged-session", runId: `run-${String(i).padStart(3, "0")}` }))));
    const doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root); const windows: number[] = [], errors: string[] = [];
    const client = createDashboardClient(async input => {
      const url = new URL(String(input), "http://127.0.0.1"); windows.push(Number(url.searchParams.get("end")));
      try {
        const data = reader.snapshot(ctx => DETAIL_ROUTES.find(route => route.path === url.pathname)!.handle(ctx, url.searchParams));
        return new Response(JSON.stringify({ apiVersion: 1, revision: "fixture", period: { start: M, end: Number(url.searchParams.get("end")) }, generatedAt: clock, data }));
      } catch (error) {
        if (!(error instanceof DashboardQueryError)) throw error;
        errors.push(error.code);
        return new Response(JSON.stringify({ apiVersion: 1, error: { code: error.code } }), { status: 400 });
      }
    });
    view = await mountDetail({ document: doc.asDocument(), root: root as unknown as HTMLElement, client, kind: "session", id: "paged-session", get period() { return { start: M, end: clock }; }, filters: [], signal: new AbortController().signal, navigate() {} });
    await settle(); clock += 60000;
    const caption = mode === "calls" ? "Recorded calls" : "Relationships";
    const section = elements(root, "section").find(s => s.children.some(c => c.tagName === "H2" && c.textContent === (mode === "calls" ? "Calls" : "Related sessions and runs")))!;
    button(section, "Next page").click(); await settle();
    const table = elements(root, "table").find(t => elements(t, "caption")[0]?.textContent === caption)!;
    expect(elements(table, "tr").slice(1)).toHaveLength(1); expect(root.textContent).not.toContain("Invalid usage query or cursor");
    expect(windows).toEqual([clock - 60000, clock - 60000]);
    // Break caught: advancing on automatic refresh with only one pager holding a cursor.
    const pinnedEnd = clock - 60000; clock += 60000; doc.activeElement = null;
    await vi.advanceTimersByTimeAsync(60000); await settle();
    expect(errors).toEqual([]); expect(windows.slice(2).every(end => end === pinnedEnd)).toBe(true);
    expect(windows).toHaveLength(mode === "calls" ? 3 : 4);
    const refreshed = elements(root, "table").find(t => elements(t, "caption")[0]?.textContent === caption)!;
    expect(elements(refreshed, "tr").slice(1)).toHaveLength(1); expect(button(section, "Previous page").disabled).toBe(false);
    button(root, "Refresh").click(); await settle(); expect(windows.at(-1)).toBe(clock);
    expect(button(section, "Previous page").disabled).toBe(true);
  } finally { view?.dispose(); reader.close(); fixture.close(); vi.useRealTimers(); }
});
