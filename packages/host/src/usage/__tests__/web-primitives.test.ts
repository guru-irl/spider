import { observeFontTransport } from "./fixtures/font-transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { PlainDocument, button, elements, descendants, cellText } from "./fixtures/plain-dom.js";

afterEach(() => vi.unstubAllGlobals());

describe("web primitives", () => {
  it.each(["both", "sans-serif-only", "missing"])("canvas measurer sets each candidate font (%s)", async available => {
    const { loadFonts } = await import("../web/fonts.js"), doc = new PlainDocument();
    doc.fonts = { async load() { return [{}]; } };
    const create = doc.createElement.bind(doc);
    const context = { font: "10px sans-serif", measureText(_text: string) {
      return { width: /Fira Sans|Cascadia Code|Bebas Neue/.test(this.font) && available !== "missing" && (available === "both" || this.font.endsWith("sans-serif")) ? 120 : 100 };
    } };
    const document = doc.asDocument();
    document.createElement = ((tag: string) => tag === "canvas" ? { getContext: () => context } : create(tag)) as typeof document.createElement;
    const faces = observeFontTransport(doc);
    await loadFonts(document);
    expect(faces).toHaveLength(available === "missing" ? 7 : 0);
    expect(elements(doc.head, "link")).toHaveLength(0);
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
    ["identity-unavailable", 503, "Usage identity unavailable. Remove the ledger's salt file if it is unusable, wait five seconds, then refresh."],
    ["invalid-query", 400, "Invalid usage query. Refresh to continue."],
    ["ledger-changed", 409, "Usage changed. Refresh to continue."],
  ] as const)("fixed API code %s reaches the view with a non-Retry notice", async (code, status, notice) => {
    const { createDashboardClient, errorCopy } = await import("../web/client.js");
    const client = createDashboardClient(async () => new Response(JSON.stringify({ error: { code, message: "ignored raw message" } }), { status }));
    const error = await client.get("/api/overview", new URLSearchParams(), new AbortController().signal).catch(error => error);
    expect.soft(error.code).toBe(code); expect.soft(errorCopy(error)).toBe(notice);
  });
  it("unknown server error codes are normalized before reaching callers", async () => {
    const { createDashboardClient } = await import("../web/client.js");
    const client = createDashboardClient(async () => new Response(JSON.stringify({ error: { code: '<img onerror="alert(1)">', message: "private" } }), { status: 500 }));
    await expect(client.get("/api/overview", new URLSearchParams(), new AbortController().signal)).rejects.toMatchObject({ code: "internal" });
  });
  it("fonts load locally before direct file transport", async () => {
    // Break caught: unconditional network links, blocking rendering, or non-stylesheet font fallback.
    const module = await import("../web/fonts.js").catch(() => null);
    expect(module, "font loader is available").not.toBeNull();
    const local = new PlainDocument(); const attempted: string[] = [];
    local.fonts = { async load(font) { attempted.push(font); return [{}]; } };
    await module!.loadFonts(local.asDocument(), undefined, font => /Fira Sans|Cascadia Code|Bebas Neue/.test(font) ? 120 : 100);
    expect(attempted).toEqual(['400 16px "Fira Sans"', '500 16px "Fira Sans"', '600 16px "Fira Sans"', '700 16px "Fira Sans"', '400 16px "Cascadia Code"', '700 16px "Cascadia Code"', '400 16px "Bebas Neue"']);
    expect(elements(local.head, "link")).toHaveLength(0);
    const missing = new PlainDocument();
    const finish: ((faces: unknown[]) => void)[] = [];
    missing.fonts = { load() { return new Promise(resolve => { finish.push(resolve); }); } };
    const missingFaces = observeFontTransport(missing);
    const pending = module!.loadFonts(missing.asDocument(), undefined, () => 100);
    expect(elements(missing.head, "link")).toHaveLength(0);
    // Use a separate failing loader to cover empty and rejected local faces.
    const offline = new PlainDocument(); offline.fonts = { async load(font) { if (font.includes("Text")) return []; throw new Error("offline"); } };
    const faces = observeFontTransport(offline);
    await module!.loadFonts(offline.asDocument(), undefined, () => 100);
    expect(faces).toHaveLength(7);
    expect(faces.every(face => face.source.startsWith(`url("https://fonts.gstatic.com/`))).toBe(true);
    expect(elements(offline.head, "link")).toHaveLength(0);
    expect(elements(offline.head, "script")).toHaveLength(0);
    // Aborting prevents a late conditional link; offline rendering remains ordinary text.
    finish.forEach(resolve => resolve([])); await pending;
    expect(missingFaces).toHaveLength(7);
    const cancelled = new PlainDocument(); const abort = new AbortController(); abort.abort();
    await module!.loadFonts(cancelled.asDocument(), abort.signal);
    expect(elements(cancelled.head, "link")).toHaveLength(0);
  });
  it("font fallback measures width rather than trusting fonts.check", async () => {
    const { loadFonts } = await import("../web/fonts.js");
    for (const available of [true, false]) {
      const doc = new PlainDocument();
      doc.fonts = { async load() { return [{}]; }, check() { throw new Error("check cannot detect a local font"); } };
      const measure = (font: string) => available && /Fira Sans|Cascadia Code|Bebas Neue/.test(font) ? 120 : 100;
      const faces = observeFontTransport(doc);
      await loadFonts(doc.asDocument(), undefined, measure);
      expect(faces).toHaveLength(available ? 0 : 7);
    }
  });
  it("font fallback is bounded at exactly 1.5 seconds", async () => {
    vi.useFakeTimers();
    try {
      const { loadFonts } = await import("../web/fonts.js"), doc = new PlainDocument();
      doc.fonts = { load() { return new Promise(() => {}); } };
      const faces = observeFontTransport(doc);
      const pending = loadFonts(doc.asDocument());
      await vi.advanceTimersByTimeAsync(1499); expect(elements(doc.head, "link")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1); expect(faces).toHaveLength(7); await pending;
      expect(faces).toHaveLength(7); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("a locally available family skips only its own remote faces", async () => {
    const { loadFonts } = await import("../web/fonts.js");
    const doc = new PlainDocument();
    doc.fonts = { async load(font) { return font.includes("Fira Sans") ? [{}] : []; }, check() { return true; } };
    const faces = observeFontTransport(doc);
    await loadFonts(doc.asDocument(), undefined, font => font.includes("Fira Sans") ? 120 : 100); expect(faces.map(face => face.family)).toEqual(["Usage Code Remote", "Usage Code Remote", "Usage Wordmark Remote"]);
  });
  it("a late font abort never appends a link", async () => {
    const { loadFonts } = await import("../web/fonts.js");
    const doc = new PlainDocument(), abort = new AbortController(), finishes: ((faces: unknown[]) => void)[] = [];
    doc.fonts = { load() { return new Promise(resolve => finishes.push(resolve)); }, check() { return false; } };
    const pending = loadFonts(doc.asDocument(), abort.signal);
    abort.abort(); finishes.forEach(resolve => resolve([])); await pending;
    expect(elements(doc.head, "link")).toHaveLength(0);
  });
  it("empty tables explain that no rows are recorded", async () => {
    const { renderTable } = await import("../web/tables.js");
    const table = renderTable(new PlainDocument().asDocument(), { caption: "Roles", columns: ["Role", "Value"], rows: [] });
    expect(cellText(elements(table, "td")[0]!)).toBe("No rows recorded");
    expect(elements(table, "td")[0]!.getAttribute("colspan")).toBe("2");
  });
  it("wide table regions remain focusable and named without explanatory scroll copy", async () => {
    const { renderTable, tableRegion } = await import("../web/tables.js"); const doc = new PlainDocument();
    const table = renderTable(doc.asDocument(), { caption: "Wide observations", columns: ["A", "B", "C", "D", "E", "F", "G"], rows: [["1", "2", "3", "4", "5", "6", "7"]] });
    const region = tableRegion(doc.asDocument(), table);
    expect(region.className).toBe("table-region wide-table-region"); expect(region.getAttribute("tabindex")).toBe("0"); expect(region.getAttribute("aria-labelledby")).toBe(elements(table, "caption")[0]!.id);
    expect(elements(region, "p")).toHaveLength(0); expect(region.getAttribute("aria-describedby")).toBeNull(); expect(elements(region, "table")).toHaveLength(1);
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
    const { chartPair } = await import("../web/charts.js"), { renderTable } = await import("../web/tables.js");
    const doc = new PlainDocument();
    const chart = chartPair(doc.asDocument(), { id: "hostile", title: response.data, svg: doc.createElementNS("http://www.w3.org/2000/svg", "svg") as unknown as SVGElement, table: renderTable(doc.asDocument(), { caption: hostile, columns: ["Session"], rows: [[hostile]] }) });
    expect(elements(chart, "img")).toHaveLength(0); expect(elements(chart, "style")).toHaveLength(0);
    expect(cellText(elements(chart, "td")[0]!)).toBe(hostile);
    expect(elements(chart, "h2")[0]!.textContent).toBe(hostile);
    for (const node of descendants(chart as never)) for (const name of node.attributes.keys()) expect(name).not.toMatch(/^(style|on)/i);
  });
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

it("a missing local bold weight requests only that remote weight", async () => {
  const { loadFonts } = await import("../web/fonts.js"); const doc = new PlainDocument();
  doc.fonts = { async load(font) { if (font.startsWith('700 ') && font.includes('Code')) throw new Error('local bold missing'); return [{}]; } };
  const faces = observeFontTransport(doc);
  await loadFonts(doc.asDocument(), undefined, font => /Fira Sans|Cascadia Code|Bebas Neue/.test(font) ? 120 : 100);
  expect(faces.map(face => `${face.family}:${face.weight}`)).toEqual(["Usage Code Remote:700"]);
});
