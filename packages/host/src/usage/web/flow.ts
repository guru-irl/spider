import type { FlowData, FlowRole, Unit, Value } from "../dashboard-v4-contract.js";
import { chartPair } from "./charts.js";
import { renderTable } from "./tables.js";
import { formatValue } from "./format.js";
const names: Record<FlowRole, string> = { own: "Own calls", workers: "Workers", reviewers: "Reviewers", scouts: "Scouts", "other-runs": "Other runs", compaction: "Compaction", background: "Background" };
const roleTokens: Record<FlowRole, string> = { own: "own", workers: "workers", reviewers: "reviewers", scouts: "others", "other-runs": "others", compaction: "others", background: "others" };
export function renderFlow(document: Document, flow: FlowData, unit: Unit, id: string): HTMLElement {
  const ns = "http://www.w3.org/2000/svg";
  const node = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] => {
    const n = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, String(value)); if (text !== undefined) n.textContent = text; return n;
  };
  const svg = node("svg", { class: "flow-svg", role: "group" });
  const amount = (v: Value) => unit === "credits" ? v.credits : v.tokens.total;
  const edges = flow.edges.filter(e => (amount(e.value) ?? 0) > 0 || e.value.calls > 0);
  const roles = (Object.keys(names) as FlowRole[]).filter(role => edges.some(e => e.role === role));
  const models = [...flow.models.filter(m => edges.some(e => e.model === m.id))];
  for (const id of [...new Set(edges.map(e => e.model))].sort()) if (!models.some(m => m.id === id)) {
    const rows = edges.filter(e => e.model === id), value = rows[0]!.value;
    models.push({ id, value: { ...value, credits: rows.some(e => e.value.credits === null) ? null : rows.reduce((n, e) => n + e.value.credits!, 0), tokens: { ...value.tokens, total: rows.reduce((n, e) => n + e.value.tokens.total, 0) } }, share: rows.reduce((n, e) => n + e.share, 0), note: "", style: { color: "#c4b7a8", shape: "circle" } });
  }
  const ordered = [...edges].sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role) || models.findIndex(m => m.id === a.model) - models.findIndex(m => m.id === b.model));
  const total = edges.reduce((n, e) => n + (amount(e.value) ?? 0), 0), scale = total > 0 ? 300 / total : 0;
  // Only nonzero tiny flows receive a visibility floor. Node heights sum those
  // exact displayed widths, so the floor cannot create gaps or lose throughput.
  const widths = new Map(ordered.map(e => [e, (amount(e.value) ?? 0) > 0 ? Math.max(.75, (amount(e.value) ?? 0) * scale) : 0]));
  type Station = { y: number; height: number; cursor: number };
  function stations(keys: readonly string[], matches: (key: string, e: typeof edges[number]) => boolean): Map<string, Station> {
    let y = 12; const result = new Map<string, Station>();
    for (const key of keys) {
      const height = ordered.filter(e => matches(key, e)).reduce((n, e) => n + widths.get(e)!, 0), span = Math.max(48, height), top = y + (span - height) / 2;
      result.set(key, { y: top, height, cursor: top }); y += span + 24;
    }
    return result;
  }
  const left = stations(roles, (key, e) => e.role === key), right = stations(models.map(m => m.id), (key, e) => e.model === key);
  const bottom = (nodes: Map<string, Station>) => Math.max(0, ...[...nodes.values()].map(n => n.y + n.height / 2 + Math.max(48, n.height) / 2));
  const height = Math.max(bottom(left), bottom(right)) + 12;
  const width = 1010 + Math.max(96, ...models.map(m => m.id.length * 8)) + 16;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const share = (n: number) => new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 }).format(n);
  const text = (x: number, y: number, label: string, anchor = "start", numeric = false) => svg.append(node("text", { x, y, "text-anchor": anchor, ...(numeric ? { class: "numeric" } : {}) }, label));
  const color = (model: string) => { const value = models.find(m => m.id === model)?.style.color ?? "#c4b7a8"; return /^#[0-9a-f]{6}$/i.test(value) ? value : "currentColor"; };
  for (const edge of ordered) {
    const source = left.get(edge.role)!, target = right.get(edge.model)!, w = widths.get(edge)!;
    const y1 = source.cursor + w / 2, y2 = target.cursor + w / 2; source.cursor += w; target.cursor += w;
    const line = node("path", { d: `M128 ${y1}C450 ${y1} 650 ${y2} 980 ${y2}`, fill: "none", stroke: color(edge.model), "stroke-width": w, "stroke-opacity": "1", tabindex: 0, "data-flow-role": edge.role, "data-flow-model": edge.model });
    const title = `${names[edge.role]} to ${edge.model}: ${formatValue(edge.value, unit)} ${unit} · ${share(edge.share)}`;
    line.setAttribute("aria-label", title); line.append(node("title", {}, title)); svg.append(line);
  }
  for (const role of roles) {
    const rows = edges.filter(e => e.role === role), credits = rows.some(e => e.value.credits === null) ? null : rows.reduce((n, e) => n + e.value.credits!, 0), tokens = rows.reduce((n, e) => n + e.value.tokens.total, 0);
    const value = { ...rows[0]!.value, credits, tokens: { ...rows[0]!.value.tokens, total: tokens } }, station = left.get(role)!, centre = station.y + station.height / 2;
    svg.append(node("rect", { x: 120, y: station.y, width: 8, height: station.height, rx: Math.min(4, station.height / 2), fill: `var(--usage-role-${roleTokens[role]})`, "data-role-node": role }));
    text(108, centre - 5, names[role], "end"); text(108, centre + 15, `${formatValue(value, unit)} · ${share(rows.reduce((n, e) => n + e.share, 0))}`, "end", true);
  }
  for (const model of models) {
    const station = right.get(model.id)!, centre = station.y + station.height / 2;
    svg.append(node("rect", { x: 980, y: station.y, width: 8, height: station.height, rx: Math.min(4, station.height / 2), fill: color(model.id), "data-model-node": model.id }));
    text(1010, centre - 5, model.id, "start", true); text(1010, centre + 15, `${formatValue(model.value, unit)} · ${share(model.share)}`, "start", true);
  }
  // Preserve the table's wire order and values, independently of ribbon stacking.
  const table = renderTable(document, { caption: "Where it went", columns: ["Role", "Model", unit === "credits" ? "Credits" : "Tokens", "Share"], rows: edges.map(edge => [names[edge.role], edge.model, formatValue(edge.value, unit), share(edge.share)]) });
  return chartPair(document, { id, title: "Where it went", svg, table });
}
