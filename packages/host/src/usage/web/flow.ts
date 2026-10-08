import type { FlowData, FlowRole, Unit, Value } from "../dashboard-v4-contract.js";
import { chartPair } from "./charts.js";
import { renderTable } from "./tables.js";
import { formatValue } from "./format.js";
import { renderModelMarker } from "./model-style.js";
const names: Record<FlowRole, string> = { own: "Own calls", workers: "Workers", reviewers: "Reviewers", scouts: "Scouts", "other-runs": "Other runs", compaction: "Compaction", background: "Background" };
const roleTokens: Record<FlowRole, string> = { own: "own", workers: "workers", reviewers: "reviewers", scouts: "others", "other-runs": "others", compaction: "others", background: "others" };
export function renderFlow(document: Document, flow: FlowData, unit: Unit, id: string): HTMLElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 1000 500"); svg.setAttribute("class", "flow-svg"); svg.setAttribute("role", "group");
  const amount = (v: Value) => unit === "credits" ? v.credits : v.tokens.total;
  const edges = flow.edges.filter(e => (amount(e.value) ?? 0) > 0 || e.value.calls > 0);
  const roles = [...new Set(edges.map(e => e.role))]; const models = flow.models.filter(m => edges.some(e => e.model === m.id));
  const share = (n: number) => new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 }).format(n);
  const text = (x: number, y: number, label: string, anchor: string = "start", numeric = false) => { const node = document.createElementNS("http://www.w3.org/2000/svg", "text"); node.setAttribute("x", String(x)); node.setAttribute("y", String(y)); node.setAttribute("text-anchor", anchor); if (numeric) node.setAttribute("class", "numeric"); node.textContent = label; svg.append(node); };
  const roleY = (role: FlowRole) => 35 + roles.indexOf(role) * (410 / Math.max(roles.length, 1));
  const modelY = (model: string) => 35 + models.findIndex(m => m.id === model) * (410 / Math.max(models.length, 1));
  const total = amount(flow.total) ?? 0;
  for (const edge of edges) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "path"), title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    const y1 = roleY(edge.role), y2 = modelY(edge.model);
    line.setAttribute("d", `M200 ${y1}C450 ${y1} 550 ${y2} 800 ${y2}`); line.setAttribute("fill", "none"); const color = models.find(model => model.id === edge.model)?.style.color ?? "#c4b7a8"; line.setAttribute("stroke", /^#[0-9a-f]{6}$/i.test(color) ? color : "currentColor"); line.setAttribute("stroke-width", String(Math.max(2, Math.min(32, (amount(edge.value) ?? 0) / (total || 1) * 100)))); line.setAttribute("stroke-opacity", ".82");
    line.setAttribute("tabindex", "0"); title.textContent = `${names[edge.role]} to ${edge.model}: ${formatValue(edge.value, unit)} ${unit} · ${share(edge.share)}`; line.setAttribute("aria-label", title.textContent); line.append(title); svg.append(line);
  }
  for (const role of roles) {
    const rows = edges.filter(e => e.role === role), credits = rows.some(e => e.value.credits === null) ? null : rows.reduce((n, e) => n + e.value.credits!, 0), tokens = rows.reduce((n, e) => n + e.value.tokens.total, 0);
    const value = { ...rows[0]!.value, credits, tokens: { ...rows[0]!.value.tokens, total: tokens } };
    const station = document.createElementNS("http://www.w3.org/2000/svg", "rect"); station.setAttribute("x", "192"); station.setAttribute("y", String(roleY(role) - 16)); station.setAttribute("width", "8"); station.setAttribute("height", "32"); station.setAttribute("rx", "4"); station.setAttribute("fill", `var(--usage-role-${roleTokens[role]})`); svg.append(station);
    text(0, roleY(role), names[role]); text(0, roleY(role) + 24, `${formatValue(value, unit)} · ${share(rows.reduce((n, e) => n + e.share, 0))}`, "start", true);
  }
  for (const model of models) {
    const marker = renderModelMarker(document, model.style).children[0]!; marker.setAttribute("data-model-node", model.id); marker.setAttribute("x", "792"); marker.setAttribute("y", String(modelY(model.id) - 8)); marker.setAttribute("width", "16"); marker.setAttribute("height", "16"); svg.append(marker);
    text(1000, modelY(model.id), model.id, "end", true); text(1000, modelY(model.id) + 24, `${formatValue(model.value, unit)} · ${share(model.share)}`, "end", true);
  }
  const table = renderTable(document, { caption: "Where it went", columns: ["Role", "Model", unit === "credits" ? "Credits" : "Tokens", "Share"], rows: edges.map(edge => [names[edge.role], edge.model, formatValue(edge.value, unit), share(edge.share)]) });
  return chartPair(document, { id, title: "Where it went", svg, table });
}
