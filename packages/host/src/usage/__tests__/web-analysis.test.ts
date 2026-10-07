import { afterEach, expect, it, vi } from "vitest";
import type { ApiEnvelope, Period } from "../dashboard-contract.js";
import { DashboardClientError, type DashboardClient } from "../web/client.js";
import { mountAnalysis, analysisProse, analysisTable, gapChart } from "../web/analysis-shared.js";
import { element } from "../web/dom.js";
import { createPager } from "../web/pager.js";
import { PlainDocument, elements, button, settle } from "./fixtures/plain-dom.js";

const period = { start: 0, end: 1000 };
type Data = { label: string; next: (string | null)[] };
const disposals: (() => void)[] = [];
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); });
async function fixture(lanes = 2, clearFilters?: () => void, initialPeriod: Period = period) {
  const doc = new PlainDocument(), root = doc.createElement("main"); doc.body.append(root);
  const requests: { params: URLSearchParams; signal: AbortSignal; resolve(label?: string, next?: (string | null)[], responsePeriod?: Period): void; reject(error: unknown): void }[] = [];
  const client: DashboardClient = { get<T>(_path: string, params: URLSearchParams, signal: AbortSignal) {
    return new Promise<ApiEnvelope<T>>((resolve, reject) => requests.push({ params, signal, reject, resolve(label = "page", next = ["daily-next", "sessions-next"], responsePeriod = initialPeriod) { resolve({ apiVersion: 1, revision: "fixture:0", period: responsePeriod, generatedAt: 1000, data: { label, next } as T }); } }));
  } };
  let bucket = "day";
  const ctx = { document: doc.asDocument(), root: root as unknown as HTMLElement, client, period: initialPeriod, filters: [], signal: new AbortController().signal, navigate() {}, clearFilters };
  const view = await mountAnalysis<Data>(ctx, { title: "Analysis", path: "/api/cache", params: () => new URLSearchParams({ bucket }),
    pages: Array.from({ length: lanes }, (_, i) => ({ title: i ? "Sessions" : "Daily", param: i ? "cursor" : "dailyCursor", next: (data: Data) => data.next[i]! })),
    render(data) { return { panels: Array.from({ length: lanes }, () => element(ctx.document, "p", data.label)) }; },
    choices: [{ label: "Daily buckets", select() { bucket = "day"; } }, { label: "Monthly buckets", select() { bucket = "month"; } }, { label: "Snapshot pairs", select() { bucket = "snapshot"; } }],
  });
  disposals.push(view.dispose);
  const panels = elements(root, "section").filter(n => n.children.some(c => c.tagName === "H2"));
  const statuses = panels.map(p => elements(p, "p").find(n => n.getAttribute("role") === "status")!);
  return { doc, root, ctx, requests, panels, statuses };
}

it("analysis pagers use readable Updated timestamps with exact datetime values", () => {
  const doc = new PlainDocument(), pager = createPager(doc.asDocument(), { title: "Evidence", param: "cursor", onLoad() {} });
  pager.complete(Date.UTC(2026, 0, 3), true);
  expect(pager.region.textContent).toContain("Updated 3 Jan 2026, 00:00 UTC");
  expect(elements(pager.region, "time").map(n => n.getAttribute("datetime"))).toEqual(["2026-01-03T00:00:00.000Z"]);
  expect(elements(pager.region, "p").filter(n => n.className.includes("numeric"))).toHaveLength(0);
});

it("analysis prose and tables render readable semantic UTC evidence", async () => {
  // Breaks: raw ISO text or monospaced timestamp fragments, unlike Overview/Detail.
  const f = await fixture(1), text = "2026-01-01T00:00:00.000Z to 2026-01-03T00:00:00.000Z UTC · x0.5 · trailing 7-day ratio";
  const prose = analysisProse(f.ctx, text), table = analysisTable(f.ctx, "Evidence", ["Window"], [[text]]);
  for (const node of [prose, table]) {
    expect(node.textContent).toContain("1 Jan 2026 to 3 Jan 2026, 00:00 UTC");
    expect(node.textContent).not.toContain("2026-01-01T");
    expect(elements(node, "time").map(n => n.getAttribute("datetime"))).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z"]);
    expect(elements(node, "span").filter(n => n.className === "numeric").some(n => n.textContent.includes("2026-"))).toBe(false);
  }
});

