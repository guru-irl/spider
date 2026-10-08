import { describe, expect, it } from "vitest";
import type { ApiEnvelope } from "../dashboard-contract.js";
import type { CalibrationData, DashboardPageContext } from "../dashboard-v4-contract.js";
import { DashboardClientError, type DashboardClient } from "../web/client.js";
import { mountCalibration } from "../web/calibration.js";
import { mountCalibrationStates } from "../web/states-calibration.js";
import { calibrationFixture, envelope, fixtureStateCases } from "./fixtures/redesign-contract.js";
import { PlainDocument, descendants, elements, button, cellText, settle, type PlainElement } from "./fixtures/plain-dom.js";

function setup(data = calibrationFixture(), get?: DashboardClient["get"]) {
  const document = new PlainDocument(), root = document.createElement("main"); document.body.append(root);
  const requests: { path: string; params: unknown; signal?: AbortSignal }[] = [], controller = new AbortController();
  const client: DashboardClient = { get: get ?? (async <T>(path: string, params?: unknown, signal?: AbortSignal) => { requests.push({ path, params, signal }); return envelope(data) as unknown as ApiEnvelope<T>; }) };
  const ctx: DashboardPageContext = { document: document.asDocument(), root: root as unknown as HTMLElement, client, route: { page: "calibration" }, signal: controller.signal,
    navigate() {}, overview: { range: "7d", from: 1, to: 2, unit: "tokens", tz: "Asia/Kathmandu", buckets: [1] }, now: () => Date.UTC(2030, 3, 14), back() {} };
  const page = mountCalibration(ctx); return { root, document, page, requests, controller };
}
const find = (root: PlainElement, cls: string) => descendants(root).find(n => n.className.split(" ").includes(cls))!;
const rows = (root: PlainElement, cls: string) => elements(find(root, cls), "tbody")[0]!.children;
const values = (row: PlainElement) => row.children.map(cellText);

