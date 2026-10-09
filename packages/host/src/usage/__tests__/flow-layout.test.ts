import { expect, it } from "vitest";
import { renderFlow } from "../web/flow.js";
import { overviewFixture } from "./fixtures/redesign-contract.js";
import { PlainDocument, elements, descendants, cellText } from "./fixtures/plain-dom.js";

it.each(["credits", "tokens"] as const)("%s ribbons conserve every node on one proportional scale", unit => {
  const flow = overviewFixture().flow, sample = flow.edges[0]!.value;
  flow.edges = [
    { role: "own", model: "model-cedar", value: { ...sample, credits: 60, tokens: { ...sample.tokens, total: 600 } }, share: .6 },
    { role: "own", model: "model-maple", value: { ...sample, credits: 10, tokens: { ...sample.tokens, total: 100 } }, share: .1 },
    { role: "workers", model: "model-cedar", value: { ...sample, credits: 20, tokens: { ...sample.tokens, total: 200 } }, share: .2 },
    { role: "workers", model: "model-maple", value: { ...sample, credits: 10, tokens: { ...sample.tokens, total: 100 } }, share: .1 },
  ];
  flow.total.credits = 100; flow.total.tokens.total = 1000;
  const doc = new PlainDocument(), render = () => renderFlow(doc.asDocument(), flow, unit, "conserved");
  const root = render(), paths = elements(root, "path").filter(n => n.hasAttribute("stroke-width"));
  const widths = paths.map(n => Number(n.getAttribute("stroke-width")));
  expect(widths[0]! / widths[1]!).toBeCloseTo(6, 8); expect(widths[2]! / widths[3]!).toBeCloseTo(2, 8);
  for (const [attribute, end] of [["data-role-node", 1], ["data-model-node", 7]] as const) {
    const nodes = descendants(root as never).filter(n => n.hasAttribute(attribute));
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      const key = node.getAttribute(attribute), top = Number(node.getAttribute("y")), height = Number(node.getAttribute("height"));
      const ribbons = paths.filter(p => p.getAttribute(attribute === "data-role-node" ? "data-flow-role" : "data-flow-model") === key);
      expect(Math.abs(ribbons.reduce((n, p) => n + Number(p.getAttribute("stroke-width")), 0) - height)).toBeLessThanOrEqual(.5);
      const spans = ribbons.map(p => { const coordinates = p.getAttribute("d")!.match(/-?\d+(?:\.\d+)?/g)!.map(Number), half = Number(p.getAttribute("stroke-width")) / 2; return [coordinates[end]! - half, coordinates[end]! + half]; });
      expect(spans[0]![0]).toBeCloseTo(top, 8); expect(spans.at(-1)![1]).toBeCloseTo(top + height, 8);
      spans.slice(1).forEach((span, i) => expect(span[0]).toBeCloseTo(spans[i]![1]!, 8));
    }
  }
  const geometry = (node: HTMLElement) => elements(node, "path").filter(n => n.hasAttribute("stroke-width")).map(n => [n.getAttribute("aria-label"), n.getAttribute("d"), n.getAttribute("stroke-width")]);
  flow.edges = [...flow.edges].reverse(); expect(geometry(render())).toEqual(geometry(root));
  const table = elements(root, "tbody")[0]!;
  expect(table.children.map(row => row.children.map(cellText))).toEqual([
    ["Own calls", "model-cedar", unit === "credits" ? "60" : "600", "60%"],
    ["Own calls", "model-maple", unit === "credits" ? "10" : "100", "10%"],
    ["Workers", "model-cedar", unit === "credits" ? "20" : "200", "20%"],
    ["Workers", "model-maple", unit === "credits" ? "10" : "100", "10%"],
  ]);
});

it("tiny ribbons remain visible without breaking node conservation", () => {
  const flow = overviewFixture().flow;
  flow.edges = flow.edges.slice(0, 2); flow.edges[0]!.value.credits = 1000000; flow.edges[1]!.value.credits = .01;
  const doc = new PlainDocument(), root = renderFlow(doc.asDocument(), flow, "credits", "tiny");
  const paths = elements(root, "path").filter(n => n.hasAttribute("stroke-width"));
  expect(Number(paths[1]!.getAttribute("stroke-width"))).toBeGreaterThanOrEqual(.75);
  const stations = elements(root, "rect").filter(n => n.hasAttribute("data-role-node"));
  expect(stations).toHaveLength(2);
  for (const station of stations) {
    const sum = paths.filter(p => p.getAttribute("data-flow-role") === station.getAttribute("data-role-node")).reduce((n, p) => n + Number(p.getAttribute("stroke-width")), 0);
    expect(sum).toBeCloseTo(Number(station.getAttribute("height")), 8);
  }
});
