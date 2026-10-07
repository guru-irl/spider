import { describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { PlainDocument, button, elements, descendants, cellText } from "./fixtures/plain-dom.js";

const tokens = { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, prompt: 60, total: 100, reasoning: null, cacheWrite1h: null };

describe("web primitives", () => {
  it("unknown filter copy offers only the action supplied by the view", async () => {
    const { errorCopy, DashboardClientError } = await import("../web/client.js");
    const error = new DashboardClientError("unknown-filter-id");
    expect(errorCopy(error)).toBe("Selected filter is no longer available. Remove the unknown filter from the address to continue.");
    expect(errorCopy(error, { clearFilters() {} })).toBe("Selected filter is no longer available. Clear filters to continue.");
  });
  it.each([
    [[12, -3, 0], ["+12 AIC", "-3 AIC", "0 AIC"], [21.875, 109.375, 91.875], 105],
    [[12, 3], ["+12 AIC", "+3 AIC"], [11.875, 47.5], 125],
    [[-12, -3], ["-12 AIC", "-3 AIC"], [59.375, 23.75], 25],
    [[0, 0], ["0 AIC", "0 AIC"], [59.375, 59.375], 125],
    [[12.4, -3.1, 0.1, -0.1], ["+12 AIC", "-3 AIC", "0 AIC", "0 AIC"], null, null],
  ] as const)("signed gap observations %j share whole AIC and a zero line", async (values, cells, positions, zero) => {
    const { chartWithTable } = await import("../web/charts.js");
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: "Account gap", unit: "gap-aic", points: values.map((value, i) => ({ start: i * 1000, end: (i + 1) * 1000, label: String(i), value, tokens: null })) });
    expect(elements(chart, "tr").slice(1).map(row => cellText(row.children[2]!))).toEqual(cells);
    const summary = elements(chart, "p")[0]!;
    expect(summary.textContent).toContain("Gap: counter minus published");
    expect(elements(chart, "svg")[0]!.getAttribute("aria-label")).toContain(summary.textContent);
    expect(elements(chart, "caption")[0]!.textContent).toContain("Gap: counter minus published");
    expect(elements(chart, "th")[2]!.textContent).toBe("Gap: counter minus published");
    const line = elements(chart, "line")[0]!;
    expect(line).toBeDefined(); expect(line.getAttribute("class")).toBe("chart-zero-line");
    // Breaks: default meet squeezes the baseline while CSS-pixel dots span the chart.
    expect(elements(chart, "svg")[1]!.getAttribute("preserveAspectRatio")).toBe("none");
    // Breaks: the compact plot scales the zero-line stroke below one CSS pixel.
    expect(line.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    expect(line.getAttribute("x1")).toBe("24"); expect(line.getAttribute("x2")).toBe("574");
    if (zero !== null) {
      expect(Number(line.getAttribute("y1"))).toBe(zero); expect(line.getAttribute("y2")).toBe(line.getAttribute("y1"));
      expect(elements(chart, "circle").map(dot => Number(dot.getAttribute("cy")))).toEqual(positions);
    }
  });
  it.each([
    [undefined, "Gap: counter minus published"],
    ["published", "Gap: counter minus published"],
    ["calibrated", "Gap: counter minus calibrated"],
    ["back-applied", "Gap: counter minus back-applied"],
  ] as const)("gap basis %s names every representation", async (gapBasis, wording) => {
    const { chartWithTable } = await import("../web/charts.js");
    for (const points of [[], [{ start: 0, end: 1000, label: "One", value: 12, tokens: null }]]) {
      const options = { title: "Account gap", unit: "gap-aic" as const, points, ...(gapBasis === undefined ? {} : { gapBasis }) };
      const chart = chartWithTable(new PlainDocument().asDocument(), options);
      const summary = elements(chart, "p")[0]!;
      expect.soft(summary.textContent).toContain(wording);
      expect.soft(elements(chart, "svg")[0]!.getAttribute("aria-label")).toBe(`Account gap · ${summary.textContent}`);
      expect.soft(elements(chart, "caption")[0]!.textContent).toBe(`Account gap · ${wording}`);
      expect.soft(elements(chart, "th")[2]!.textContent).toBe(wording);
    }
  });
  it.each([[0, "0 tokens"], [1, "1 token"], [2, "2 tokens"]] as const)("token count %s pluralizes in table, tooltip and summary", async (value, wording) => {
    const { chartWithTable } = await import("../web/charts.js");
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: "Tokens", unit: "tokens", points: [{ start: 0, end: 1000, label: "One", value, tokens: null }] });
    expect.soft(cellText(elements(chart, "td")[2]!)).toBe(wording);
    expect.soft(elements(chart, "title")[1]!.textContent).toContain(` · ${wording} · `);
    expect.soft(elements(chart, "p")[0]!.textContent).toContain(`${wording} minimum · ${wording} maximum`);
  });
  it("gap lower bounds and missing values remain explicit", async () => {
    const { chartWithTable } = await import("../web/charts.js");
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: "Gap", unit: "gap-aic", points: [
      { start: 0, end: 1000, label: "One", value: 12, tokens: null, lowerBound: true },
      { start: 1000, end: 2000, label: "Two", value: -3, tokens: null, lowerBound: true },
      { start: 2000, end: 3000, label: "Missing", value: null, tokens: null },
      { start: 3000, end: 4000, label: "Invalid", value: Infinity, tokens: null },
    ] });
    expect(elements(chart, "tr").slice(1).map(row => cellText(row.children[2]!))).toEqual(["+12+ AIC", "-3+ AIC", "unavailable", "unavailable"]);
    expect(elements(chart, "p")[0]!.textContent).toBe("Gap: counter minus published · 1 Jan 1970, 00:00 UTC to 1 Jan 1970, 00:00:04 UTC · -3+ AIC minimum · +12+ AIC maximum");
    expect(elements(chart, "circle")).toHaveLength(2);
    const empty = chartWithTable(new PlainDocument().asDocument(), { title: "Gap", unit: "gap-aic", points: [] });
    expect(elements(empty, "p")[0]!.textContent).toBe("Gap: counter minus published · No recorded values in this period");
  });
  it.each(["both", "sans-serif-only", "missing"])("canvas measurer sets each candidate font (%s)", async available => {
    const { loadFonts } = await import("../web/fonts.js"), doc = new PlainDocument();
    doc.fonts = { async load() { return [{}]; } };
    const create = doc.createElement.bind(doc);
    const context = { font: "10px sans-serif", measureText(_text: string) {
      return { width: this.font.includes("Usage") && available !== "missing" && (available === "both" || this.font.endsWith("sans-serif")) ? 120 : 100 };
    } };
    const document = doc.asDocument();
    document.createElement = ((tag: string) => tag === "canvas" ? { getContext: () => context } : create(tag)) as typeof document.createElement;
    await loadFonts(document);
    expect(elements(doc.head, "link")).toHaveLength(available === "missing" ? 1 : 0);
  });

  it("client rejects decoding after cancellation and bounds deadlines", async () => {
    const { createDashboardClient, errorCopy } = await import("../web/client.js");
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    const client = createDashboardClient(async () => new Response(body));
    const abort = new AbortController(); const pending = client.get("/api/overview", new URLSearchParams(), abort.signal);
    await Promise.resolve(); await Promise.resolve(); abort.abort();
    stream.enqueue(new TextEncoder().encode(JSON.stringify({ apiVersion: 1, revision: "fixture", period: { start: 0, end: 1000 }, generatedAt: 1000, data: {} }))); stream.close();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    vi.useFakeTimers();
    try {
      const slow = createDashboardClient(async (_input, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
      const expired = slow.get("/api/overview", new URLSearchParams(), new AbortController().signal);
      const assertion = expect(expired).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(10000); await assertion;
      expect(vi.getTimerCount()).toBe(0);
      expect(errorCopy(new Error("sensitive arbitrary message"))).toBe("Could not load usage. Retry.");
    } finally { vi.useRealTimers(); }
  });
  it("settled client requests remove their caller abort listener", async () => {
    const { createDashboardClient } = await import("../web/client.js");
    for (const succeed of [true, false]) {
      const signal = new AbortController().signal;
      const client = createDashboardClient(async () => {
        if (!succeed) throw new TypeError("offline");
        return new Response(JSON.stringify({ apiVersion: 1, revision: "fixture", period: { start: 0, end: 1000 }, generatedAt: 1000, data: {} }));
      });
      const pending = client.get("/api/overview", new URLSearchParams(), signal);
      expect(getEventListeners(signal, "abort")).toHaveLength(1);
      if (succeed) await pending; else await expect(pending).rejects.toMatchObject({ code: "server-unavailable" });
      expect(getEventListeners(signal, "abort")).toHaveLength(0);
    }
  });
  it.each([
    ["unknown-filter-id", 400, "Selected filter is no longer available. Remove the unknown filter from the address to continue."],
    ["identity-unavailable", 503, "Usage identity unavailable. Remove the ledger's explorer-salt file if it is unusable and wait five seconds, then refresh. Opaque filter bookmarks must be rebuilt."],
    ["invalid-query", 400, "Invalid usage query or cursor. Refresh to start a new page."],
    ["ledger-changed", 409, "Usage changed. Refresh to start a new page."],
  ] as const)("fixed API code %s reaches the view with a non-Retry notice", async (code, status, notice) => {
    const { createDashboardClient, errorCopy } = await import("../web/client.js");
    const client = createDashboardClient(async () => new Response(JSON.stringify({ error: { code, message: "ignored raw message" } }), { status }));
    const error = await client.get("/api/explorer", new URLSearchParams(), new AbortController().signal).catch(error => error);
    expect.soft(error.code).toBe(code); expect.soft(errorCopy(error)).toBe(notice);
  });
  it("unknown server error codes are normalized before reaching callers", async () => {
    const { createDashboardClient } = await import("../web/client.js");
    const client = createDashboardClient(async () => new Response(JSON.stringify({ error: { code: '<img onerror="alert(1)">', message: "private" } }), { status: 500 }));
    await expect(client.get("/api/overview", new URLSearchParams(), new AbortController().signal)).rejects.toMatchObject({ code: "internal" });
  });
  it("null charts never invent a zero maximum", async () => {
    const { chartWithTable } = await import("../web/charts.js");
    const doc = new PlainDocument();
    const chart = chartWithTable(doc.asDocument(), { title: "Gap", unit: "estimated-aic", points: [{ start: 0, end: 1000, label: "Unknown", value: null, tokens: null }] });
    expect(elements(chart, "circle")).toHaveLength(0);
    expect(elements(chart, "p")[0]!.textContent).toBe("No recorded values in this period");
    const negative = chartWithTable(doc.asDocument(), { title: "Gap", unit: "estimated-aic", points: [{ start: 0, end: 1000, label: "One", value: -3, tokens: null }] });
    expect(elements(negative, "p")[0]!.textContent).toContain("~-3 AIC ? maximum");
  });
  it("AIC formatting preserves basis evidence and lower bounds", async () => {
    // Break caught: treating unavailable as zero, omitting lower bounds or applying an implausible factor.
    const module = await import("../web/format.js");
    expect(module).toHaveProperty("formatAicDisplay");
    const fit = { status: "calibrated" as const, factor: 0.56, windowStart: 0, windowEnd: 604800000, coveredHours: 24, computedAic: 1000, counterDelta: 560, unpricedCalls: 2, method: "trailing-7d-ratio" as const };
    const cal = module.formatAicDisplay({ primaryAic: 560, publishedAic: 1000, basis: "calibrated" }, 2, fit);
    expect(cal.primary).toBe("560+ AIC cal"); expect(cal.secondary).toBe("~1,000+ AIC published estimate");
    expect(cal.legend).toContain("calibrated x0.56 over 7 days");
    expect(cal.legend).toContain("1 Jan 1970, 00:00 UTC to 8 Jan 1970, 00:00 UTC");
    expect(cal.legend).toContain("24 h covered"); expect(cal.legend).toContain("2 unpriced calls");
    const back = module.formatAicDisplay({ primaryAic: 560, publishedAic: 1000, basis: "back-applied" }, 0, fit);
    expect(back.primary).toBe("560 AIC cal (back-applied)");
    expect(back.legend).toContain("calibrated, back-applied x0.56");
    for (const [status, marker] of [["uncalibrated", "?"], ["implausible", "?"], ["off", "est"]] as const) {
      const result = module.formatAicDisplay({ primaryAic: 1000, publishedAic: 1000, basis: "published" }, 0, { ...fit, status, factor: status === "implausible" ? 2 : null });
      expect(result.primary).toBe(`~1,000 AIC ${marker}`); expect(result.legend).toContain(status);
    }
    expect(module.formatEstimatedAic(null, 3)).toBe("unpriced AIC");
    expect(module.formatEstimatedAic(null, 0)).toBe("AIC unavailable");
    expect(module.formatEstimatedAic(0, 0)).toBe("~0 AIC published estimate");
  });
  it.each([
    [0, "0 days", 0, "0 unpriced calls"],
    [1, "1 day", 1, "1 unpriced call"],
    [2, "2 days", 2, "2 unpriced calls"],
    [1.5, "1.5 days", 1, "1 unpriced call"],
    [1.004, "1 day", 1, "1 unpriced call"],
  ] as const)("calibration duration %s and count %s use readable legend copy", async (days, duration, calls, count) => {
    const { formatAicDisplay } = await import("../web/format.js");
    const fit = { status: "calibrated" as const, factor: 0.56, windowStart: 0, windowEnd: days * 86400000, coveredHours: 24, computedAic: 1000, counterDelta: 560, unpricedCalls: calls, method: "trailing-7d-ratio" as const };
    for (const basis of ["published", "calibrated", "back-applied"] as const) {
      const legend = formatAicDisplay({ primaryAic: 560, publishedAic: 1000, basis }, calls, fit).legend;
      if (basis !== "published") expect.soft(legend).toContain(`over ${duration}`);
      expect.soft(legend).toContain(count);
      expect.soft(legend).toContain("trailing 7-day ratio");
      expect.soft(legend).not.toContain("trailing-7d-ratio");
    }
  });
  it("published rows retain their own legend under a calibrated response", async () => {
    const { formatAicDisplay } = await import("../web/format.js");
    const fit = { status: "calibrated" as const, factor: 0.56, windowStart: 0, windowEnd: 604800000, coveredHours: 24, computedAic: 1000, counterDelta: 560, unpricedCalls: 0, method: "trailing-7d-ratio" as const };
    expect(formatAicDisplay({ primaryAic: 1000, publishedAic: 1000, basis: "published" }, 0, fit).legend).toContain("Published estimate; row is not calibrated");
  });
  it("implausible calibration reports its clamped unapplied diagnostic", async () => {
    const { formatAicDisplay } = await import("../web/format.js");
    const fit = { status: "implausible" as const, factor: 2, windowStart: 0, windowEnd: 604800000, coveredHours: 24, computedAic: 1000, counterDelta: 3000, unpricedCalls: 0, method: "trailing-7d-ratio" as const };
    expect(formatAicDisplay({ primaryAic: 1000, publishedAic: 1000, basis: "published" }, 0, fit).legend).toContain("Diagnostic x2.00 (clamped, not applied)");
  });
  it("fonts load locally before conditional link", async () => {
    // Break caught: unconditional network links, blocking rendering, or non-stylesheet font fallback.
    const module = await import("../web/fonts.js").catch(() => null);
    expect(module, "font loader is available").not.toBeNull();
    const local = new PlainDocument(); const attempted: string[] = [];
    local.fonts = { async load(font) { attempted.push(font); return [{}]; } };
    await module!.loadFonts(local.asDocument(), undefined, font => font.includes("Usage") ? 120 : 100);
    expect(attempted).toEqual(['16px "Usage Text Local"', '16px "Usage Code Local"']);
    expect(elements(local.head, "link")).toHaveLength(0);
    const missing = new PlainDocument();
    const finish: ((faces: unknown[]) => void)[] = [];
    missing.fonts = { load() { return new Promise(resolve => { finish.push(resolve); }); } };
    const pending = module!.loadFonts(missing.asDocument());
    expect(elements(missing.head, "link")).toHaveLength(0);
    // Use a separate failing loader to cover empty and rejected local faces.
    const offline = new PlainDocument(); offline.fonts = { async load(font) { if (font.includes("Text")) return []; throw new Error("offline"); } };
    await module!.loadFonts(offline.asDocument());
    const links = elements(offline.head, "link"); expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("rel")).toBe("stylesheet");
    expect(links[0]!.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(links[0]!.getAttribute("href")).toBe("https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@400;500;600;700&family=Cascadia+Code:wght@400;700&display=swap");
    expect(elements(offline.head, "script")).toHaveLength(0);
    // Aborting prevents a late conditional link; offline rendering remains ordinary text.
    finish.forEach(resolve => resolve([])); await pending;
    const cancelled = new PlainDocument(); const abort = new AbortController(); abort.abort();
    await module!.loadFonts(cancelled.asDocument(), abort.signal);
    expect(elements(cancelled.head, "link")).toHaveLength(0);
  });
  it("font fallback measures width rather than trusting fonts.check", async () => {
    const { loadFonts } = await import("../web/fonts.js");
    for (const available of [true, false]) {
      const doc = new PlainDocument();
      doc.fonts = { async load() { return [{}]; }, check() { throw new Error("check cannot detect a local font"); } };
      const measure = (font: string) => available && font.includes("Usage") ? 120 : 100;
      await loadFonts(doc.asDocument(), undefined, measure);
      expect(elements(doc.head, "link")).toHaveLength(available ? 0 : 1);
    }
  });
  it("font fallback is bounded at exactly 1.5 seconds", async () => {
    vi.useFakeTimers();
    try {
      const { loadFonts } = await import("../web/fonts.js"), doc = new PlainDocument();
      doc.fonts = { load() { return new Promise(() => {}); } };
      const pending = loadFonts(doc.asDocument());
      await vi.advanceTimersByTimeAsync(1499); expect(elements(doc.head, "link")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1); await pending;
      expect(elements(doc.head, "link")).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("one local font does not suppress the missing font fallback", async () => {
    const { loadFonts } = await import("../web/fonts.js");
    const doc = new PlainDocument();
    doc.fonts = { async load(font) { return font.includes("Text") ? [{}] : []; }, check() { return true; } };
    await loadFonts(doc.asDocument(), undefined, font => font.includes("Usage") ? 120 : 100); expect(elements(doc.head, "link")).toHaveLength(1);
  });
  it("a late font abort never appends a link", async () => {
    const { loadFonts } = await import("../web/fonts.js");
    const doc = new PlainDocument(), abort = new AbortController(), finishes: ((faces: unknown[]) => void)[] = [];
    doc.fonts = { load() { return new Promise(resolve => finishes.push(resolve)); }, check() { return false; } };
    const pending = loadFonts(doc.asDocument(), abort.signal);
    abort.abort(); finishes.forEach(resolve => resolve([])); await pending;
    expect(elements(doc.head, "link")).toHaveLength(0);
  });
  it("SVG summaries name the range and extremes and table regions have specific names", async () => {
    const { chartWithTable } = await import("../web/charts.js");
    const doc = new PlainDocument();
    const chart = chartWithTable(doc.asDocument(), { title: "Daily AIC", unit: "calibrated-aic", points: [
      { start: 0, end: 1000, label: "One", value: 4, tokens: null, lowerBound: true },
      { start: 1000, end: 2000, label: "Two", value: 2, tokens: null },
    ] });
    expect(elements(chart, "svg")[0]!.getAttribute("aria-label")).toBe("Daily AIC · 1 Jan 1970, 00:00 UTC to 1 Jan 1970, 00:00:02 UTC · 2 AIC cal minimum · 4+ AIC cal maximum");
    expect(cellText(elements(chart, "td")[2]!)).toBe("4+ AIC cal");
    expect(elements(chart, "p")[0]!.textContent).toContain("4+ AIC cal maximum");
    const table = elements(chart, "table")[0]!, region = table.parentElement!, caption = elements(table, "caption")[0]!;
    expect(region.getAttribute("aria-labelledby")).toBe(caption.id); expect(caption.id).not.toBe("");
    const toggle = button(chart, "Table");
    expect(toggle.getAttribute("aria-controls")).toBe(region.id); expect(region.id).not.toBe("");
    toggle.click(); expect(toggle.textContent).toBe("Table"); expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const empty = chartWithTable(doc.asDocument(), { title: "Empty", unit: "tokens", points: [] });
    expect(elements(empty, "svg")[0]!.getAttribute("aria-label")).toBe("Empty · No recorded values in this period");
  });
  it("chart values and maximum retain lower-bound markers", async () => {
    const { chartWithTable } = await import("../web/charts.js");
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: "AIC", unit: "estimated-aic", points: [{ start: 0, end: 1000, label: "One", value: 4, tokens: null, lowerBound: true }] });
    expect(cellText(elements(chart, "td")[2]!)).toBe("~4+ AIC ?");
    expect(elements(chart, "p")[0]!.textContent).toContain("~4+ AIC ? maximum");
  });
  it("Chart and Table pills select one representation without dropping focus", async () => {
    const { chartWithTable } = await import("../web/charts.js");
    const doc = new PlainDocument(), chart = chartWithTable(doc.asDocument(), { title: "Daily", unit: "tokens", points: [] });
    const graphic = elements(chart, "svg")[0]!.parentElement!, region = elements(chart, "table")[0]!.parentElement!;
    const chartButton = button(chart, "Chart"), tableButton = button(chart, "Table");
    expect(chartButton.parentElement).toBe(tableButton.parentElement);
    expect(chartButton.parentElement!.getAttribute("role")).toBe("group");
    expect(chartButton.parentElement!.getAttribute("aria-label")).toBe("Chart representation");
    expect(chartButton.getAttribute("aria-pressed")).toBe("true"); expect(tableButton.getAttribute("aria-pressed")).toBe("false");
    tableButton.focus(); tableButton.click(); tableButton.click();
    expect(region.hidden).toBe(false); expect(graphic.hidden).toBe(true); expect(doc.activeElement).toBe(tableButton);
    expect(tableButton.getAttribute("aria-pressed")).toBe("true"); expect(chartButton.getAttribute("aria-pressed")).toBe("false");
    chartButton.focus(); chartButton.click();
    expect(graphic.hidden).toBe(false); expect(region.hidden).toBe(true); expect(doc.activeElement).toBe(chartButton);
    expect(chartButton.getAttribute("aria-controls")).toBe(graphic.id); expect(graphic.id).not.toBe("");
  });
  it("back-applied value cells preserve their calibration basis", async () => {
    const { chartWithTable } = await import("../web/charts.js");
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: "Back applied", unit: "back-applied-aic", points: [{ start: 0, end: 1000, label: "One", value: 560, tokens, lowerBound: true }] });
    expect(cellText(elements(chart, "td")[2]!)).toBe("560+ AIC cal (back-applied)");
    expect(elements(chart, "p")[0]!.textContent).toContain("560+ AIC cal (back-applied) maximum");
  });
  it("empty tables explain that no rows are recorded", async () => {
    const { renderTable } = await import("../web/tables.js");
    const table = renderTable(new PlainDocument().asDocument(), { caption: "Roles", columns: ["Role", "Value"], rows: [] });
    expect(cellText(elements(table, "td")[0]!)).toBe("No rows recorded");
    expect(elements(table, "td")[0]!.getAttribute("colspan")).toBe("2");
  });
  it("table regions are named after their captions", async () => {
    const { renderTable, tableRegion } = await import("../web/tables.js");
    const doc = new PlainDocument();
    const regions = ["Actors", "Source diagnostics"].map(caption => tableRegion(doc.asDocument(), renderTable(doc.asDocument(), { caption, columns: ["Observation"], rows: [["sample"]] })));
    for (const region of regions) {
      const caption = elements(region, "caption")[0]!;
      expect(caption.id).not.toBe(""); expect(region.getAttribute("aria-labelledby")).toBe(caption.id);
    }
    expect(elements(regions[0]!, "caption")[0]!.id).not.toBe(elements(regions[1]!, "caption")[0]!.id);
  });
  it.each(["listed", "recorded"] as const)("%s token subsets have identical chart and table observations", async subsets => {
    const { tokenObservation } = await import("../web/format.js"), { chartWithTable } = await import("../web/charts.js");
    const expected = "input 10; cache read 20; cache write 30; output 40; prompt 60; total 100" + (subsets === "listed" ? "; cache write 1h unavailable; reasoning unavailable" : "");
    expect.soft(tokenObservation(tokens, subsets)).toBe(expected);
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: "Tokens", unit: "tokens", subsets, points: [{ start: 0, end: 1000, label: "One", value: 100, tokens }, { start: 1000, end: 2000, label: "Two", value: 100, tokens: { ...tokens, cacheWrite1h: 0, reasoning: 2 } }] });
    expect.soft(cellText(elements(chart, "td")[3]!)).toBe(expected);
    expect.soft(elements(chart, "title")[1]!.textContent).toBe(`One · 1 Jan 1970, 00:00 UTC to 1 Jan 1970, 00:00:01 UTC · 100 tokens · ${expected} · `);
    expect(cellText(elements(chart, "td")[8]!)).toBe("input 10; cache read 20; cache write 30; output 40; prompt 60; total 100; cache write 1h 0; reasoning 2");
    expect(tokenObservation(null, subsets)).toBe("tokens unavailable");
  });
  it("chart text lives outside the scaled plot at a readable CSS pixel size", async () => {
    const { chartWithTable } = await import("../web/charts.js");
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: "Narrow", unit: "tokens", points: [{ start: 0, end: 1000, label: "One", value: 100, tokens }] });
    const svg = elements(chart, "svg")[0]!, label = elements(chart, "p")[0]!;
    expect(svg.getAttribute("viewBox")).toBeNull(); expect(label.parentElement).toBe(svg.parentElement); expect(label.namespaceURI).toBeNull();
    expect(label.className.split(" ")).toContain("chart-summary");
    expect(elements(svg, "text")).toHaveLength(0); expect(svg.getAttribute("aria-describedby")).toBe(label.id); expect(label.id).not.toBe("");
    expect(svg.getAttribute("width")).toBe("100%"); expect(svg.getAttribute("height")).toBe("96");
    const plot = elements(chart, "svg")[1]!;
    expect(plot.getAttribute("viewBox")).toBe("0 0 600 160"); expect(elements(plot, "circle")).toHaveLength(0); expect(elements(svg, "circle")).toHaveLength(1); expect(elements(plot, "text")).toHaveLength(0);
  });
  it("hostile labels remain text", async () => {
    // Break caught: interpreting labels as markup or allowing an API request to leave the loopback origin.
    const module = await import("../web/client.js").catch(() => null);
    expect(module, "same-origin client is available").not.toBeNull();
    const calls: string[] = [];
    const hostile = '<img src=x onerror=alert(1)><style>body{display:none}</style>';
    const client = module!.createDashboardClient(async (input, init) => {
      calls.push(String(input));
      expect(init?.credentials).toBe("same-origin"); expect(init?.mode).toBe("same-origin"); expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({ apiVersion: 1, revision: "fixture:0", period: { start: 0, end: 1000 }, generatedAt: 1000, data: hostile }));
    });
    const signal = new AbortController().signal;
    for (const path of ["https://foreign.invalid/api/overview", "//foreign.invalid/api/overview", "/api/../bootstrap", "/api/overview?x=1", "/bootstrap"]) {
      await expect(client.get(path, new URLSearchParams(), signal)).rejects.toMatchObject({ code: "invalid-query" });
    }
    expect(calls).toEqual([]);
    const response = await client.get<string>("/api/overview", new URLSearchParams({ filters: JSON.stringify([{ field: "role", value: hostile }]) }), signal);
    expect(calls[0]).toBe('/api/overview?filters=%5B%7B%22field%22%3A%22role%22%2C%22value%22%3A%22%3Cimg+src%3Dx+onerror%3Dalert%281%29%3E%3Cstyle%3Ebody%7Bdisplay%3Anone%7D%3C%2Fstyle%3E%22%7D%5D');
    const { chartWithTable } = await import("../web/charts.js");
    const chart = chartWithTable(new PlainDocument().asDocument(), { title: response.data, unit: "tokens", points: [{ start: 0, end: 1000, label: hostile, value: 100, tokens }] });
    expect(elements(chart, "img")).toHaveLength(0); expect(elements(chart, "style")).toHaveLength(0);
    expect(cellText(elements(chart, "td")[0]!)).toBe(hostile);
    expect(elements(chart, "h3")[0]!.textContent).toBe(hostile);
    expect(elements(chart, "title")[0]!.textContent).toBe(hostile);
    expect(elements(chart, "td")[0]!.textContent).toContain(hostile);
    expect(elements(chart, "p")[0]!.textContent).toBe("1 Jan 1970, 00:00 UTC to 1 Jan 1970, 00:00:01 UTC · 100 tokens minimum · 100 tokens maximum");
    for (const node of descendants(chart as never)) for (const name of node.attributes.keys()) expect(name).not.toMatch(/^(style|on)/i);
  });
  it("chart table has identical observations", async () => {
    // Break caught: dropping nulls/tokens/basis in either representation or replacing the focused toggle.
    const module = await import("../web/charts.js").catch(() => null);
    expect(module, "chart primitive is available").not.toBeNull();
    const doc = new PlainDocument();
    const chart = module!.chartWithTable(doc.asDocument(), { title: "Daily AIC", unit: "calibrated-aic", points: [
      { start: 0, end: 1000, label: "One", value: 0, tokens, note: "published estimate ~0 AIC" },
      { start: 1000, end: 2000, label: "Two", value: null, tokens: null, note: "unpriced" },
    ] });
    const titles = elements(chart, "title").slice(1).map(node => node.textContent);
    expect(titles).toEqual([
      "One · 1 Jan 1970, 00:00 UTC to 1 Jan 1970, 00:00:01 UTC · 0 AIC cal · input 10; cache read 20; cache write 30; output 40; prompt 60; total 100; cache write 1h unavailable; reasoning unavailable · published estimate ~0 AIC",
      "Two · 1 Jan 1970, 00:00:01 UTC to 1 Jan 1970, 00:00:02 UTC · unavailable · tokens unavailable · unpriced",
    ]);
    expect(elements(chart, "tr").slice(1).map(row => row.children.map(cell => cellText(cell)).join(" · "))).toEqual(titles);
    expect(elements(chart, "circle")).toHaveLength(1); // null is never plotted as zero
    const toggle = button(chart, "Table"); toggle.focus(); toggle.click();
    expect(elements(chart, "table")[0]!.parentElement!.hidden).toBe(false);
    expect(elements(chart, "svg")[0]!.parentElement!.hidden).toBe(true);
    expect(doc.activeElement).toBe(toggle);
    expect(toggle.textContent).toBe("Table"); const chartButton = button(chart, "Chart"); chartButton.focus(); chartButton.click();
    expect(doc.activeElement).toBe(chartButton);
    expect(elements(chart, "svg")[0]!.parentElement!.hidden).toBe(false);
  });
});