describe("Calibration & data", () => {
  it("requests only Calibration, with no inherited Overview filters", async () => {
    const s = setup(); await s.page.refresh();
    expect(s.requests.length).toBeGreaterThan(0);
    expect(s.requests.every(r => r.path === "/api/calibration" && r.params instanceof URLSearchParams && r.params.size === 0)).toBe(true);
    expect(elements(s.root, "h1")[0]!.textContent).toBe("Calibration & data");
    expect(elements(s.root, "section")).toHaveLength(3);
    expect(s.root.textContent).not.toMatch(/AIC|Preview|Design options|even pace/);
    s.page.dispose();
  });
  it.each([
    ["calibrated", "Calibrated"], ["back-applied", "Back-applied"], ["published-only", "Published only"], ["counter-unavailable", "Counter unavailable"],
  ] as const)("shows matched totals and the %s status without guessing", async (status, label) => {
    const data = calibrationFixture(); data.correction.status = status;
    const s = setup(data); await s.page.refresh();
    const stats = find(s.root, "correction-stats");
    expect(stats.textContent).toContain("0.5"); expect(stats.textContent).toContain("12"); expect(stats.textContent).toContain("6"); expect(stats.textContent).toContain("48");
    expect(find(stats, "state-pill").textContent).toBe(label);
    expect(find(s.root, "method-copy").textContent.split(/[.!?](?:\s|$)/).filter(Boolean).length).toBeLessThanOrEqual(2);
    s.page.dispose();
  });
  it("keeps the exact factor while rounding fractional coverage for the stat row", async () => {
    const data = calibrationFixture(); data.correction.factor = 0.54; data.correction.coveredHours = 138 + 2 / 3;
    const s = setup(data); await s.page.refresh();
    const stats = find(s.root, "correction-stats"); expect(stats.textContent).toContain("0.54");
    expect(stats.children[3]!.textContent).toBe("Hours covered138.7"); s.page.dispose();
  });
  it("keeps null counter gaps distinct from zero and preserves exact chart/table numbers", async () => {
    const data = calibrationFixture(); data.daily = [
      { day: Date.UTC(2030, 3, 12), publishedEstimate: 8, counterDelta: 2 },
      { day: Date.UTC(2030, 3, 13), publishedEstimate: null, counterDelta: null },
      { day: Date.UTC(2030, 3, 14), publishedEstimate: 6, counterDelta: 0 },
    ];
    const s = setup(data); await s.page.refresh();
    const daily = rows(s.root, "daily-table");
    expect(values(daily[1]!)).toEqual(["Sat 13 APR UTC", "unavailable", "unavailable"]);
    expect(values(daily[2]!)).toEqual(["Sun 14 APR UTC", "6", "0"]);
    const counter = descendants(s.root).filter(n => n.getAttribute("data-series") === "counter" && n.getAttribute("data-value") !== null);
    expect(counter.map(n => n.getAttribute("data-value"))).toEqual(["2", "0"]);
    expect(descendants(s.root).filter(n => n.className === "counter-line")).toHaveLength(2);
    const table = button(s.root, "Table"); table.focus(); table.click();
    expect(table.getAttribute("aria-pressed")).toBe("true"); expect(s.document.activeElement).toBe(table);
    await s.page.refresh(); expect(button(s.root, "Table")).toBe(table); expect(s.document.activeElement).toBe(table);
    expect(table.getAttribute("aria-pressed")).toBe("true"); s.page.dispose();
  });
  it("does not connect observed counter days across an omitted UTC day", async () => {
    const data = calibrationFixture(); data.daily = [
      { day: Date.UTC(2030, 3, 12), publishedEstimate: 8, counterDelta: 2 },
      { day: Date.UTC(2030, 3, 14), publishedEstimate: 6, counterDelta: 3 },
    ];
    const s = setup(data); await s.page.refresh();
    expect(descendants(s.root).filter(n => n.className === "counter-line")).toHaveLength(2); s.page.dispose();
  });
  it("sorts intervals newest first, starts at ten and keeps Show more focused", async () => {
    const data = calibrationFixture(); data.intervals = Array.from({ length: 23 }, (_, i) => ({ start: Date.UTC(2030, 3, 1, i), end: Date.UTC(2030, 3, 1, i + 1), counterDelta: i, publishedEstimate: i * 2, ratio: i ? 0.5 : null }));
    const s = setup(data); await s.page.refresh();
    expect(rows(s.root, "intervals-table")).toHaveLength(10);
    expect(values(rows(s.root, "intervals-table")[0]!)[0]).toBe("Mon 1 APR 22:00 UTC");
    const more = button(s.root, "Show more"); more.focus(); more.click();
    expect(rows(s.root, "intervals-table")).toHaveLength(20); expect(s.document.activeElement).toBe(more); expect(more.getAttribute("aria-expanded")).toBe("true");
    await s.page.refresh(); expect(rows(s.root, "intervals-table")).toHaveLength(20);
    expect(s.document.activeElement).toBe(more); expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(find(s.root, "interval-note").textContent).toContain("Showing 20 of 23");
    more.click(); expect(rows(s.root, "intervals-table")).toHaveLength(23); expect(s.document.activeElement).toBe(more); expect(more.getAttribute("aria-disabled")).toBe("true");
    expect(more.textContent).toBe("All 23 shown"); more.click(); expect(rows(s.root, "intervals-table")).toHaveLength(23);
    await s.page.refresh(); expect(rows(s.root, "intervals-table")).toHaveLength(23); expect(s.document.activeElement).toBe(more); expect(more.textContent).toBe("All 23 shown");
    data.intervals = data.intervals.slice(0, -1); await s.page.refresh(); expect(rows(s.root, "intervals-table")).toHaveLength(10);
    expect(more.textContent).toBe("Show more"); expect(more.getAttribute("aria-expanded")).toBe("false");
    s.page.dispose();
  });
  it("uses singular coverage copy for one interval", async () => {
    const s = setup(); await s.page.refresh();
    expect(find(s.root, "interval-note").textContent).toBe("Newest first. Showing 1 of 1 interval.");
    s.page.dispose();
  });
  it.each([
    [8, ["0", "5", "10", "15"], "8"],
    [58000, ["0", "20k", "40k", "60k"], "58,000"],
    [0.58, ["0", "0.2", "0.4", "0.6"], "0.58"],
    [0.00058, ["0", "0.0002", "0.0004", "0.0006"], "0.00058"],
    [0, ["0", "0.5", "1", "1.5"], "0"],
  ] as const)("uses readable, rounded credit ticks at max %s", async (max, ticks, tableValue) => {
    const data = calibrationFixture(); data.daily = [{ day: Date.UTC(2030, 3, 12), publishedEstimate: max, counterDelta: 0 }];
    const s = setup(data); await s.page.refresh();
    const axes = descendants(s.root).filter(n => n.className === "correction-axis" && n.getAttribute("text-anchor") === "end");
    expect(axes.map(n => n.textContent)).toEqual(ticks);
    const bar = descendants(s.root).find(n => n.getAttribute("data-series") === "published")!;
    const top = Number(bar.getAttribute("d")!.match(/V([\d.]+)/)![1]); expect(top).toBeGreaterThanOrEqual(24); expect(top).toBeLessThanOrEqual(236);
    expect(values(rows(s.root, "daily-table")[0]!)[1]).toBe(tableValue);
    s.page.dispose();
  });
  it("names the daily chart by its evidence, unit and time zone", async () => {
    const s = setup(); await s.page.refresh();
    expect(elements(find(s.root, "correction-chart"), "title")[0]!.textContent).toBe("Daily published estimate and account counter, credits, UTC");
    s.page.dispose();
  });
  it("renders separate rate tiers, source dates, real zero and genuine unavailable prices", async () => {
    const data = calibrationFixture(); data.rates = [data.rates[0]!, { ...data.rates[0]!, tier: "long", abovePromptTokens: 200000, input: 0, cacheRead: null }];
    data.unpricedModels = [{ model: null, calls: 2, reason: "Model unavailable" }, { model: "model-unlisted", calls: 3, reason: "No published rate" }];
    const s = setup(data); await s.page.refresh(); const rates = rows(s.root, "rates-table");
    expect(rates).toHaveLength(2); expect(values(rates[1]!)).toEqual(["model-cedar", "long", "200,000", "0", "unavailable", "2.5", "8", "2030-04-01"]);
    expect(find(s.root, "rates-section").textContent).toContain("per 1M tokens");
    expect(find(s.root, "unpriced-models").textContent).toContain("3 calls"); expect(find(s.root, "unpriced-models").textContent).toContain("No published rate");
    s.page.dispose();
  });
  it.each([
    ["this-session", "This pi session"], ["another-session", "Another pi session"], ["dashboard-server", "Dashboard server"], ["none", "None"],
  ] as const)("shows %s ingestion, redacted errors and data gaps", async (collector, label) => {
    const data = calibrationFixture(); data.ingestion.collector = collector;
    data.gaps = { unpricedCalls: 3, compactionWithoutModel: 2, daysWithoutCounter: [Date.UTC(2030, 3, 12)] };
    const s = setup(data); await s.page.refresh();
    const ingest = find(s.root, "ingestion-section"); expect(ingest.textContent).toContain(label);
    expect(ingest.textContent).toContain("Sun 14 APR 23:59 UTC"); expect(ingest.textContent).toContain("archive/session");
    expect(ingest.textContent).toContain("parse-error"); expect(ingest.textContent).toContain("Fri 12 APR UTC");
    expect(find(ingest, "gaps-stats").textContent).toContain("Compaction without model2");
    s.page.dispose();
  });
  it("no-data sections each settle to one line without empty charts or tables", async () => {
    const example = fixtureStateCases().find(c => c.page === "calibration" && c.scenario === "no-data")!;
    const body = example.responses["/api/calibration"]!.body; if (!("data" in body)) throw new Error("Missing fixture");
    const s = setup(body.data as CalibrationData); await s.page.refresh();
    expect(elements(s.root, "section")).toHaveLength(3); expect(elements(s.root, "svg")).toHaveLength(0); expect(elements(s.root, "table")).toHaveLength(0);
    for (const section of elements(s.root, "section")) { expect(section.getAttribute("aria-busy")).toBe("false"); expect(elements(section, "p")).toHaveLength(1); }
    s.page.dispose();
  });
  it("handles unavailable counter with retained factor and short empty errors", async () => {
    const data = calibrationFixture(); data.correction.status = "counter-unavailable"; data.correction.accountCounter = null; data.errors = []; data.ingestion.errors = 0;
    const s = setup(data); await s.page.refresh(); expect(s.root.textContent).toContain("Counter unavailable"); expect(find(s.root, "correction-stats").textContent).toContain("0.5");
    expect(find(s.root, "errors-list").textContent).toBe("No collection errors."); s.page.dispose();
  });
  it("error ends loading and Retry replaces it with data", async () => {
    let fail = true; const s = setup(undefined, async <T>() => { if (fail) throw new Error("Failure"); return envelope(calibrationFixture()) as unknown as ApiEnvelope<T>; });
    await s.page.refresh(); expect(s.root.getAttribute("aria-busy")).toBe("false");
    expect(s.root.textContent).toContain("Could not load usage. Retry."); fail = false; button(s.root, "Retry").click(); await settle();
    expect(s.root.textContent).toContain("Correction factor"); expect(elements(s.root, "button").some(n => n.textContent === "Retry")).toBe(false); s.page.dispose();
  });
  it.each(["unauthorized", "server-unavailable"] as const)("%s directs reopening /usage instead of an ineffective Retry", async code => {
    const s = setup(undefined, async () => { throw new DashboardClientError(code); });
    await s.page.refresh(); expect(s.root.getAttribute("aria-busy")).toBe("false");
    expect(find(s.root, "calibration-error").textContent).toBe("Run /usage again");
    expect(elements(s.root, "button")).toHaveLength(0); s.page.dispose();
  });
  it.each(["busy", "timeout", "rate-limited"] as const)("%s offers a working Retry for transient errors", async code => {
    let fail = true;
    const s = setup(undefined, async <T>() => { if (fail) throw new DashboardClientError(code); return envelope(calibrationFixture()) as unknown as ApiEnvelope<T>; });
    await s.page.refresh(); expect(s.root.getAttribute("aria-busy")).toBe("false");
    expect(find(s.root, "calibration-error").textContent).toContain("Usage is temporarily unavailable. Retry.");
    expect(elements(s.root, "button").filter(n => n.textContent === "Retry")).toHaveLength(1);
    fail = false; button(s.root, "Retry").click(); await settle(); expect(find(s.root, "correction-stats").textContent).toContain("Correction factor"); s.page.dispose();
  });
  it("does not offer Retry for a rejected query", async () => {
    const s = setup(undefined, async () => { throw new DashboardClientError("invalid-query"); });
    await s.page.refresh(); expect(elements(s.root, "button")).toHaveLength(0);
    expect(s.root.getAttribute("aria-busy")).toBe("false"); s.page.dispose();
  });
  it("out-of-order refresh and navigation never paint stale data", async () => {
    const pending: ((data: ReturnType<typeof envelope<CalibrationData>>) => void)[] = [], signals: AbortSignal[] = [];
    const s = setup(undefined, <T>(_path: string, _params?: unknown, signal?: AbortSignal) => { signals.push(signal!); return new Promise(resolve => pending.push(resolve as never)) as never as Promise<ReturnType<typeof envelope<T>>>; });
    const first = s.page.refresh(), second = s.page.refresh();
    pending.at(-1)!(envelope(calibrationFixture({ correction: { factor: 0.75, publishedEstimate: 8, accountCounter: 6, coveredHours: 24, status: "calibrated" } }))); await second;
    pending.at(-2)!(envelope(calibrationFixture())); await first; expect(find(s.root, "correction-stats").textContent).toContain("0.75");
    const late = s.page.refresh(); s.controller.abort(); s.root.textContent = "New route"; pending.at(-1)!(envelope(calibrationFixture())); await late;
    expect(s.root.textContent).toBe("New route"); expect(signals.at(-1)!.aborted).toBe(true); s.page.dispose();
  });
  it("state examples mount the actual page from fixture cases", async () => {
    const document = new PlainDocument(), root = document.createElement("div"); document.body.append(root);
    await mountCalibrationStates(root as unknown as HTMLElement, fixtureStateCases());
    expect(elements(root, "h1").length).toBeGreaterThan(2); expect(root.textContent).toContain("Counter unavailable"); expect(root.textContent).toContain("Usage is temporarily unavailable. Retry.");
    expect(root.textContent).toContain("Back-applied"); expect(root.textContent).toContain("Published only"); expect(root.textContent).toContain("Showing 12 of 12 intervals");
  });
});
