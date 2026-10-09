import type { FlowData, FlowEdge, FlowRole, Unit, Value } from "../dashboard-v4-contract.js";
import { chartPair } from "./charts.js";
import { renderTable } from "./tables.js";
import { element } from "./dom.js";
import { formatValue } from "./format.js";

const names: Record<FlowRole, string> = { own: "Own calls", workers: "Workers", reviewers: "Reviewers", scouts: "Scouts", "other-runs": "Other runs", compaction: "Compaction", background: "Background" };
const standardRoles: FlowRole[] = ["own", "workers", "reviewers", "scouts", "compaction", "background"];
const roleTokens: Record<FlowRole, string> = { own: "own", workers: "workers", reviewers: "reviewers", scouts: "others", "other-runs": "others", compaction: "others", background: "others" };
const share = (n: number) => new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 }).format(n);

/** Known credits are a lower bound, not unavailable just because another call is unpriced. */
function sumValues(rows: readonly FlowEdge[]): Value {
  const sum = (read: (v: Value) => number) => rows.reduce((n, e) => n + read(e.value), 0);
  const nullable = (read: (v: Value) => number | null) => rows.length && rows.every(e => read(e.value) === null) ? null : sum(v => read(v) ?? 0);
  return {
    credits: nullable(v => v.credits), calls: sum(v => v.calls), unpricedCalls: sum(v => v.unpricedCalls),
    tokens: { input: sum(v => v.tokens.input), output: sum(v => v.tokens.output), cacheRead: sum(v => v.tokens.cacheRead), cacheWrite: sum(v => v.tokens.cacheWrite), cacheWrite1h: nullable(v => v.tokens.cacheWrite1h), reasoning: nullable(v => v.tokens.reasoning), prompt: sum(v => v.tokens.prompt), total: sum(v => v.tokens.total) },
  };
}

