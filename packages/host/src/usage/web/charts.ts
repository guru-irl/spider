import { representation, selectRepresentation } from "./representation.js";
import { action, element } from "./dom.js";
import { tableRegion } from "./tables.js";

/** Pair a page's SVG with its same-number table. Choices are independent and durable. */
export function chartPair(document: Document, options: { id: string; title: string; svg: SVGElement; table: HTMLTableElement }): HTMLElement {
  const section = element(document, "div", undefined, "chart-panel");
  const head = element(document, "div", undefined, "section-head"); head.append(element(document, "h2", options.title));
  const graphic = element(document, "div", undefined, "chart-graphic"); graphic.append(options.svg);
  options.svg.setAttribute("aria-label", options.title);
  const region = tableRegion(document, options.table);
  const select = (mode: "chart" | "table") => {
    graphic.hidden = mode === "table"; region.hidden = mode === "chart";
    chart.setAttribute("aria-pressed", String(mode === "chart")); table.setAttribute("aria-pressed", String(mode === "table"));
  };
  const chart = action(document, "Chart", () => { selectRepresentation(document, options.id, "chart"); select("chart"); });
  const table = action(document, "Table", () => { selectRepresentation(document, options.id, "table"); select("table"); });
  const controls = element(document, "div", undefined, "segmented"); controls.setAttribute("role", "group"); controls.setAttribute("aria-label", "Chart representation"); controls.append(chart, table);
  head.append(controls); section.append(head, graphic, region); select(representation(document, options.id)); return section;
}

/** Three readable intervals, rounded upward to 1, 2 or 5 × 10^n. */
export function creditStep(max: number): number {
  const target = (max > 0 ? max : 1) / 3, power = 10 ** Math.floor(Math.log10(target)), fraction = target / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}
