import { describe, expect, it, vi } from "vitest";
import { PlainDocument, elements, settle, button, cellText } from "./fixtures/plain-dom.js";
import { startDashboard } from "../web/app.js";
import { chartWithTable } from "../web/charts.js";
import { renderTable } from "../web/tables.js";
import { tokenList, periodTimes, formatUtcTimestamp, evidenceText } from "../web/format.js";
import * as dom from "../web/dom.js";

const period = { start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 9, 6, 22, 13) };
const tokens = { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, prompt: 60, total: 100, reasoning: null, cacheWrite1h: 0 };

function browserWindow(doc: PlainDocument, hash = "") {
  const win = new EventTarget();
  const location = { hash };
  const entries = [hash]; let index = 0;
  const history = {
    pushState(_state: unknown, _title: string, url: string) { location.hash = url; entries.splice(++index); entries.push(url); },
    replaceState(_state: unknown, _title: string, url: string) { location.hash = url; entries[index] = url; },
    back() { if (index > 0) { location.hash = entries[--index]!; win.dispatchEvent(new Event("popstate")); win.dispatchEvent(new Event("hashchange")); } },
    forward() { if (index < entries.length - 1) { location.hash = entries[++index]!; win.dispatchEvent(new Event("popstate")); win.dispatchEvent(new Event("hashchange")); } },
  };
  Object.assign(win, { location, history }); Object.defineProperty(doc, "defaultView", { value: win });
  return { win, location, history };
}

it("navigation disposes old view and preserves selection", async () => {
  // Breaks: failing to serialize or restore slice/representation, leaked old work, duplicate history events.
  vi.useFakeTimers(); const doc = new PlainDocument(), browser = browserWindow(doc);
  const listenerAdd = vi.spyOn(browser.win, "addEventListener"), listenerRemove = vi.spyOn(browser.win, "removeEventListener");
  const reads: { view: string; period: unknown; filters: unknown; signal: AbortSignal }[] = [];
  const disposals: string[] = [];
  const mount = (name: string): import("../web/views.js").ViewMount => async ctx => {
    reads.push({ view: name, period: ctx.period, filters: ctx.filters, signal: ctx.signal });
    const timer = setInterval(() => {}, 60000);
    ctx.root.append(chartWithTable(ctx.document, { title: name, unit: "tokens", points: [{ ...period, label: "Day", value: 100, tokens }] }));
    return { dispose() { disposals.push(name); clearInterval(timer); } };
  };
  const mounts = { overview: mount("overview"), cache: mount("cache") };
  let app = startDashboard({ document: doc.asDocument(), initialRoute: { view: "overview", period, filters: [{ field: "role", kind: "id", value: "v1_safe" }] }, mounts });
  try {
    await settle(); button(doc.body, "Table").click();
    expect(browser.location.hash).not.toContain("mode=");
    button(doc.body, "Cache").click(); await settle();
    expect(disposals).toEqual(["overview"]); expect(reads[0]!.signal.aborted).toBe(true);
    expect(reads[1]).toMatchObject({ view: "cache", period, filters: [{ field: "role", kind: "id", value: "v1_safe" }] });
    expect(button(doc.body, "Table").getAttribute("aria-pressed")).toBe("false");
    browser.history.back(); await settle();
    expect(reads).toHaveLength(3); expect(reads[2]).toMatchObject({ view: "overview", period, filters: [{ field: "role", kind: "id", value: "v1_safe" }] });
    expect(disposals).toEqual(["overview", "cache"]); expect(reads[1]!.signal.aborted).toBe(true);
    browser.history.forward(); await settle(); expect(reads).toHaveLength(4); expect(reads[3]!.view).toBe("cache");
    app.dispose();
    app = startDashboard({ document: doc.asDocument(), mounts }); await settle();
    expect(reads.at(-1)).toMatchObject({ view: "cache", period, filters: [{ field: "role", kind: "id", value: "v1_safe" }] });
    expect(button(doc.body, "Table").getAttribute("aria-pressed")).toBe("false");
    const count = reads.length; app.dispose(); browser.history.back(); await settle(); expect(reads).toHaveLength(count);
  } finally {
    app.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
    expect([...doc.listeners.values()].every(set => set.size === 0)).toBe(true);
    expect(listenerRemove.mock.calls).toHaveLength(listenerAdd.mock.calls.length);
  }
});

