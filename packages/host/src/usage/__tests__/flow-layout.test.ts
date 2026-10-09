import { expect, it } from "vitest";
import { renderFlow } from "../web/flow.js";
import { overviewFixture } from "./fixtures/redesign-contract.js";
import { PlainDocument, elements, descendants, cellText, type PlainElement } from "./fixtures/plain-dom.js";

const bands = (root: HTMLElement) => elements(root, "path").filter(n => n.hasAttribute("data-flow-role"));
const thickness = (p: PlainElement) => { const c = p.getAttribute("d")!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number); return c[9]! - c[7]!; };
const spans = (p: PlainElement, source: boolean) => { const c = p.getAttribute("d")!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number); return source ? [c[1]!, c[15]!] : [c[7]!, c[9]!]; };

it.each(["credits", "tokens"] as const)("%s filled bands conserve every node on one proportional scale", unit => {
  const flow = overviewFixture().flow, sample = flow.edges[0]!.value;
  flow.edges = [
    { role: "own", model: "model-cedar", value: { ...sample, credits: 60, tokens: { ...sample.tokens, total: 600 } }, share: .6 },
    { role: "own", model: "model-maple", value: { ...sample, credits: 10, tokens: { ...sample.tokens, total: 100 } }, share: .1 },
    { role: "workers", model: "model-cedar", value: { ...sample, credits: 20, tokens: { ...sample.tokens, total: 200 } }, share: .2 },
    { role: "workers", model: "model-maple", value: { ...sample, credits: 10, tokens: { ...sample.tokens, total: 100 } }, share: .1 },
  ];
  flow.total.credits = 100; flow.total.tokens.total = 1000;
  const doc = new PlainDocument(), render = () => renderFlow(doc.asDocument(), flow, unit, "conserved");
  const root = render(), paths = bands(root), widths = paths.map(thickness);
  expect(paths).toHaveLength(4);
  for (const p of paths) { expect(p.getAttribute("fill")).not.toBe("none"); expect(p.getAttribute("d")).toMatch(/Z$/); }
  expect(widths[0]! / widths[1]!).toBeCloseTo(6, 8); expect(widths[2]! / widths[3]!).toBeCloseTo(2, 8);
  expect(widths[1]).toBeCloseTo(widths[3]!, 8); expect(widths[0]! / widths[2]!).toBeCloseTo(3, 8);
  for (const attribute of ["data-role-node", "data-model-node"] as const) {
    const nodes = elements(root, "rect").filter(n => n.hasAttribute(attribute));
    expect(nodes).toHaveLength(attribute === "data-role-node" ? 6 : 2);
    for (const node of nodes) {
      const key = node.getAttribute(attribute), top = Number(node.getAttribute("y")), height = Number(node.getAttribute("height"));
      expect(node.getAttribute("width")).toBe("8");
      const ribbons = paths.filter(p => p.getAttribute(attribute === "data-role-node" ? "data-flow-role" : "data-flow-model") === key);
      expect(ribbons.reduce((n, p) => n + thickness(p), 0)).toBeCloseTo(height, 8);
      if (!ribbons.length) continue;
      const intervals = ribbons.map(p => spans(p, attribute === "data-role-node"));
      expect(intervals[0]![0]).toBeCloseTo(top, 8); expect(intervals.at(-1)![1]).toBeCloseTo(top + height, 8);
      intervals.slice(1).forEach((span, i) => expect(span[0]).toBeCloseTo(intervals[i]![1]!, 8));
    }
  }
  const geometry = (node: HTMLElement) => bands(node).map(n => [n.getAttribute("aria-label"), n.getAttribute("d")]);
  flow.edges = [...flow.edges].reverse(); expect(geometry(render())).toEqual(geometry(root));
  const table = elements(root, "tbody")[0]!;
  expect(table.children.map(row => row.children.map(cellText))).toEqual([
    ["Own calls", "model-cedar", unit === "credits" ? "60" : "600", "60%"],
    ["Own calls", "model-maple", unit === "credits" ? "10" : "100", "10%"],
    ["Workers", "model-cedar", unit === "credits" ? "20" : "200", "20%"],
    ["Workers", "model-maple", unit === "credits" ? "10" : "100", "10%"],
  ]);
});

