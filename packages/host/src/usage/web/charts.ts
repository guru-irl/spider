import type { TokenTotals } from "../dashboard-contract.js";
import { action, element } from "./dom.js";
import { formatCount, formatTokens, tokenObservation, tokenList, periodTimes, numericText } from "./format.js";
import { renderTable, tableRegion } from "./tables.js";
export type ChartUnit = "estimated-aic" | "calibrated-aic" | "back-applied-aic" | "gap-aic" | "tokens" | "percent" | "ratio";
export type ChartPoint = { start: number; end: number; label: string; value: number | null; tokens: TokenTotals | null; lowerBound?: boolean; note?: string };
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
function observation(value: number | null, unit: ChartUnit, lowerBound = false): string {
  if (value === null || !Number.isFinite(value)) return "unavailable";
  if (unit === "gap-aic") {
    const rounded = Math.round(Math.abs(value)) * Math.sign(value);
    return `${rounded > 0 ? "+" : ""}${formatTokens(rounded === 0 ? 0 : rounded)}${lowerBound ? "+" : ""} AIC`;
  }
  if (unit === "tokens") return formatCount(value, "token");
  if (unit === "percent") return `~${decimal.format(value)}%`;
  if (unit === "ratio") return `~${decimal.format(value)} ratio`;
  if (unit === "back-applied-aic") return `${formatTokens(value)}${lowerBound ? "+" : ""} AIC calibrated, back-applied`;
  return unit === "calibrated-aic" ? `${formatTokens(value)}${lowerBound ? "+" : ""} AIC calibrated` : `~${formatTokens(value)}${lowerBound ? "+" : ""} AIC published estimate`;
}
export function chartWithTable(document: Document, options: { title: string; points: readonly ChartPoint[]; unit: ChartUnit; gapBasis?: "published" | "calibrated" | "back-applied"; subsets?: "listed" | "recorded" }): HTMLElement {
  const section = element(document, "section", undefined, "chart-panel");
  section.append(element(document, "h3", options.title));
  const rows = options.points.map(point => [point.label, periodTimes(document, point.start, point.end),
    numericText(document, observation(point.value, options.unit, point.lowerBound)), tokenList(document, point.tokens, options.subsets), point.note ?? ""]);
  const tooltipRows = options.points.map((point, i) => [point.label, (rows[i]![1] as HTMLElement).textContent,
    observation(point.value, options.unit, point.lowerBound), tokenObservation(point.tokens, options.subsets), point.note ?? ""]);
  const compact = options.points.length < 3;
  const svgNode = <K extends keyof SVGElementTagNameMap>(tag: K) => document.createElementNS("http://www.w3.org/2000/svg", tag);
  const svg = svgNode("svg"); svg.setAttribute("width", "100%"); svg.setAttribute("height", compact ? "96" : "160"); svg.setAttribute("role", "img");
  // Only the glyph-free plot scales. Text stays in the outer CSS-pixel viewport.
  const plot = svgNode("svg"); plot.setAttribute("viewBox", "0 0 600 160"); plot.setAttribute("width", "100%"); plot.setAttribute("height", compact ? "76" : "140"); plot.setAttribute("aria-hidden", "true");
  svg.setAttribute("aria-label", options.title); svg.setAttribute("class", compact ? "observation-chart compact-chart" : "observation-chart");
  const title = svgNode("title"); title.textContent = options.title; svg.append(title);
  const valid = options.points.filter(point => point.value !== null && Number.isFinite(point.value));
  const minimum = Math.min(0, ...valid.map(point => point.value!)), maximum = Math.max(0, ...valid.map(point => point.value!));
  const span = maximum - minimum || 1;
  if (options.unit === "gap-aic") {
    const zero = svgNode("line"), y = String(125 - ((0 - minimum) / span) * 100);
    zero.setAttribute("x1", "24"); zero.setAttribute("x2", "574"); zero.setAttribute("y1", y); zero.setAttribute("y2", y);
    zero.setAttribute("class", "chart-zero-line"); plot.append(zero);
  }
  const start = Math.min(...options.points.map(point => point.start)), end = Math.max(...options.points.map(point => point.end));
  options.points.forEach((point, i) => {
    const group = svgNode("g"), tooltip = svgNode("title"); tooltip.textContent = tooltipRows[i]!.join(" · "); group.append(tooltip);
    if (point.value !== null && Number.isFinite(point.value)) {
      const dot = svgNode("circle");
      dot.setAttribute("cx", String(24 + ((point.start - start) / (end - start || 1)) * 550));
      dot.setAttribute("cy", String(125 - ((point.value - minimum) / span) * 100)); dot.setAttribute("r", "3");
      dot.setAttribute("class", "chart-dot"); group.append(dot);
    }
    plot.append(group);
  });
  svg.append(plot);
  const label = element(document, "p", undefined, "chart-summary");
  const extreme = (value: number) => observation(value, options.unit, valid.some(point => point.value === value && point.lowerBound));
  const range = options.points.length === 1 ? options.points[0]!.label : `${options.points[0]?.label} to ${options.points.at(-1)?.label}`;
  label.textContent = valid.length ? `${range} · ${extreme(Math.min(...valid.map(point => point.value!)))} minimum · ${extreme(Math.max(...valid.map(point => point.value!)))} maximum` : "No recorded values in this period";
  const gapLabel = `Gap: counter minus ${options.gapBasis ?? "published"}`;
  if (options.unit === "gap-aic") label.textContent = `${gapLabel} · ${label.textContent}`;
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
  const chartButton = action(document, "Chart", () => select(false));
  const tableButton = action(document, "Table", () => select(true));
  chartButton.setAttribute("aria-controls", graphic.id); tableButton.setAttribute("aria-controls", region.id);
  const group = element(document, "div", undefined, "view-actions"); group.setAttribute("role", "group"); group.setAttribute("aria-label", "Chart representation"); group.append(chartButton, tableButton);
  select(false);
  section.append(group, graphic, region); return section;
}