it("default Explorer restores representation and every view explains AIC markers", async () => {
  const { createDashboardBrowserPage } = await import("./fixtures/dashboard-browser-fixture.js");
  const { allViewPage } = await import("./fixtures/all-view-browser-fixture.js");
  const { createDashboardClient } = await import("../web/client.js");
  const fixture = allViewPage(await createDashboardBrowserPage(), "calibrated");
  const doc = new PlainDocument(), browser = browserWindow(doc, "#view=explorer&mode=table");
  const client = createDashboardClient(async input => {
    const url = new URL(String(input), "https://dashboard.invalid"); const route = fixture.routes[url.pathname]!;
    return new Response(route.body as string);
  });
  const app = startDashboard({ document: doc.asDocument(), client });
  try {
    for (let i = 0; i < 30; i++) await settle();
    expect(button(doc.body, "Table").getAttribute("aria-pressed")).toBe("true");
    button(doc.body, "Chart").click(); expect(button(doc.body, "Chart").getAttribute("aria-pressed")).toBe("true"); expect(browser.location.hash).not.toContain("mode=");
    for (const label of ["Overview", "Session", "Run", "Context", "Cache", "Reconciliation", "Rates"]) {
      button(doc.body, label).click(); for (let i = 0; i < 30; i++) await settle();
      expect(elements(doc.body, "p").filter(n => n.className === "muted aic-key").map(n => n.textContent)).toEqual(["cal means calibrated; ? means calibration unavailable; est means published estimate with calibration off."]);
    }
  } finally { app.dispose(); }
});

it.each(["explorer", "cache", "reconciliation", "rates"] as const)("default %s uses compact token cells and readable calibration dates", async view => {
  // Breaks: one consumer collapses token categories into prose or shows raw ISO evidence.
  const { createDashboardBrowserPage } = await import("./fixtures/dashboard-browser-fixture.js");
  const { allViewPage } = await import("./fixtures/all-view-browser-fixture.js");
  const { createDashboardClient } = await import("../web/client.js");
  const fixture = allViewPage(await createDashboardBrowserPage(), "calibrated"), doc = new PlainDocument();
  const client = createDashboardClient(async input => new Response(fixture.routes[new URL(String(input), "https://dashboard.invalid").pathname]!.body as string));
  const app = startDashboard({ document: doc.asDocument(), initialRoute: { view }, client });
  try {
    for (let i = 0; i < 30; i++) await settle();
    const table = elements(doc.body, "table")[0]!;
    if (view === "reconciliation") { expect(elements(table, "dt")).toHaveLength(0); expect(table.textContent).toContain("prompt 500 · output 200 · total 700"); }
    else { expect(elements(table, "dt").map(n => n.textContent.trim())).toContain("prompt"); expect(elements(table, "dd").map(n => n.textContent.replace(/; $/, ""))).toContain("1,700"); }
    if (view !== "reconciliation") expect(elements(doc.body, "p").filter(n => n.className === "calibration-evidence").every(n => !n.textContent.includes("T00:00:00.000Z"))).toBe(true);
  } finally { app.dispose(); }
});

it("mount failures use shared error and recovery copy", async () => {
  const { DashboardClientError } = await import("../web/client.js");
  const doc = new PlainDocument();
  const app = startDashboard({ document: doc.asDocument(), initialRoute: { view: "cache" }, mounts: { cache: async () => { throw new DashboardClientError("ledger-unavailable"); } } });
  try { await settle(); expect(doc.body.textContent).toContain("Usage ledger unavailable. Retry after ingestion starts."); expect(button(doc.body, "Retry")).toBeDefined(); }
  finally { app.dispose(); }
});