it.each(["invalid-query", "ledger-changed"] as const)("page-1 %s errors never self-retry", async code => {
  // Breaks: recovering without a cursor loops on page-1 400/409. Keep the second request pending if broken.
  const f = await fixture(); f.requests[0]!.reject(new DashboardClientError(code)); await settle();
  expect(f.requests).toHaveLength(1); expect(f.statuses.filter(n => n.textContent)).toHaveLength(1);
});
it("recovers both Cache cursors before one reset request and announces the next manual action", async () => {
  // Breaks: short-circuit recovery or leaving the recovery flag set permanently.
  const f = await fixture(); f.requests[0]!.resolve(); await settle();
  button(f.panels[0]!, "Next page").click(); f.requests[1]!.resolve(); await settle();
  button(f.panels[1]!, "Next page").click(); f.requests[2]!.resolve(); await settle();
  button(f.root, "Refresh").click(); f.requests[3]!.reject(new DashboardClientError("ledger-changed")); await settle();
  expect(f.requests).toHaveLength(5); expect(f.requests[4]!.params.has("dailyCursor")).toBe(false); expect(f.requests[4]!.params.has("cursor")).toBe(false);
  f.requests[4]!.resolve(); await settle(); expect(f.statuses.map(s => s.textContent)).toEqual(["Daily, Sessions: Page link no longer valid. Showing page 1.", ""]);
  button(f.panels[0]!, "Next page").click(); expect(f.statuses[0]!.textContent).toBe("Loading usage"); f.requests[5]!.resolve(); await settle(); expect(f.statuses[0]!.textContent).toBe("Usage updated.");
});
it("scopes failure and Retry to the initiating section and preserves the other failed target", async () => {
  // Breaks: one failure produces two live messages/Retry targets, or unrelated success discards a failed target.
  const f = await fixture(); f.requests[0]!.resolve(); await settle();
  button(f.panels[0]!, "Next page").click(); expect(f.statuses.filter(n => n.textContent === "Loading usage")).toHaveLength(1);
  f.requests[1]!.reject(new DashboardClientError("busy")); await settle();
  expect(f.statuses.filter(n => n.textContent.includes("temporarily unavailable"))).toHaveLength(1);
  expect(button(f.panels[0]!, "Retry").hidden).toBe(false); expect(button(f.panels[1]!, "Retry").hidden).toBe(true);
  button(f.panels[1]!, "Next page").click(); f.requests[2]!.reject(new DashboardClientError("busy")); await settle();
  button(f.panels[1]!, "Retry").click(); expect(f.requests[3]!.params.get("cursor")).toBe("sessions-next"); expect(f.requests[3]!.params.has("dailyCursor")).toBe(false);
  f.requests[3]!.resolve(); await settle(); expect(button(f.panels[0]!, "Retry").hidden).toBe(false);
  button(f.panels[0]!, "Retry").click(); expect(f.requests[4]!.params.get("dailyCursor")).toBe("daily-next"); expect(f.requests[4]!.params.get("cursor")).toBe("sessions-next");
});
it("clears old content when the cursor-reset replacement request fails", async () => {
  // Breaks: pager says page 1 while page-2 data remains on screen.
  const f = await fixture(1); f.requests[0]!.resolve("page 1"); await settle(); button(f.root, "Next page").click(); f.requests[1]!.resolve("page 2"); await settle();
  button(f.root, "Refresh").click(); f.requests[2]!.reject(new DashboardClientError("ledger-changed")); await settle(); f.requests[3]!.reject(new DashboardClientError("busy")); await settle();
  expect(f.root.textContent).not.toContain("page 2"); expect(f.statuses[0]!.textContent).toContain("temporarily unavailable"); expect(button(f.root, "Previous page").getAttribute("aria-disabled")).toBe("true");
});
it("last bucket choice during a load is queued, not dropped or sent concurrently", async () => {
  // Breaks: ignoring bucket clicks or issuing them concurrently while an old response can still render.
  const f = await fixture(1); button(f.root, "Monthly buckets").click(); button(f.root, "Snapshot pairs").click();
  expect(f.requests).toHaveLength(1); f.requests[0]!.resolve(); await settle();
  expect(f.requests).toHaveLength(2); expect(f.requests[1]!.params.get("bucket")).toBe("snapshot"); expect(button(f.root, "Snapshot pairs").getAttribute("aria-pressed")).toBe("true");
  f.requests[1]!.resolve(); await settle(); expect(f.requests).toHaveLength(2);
});
it("pauses unauthorized polling even though a manual Retry is permitted", async () => {
  // Breaks: unauthorized omitted from shutdown codes.
  vi.useFakeTimers(); const f = await fixture(1); f.requests[0]!.reject(new DashboardClientError("unauthorized")); await settle();
  await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(1);
});
it("disables last-page Next and marks content busy without stealing focus", async () => {
  // Breaks: missing next-cursor aria-disabled, content aria-busy or native disabling focused actions.
  const f = await fixture(1); f.requests[0]!.resolve("first"); await settle(); const next = button(f.root, "Next page"); next.focus(); next.click();
  const content = f.panels[0]!.children[1]!; expect(content.getAttribute("aria-busy")).toBe("true"); expect(f.doc.activeElement).toBe(next); expect(next.disabled).toBe(false);
  f.requests[1]!.resolve("last", [null]); await settle(); expect(content.getAttribute("aria-busy")).toBe("false"); expect(next.getAttribute("aria-disabled")).toBe("true"); next.click(); expect(f.requests).toHaveLength(2);
});
it("Previous and Retry do nothing during an in-flight load", async () => {
  // Breaks: ignoring loading or hidden guards in Previous/Retry.
  const f = await fixture(1); f.requests[0]!.resolve(); await settle(); button(f.root, "Next page").click(); f.requests[1]!.resolve(); await settle();
  button(f.root, "Refresh").click(); button(f.root, "Previous page").click(); button(f.root, "Retry").click(); expect(f.requests).toHaveLength(3);
  f.requests[2]!.reject(new DashboardClientError("busy")); await settle(); const retry = button(f.root, "Retry"); retry.click(); expect(retry.hidden).toBe(true); retry.click(); button(f.root, "Previous page").click(); expect(f.requests).toHaveLength(4);
});
it("stale finally and timer cannot end or supersede an active load", async () => {
  // Breaks: stale finally clears loading, or timer ignores it.
  vi.useFakeTimers(); const f = await fixture(1); button(f.root, "Refresh").click(); f.requests[0]!.resolve(); await settle();
  await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(2); expect(f.panels[0]!.children[1]!.getAttribute("aria-busy")).toBe("true");
  f.requests[1]!.resolve(); await settle(); await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(3);
});
it("persistent controls never stop automatic refresh; form controls and recent interaction defer it", async () => {
  // Breaks: whole-section focus guard or no ten-second deferral.
  vi.useFakeTimers(); const f = await fixture(1); f.requests[0]!.resolve(); await settle(); button(f.root, "Refresh").focus();
  await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(2); f.requests[1]!.resolve(); await settle();
  const formButton = f.doc.createElement("button"); f.panels[0]!.children[1]!.append(formButton); formButton.focus();
  await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(2); f.doc.activeElement = null;
  await vi.advanceTimersByTimeAsync(59000); f.doc.dispatchEvent(new Event("pointerdown")); await vi.advanceTimersByTimeAsync(1000); expect(f.requests).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(3);
});
it("automatic failure clears stale success quietly and records failure", async () => {
  // Breaks: failed timer refresh still claims Usage updated in the live status.
  vi.useFakeTimers(); const f = await fixture(1); f.requests[0]!.resolve(); await settle(); expect(f.statuses[0]!.textContent).toBe("Usage updated.");
  await vi.advanceTimersByTimeAsync(60000); f.requests[1]!.reject(new DashboardClientError("busy")); await settle(); expect(f.statuses[0]!.textContent).toBe(""); expect(f.panels[0]!.textContent).toContain("temporarily unavailable");
});
it("uses action-aware unknown-filter copy", async () => {
  // Breaks: discarding ctx.clearFilters in errorCopy.
  const f = await fixture(1, () => {}); f.requests[0]!.reject(new DashboardClientError("unknown-filter-id")); await settle(); expect(f.statuses[0]!.textContent).toBe("Selected filter is no longer available. Clear filters to continue.");
});
it("keeps 7-day prose in the text face, without patching formatter words", async () => {
  // Breaks: splitting the digit/hyphen into a numeric span or patching legend grammar.
  const f = await fixture(1); const prose = analysisProse(f.ctx, "Trailing 7-day ratio x0.5 over 1 day · trailing 7-day ratio");
  expect(elements(prose, "span").filter(n => n.className === "numeric").map(n => n.textContent)).not.toContain("7-"); expect(prose.textContent).toContain("over 1 day"); expect(prose.textContent).toContain("trailing 7-day ratio");
});
it("panel headings name content and pager controls have their own group label", async () => {
  // Breaks: unlabeled pagination control groups among chart groups.
  const f = await fixture(1); expect(elements(f.panels[0]!, "h2")[0]!.textContent).toBe("Daily");
  const controls = button(f.root, "Next page").parentElement!; expect(controls.getAttribute("role")).toBe("group"); expect(controls.getAttribute("aria-label")).toBe("Daily pages");
});