export function renderFlow(document: Document, flow: FlowData, unit: Unit, id: string): HTMLElement {
  const ns = "http://www.w3.org/2000/svg";
  const node = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] => {
    const n = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, String(value)); if (text !== undefined) n.textContent = text; return n;
  };
  const svg = node("svg", { class: "flow-svg", role: "group" });
  const amount = (v: Value) => unit === "credits" ? v.credits : v.tokens.total;
  const edges = flow.edges.filter(e => (amount(e.value) ?? 0) > 0 || e.value.calls > 0);
  const roles = [...standardRoles, ...(edges.some(e => e.role === "other-runs") ? ["other-runs" as const] : [])];
  const modelIds = [...flow.models.filter(m => edges.some(e => e.model === m.id)).map(m => m.id)];
  for (const model of [...new Set(edges.map(e => e.model))].sort()) if (!modelIds.includes(model)) modelIds.push(model);
  const models = modelIds.map(model => ({ id: model, style: flow.models.find(m => m.id === model)?.style ?? { color: "#c4b7a8", shape: "circle" } }));
  const ordered = [...edges].sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role) || modelIds.indexOf(a.model) - modelIds.indexOf(b.model));
  const total = amount(sumValues(edges)) ?? 0, scale = total > 0 ? 300 / total : 0;
  // Both endpoints sum the exact same widths, including the floor for tiny nonzero flows.
  const widths = new Map(ordered.map(e => [e, (amount(e.value) ?? 0) > 0 ? Math.max(.75, (amount(e.value) ?? 0) * scale) : 0]));
  type Station = { y: number; height: number; cursor: number; value: Value; share: number };
  function stations(keys: readonly string[], matches: (key: string, e: FlowEdge) => boolean): Map<string, Station> {
    let y = 32; const result = new Map<string, Station>();
    for (const key of keys) {
      const rows = ordered.filter(e => matches(key, e)), height = rows.reduce((n, e) => n + widths.get(e)!, 0), span = Math.max(32, height), top = y + (span - height) / 2;
      result.set(key, { y: top, height, cursor: top, value: sumValues(rows), share: rows.reduce((n, e) => n + e.share, 0) }); y += span + 32;
    }
    return result;
  }
  const left = stations(roles, (key, e) => e.role === key), right = stations(modelIds, (key, e) => e.model === key);
  const valueLine = (station: Station) => `${formatValue(station.value, unit)} · ${share(station.share)}`;
  // Conservative glyph bounds for Fira Sans at 14px, code values at 15px and
  // model ids at 12px. Include the value line, not only the node's name.
  const leftGutter = Math.max(0, ...roles.map(role => Math.max(names[role].length * 9, valueLine(left.get(role)!).length * 10))) + 30;
  const rightGutter = Math.max(0, ...models.map(m => Math.max(m.id.length * 12, valueLine(right.get(m.id)!).length * 10))) + 30;
  const width = Math.max(1200, leftGutter + rightGutter + 400), x1 = leftGutter, x2 = width - rightGutter;
  const bottom = (stations: Map<string, Station>) => Math.max(0, ...[...stations.values()].map(n => n.y + n.height / 2 + Math.max(32, n.height) / 2));
  const height = Math.max(630, bottom(left) + 32, bottom(right) + 32);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const color = (model: string) => { const value = models.find(m => m.id === model)?.style.color ?? "#c4b7a8"; return /^#[0-9a-f]{6}$/i.test(value) ? value : "currentColor"; };
  const tooltip = element(document, "div", undefined, "flow-tooltip"); tooltip.setAttribute("role", "tooltip"); tooltip.id = `${id}-detail`; tooltip.hidden = true;
  // SVG positioning works under the dashboard's CSP, which forbids inline style attributes.
  const frameWidth = Math.min(width - 32, Math.max(330, ...models.map(m => m.id.length * 8 + 34)));
  const frame = node("foreignObject", { class: "flow-tooltip-frame", x: Math.max(16, Math.min(width - frameWidth - 16, (x1 + x2 - frameWidth) / 2)), y: 120, width: frameWidth, height: 220, visibility: "hidden" }); frame.append(tooltip);
  const paths: { edge: FlowEdge; path: SVGPathElement }[] = [];
  const detail = (label: string, value: Value, fraction: number) => `${label}, ${formatValue(value, unit)} ${unit}, ${share(fraction)} of total, ${value.calls} calls${value.unpricedCalls ? `, ${value.unpricedCalls} unpriced calls` : ""}`;
  const hide = () => { tooltip.hidden = true; frame.setAttribute("visibility", "hidden"); paths.forEach(({ path }) => path.setAttribute("opacity", "1")); };
  function interact(target: SVGElement, matches: (edge: FlowEdge) => boolean, label: string, value: Value, fraction: number) {
    target.setAttribute("tabindex", "0"); target.setAttribute("role", "img"); target.setAttribute("aria-label", detail(label, value, fraction)); target.setAttribute("aria-describedby", tooltip.id);
    const show = () => {
      paths.forEach(({ edge, path }) => path.setAttribute("opacity", matches(edge) ? "1" : "0.16"));
      tooltip.replaceChildren(element(document, "strong", label), element(document, "p", `${formatValue(value, unit)} ${unit} · ${share(fraction)} of total`, "mono"), element(document, "p", `${value.calls} calls${value.unpricedCalls ? ` · ${value.unpricedCalls} unpriced calls` : ""}`, "mono"));
      tooltip.hidden = false; frame.setAttribute("visibility", "visible");
    };
    target.addEventListener("pointerenter", show); target.addEventListener("focus", show);
    target.addEventListener("pointerleave", hide); target.addEventListener("blur", hide);
    target.addEventListener("keydown", event => { if ((event as KeyboardEvent).key === "Escape") { event.preventDefault(); hide(); } });
  }
  function label(station: Station, name: string, key: string, isRole: boolean) {
    const centre = station.y + station.height / 2, x = isRole ? x1 - 18 : x2 + 20, anchor = isRole ? "end" : "start";
    const g = node("g", { class: "flow-node", [isRole ? "data-flow-node-role" : "data-flow-node-model"]: key });
    // The labels are part of the pointer target, including nodes with no priced width.
    g.append(node("rect", { class: "flow-node-hit", x: isRole ? 0 : x2, y: Math.max(0, centre - 22), width: isRole ? x1 : rightGutter, height: 44, fill: "transparent" }));
    g.append(node("rect", { x: isRole ? x1 - 8 : x2, y: station.y, width: 8, height: station.height, rx: Math.min(4, station.height / 2), fill: isRole ? `var(--usage-role-${roleTokens[key as FlowRole]})` : color(key), [isRole ? "data-role-node" : "data-model-node"]: key }));
    g.append(node("text", { x, y: centre - 5, "text-anchor": anchor, class: isRole ? "flow-role-label" : "flow-model-label numeric" }, name));
    g.append(node("text", { x, y: centre + 15, "text-anchor": anchor, class: "flow-value numeric" }, valueLine(station)));
    interact(g, edge => isRole ? edge.role === key : edge.model === key, name, station.value, station.share); return g;
  }
  // Tab order follows the chart: left nodes, bands in role/model order, right nodes.
  for (const role of roles) svg.append(label(left.get(role)!, names[role], role, true));
  for (const edge of ordered) {
    const source = left.get(edge.role)!, target = right.get(edge.model)!, w = widths.get(edge)!;
    const a = source.cursor, b = target.cursor, mid = (x1 + x2) / 2; source.cursor += w; target.cursor += w;
    if (!w) continue;
    const path = node("path", { class: "flow-band", d: `M ${x1} ${a} C ${mid} ${a} ${mid} ${b} ${x2} ${b} L ${x2} ${b + w} C ${mid} ${b + w} ${mid} ${a + w} ${x1} ${a + w} Z`, fill: color(edge.model), opacity: 1, "data-flow-role": edge.role, "data-flow-model": edge.model });
    paths.push({ edge, path }); interact(path, e => e === edge, `${names[edge.role]} to ${edge.model}`, edge.value, edge.share); svg.append(path);
  }
  for (const model of models) svg.append(label(right.get(model.id)!, model.id, model.id, false));
  svg.append(frame);
  // Preserve the table's wire order and values, independently of band stacking and node sums.
  const table = renderTable(document, { caption: "Where it went", columns: ["Role", "Model", unit === "credits" ? "Credits" : "Tokens", "Share"], rows: edges.map(edge => [names[edge.role], edge.model, formatValue(edge.value, unit), share(edge.share)]) });
  const pair = chartPair(document, { id, title: "Where it went", svg, table }); pair.className += " flow-panel";
  return pair;
}