it.each(["#view=unknown", "#%E0%A4%A", "#view=cache&start=bad&end=2", "#view=cache&start=2&end=1", "#view=cache&filters=%7B", "#view=cache&filters=%5Bnull%5D", "#view=cache&mode=invalid", "#view=cache&filters=" + encodeURIComponent(JSON.stringify([{ field: "path", value: "private" }]))])("malformed hash %s falls back safely", async hash => {
  const doc = new PlainDocument(); browserWindow(doc, hash); const mounted: string[] = [];
  const app = startDashboard({ document: doc.asDocument(), mounts: { overview: async () => { mounted.push("overview"); return { dispose() {} }; }, cache: async () => { mounted.push("cache"); return { dispose() {} }; } } });
  try { await settle(); expect(mounted).toEqual(["overview"]); } finally { app.dispose(); }
});

describe("Task 13 shared presentation", () => {
  it("period header displays readable UTC dates with exact machine timestamps", () => {
    // Break caught: raw ISO copy or losing machine-readable endpoints.
    const doc = new PlainDocument();
    const app = startDashboard({ document: doc.asDocument(), initialRoute: { view: "context", period } });
    try {
      const label = elements(doc.body, "p").find(node => node.className === "period-label")!;
      expect(label.textContent).toBe("1 Oct 2026, 00:00 UTC to 6 Oct 2026, 22:13 UTC");
      expect(elements(label, "time").map(node => node.getAttribute("datetime"))).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-06T22:13:00.000Z"]);
    } finally { app.dispose(); }
  });
  it("invalid timestamp-looking labels remain text without exceptions", () => {
    const text = "Synthetic-2026-99-99T99:99:99.000Z";
    const node = evidenceText(new PlainDocument().asDocument(), text);
    expect(node.textContent).toBe(text); expect(elements(node, "time")).toHaveLength(0);
  });
  it("chart free-text evidence preserves timestamp-looking text", () => {
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: "Daily", unit: "tokens", points: [{ ...period, label: "Day", value: 100, tokens, note: "Window 2026-10-01T00:00:00.000Z to 2026-10-06T22:13:00.000Z UTC" }] });
    const evidence = elements(chart, "td")[4]!;
    expect(evidence.textContent).toContain("Window 2026-10-01T00:00:00.000Z to 2026-10-06T22:13:00.000Z UTC");
    expect(elements(evidence, "time")).toHaveLength(0);
  });
  it("shared tables carry column labels without changing observations", () => {
    // Break caught: unlabeled values when the shared responsive table stacks.
    const table = renderTable(new PlainDocument().asDocument(), { caption: "Usage", columns: ["Observation", "Count"], rows: [["Day 2", "10"]] });
    expect(elements(table, "td").map(cell => cell.getAttribute("data-label"))).toEqual(["Observation", "Count"]);
    expect(elements(table, "td").map(cell => cell.children[1]!.textContent)).toEqual(["Day 2", "10"]);
    expect(elements(table, "td")[0]!.className).not.toContain("numeric");
  });
  it.each([1, 2, 3])("%s points use compact geometry only below three points", count => {
    // Break caught: treating sparse evidence as a full-height plot.
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: "Daily", unit: "tokens", points: Array.from({ length: count }, (_, i) => ({ start: i * 1000, end: (i + 1) * 1000, label: `Day ${i + 1}`, value: 100, tokens })) });
    expect(elements(chart, "svg")[0]!.getAttribute("height")).toBe(count < 3 ? "96" : "160");
    expect(elements(chart, "circle")).toHaveLength(count);
    if (count === 1) expect(elements(chart, "p")[0]!.textContent).toBe("1 Jan 1970, 00:00 UTC to 1 Jan 1970, 00:00:01 UTC · 100 tokens minimum · 100 tokens maximum");
  });
  it("chart tables keep token labels in a compact list and UTC periods in time elements", () => {
    // Break caught: collapsing the token categories into a dense prose cell.
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: "Daily", unit: "tokens", points: [{ ...period, label: "Day 2", value: 100, tokens }] });
    const cells = elements(chart, "td");
    expect(elements(cells[3]!, "dt").map(node => node.textContent.trim())).toEqual(["input", "cache read", "cache write", "output", "prompt", "total", "cache write 1h", "reasoning"]);
    expect(elements(cells[3]!, "dd").map(node => node.textContent.replace(/; $/, ""))).toEqual(["10", "20", "30", "40", "60", "100", "0", "unavailable"]);
    expect(cellText(cells[3]!)).toBe("input 10; cache read 20; cache write 30; output 40; prompt 60; total 100; cache write 1h 0; reasoning unavailable");
    expect(elements(cells[1]!, "time").map(node => node.getAttribute("datetime"))).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-06T22:13:00.000Z"]);
    expect(elements(cells[2]!, "span").filter(node => node.className === "numeric").map(node => node.textContent)).toEqual(["100"]);
    expect(elements(cells[0]!, "span").filter(node => node.className === "numeric")).toHaveLength(0);
  });
});