it("tiny nonzero bands remain visible without inflating zero flows or breaking conservation", () => {
  const flow = overviewFixture().flow;
  flow.edges = flow.edges.slice(0, 2); flow.edges[0]!.value.credits = 1000000; flow.edges[1]!.value.credits = .01;
  const doc = new PlainDocument(), root = renderFlow(doc.asDocument(), flow, "credits", "tiny");
  const paths = bands(root); expect(thickness(paths[1]!)).toBeGreaterThanOrEqual(.75);
  for (const station of elements(root, "rect").filter(n => n.hasAttribute("data-role-node"))) {
    const sum = paths.filter(p => p.getAttribute("data-flow-role") === station.getAttribute("data-role-node")).reduce((n, p) => n + thickness(p), 0);
    expect(sum).toBeCloseTo(Number(station.getAttribute("height")), 8);
  }
  flow.edges[1]!.value.credits = 0;
  const zero = renderFlow(doc.asDocument(), flow, "credits", "zero");
  expect(bands(zero).filter(p => p.getAttribute("data-flow-role") === flow.edges[1]!.role)).toHaveLength(0);
});

it("bands are opaque so crossings never blend model colours", () => {
  const doc = new PlainDocument(), root = renderFlow(doc.asDocument(), overviewFixture().flow, "credits", "opaque");
  const paths = bands(root); expect(paths.length).toBeGreaterThan(1);
  for (const path of paths) { expect(path.getAttribute("fill")).not.toBe("none"); expect([null, "1"]).toContain(path.getAttribute("fill-opacity")); expect([null, "1"]).toContain(path.getAttribute("opacity")); }
});

it.each(["credits", "tokens"] as const)("%s labels fit the viewBox with unavailable and very long synthetic values", unit => {
  const flow = overviewFixture().flow;
  flow.edges = flow.edges.slice(0, 2).map((e, i) => ({ ...e, value: { ...e.value, credits: i ? 1e27 : null, tokens: { ...e.value.tokens, total: 1e27 } }, share: i ? .473 : .527 }));
  flow.models = flow.models.map(m => ({ ...m, id: m.id + "-with-a-very-long-model-label", value: { ...m.value, credits: 1e27, tokens: { ...m.value.tokens, total: 1e27 } } }));
  flow.edges = flow.edges.map((e, i) => ({ ...e, model: flow.models[i]!.id }));
  const root = renderFlow(new PlainDocument().asDocument(), flow, unit, "long"), svg = elements(root, "svg")[0]!;
  const [, , width, height] = svg.getAttribute("viewBox")!.split(" ").map(Number);
  for (const label of elements(root, "text")) {
    const x = Number(label.getAttribute("x")), y = Number(label.getAttribute("y"));
    // Independent conservative glyph bounds for the pinned 12/14/15px fonts.
    const textWidth = label.textContent.length * (label.className.includes("flow-model-label") ? 8 : label.className.includes("numeric") ? 9 : 8);
    expect(x - (label.getAttribute("text-anchor") === "end" ? textWidth : 0)).toBeGreaterThanOrEqual(0);
    expect(x + (label.getAttribute("text-anchor") === "end" ? 0 : textWidth)).toBeLessThanOrEqual(width!);
    expect(y - 16).toBeGreaterThanOrEqual(0); expect(y + 4).toBeLessThanOrEqual(height!);
  }
});

it("always names the six standard roles and adds Other runs only when present", () => {
  const flow = overviewFixture().flow, doc = new PlainDocument(); flow.edges = flow.edges.slice(0, 1);
  const labels = (root: HTMLElement) => elements(root, "text").filter(n => n.className.includes("flow-role-label")).map(n => n.textContent);
  expect(labels(renderFlow(doc.asDocument(), flow, "credits", "roles"))).toEqual(["Own calls", "Workers", "Reviewers", "Scouts", "Compaction", "Background"]);
  flow.edges = [...flow.edges, { ...flow.edges[0]!, role: "other-runs" }];
  expect(labels(renderFlow(doc.asDocument(), flow, "credits", "other"))).toEqual(["Own calls", "Workers", "Reviewers", "Scouts", "Compaction", "Background", "Other runs"]);
});

