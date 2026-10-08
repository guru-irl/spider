import { expect, it, vi } from "vitest";
import { PlainDocument, elements, button, descendants } from "./fixtures/plain-dom.js";
import { formatValue, formatLocalTime, formatUtcTime } from "../web/format.js";
import { chartPair } from "../web/charts.js";
import { sectionState, updateEvidence, chip } from "../web/dom.js";
import { renderTable } from "../web/tables.js";
import { renderModelMarker } from "../web/model-style.js";
import { loadFonts } from "../web/fonts.js";
import { renderFlow } from "../web/flow.js";
import { renderStateExamples } from "../web/state-examples.js";
import { fixtureStateCases } from "./fixtures/redesign-contract.js";
import { overviewFixture } from "./fixtures/redesign-contract.js";
it("fixture state examples are isolated, settled, disposed and do not change the browser URL", async () => {
  const doc = new PlainDocument(), location = { hash: "#/calibration" }, history = { replaceState: vi.fn(), pushState: vi.fn() };
  Object.defineProperty(doc, "defaultView", { value: Object.assign(new EventTarget(), { location, history }) });
  const roots: HTMLElement[] = [], signals: AbortSignal[] = [], dispose = vi.fn();
  const cases = fixtureStateCases().filter(c => c.page === "overview").slice(0, 2);
  await renderStateExamples(doc.body as unknown as HTMLElement, { overview: ctx => { roots.push(ctx.root); signals.push(ctx.signal); return { refresh: async () => { ctx.root.textContent = "Settled"; }, dispose }; } }, cases);
  expect(new Set(roots).size).toBe(2); expect(signals.every(s => s.aborted)).toBe(true); expect(dispose).toHaveBeenCalledTimes(2); expect(doc.body.textContent).toContain("Settled"); expect(history.replaceState).not.toHaveBeenCalled(); expect(history.pushState).not.toHaveBeenCalled();
});
it("gallery disposal freezes page classes and visible interaction cards", async () => {
  const doc = new PlainDocument();
  await renderStateExamples(doc.body as unknown as HTMLElement, { overview: ctx => {
    const card = doc.createElement("div"); card.className = "route-card";
    ctx.root.className = "overview-page"; ctx.root.append(card as unknown as HTMLElement);
    return { refresh: async () => {}, dispose() { ctx.root.className = ""; card.hidden = true; } };
  } }, fixtureStateCases().filter(c => c.page === "overview").slice(0, 1));
  expect(descendants(doc.body).find(n => n.className === "overview-page")).toBeDefined();
  expect(descendants(doc.body).find(n => n.className === "route-card")!.hidden).toBe(false);
});
it("gallery waits for layout frames before disposing responsive graphics", async () => {
  const doc = new PlainDocument(), events: string[] = [];
  Object.defineProperty(doc, "defaultView", { value: Object.assign(new EventTarget(), { requestAnimationFrame(callback: FrameRequestCallback) { events.push("frame"); queueMicrotask(() => callback(0)); return 1; } }) });
  await renderStateExamples(doc.body as unknown as HTMLElement, { overview: () => ({ refresh: async () => { events.push("refresh"); }, dispose() { events.push("dispose"); } }) }, fixtureStateCases().filter(c => c.page === "overview").slice(0, 1));
  expect(events).toEqual(["refresh", "frame", "frame", "dispose"]);
});
it("unknown-session catalogue mounts its typed 404 identity", async () => {
  const doc = new PlainDocument(), ids: string[] = [];
  await renderStateExamples(doc.body as unknown as HTMLElement, { session: ctx => { if (ctx.route.page === "session") ids.push(ctx.route.id); return { refresh: async () => {}, dispose() {} }; } }, fixtureStateCases().filter(c => c.page === "session" && c.scenario === "unknown-session"));
  expect(ids).toEqual(["unknown-session"]);
});
it("remote font faces preserve native weight matching and rendering never waits for network", async () => {
  const doc = new PlainDocument(), remote: {family: string; source: string; weight: string}[] = [];
  doc.fonts = { load: async () => [] }; Object.assign(doc.fonts, { add() {} });
  vi.stubGlobal("FontFace", class {
    constructor(family: string, source: string, descriptors: {weight: string}) { remote.push({ family, source, weight: descriptors.weight }); }
    load() { return new Promise(() => {}); }
  });
  try {
    await loadFonts(doc.asDocument(), undefined, () => 10);
    expect(remote.map(r => [r.family, r.weight])).toEqual([
      ["Usage Text Remote", "400"], ["Usage Text Remote", "500"], ["Usage Text Remote", "600"], ["Usage Text Remote", "700"],
      ["Usage Code Remote", "400"], ["Usage Code Remote", "700"], ["Usage Wordmark Remote", "400"],
    ]);
    expect(remote.every(r => /^url\("https:\/\/fonts\.gstatic\.com\/.+\.woff2"\)$/.test(r.source))).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});
it("formats credits and tokens without basis markers and local or UTC dates", () => {
  const value = overviewFixture().total;
  expect(formatValue({ ...value, credits: 12.5 }, "credits")).toBe("12.5");
  expect(formatValue({ ...value, credits: null }, "credits")).toBe("unavailable");
  expect(formatValue({ ...value, tokens: { ...value.tokens, total: 1500 } }, "tokens")).toBe("1.5k");
  const ts = Date.UTC(2026, 9, 6, 9, 12); expect(formatLocalTime(ts, "UTC")).toBe("Tue 6 OCT 09:12"); expect(formatUtcTime(ts)).toBe("Tue 6 OCT 09:12 UTC");
  expect(formatLocalTime(ts, "invalid")).toBe("Tue 6 OCT 09:12");
});
it("Chart/Table persists per chart and retains focus when data refreshes", () => {
  const doc = new PlainDocument(), root = doc.body; const chart = (n: number) => chartPair(doc.asDocument(), { id: "daily", title: "Daily credits", svg: doc.createElementNS("http://www.w3.org/2000/svg", "svg") as unknown as SVGElement, table: renderTable(doc.asDocument(), { caption: "Daily credits", columns: ["Credits"], rows: [[String(n)]] }) });
  root.append(chart(12) as never); const toggle = button(root, "Table"); toggle.click(); toggle.focus();
  updateEvidence(root as unknown as HTMLElement, chart(24)); expect(button(root, "Table")).toBe(toggle); expect(doc.activeElement).toBe(toggle); expect(toggle.getAttribute("aria-pressed")).toBe("true"); expect(root.textContent).toContain("24");
  const rebuilt = chart(48); expect(button(rebuilt, "Table").getAttribute("aria-pressed")).toBe("true");
  const other = chartPair(doc.asDocument(), { id: "other", title: "Other", svg: doc.createElementNS("http://www.w3.org/2000/svg", "svg") as unknown as SVGElement, table: renderTable(doc.asDocument(), { caption: "Other", columns: [], rows: [] }) }); expect(button(other, "Chart").getAttribute("aria-pressed")).toBe("true");
});
it("loading empty and error states replace old content, only errors retry", () => {
  const doc = new PlainDocument(), retry = vi.fn();
  for (const state of ["loading", "empty", "error"] as const) { sectionState(doc.body as unknown as HTMLElement, state, state, retry); expect(doc.body.getAttribute("aria-busy")).toBe(String(state === "loading")); expect(elements(doc.body, "button")).toHaveLength(state === "error" ? 1 : 0); }
  button(doc.body, "Retry").click(); expect(retry).toHaveBeenCalledOnce();
});
it("model markers have shape and safe SVG colour, never inline styles", () => {
  const doc = new PlainDocument();
  for (const shape of ["circle", "square", "diamond", "triangle"] as const) { const marker = renderModelMarker(doc.asDocument(), { shape, color: "#f8785c" }); expect(marker.getAttribute("data-shape")).toBe(shape === "square" ? "diamond" : shape === "diamond" ? "square" : shape); expect(marker.getAttribute("role")).toBe("img"); expect(marker.getAttribute("aria-label")).toBe(shape === "square" ? "diamond" : shape === "diamond" ? "square" : shape); expect(descendants(marker as never).some(n => n.hasAttribute("style"))).toBe(false); }
  const bad = renderModelMarker(doc.asDocument(), { shape: "circle", color: "url(https://invalid.example)" }); expect(elements(bad, "circle")[0]!.getAttribute("fill")).toBe("currentColor");
});
it("flow shows actual edge values in a paired table with no invented total", () => {
  const doc = new PlainDocument(), flow = overviewFixture().flow;
  const node = renderFlow(doc.asDocument(), flow, "credits", "flow"); expect(elements(node, "table")).toHaveLength(1); expect(elements(node, "tbody")[0]!.children).toHaveLength(flow.edges.length);
  expect(elements(node, "svg")[0]!.getAttribute("role")).toBe("group");
  const links = elements(node, "path").filter(path => path.hasAttribute("stroke-width")); expect(links).toHaveLength(flow.edges.length);
  for (const path of links) { expect(path.getAttribute("tabindex")).toBe("0"); expect(path.getAttribute("aria-label")).toBe(elements(path, "title")[0]!.textContent); }
  flow.edges.forEach(edge => expect(node.textContent).toContain(formatValue(edge.value, "credits")));
  expect(descendants(node as never).some(n => n.hasAttribute("style"))).toBe(false);
});

it("September is SEP and every month uses a fixed three-letter English label", () => {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  expect(formatLocalTime(Date.UTC(2026, 8, 6, 9, 12), "UTC")).toBe("Sun 6 SEP 09:12");
  months.forEach((month, index) => expect(formatLocalTime(Date.UTC(2026, index, 6, 9, 12), "UTC")).toContain(`6 ${month} 09:12`));
});
it("repeated local hours include distinct offsets when requested", () => {
  expect(formatLocalTime(Date.UTC(2026, 9, 25, 0, 30), "Europe/London", { offset: true })).toBe("Sun 25 OCT 01:30 GMT+1");
  expect(formatLocalTime(Date.UTC(2026, 9, 25, 1, 30), "Europe/London", { offset: true })).toMatch(/^Sun 25 OCT 01:30 GMT(?:\+0)?$/);
  expect(formatLocalTime(Date.UTC(2026, 9, 25, 1, 30), "Europe/London")).toBe("Sun 25 OCT 01:30");
});
it("shared chips distinguish text labels from machine values without inline styles", () => {
  const doc = new PlainDocument(), node = chip(doc.asDocument(), "Calls", "12"); expect(node.className).toBe("stat-chip"); expect(elements(node, "span")[1]!.textContent).toBe("Calls"); const value = elements(node, "strong")[0]!; expect(value.textContent).toBe("12"); expect(value.className).toBe("mono"); expect(descendants(node as never).some(n => n.hasAttribute("style"))).toBe(false);
});

it("flow nodes span the chart and the viewport fits its last label", () => {
  const doc = new PlainDocument(), node = renderFlow(doc.asDocument(), overviewFixture().flow, "credits", "width-flow"), svg = elements(node, "svg")[0]!;
  expect(svg.getAttribute("viewBox")).toBe("0 0 1122 272");
  const stations = elements(svg, "rect"); expect(stations.every(n => n.getAttribute("x") === "120")).toBe(true);
  const modelLabels = elements(svg, "text").filter(n => n.textContent.startsWith("model-"));
  expect(modelLabels.every(n => n.getAttribute("text-anchor") === "start" && n.getAttribute("x") === "1010")).toBe(true);
});

it("flow omits stations and table rows for roles with no usage", () => {
  const doc = new PlainDocument(), flow = overviewFixture().flow, value = structuredClone(flow.total);
  value.credits = 0; value.calls = 0; value.tokens.total = 0;
  flow.edges = [...flow.edges, { role: "scouts", model: flow.models[0]!.id, value, share: 0 }];
  const node = renderFlow(doc.asDocument(), flow, "credits", "zero-flow");
  expect(elements(node, "text").some(n => n.textContent === "Scouts")).toBe(false);
  expect(elements(node, "tbody")[0]!.children.some(n => n.textContent.includes("Scouts"))).toBe(false);
});

it("installed families are detected by native width even when fonts.load returns no CSS faces", async () => {
  const doc = new PlainDocument(); doc.fonts = { load: async () => [] };
  const faces: string[] = []; Object.assign(doc.fonts, { add(face: { family: string }) { faces.push(face.family); } });
  vi.stubGlobal("FontFace", class { constructor(readonly family: string) {} load() { return Promise.resolve(this); } });
  try {
    await loadFonts(doc.asDocument(), undefined, font => /Fira Sans|Cascadia Code|Bebas Neue/.test(font) ? 120 : 100);
    expect(faces).toEqual([]);
  } finally { vi.unstubAllGlobals(); }
});