describe("in-place suspension", () => {
  async function fixture(hidden = false, rolling = false) {
    vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2030, 0, 31, 23, 59));
    const doc = new PlainDocument(); if (hidden) doc.visibilityState = "hidden";
    const reads: { id?: string; filters: unknown; start: number; end: number }[] = [];
    let mounts = 0, disposals = 0, suspensions = 0, paused = false, timer: ReturnType<typeof setInterval> | undefined;
    const app = startDashboard({ document: doc.asDocument(), initialRoute: { view: "context", id: "s1", filters: [{ field: "actor", value: "parent" }], ...(rolling ? {} : { period }) }, mounts: { context: async ctx => {
      ++mounts;
      const read = () => { ctx.requestStarted?.(); reads.push({ id: ctx.id, filters: ctx.filters, ...ctx.period }); };
      const arm = () => { clearInterval(timer); timer = setInterval(read, 60000); };
      const control = doc.createElement("button"); control.textContent = "Refresh"; control.addEventListener("click", read); (ctx.root as unknown as typeof doc.body).append(control);
      read(); arm();
      return { dispose() { ++disposals; clearInterval(timer); }, suspend(abort: boolean) { paused = true; clearInterval(timer); if (abort) ++suspensions; }, resume() { paused = false; arm(); }, refresh: read };
    } } });
    await settle();
    return { doc, app, reads, get mounts() { return mounts; }, get disposals() { return disposals; }, get suspensions() { return suspensions; }, get paused() { return paused; } };
  }
  it("a short hide pauses polling without abort, remount, refresh or focus loss", async () => {
    const f = await fixture(); try {
      const control = button(f.doc.body, "Refresh"); control.focus();
      f.doc.visibilityState = "hidden"; f.doc.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(120000); expect(f.reads).toHaveLength(1); expect(f.suspensions).toBe(0);
      f.doc.visibilityState = "visible"; f.doc.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(300); expect(f.reads).toHaveLength(1);
      expect(f.mounts).toBe(1); expect(f.disposals).toBe(0); expect(f.doc.activeElement).toBe(control);
      await vi.advanceTimersByTimeAsync(60000); expect(f.reads).toHaveLength(2);
    } finally { f.app.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); }
  });
  it.each(["hidden", "idle"])("%s resumes once after 300ms, retaining route, filters, rolling month and focus, and suspends a second time", async mode => {
    const f = await fixture(false, true); try {
      const control = button(f.doc.body, "Refresh"); control.focus();
      if (mode === "hidden") { f.doc.visibilityState = "hidden"; f.doc.dispatchEvent(new Event("visibilitychange")); }
      await vi.advanceTimersByTimeAsync(300000); expect(f.suspensions).toBe(1);
      const count = f.reads.length; await vi.advanceTimersByTimeAsync(600000); expect(f.reads).toHaveLength(count);
      f.doc.visibilityState = "visible";
      for (let i = 0; i < 20; i++) { f.doc.dispatchEvent(new Event("visibilitychange")); f.doc.dispatchEvent(new Event("keydown")); }
      expect(f.paused).toBe(false); await vi.advanceTimersByTimeAsync(299); expect(f.reads).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1); expect(f.reads).toHaveLength(count + 1);
      expect(f.reads.at(-1)).toEqual({ id: "s1", filters: [{ field: "actor", value: "parent" }], start: Date.UTC(2030, 1, 1), end: Date.now() });
      expect(f.mounts).toBe(1); expect(f.disposals).toBe(0); expect(f.doc.activeElement).toBe(control);
      await vi.advanceTimersByTimeAsync(300000); expect(f.suspensions).toBe(2);
    } finally { f.app.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); }
    expect([...f.doc.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
  });
  it("a wake refresh interrupted by a short hide remains pending until the next show", async () => {
    // Break caught: skipping or running the debounced refresh while hidden, then losing it.
    const f = await fixture(); try {
      await vi.advanceTimersByTimeAsync(300000); const count = f.reads.length;
      f.doc.dispatchEvent(new Event("keydown")); await vi.advanceTimersByTimeAsync(100);
      f.doc.visibilityState = "hidden"; f.doc.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(1000); expect(f.reads).toHaveLength(count);
      f.doc.visibilityState = "visible"; f.doc.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(299); expect(f.reads).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1); expect(f.reads).toHaveLength(count + 1);
      await vi.advanceTimersByTimeAsync(1000); expect(f.reads).toHaveLength(count + 1); expect(f.mounts).toBe(1);
    } finally { f.app.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); }
  });
  it("a queued wake refresh checks visibility before the hide event is delivered", async () => {
    // Break caught: the timer refreshes a hidden document before visibilitychange runs.
    const f = await fixture(); try {
      await vi.advanceTimersByTimeAsync(300000); const count = f.reads.length;
      f.doc.dispatchEvent(new Event("keydown")); f.doc.visibilityState = "hidden";
      await vi.advanceTimersByTimeAsync(300); expect(f.reads).toHaveLength(count);
      f.doc.dispatchEvent(new Event("visibilitychange")); f.doc.visibilityState = "visible"; f.doc.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(300); expect(f.reads).toHaveLength(count + 1);
    } finally { f.app.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); }
  });
  it("twenty minutes of pointer activity never suspends active users", async () => {
    const f = await fixture(); try {
      for (let i = 0; i < 20; i++) { await vi.advanceTimersByTimeAsync(60000); f.doc.dispatchEvent(new Event("pointermove")); }
      expect(f.suspensions).toBe(0); expect(f.paused).toBe(false); expect(f.mounts).toBe(1); expect(f.disposals).toBe(0);
    } finally { f.app.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); }
  });
  it("starts hidden without mounting or requesting, then mounts once on show", async () => {
    const f = await fixture(true); try {
      await vi.advanceTimersByTimeAsync(600000); expect(f.mounts).toBe(0); expect(f.reads).toHaveLength(0);
      f.doc.visibilityState = "visible"; f.doc.dispatchEvent(new Event("visibilitychange")); await settle();
      expect(f.mounts).toBe(1); expect(f.reads).toHaveLength(1);
    } finally { f.app.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); }
  });
  it.each(["click", "input", "change", "touchstart", "keydown", "wheel"])("%s resumes immediately, and the interaction's Refresh still runs with no duplicate refresh", async event => {
    const f = await fixture(); try {
      await vi.advanceTimersByTimeAsync(300000); const count = f.reads.length;
      f.doc.dispatchEvent(new Event(event)); expect(f.paused).toBe(false);
      button(f.doc.body, "Refresh").click(); expect(f.reads).toHaveLength(count + 1);
      await vi.advanceTimersByTimeAsync(300); expect(f.reads).toHaveLength(count + 1);
    } finally { f.app.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); }
  });
  it("activity is passive, timestamp-throttled and does not allocate timers on pointermove", async () => {
    const f = await fixture(); const spy = vi.spyOn(globalThis, "setTimeout"); try {
      for (let i = 0; i < 100; i++) f.doc.dispatchEvent(new Event("pointermove"));
      expect(spy).not.toHaveBeenCalled();
      expect(f.doc.listenerOptions.get("pointermove")).toMatchObject({ passive: true, capture: true });
    } finally { spy.mockRestore(); f.app.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); }
  });
});