it.each(["credits", "tokens"] as const)("%s hover and focus detail dims only unrelated bands and dismisses without losing focus", unit => {
  const flow = overviewFixture().flow; flow.edges = flow.edges.map((e, i) => ({ ...e, value: { ...e.value, calls: 7, unpricedCalls: i ? 0 : 2 } }));
  const doc = new PlainDocument(), root = renderFlow(doc.asDocument(), flow, unit, "detail"), paths = bands(root);
  const tooltip = descendants(root as never).find(n => n.getAttribute("role") === "tooltip");
  expect(tooltip).toBeDefined(); expect(tooltip!.hidden).toBe(true); expect(elements(root, "title")).toHaveLength(0);
  const first = paths[0]!; first.dispatchEvent(new Event("pointerenter"));
  expect(tooltip!.hidden).toBe(false); expect(tooltip!.textContent).toContain("Own calls to model-cedar"); expect(tooltip!.textContent).toContain(unit); expect(tooltip!.textContent).toContain("7 calls"); expect(tooltip!.textContent).toContain("2 unpriced calls"); expect(tooltip!.textContent).toContain("20%");
  expect(first.getAttribute("opacity")).toBe("1"); expect(paths.slice(1).every(p => p.getAttribute("opacity") === "0.16")).toBe(true);
  first.dispatchEvent(new Event("pointerleave")); expect(tooltip!.hidden).toBe(true); expect(paths.every(p => p.getAttribute("opacity") === "1")).toBe(true);
  first.focus(); first.dispatchEvent(new Event("focus")); expect(tooltip!.hidden).toBe(false);
  first.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" })); expect(tooltip!.hidden).toBe(true); expect(doc.activeElement).toBe(first);
  const left = descendants(root as never).find(n => n.getAttribute("data-flow-node-role") === "own")!;
  expect(left.getAttribute("tabindex")).toBe("0"); left.dispatchEvent(new Event("focus"));
  expect(paths.every(p => p.getAttribute("opacity") === (p.getAttribute("data-flow-role") === "own" ? "1" : "0.16"))).toBe(true);
  const right = descendants(root as never).find(n => n.getAttribute("data-flow-node-model") === "model-cedar")!;
  expect(right.getAttribute("tabindex")).toBe("0"); right.dispatchEvent(new Event("pointerenter"));
  expect(paths.every(p => p.getAttribute("opacity") === (p.getAttribute("data-flow-model") === "model-cedar" ? "1" : "0.16"))).toBe(true);
  right.dispatchEvent(new Event("blur")); expect(tooltip!.hidden).toBe(true);
});

it("mixed priced and unpriced edges preserve known node credits and sum call detail", () => {
  const flow = overviewFixture().flow, sample = flow.edges[0]!.value;
  flow.edges = [
    { role: "other-runs", model: "model-cedar", value: { ...sample, credits: 12, calls: 3, unpricedCalls: 0 }, share: .6 },
    { role: "other-runs", model: "model-cedar", value: { ...sample, credits: null, calls: 2, unpricedCalls: 2 }, share: 0 },
    { role: "background", model: "unknown-model", value: { ...sample, credits: null, calls: 1, unpricedCalls: 1 }, share: 0 },
  ];
  const root = renderFlow(new PlainDocument().asDocument(), flow, "credits", "mixed");
  const role = elements(root, "rect").find(n => n.getAttribute("data-role-node") === "other-runs")!;
  const centre = Number(role.getAttribute("y")) + Number(role.getAttribute("height")) / 2;
  expect(elements(root, "text").filter(n => Number(n.getAttribute("y")) === centre + 15).some(n => n.textContent === "12 · 60%")).toBe(true);
  expect(elements(root, "text").filter(n => n.getAttribute("text-anchor") === "start").some(n => n.textContent === "12 · 60%")).toBe(true);
  const tooltip = descendants(root as never).find(n => n.getAttribute("role") === "tooltip")!;
  const node = descendants(root as never).find(n => n.getAttribute("data-flow-node-role") === "other-runs")!;
  node.dispatchEvent(new Event("focus")); expect(tooltip.textContent).toContain("12 credits"); expect(tooltip.textContent).toContain("5 calls"); expect(tooltip.textContent).toContain("2 unpriced calls");
  descendants(root as never).find(n => n.getAttribute("data-flow-node-model") === "model-cedar")!.dispatchEvent(new Event("focus"));
  expect(tooltip.textContent).toContain("12 credits"); expect(tooltip.textContent).toContain("5 calls"); expect(tooltip.textContent).toContain("2 unpriced calls");
  descendants(root as never).find(n => n.getAttribute("data-flow-node-model") === "unknown-model")!.dispatchEvent(new Event("focus"));
  expect(tooltip.textContent).toContain("unavailable credits"); expect(tooltip.textContent).toContain("1 unpriced calls");
});