it("failed Retry pins survive an unrelated page-1 refresh", () => {
  // Breaks: retaining the failed cursor but silently changing the period that validates it.
  const doc = new PlainDocument(); const requests: { cursor: string | null; end: number | undefined }[] = [];
  const pager = createPager(doc.asDocument(), { title: "Daily", param: "cursor", onLoad() { const params = new URLSearchParams(); const pin = pager.request(params); requests.push({ cursor: params.get("cursor"), end: pin?.end }); } });
  doc.body.append(pager.region as unknown as ReturnType<PlainDocument["createElement"]>);
  pager.accept(period, "page-2"); pager.complete(1000, true); button(pager.region, "Next page").click(); pager.fail(new DashboardClientError("busy"), true);
  pager.accept({ start: 0, end: 2000 }, "new-page-2", false); pager.complete(2000, false); button(pager.region, "Retry").click();
  expect(requests).toEqual([{ cursor: "page-2", end: 1000 }, { cursor: "page-2", end: 1000 }]);
});
it("Clear filters is offered only with the context action and hides when refresh starts", async () => {
  // Breaks: promising Clear filters with no clickable action, showing it for unrelated errors, or leaving it after success.
  let clears = 0; const f = await fixture(1, () => { clears++; }); f.requests[0]!.reject(new DashboardClientError("unknown-filter-id")); await settle();
  const clear = button(f.root, "Clear filters"); expect(clear.hidden).toBe(false); clear.click(); expect(clears).toBe(1);
  clear.focus(); button(f.root, "Refresh").click(); expect(clear.hidden).toBe(true); expect(f.doc.activeElement?.tagName).toBe("H2"); f.requests[1]!.resolve(); await settle(); expect(clear.hidden).toBe(true);
  button(f.root, "Refresh").click(); f.requests[2]!.reject(new DashboardClientError("busy")); await settle(); expect(clear.hidden).toBe(true);
  const g = await fixture(1); g.requests[0]!.reject(new DashboardClientError("unknown-filter-id")); await settle(); expect(button(g.root, "Clear filters").hidden).toBe(true); expect(g.statuses[0]!.textContent).toContain("Remove the unknown filter from the address");
});