describe("semantic presentation regressions", () => {
  it("tables expose explicit column associations and silent real stacked labels", () => {
    const table = renderTable(new PlainDocument().asDocument(), { caption: "Usage", columns: ["Name", "Count"], rows: [["Alpha", "42"]] });
    expect(table.getAttribute("role")).toBe("table");
    expect(elements(table, "thead")[0]!.getAttribute("role")).toBe("rowgroup");
    expect(elements(table, "tbody")[0]!.getAttribute("role")).toBe("rowgroup");
    for (const row of elements(table, "tr")) expect(row.getAttribute("role")).toBe("row");
    elements(table, "th").forEach((head, i) => {
      expect(head.getAttribute("role")).toBe("columnheader"); expect(head.id).not.toBe("");
      const cell = elements(table, "td")[i]!;
      expect(cell.getAttribute("role")).toBe("cell"); expect(cell.getAttribute("headers")).toBe(head.id);
      const label = cell.children[0]!; expect(label.className).toBe("cell-label"); expect(label.getAttribute("aria-hidden")).toBe("true"); expect(label.textContent).toBe(head.textContent);
    });
  });
  it("ten columns opt into wide-table scrolling", () => {
    const doc = new PlainDocument().asDocument();
    expect(renderTable(doc, { caption: "Tiers", columns: Array(10).fill("Rate"), rows: [] }).className).toContain("wide-table");
    expect(renderTable(doc, { caption: "Usage", columns: Array(6).fill("Value"), rows: [] }).className).not.toContain("wide-table");
  });
  it("token separators are explicitly excluded from assistive text", () => {
    const list = tokenList(new PlainDocument().asDocument(), tokens);
    const separators = elements(list, "span").filter(node => node.className === "token-separator");
    expect(separators).toHaveLength(7); for (const separator of separators) expect(separator.getAttribute("aria-hidden")).toBe("true");
  });
  it("a sub-second period displays distinct millisecond endpoints", () => {
    const span = periodTimes(new PlainDocument().asDocument(), period.end + 100, period.end + 200);
    expect(elements(span, "time").map(node => node.textContent)).toEqual(["6 Oct 2026, 22:13:00.100 UTC", "6 Oct 2026, 22:13:00.200 UTC"]);
    expect(elements(span, "time").map(node => node.getAttribute("datetime"))).toEqual(["2026-10-06T22:13:00.100Z", "2026-10-06T22:13:00.200Z"]);
  });
  it("in-place evidence updates retain chart controls, selected representation, focus and scroll regions while values change", () => {
    const doc = new PlainDocument(), root = doc.createElement("div"); doc.body.append(root);
    const chart = (value: number) => chartWithTable(doc.asDocument(), { title: "Daily", unit: "tokens", points: [{ ...period, label: "Day", value, tokens }] });
    const initial = chart(10); (root as unknown as HTMLElement).append(initial); const toggle = button(root, "Table"); toggle.click(); toggle.focus();
    const region = elements(root, "table")[0]!.parentElement!;
    dom.updateEvidence(root as unknown as HTMLElement, chart(20));
    expect(button(root, "Table")).toBe(toggle); expect(doc.activeElement).toBe(toggle); expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(elements(root, "table")[0]!.parentElement).toBe(region); expect(region.hidden).toBe(false);
    expect(root.textContent).toContain("20 tokens");
    button(root, "Chart").click(); expect(region.hidden).toBe(true); toggle.click(); expect(region.hidden).toBe(false);
  });
});

it("timestamp formatting reuses cached Intl formatters for large pages", () => {
  const constructor = vi.spyOn(Intl, "DateTimeFormat");
  try {
    for (let i = 0; i < 200; i++) { formatUtcTimestamp(period.end); formatUtcTimestamp(period.end + 1000); formatUtcTimestamp(period.end + 100, false, true); }
    expect(constructor).not.toHaveBeenCalled();
  } finally { constructor.mockRestore(); }
});
