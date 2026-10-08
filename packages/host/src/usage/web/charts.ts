import { representation, selectRepresentation } from "./representation.js";
import type { TokenTotals, CalibrationResult } from "../dashboard-contract.js";
import { action, element } from "./dom.js";
import { formatCount, tokenObservation, tokenList, periodTimes, numericText, evidenceText, dateField, formatAicAmount, formatRatio, signedGap } from "./format.js";
import { renderTable, tableRegion } from "./tables.js";
export type ChartUnit = "estimated-aic" | "calibrated-aic" | "back-applied-aic" | "gap-aic" | "tokens" | "percent" | "ratio";
export type ChartPoint = { start: number; end: number; label: string; labelDate?: "day" | "month" | "timestamp"; value: number | null; tokens: TokenTotals | null; lowerBound?: boolean; note?: string | HTMLElement };
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
function observation(value: number | null, unit: ChartUnit, lowerBound = false, status: CalibrationResult["status"] = "uncalibrated"): string {
  if (value === null || !Number.isFinite(value)) return "unavailable";
  if (unit === "gap-aic") return signedGap(value, lowerBound);
  if (unit === "tokens") return formatCount(value, "token");
  if (unit === "percent") return `~${decimal.format(value)}%`;
  if (unit === "ratio") return formatRatio(value);
  return formatAicAmount(value, lowerBound ? 1 : 0, unit === "back-applied-aic" ? "back-applied" : unit === "calibrated-aic" ? "calibrated" : "published", status);
}
export function chartWithTable(document: Document, options: { id?: string; view?: string; section?: string; title: string; points: readonly ChartPoint[]; unit: ChartUnit; calibrationStatus?: CalibrationResult["status"]; gapBasis?: "published" | "calibrated" | "back-applied"; subsets?: "listed" | "recorded" }): HTMLElement {
  const chartId = options.id ?? `chart:${options.view ?? "standalone"}:${options.section ?? options.title}`;
  const section = element(document, "section", undefined, "chart-panel");
  section.append(element(document, "h3", options.title));
  const rows = options.points.map(point => [point.labelDate ? dateField(document, point.label) : element(document, "span", point.label), periodTimes(document, point.start, point.end, point.labelDate === "day" || point.labelDate === "month"),
    numericText(document, observation(point.value, options.unit, point.lowerBound, options.calibrationStatus)), tokenList(document, point.tokens, options.subsets), typeof point.note === "object" ? point.note : evidenceText(document, point.note ?? "")]);
  const tooltipRows = options.points.map((point, i) => [(rows[i]![0] as HTMLElement).textContent, (rows[i]![1] as HTMLElement).textContent,
    observation(point.value, options.unit, point.lowerBound, options.calibrationStatus), tokenObservation(point.tokens, options.subsets), (rows[i]![4] as HTMLElement).textContent]);
  const compact = options.points.length < 3;
  const svgNode = <K extends keyof SVGElementTagNameMap>(tag: K) => document.createElementNS("http://www.w3.org/2000/svg", tag);
  const svg = svgNode("svg"); svg.setAttribute("width", "100%"); svg.setAttribute("height", compact ? "96" : "160"); svg.setAttribute("role", "img");
  // Only the baseline plot scales. Point glyphs and text use CSS pixels.
  const plot = svgNode("svg"); plot.setAttribute("viewBox", "0 0 600 160"); plot.setAttribute("width", "100%"); plot.setAttribute("height", compact ? "76" : "140"); plot.setAttribute("aria-hidden", "true"); plot.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-label", options.title); svg.setAttribute("class", compact ? "observation-chart compact-chart" : "observation-chart");
  const title = svgNode("title"); title.textContent = options.title; svg.append(title);
  const valid = options.points.filter(point => point.value !== null && Number.isFinite(point.value));
  const minimum = Math.min(0, ...valid.map(point => point.value!)), maximum = Math.max(0, ...valid.map(point => point.value!));
  const span = maximum - minimum || 1;
  if (options.unit === "gap-aic") {
    const zero = svgNode("line"), y = String(125 - ((0 - minimum) / span) * 100);
    zero.setAttribute("x1", "24"); zero.setAttribute("x2", "574"); zero.setAttribute("y1", y); zero.setAttribute("y2", y);
    zero.setAttribute("class", "chart-zero-line"); zero.setAttribute("vector-effect", "non-scaling-stroke"); plot.append(zero);
  }
  const start = Math.min(...options.points.map(point => point.start)), end = Math.max(...options.points.map(point => point.end));
  svg.append(plot);
  options.points.forEach((point, i) => {
    const group = svgNode("g"), tooltip = svgNode("title"); tooltip.textContent = tooltipRows[i]!.join(" · "); group.append(tooltip);
    if (point.value !== null && Number.isFinite(point.value)) {
      const dot = svgNode("circle");
      dot.setAttribute("cx", `${(24 + ((point.start - start) / (end - start || 1)) * 550) / 6}%`);
      dot.setAttribute("cy", String((125 - ((point.value - minimum) / span) * 100) * (compact ? 76 : 140) / 160)); dot.setAttribute("r", "3.5");
      dot.setAttribute("class", "chart-dot"); group.append(dot);
    }
    svg.append(group);
  });
  const label = element(document, "p", undefined, "chart-summary");
  const extreme = (value: number) => observation(value, options.unit, valid.some(point => point.value === value && point.lowerBound), options.calibrationStatus);
  const gapLabel = `Gap: counter minus ${options.gapBasis ?? "published"}`;
  if (options.unit === "gap-aic") label.append(element(document, "span", `${gapLabel} · `));
  if (valid.length) label.append(periodTimes(document, start, end, options.points.every(point => point.labelDate === "day" || point.labelDate === "month")), numericText(document, ` · ${extreme(Math.min(...valid.map(point => point.value!)))} minimum · ${extreme(Math.max(...valid.map(point => point.value!)))} maximum`));
  else label.append(element(document, "span", "No recorded values in this period"));
  svg.setAttribute("aria-label", `${options.title} · ${label.textContent}`);
  const region = tableRegion(document, renderTable(document, { caption: options.unit === "gap-aic" ? `${options.title} · ${gapLabel}` : options.title, columns: ["Observation", "UTC period", options.unit === "gap-aic" ? gapLabel : "Value", "Tokens (subsets not additive)", "Evidence"], rows }));
  region.hidden = true;
  label.id = `${region.id}-summary`; svg.setAttribute("aria-describedby", label.id);
  const graphic = element(document, "div"); graphic.id = `${region.id}-chart`; graphic.append(svg, label);
  const select = (table: boolean) => {
    region.hidden = !table; graphic.hidden = table;
    chartButton.setAttribute("aria-pressed", String(!table));
    tableButton.setAttribute("aria-pressed", String(table));
  };
  const chartButton = action(document, "Chart", () => { select(false); selectRepresentation(document, chartId, "chart"); });
  const tableButton = action(document, "Table", () => { select(true); selectRepresentation(document, chartId, "table"); });
  chartButton.setAttribute("aria-controls", graphic.id); tableButton.setAttribute("aria-controls", region.id);
  const group = element(document, "div", undefined, "view-actions"); group.setAttribute("role", "group"); group.setAttribute("aria-label", "Chart representation"); group.append(chartButton, tableButton);
  select(representation(document, chartId) === "table");
  section.append(group, graphic, region); return section;
}

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