it("announces success only in the initiating lane", async () => {
  // Breaks: N4 makes every lane announce one manual action.
  const f = await fixture(); f.requests[0]!.resolve(); await settle();
  expect(f.statuses.map(s => s.textContent)).toEqual(["Usage updated.", ""]);
  button(f.panels[1]!, "Next page").click(); f.requests[1]!.resolve(); await settle();
  expect(f.statuses.map(s => s.textContent)).toEqual(["", "Usage updated."]);
});
it("Retry excludes a different lane's cursor and keeps that lane's page and pin", async () => {
  // Breaks: E12 sends an old Sessions cursor with Daily's newer pin, or resets Daily.
  vi.useFakeTimers(); const f = await fixture(); f.requests[0]!.resolve(); await settle();
  button(f.panels[1]!, "Next page").click(); f.requests[1]!.reject(new DashboardClientError("busy")); await settle();
  f.ctx.period = { start: 0, end: 2000 };
  await vi.advanceTimersByTimeAsync(60000); f.requests[2]!.resolve("fresh", ["d2b", "s2b"], f.ctx.period); await settle();
  button(f.panels[0]!, "Next page").click(); f.requests[3]!.resolve("daily page 2", ["d3b", "s3b"], f.ctx.period); await settle();
  button(f.panels[1]!, "Retry").click();
  expect(f.requests[4]!.params.get("end")).toBe("1000"); expect(f.requests[4]!.params.get("cursor")).toBe("sessions-next");
  expect(f.requests[4]!.params.has("dailyCursor")).toBe(false);
  f.requests[4]!.resolve("sessions page 2", ["d3a", "s3a"]); await settle();
  expect(f.panels[0]!.children[1]!.textContent).toBe("daily page 2");
  expect(button(f.panels[0]!, "Previous page").getAttribute("aria-disabled")).toBe("false");
  button(f.panels[0]!, "Next page").click();
  expect(f.requests[5]!.params.get("end")).toBe("2000"); expect(f.requests[5]!.params.get("dailyCursor")).toBe("d3b");
  expect(f.requests[5]!.params.has("cursor")).toBe(false);
});
it("clears a superseded lane's loading text after Refresh succeeds", async () => {
  // Breaks: E11 leaves Sessions saying Loading usage forever.
  const f = await fixture(); f.requests[0]!.resolve(); await settle();
  button(f.panels[1]!, "Next page").click(); button(f.root, "Refresh").click();
  f.requests[2]!.resolve(); await settle(); f.requests[1]!.resolve("late"); await settle();
  expect(f.statuses.map(s => s.textContent)).toEqual(["Usage updated.", ""]);
});
it("clears every lane's stale success and records automatic failure quietly", async () => {
  // Breaks: E15 keeps success/Updated stamps in non-owner lanes after a failed timer.
  vi.useFakeTimers(); const f = await fixture(); f.requests[0]!.resolve(); await settle();
  button(f.panels[1]!, "Next page").click(); f.requests[1]!.resolve(); await settle();
  await vi.advanceTimersByTimeAsync(60000); f.requests[2]!.reject(new DashboardClientError("busy")); await settle();
  expect(f.statuses.map(s => s.textContent)).toEqual(["", ""]);
  for (const p of f.panels) { expect(p.children[3]!.textContent).toContain("temporarily unavailable"); expect(p.children[3]!.textContent).not.toContain("Updated"); }
  expect(f.panels.map(p => button(p, "Retry").hidden)).toEqual([false, true]);
});
it("manual Refresh announces a non-owner lane's page-1 reset once", async () => {
  // Breaks: E4 puts Sessions reset only in the non-live stamp.
  const f = await fixture(); f.requests[0]!.resolve(); await settle();
  button(f.panels[1]!, "Next page").click(); f.requests[1]!.resolve(); await settle();
  button(f.root, "Refresh").click(); f.requests[2]!.reject(new DashboardClientError("ledger-changed")); await settle();
  expect(f.statuses[0]!.textContent).toBe("Sessions: Page link no longer valid. Showing page 1.");
  f.requests[3]!.resolve(); await settle();
  expect(f.statuses[0]!.textContent).toBe("Sessions: Page link no longer valid. Showing page 1."); expect(f.statuses[1]!.textContent).toBe("");
});
it("recovery failure and the next manual action stay in the initiating lane", async () => {
  // Breaks: N31 loses the initiator; N34 keeps recovery silence after failure.
  const f = await fixture(); f.requests[0]!.resolve(); await settle();
  button(f.panels[1]!, "Next page").click(); f.requests[1]!.reject(new DashboardClientError("ledger-changed")); await settle();
  f.requests[2]!.reject(new DashboardClientError("busy")); await settle();
  expect(f.statuses[0]!.textContent).toBe(""); expect(f.statuses[1]!.textContent).toContain("temporarily unavailable");
  expect(f.panels.map(p => button(p, "Retry").hidden)).toEqual([true, false]);
  button(f.panels[1]!, "Retry").click(); expect(f.statuses[1]!.textContent).toBe("Loading usage");
  f.requests[3]!.resolve(); await settle(); expect(f.statuses.map(s => s.textContent)).toEqual(["", "Usage updated."]);
});
it("a failed Refresh restores the superseded lane's committed position", async () => {
  // Breaks: N7 leaves the pending Sessions move committed after Refresh fails.
  const f = await fixture(); f.requests[0]!.resolve("page 1"); await settle();
  button(f.panels[1]!, "Next page").click(); button(f.root, "Refresh").click();
  f.requests[2]!.reject(new DashboardClientError("busy")); await settle();
  expect(button(f.panels[1]!, "Previous page").getAttribute("aria-disabled")).toBe("true");
  expect(f.panels[1]!.children[1]!.textContent).toBe("page 1");
  button(f.root, "Refresh").click(); expect(f.requests[3]!.params.has("cursor")).toBe(false);
});
it("identity-unavailable pauses polling after a successful manual load", async () => {
  // Breaks: N28 resumes polling because identity-unavailable is retryable at client level.
  vi.useFakeTimers(); const f = await fixture(1); f.requests[0]!.resolve(); await settle();
  button(f.root, "Refresh").click(); f.requests[1]!.reject(new DashboardClientError("identity-unavailable")); await settle();
  await vi.advanceTimersByTimeAsync(60000); expect(f.requests).toHaveLength(2);
});
it("Previous is aria-disabled during a load even when a previous page exists", async () => {
  // Breaks: N20 drops loading from Previous's accessible disabled state.
  const f = await fixture(1); f.requests[0]!.resolve(); await settle();
  button(f.root, "Next page").click(); f.requests[1]!.resolve(); await settle();
  const back = button(f.root, "Previous page"); expect(back.getAttribute("aria-disabled")).toBe("false");
  button(f.root, "Refresh").click(); expect(back.getAttribute("aria-disabled")).toBe("true");
});
it("gapChart labels supplied back-applied gaps natively", async () => {
  // Breaks: gapChart discards the supplied basis instead of using 5b's native option.
  const f = await fixture(1);
  const chart = gapChart(f.ctx, "Back-applied gap", [{ start: 0, end: 1000, label: "one", value: 2, tokens: null }], "back-applied");
  expect(elements(chart, "p").find(p => p.className.split(" ").includes("chart-summary"))!.textContent).toContain("Gap: counter minus back-applied");
  expect(elements(chart, "th")[2]!.textContent).toBe("Gap: counter minus back-applied");
});