it("successful retained-focus pager refresh hides Retry and focuses the section heading", async () => {
  // Break caught: success leaves a focused error-only action visible.
  const { createPager } = await import("../web/pager.js"), { DashboardClientError } = await import("../web/client.js");
  const doc = new PlainDocument(), pager = createPager(doc.asDocument(), { title: "Usage", param: "cursor", onLoad() {} });
  doc.body.append(pager.region as unknown as import("./fixtures/plain-dom.js").PlainElement);
  pager.fail(new DashboardClientError("busy"), true); const retry = button(pager.region, "Retry"); retry.focus();
  pager.busy(true, false, true); expect(retry.hidden).toBe(false);
  pager.accept({ start: 0, end: 100 }, null); pager.complete(100, true);
  expect(retry.hidden).toBe(true); expect(doc.activeElement).toBe(elements(pager.region, "h2")[0]);
});

it("updateEvidence keeps reordered row buttons but adopts each new row action", async () => {
  // Break caught: retained row buttons execute stale closures after a reorder.
  const { action, updateEvidence } = await import("../web/dom.js"), { renderTable } = await import("../web/tables.js");
  const doc = new PlainDocument(), parent = doc.createElement("div"), chosen: string[] = [];
  const render = (ids: string[]) => renderTable(doc.asDocument(), { caption: "Rows", columns: ["Name"], rows: ids.map(id => [action(doc.asDocument(), id, () => chosen.push(id))]) });
  updateEvidence(parent as unknown as HTMLElement, render(["first", "second"])); const retained = elements(parent, "button");
  updateEvidence(parent as unknown as HTMLElement, render(["second", "first"]));
  expect(elements(parent, "button")).toEqual(retained); retained[0]!.click(); retained[1]!.click(); expect(chosen).toEqual(["second", "first"]);
});