it("manual lane failure preserves the other lane's Updated stamp; Refresh removes failed Retry", async () => {
  // Breaks: E19 replaces Daily's stamp after Sessions fails; D8 preserves Sessions Retry after Refresh.
  const f = await fixture(); f.requests[0]!.resolve(); await settle();
  const stamp = f.panels[0]!.children[3]!.textContent;
  expect(stamp).toBe("Updated 1 Jan 1970, 00:00:01 UTC");
  button(f.panels[1]!, "Next page").click(); f.requests[1]!.reject(new DashboardClientError("busy")); await settle();
  expect(f.panels[0]!.children[3]!.textContent).toBe(stamp);
  expect(f.statuses[1]!.textContent).toBe("Usage is temporarily unavailable. Retry.");
  expect(button(f.panels[1]!, "Retry").hidden).toBe(false);
  button(f.root, "Refresh").click(); f.requests[2]!.resolve(); await settle();
  expect(button(f.panels[1]!, "Retry").hidden).toBe(true);
});
it("automatic failure offers Retry copy only in sections with Retry", async () => {
  // Breaks: an included non-owner stamp instructs Retry without offering the action.
  vi.useFakeTimers(); const f = await fixture(); f.requests[0]!.resolve(); await settle();
  await vi.advanceTimersByTimeAsync(60000); f.requests[1]!.reject(new DashboardClientError("busy")); await settle();
  expect(f.panels.map(p => p.children[3]!.textContent)).toEqual(["Usage is temporarily unavailable. Retry.", "Usage is temporarily unavailable."]);
  expect(f.panels.map(p => button(p, "Retry").hidden)).toEqual([false, true]);
});
async function fixedSplitPins() {
  // Explicit non-rolling windows with the same end but different starts exercise D1.
  vi.useFakeTimers(); const f = await fixture(2, undefined, { start: 0, end: 8640000000 }); f.requests[0]!.resolve(); await settle();
  button(f.panels[1]!, "Next page").click(); f.requests[1]!.reject(new DashboardClientError("busy")); await settle();
  f.ctx.period = { start: 86400000, end: 8640000000 };
  await vi.advanceTimersByTimeAsync(60000); f.requests[2]!.resolve("fixed B", ["dB", "sB"], f.ctx.period); await settle();
  button(f.panels[0]!, "Next page").click(); f.requests[3]!.resolve("daily B2", ["dB3", "sB3"], f.ctx.period); await settle();
  button(f.panels[1]!, "Retry").click();
  expect(f.requests[4]!.params.get("start")).toBe("0"); expect(f.requests[4]!.params.has("dailyCursor")).toBe(false);
  f.requests[4]!.resolve("sessions A2", ["dA3", "sA3"]); await settle();
  expect(f.panels[0]!.children[1]!.textContent).toBe("daily B2");
  return f;
}
it("fixed-period automatic failure leaves excluded lane evidence and Updated stamp intact", async () => {
  // Breaks: D6 gives an incompatible pinned lane the request's failure stamp.
  const f = await fixedSplitPins(); const stamp = f.panels[1]!.children[3]!.textContent;
  await vi.advanceTimersByTimeAsync(60000); expect(f.requests[5]!.params.has("cursor")).toBe(false);
  f.requests[5]!.reject(new DashboardClientError("busy")); await settle();
  expect(f.panels[1]!.children[1]!.textContent).toBe("sessions A2"); expect(f.panels[1]!.children[3]!.textContent).toBe(stamp);
});
it("fixed-period cursor recovery skips excluded lanes and does not prefix the owner's sole reset", async () => {
  // Breaks: D9 resets an excluded cursor; D3 always prefixes even a lane's own sole reset.
  const f = await fixedSplitPins(); button(f.panels[0]!, "Next page").click();
  f.requests[5]!.reject(new DashboardClientError("ledger-changed")); await settle();
  expect(f.statuses[0]!.textContent).toBe("Page link no longer valid. Showing page 1.");
  expect(f.requests[6]!.params.has("dailyCursor")).toBe(false);
  expect(f.requests[6]!.params.has("cursor")).toBe(false);
  expect(f.panels[1]!.children[1]!.textContent).toBe("sessions A2");
});
it("fixed-period unpinned initiating lane uses the selected period, not another lane's pin", async () => {
  // Breaks: D16 takes Sessions A's pin when Daily returns to page 1 under selected B.
  const f = await fixedSplitPins(); button(f.panels[0]!, "Previous page").click();
  expect(f.requests[5]!.params.get("start")).toBe("86400000"); expect(f.requests[5]!.params.get("end")).toBe("8640000000");
  expect(f.requests[5]!.params.has("cursor")).toBe(false); expect(f.requests[5]!.params.has("dailyCursor")).toBe(false);
  f.requests[5]!.resolve("daily B1", ["dB", "sB"], f.ctx.period); await settle();
  expect(f.panels[1]!.children[1]!.textContent).toBe("sessions A2");
});