it("chart markers use the unscaled CSS viewport and never connect nulls or gaps", async () => {
  // Breaks: scalable plot circles shrink below 3.5 CSS px radius or lines invent intervening observations.
  const { chartWithTable } = await import("../web/charts.js"), doc = new PlainDocument();
  const chart = chartWithTable(doc.asDocument(), { title: "Sparse observations", unit: "tokens", points: [
    { start: 0, end: 1000, label: "first", value: 10, tokens: null },
    { start: 1000, end: 2000, label: "unknown", value: null, tokens: null },
    { start: 9000, end: 10000, label: "after a gap", value: 20, tokens: null },
  ] });
  const dots = elements(chart,"circle"); expect(dots).toHaveLength(2);
  expect(dots.map(n=>n.getAttribute("r"))).toEqual(["3.5","3.5"]);
  for(const dot of dots) { let parent=dot.parentElement; while(parent&&parent.tagName.toLowerCase()!=="svg")parent=parent.parentElement; expect(parent?.getAttribute("viewBox")).toBeNull(); }
  expect(elements(chart,"line")).toHaveLength(0);expect(elements(chart,"path")).toHaveLength(0);expect(elements(chart,"polyline")).toHaveLength(0);
  expect(elements(chart,"tr").slice(1).map(row=>cellText(row.children[2]!))).toEqual(["10 tokens","unavailable","20 tokens"]);
});
