import "./overview.css";
import type { DashboardPage, DashboardPageContext, OverviewDataV4, RangeQuery, Role, SessionRow, SessionsData, SessionSort, Unit, Value } from "../dashboard-v4-contract.js";
import { action, element, sectionState } from "./dom.js";
import { chartPair } from "./charts.js";
import { renderTable } from "./tables.js";
import { renderModelMarker } from "./model-style.js";
import { renderFlow } from "./flow.js";
import { representation } from "./representation.js";
import { formatLocalTime, formatValue } from "./format.js";
import { canRetry, errorCopy } from "./client.js";
import { renderPace, disposePace } from "./pace.js";
const NS = "http://www.w3.org/2000/svg", DAY = 86400000;
const observedModelColors = new WeakMap<Document, Map<string, string>>();
const roleNames: Record<Role, string> = { own: "Own calls", workers: "Workers", reviewers: "Reviewers", others: "Others" };
const roles: Role[] = ["own", "workers", "reviewers", "others"];
const percent = (n: number) => new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(n);
const amount = (value: Value, unit: Unit) => unit === "credits" ? value.credits : value.tokens.total;
/** Round the axis step upward to 1, 2 or 5 times a power of ten. */
function niceAxis(maximum: number): { step: number; ceiling: number } {
  const magnitude = 10 ** Math.floor(Math.log10(maximum / 3));
  const normalized = maximum / 3 / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  return { step, ceiling: Math.ceil(maximum / step) * step };
}
function params(query: RangeQuery): URLSearchParams {
  return new URLSearchParams({ range: query.range, from: String(query.from), to: String(query.to), tz: query.tz, unit: query.unit, buckets: JSON.stringify(query.buckets) });
}
function nodes(root: Element): Element[] { return [root, ...Array.from(root.children).flatMap(nodes)]; }
function localInput(ts: number): string {
  const d = new Date(ts), pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** Offset-bearing accessible labels distinguish both occurrences of a repeated local hour. */
function bucketLabel(ts: number, tz: string, hourly: boolean): string {
  const label = formatLocalTime(ts, tz);
  if (!hourly) return label.slice(0, -6);
  let offset: string;
  try { offset = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(ts).find(p => p.type === "timeZoneName")!.value.replace("GMT", "UTC"); } catch { offset = "UTC"; }
  return `${label} ${offset === "UTC" ? "UTC+00:00" : offset}`;
}
export function mountOverview(ctx: DashboardPageContext): DashboardPage {
  const { document, root } = ctx;
  const originalClass = root.className; root.className = `${originalClass} overview-page`.trim();
  const modelColors = observedModelColors.get(document) ?? new Map<string, string>(); observedModelColors.set(document, modelColors);
  let query = structuredClone(ctx.route.page === "overview" ? ctx.route.query : ctx.overview);
  let data: OverviewDataV4 | undefined, revision = "", sessionData: SessionsData | undefined;
  let disposed = false, generation = 0, sessionsGeneration = 0, controller: AbortController | undefined, sessionsController: AbortController | undefined;
  let paceNode: HTMLElement | undefined, sort: SessionSort = "credits", roving = 0;
  let customOpen = query.range === "custom", fromInput = localInput(query.from), toInput = localInput(query.to), rangeError = "";
  let loading: Promise<void> | undefined;
  const focusKey = () => document.activeElement?.getAttribute("data-focus");
  const restoreFocus = (key: string | null | undefined) => { if (key) (nodes(root).find(n => n.getAttribute("data-focus") === key) as HTMLElement | undefined)?.focus(); };
  const keyed = <T extends Element>(node: T, key: string): T => { node.setAttribute("data-focus", key); return node; };
  const svgNode = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] => {
    const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (text !== undefined) n.textContent = text; return n;
  };
  function chip(label: string, value: string): HTMLElement { const n = element(document, "span", undefined, "stat-chip"); n.append(element(document, "span", label), element(document, "strong", value, "mono")); return n; }
  function panel(id: string, title: string, svg: SVGElement, table: HTMLTableElement, summary?: HTMLElement): HTMLElement {
    const section = element(document, "section", undefined, "overview-panel"); section.setAttribute("data-panel", id);
    const pair = chartPair(document, { id: `overview-${id}`, title, svg, table });
    const children = Array.from(pair.children) as HTMLElement[];
    const buttons = nodes(children[0]!).filter(n => n.tagName.toLowerCase() === "button"); buttons.forEach((n, i) => keyed(n, `${id}-view-${i}`));
    if (summary) pair.replaceChildren(children[0]!, summary, ...children.slice(1));
    section.append(pair); return section;
  }
  function emptyPanel(id: string, title: string, text: string): HTMLElement {
    const section = element(document, "section", undefined, "overview-panel"); section.setAttribute("data-panel", id); section.append(element(document, "h2", title));
    const body = element(document, "div"); sectionState(body, "empty", text); section.append(body); return section;
  }
  function navigate(next: RangeQuery): void { ctx.navigate({ page: "overview", query: next }); }
  function select(key: number): void {
    query = { ...query, buckets: query.buckets.includes(key) ? query.buckets.filter(k => k !== key) : [...query.buckets, key].sort((a, b) => a - b) };
    ctx.navigate({ page: "overview", query }, { replace: true }); void refresh();
  }
  function clearSelection(): void { if (query.buckets.length) { query = { ...query, buckets: [] }; ctx.navigate({ page: "overview", query }, { replace: true }); void refresh(); } }
  function controls(): HTMLElement {
    const toolbar = element(document, "div", undefined, "overview-toolbar"); toolbar.setAttribute("data-controls", "true"); toolbar.setAttribute("aria-label", "Usage filters");
    const presets = element(document, "div", undefined, "segmented presets"); presets.setAttribute("role", "group"); presets.setAttribute("aria-label", "Time range");
    for (const [range, label] of [["24h", "24 h"], ["7d", "7 days"], ["30d", "30 days"], ["month", "This month"], ["custom", "Custom"]] as const) {
      const b = keyed(action(document, label, () => {
        if (range === "custom") { customOpen = true; paint(); return; }
        const now = ctx.now(), local = new Date(now); navigate({ ...query, range, from: range === "month" ? new Date(local.getFullYear(), local.getMonth(), 1).getTime() : now - (range === "24h" ? 1 : range === "30d" ? 30 : 7) * DAY, to: now, buckets: [] });
      }), `range-${range}`); b.setAttribute("aria-pressed", String(range === query.range)); presets.append(b);
    }
    const units = element(document, "div", undefined, "segmented units"); units.setAttribute("role", "group"); units.setAttribute("aria-label", "Unit");
    for (const unit of ["credits", "tokens"] as const) { const b = keyed(action(document, unit === "credits" ? "Credits" : "Tokens", () => navigate({ ...query, unit })), `unit-${unit}`); b.setAttribute("aria-pressed", String(unit === query.unit)); units.append(b); }
    toolbar.append(presets, units);
    if (customOpen) {
      const custom = element(document, "div", undefined, "overview-custom");
      for (const [label, value, key] of [["From", fromInput, "from"], ["To", toInput, "to"]] as const) {
        const wrap = element(document, "label", label), input = keyed(element(document, "input"), `custom-${key}`); input.type = "datetime-local"; input.value = value;
        input.addEventListener("input", () => { if (key === "from") fromInput = input.value; else toInput = input.value; }); wrap.append(input); custom.append(wrap);
      }
      custom.append(keyed(action(document, "Apply range", () => {
        // datetime-local is intentionally interpreted in the browser's local zone.
        const inputs = nodes(custom).filter(n => n.tagName.toLowerCase() === "input") as HTMLInputElement[];
        fromInput = inputs[0]!.value; toInput = inputs[1]!.value;
        const from = new Date(fromInput).getTime(), to = new Date(toInput).getTime();
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to - from > 93 * DAY) { rangeError = "Choose an ordered range of at most 93 days."; paint(); return; }
        navigate({ ...query, range: "custom", from, to, buckets: [] });
      }), "custom-apply")); const error = element(document, "span", rangeError, "danger"); error.setAttribute("role", "alert"); custom.append(error); toolbar.append(custom);
    }
    return toolbar;
  }
  function daily(d: OverviewDataV4): HTMLElement {
    const title = `${d.bucketSize === "hour" ? "Hourly" : "Daily"} ${query.unit}`;
    if (!d.buckets.length || d.total.calls === 0) return emptyPanel("daily", title, "No calls in this range.");
    const summary = element(document, "div", undefined, "range-summary summary-chips");
    const values = d.buckets.map(b => amount(b.total, query.unit)); const known = values.filter((n): n is number => n !== null);
    const compact = (n: number | null) => n === null ? "unavailable" : new Intl.NumberFormat("en-US", { notation: n >= 1000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n).replace("K", "k");
    const total = amount(d.total, query.unit), average = total === null ? null : total / d.buckets.length;
    const peak = known.length ? Math.max(...known) : null, peakBucket = d.buckets.find(b => amount(b.total, query.unit) === peak);
    summary.append(chip("Total", formatValue(d.total, query.unit)), chip("Average", `${compact(average)} ${d.bucketSize === "hour" ? "an hour" : "a day"}`), chip("Peak", peakBucket ? `${bucketLabel(peakBucket.key, query.tz, d.bucketSize === "hour")} · ${compact(peak)}` : "unavailable"));
    if (query.buckets.length) { const n = element(document, "span", `Selected ${query.buckets.length} ${d.bucketSize === "hour" ? query.buckets.length === 1 ? "hour" : "hours" : query.buckets.length === 1 ? "day" : "days"} · ${formatValue(d.selectedTotal, query.unit)} ${query.unit}`, "selection-chip"); n.setAttribute("role", "status"); n.setAttribute("aria-live", "polite"); summary.append(n); }
    const svg = svgNode("svg", { viewBox: "0 0 900 350", class: "daily-chart", role: "group" });
    const axis = niceAxis(Math.max(1, ...known)), max = axis.ceiling, step = 810 / d.buckets.length;
    svg.append(svgNode("text", { x: 66, y: 30, class: "numeric daily-unit" }, query.unit));
    for (let tick = 0; tick <= Math.round(max / axis.step); tick++) { const value = tick * axis.step, y = 296 - value / max * 240; svg.append(svgNode("path", { d: `M66 ${y}H890`, class: "daily-gridline" }), svgNode("text", { x: 56, y: y + 5, "text-anchor": "end", class: "numeric" }, formatValue({ ...d.total, credits: value, tokens: { ...d.total.tokens, total: value } }, query.unit))); }
    const groups: SVGElement[] = [];
    roving = Math.min(roving, d.buckets.length - 1);
    d.buckets.forEach((bucket, index) => {
      const label = bucketLabel(bucket.key, query.tz, d.bucketSize === "hour"), selected = query.buckets.includes(bucket.key);
      const g = keyed(svgNode("g", { "data-bucket": bucket.key, "data-value": amount(bucket.total, query.unit) ?? "unavailable", role: "button", tabindex: index === roving ? 0 : -1, "aria-pressed": String(selected), "aria-label": `${label}, ${formatValue(bucket.total, query.unit)} ${query.unit}`, "data-dim": String(query.buckets.length > 0 && !selected), "data-selected": String(selected) }), `bucket-${bucket.key}`);
      let y = 296; const x = 72 + index * step, w = Math.max(1, step - Math.min(25, step / 4));
      g.append(svgNode("rect", { x: x - 4, y: 20, width: w + 8, height: 284, class: "bucket-hit" }));
      for (const row of bucket.models) { const n = amount(row.value, query.unit); if (n === null) continue; const height = n / max * 240; y -= height;
        const color = modelColors.get(row.model) ?? "#c4b7a8";
        g.append(svgNode("rect", { x, y, width: w, height, fill: /^#[0-9a-f]{6}$/i.test(color) ? color : "currentColor" }));
      }
      g.append(svgNode("rect", { x: x - 4, y: 20, width: w + 8, height: 284, class: "bucket-focus" }));
      const tooltip = svgNode("title", {}, `${label}\n${bucket.models.map(m => `${m.model}: ${formatValue(m.value, query.unit)} ${query.unit}`).join("\n")}`); g.append(tooltip);
      g.addEventListener("click", e => { const event = e as MouseEvent; if (event.button && event.button !== 0) return; roving = index; groups.forEach((bar, i) => bar.setAttribute("tabindex", i === index ? "0" : "-1")); g.focus(); if (event.metaKey || event.ctrlKey) select(bucket.key); });
      g.addEventListener("keydown", e => { const event = e as KeyboardEvent;
        if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) { event.preventDefault(); roving = event.key === "Home" ? 0 : event.key === "End" ? groups.length - 1 : Math.max(0, Math.min(groups.length - 1, index + (event.key === "ArrowRight" ? 1 : -1))); groups.forEach((bar, i) => bar.setAttribute("tabindex", i === roving ? "0" : "-1")); groups[roving]!.focus(); }
        else if (event.key === " " || event.key === "Spacebar" || event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); roving = index; select(bucket.key); }
      });
      groups.push(g); svg.append(g);
      if (d.buckets.length <= 12 || index % Math.ceil(d.buckets.length / 8) === 0) svg.append(svgNode("text", { x: x + w / 2, y: 329, "text-anchor": "middle", class: "numeric" }, d.bucketSize === "hour" ? formatLocalTime(bucket.key, query.tz).slice(-5) : label));
    });
    const modelIds = [...new Set(d.buckets.flatMap(b => b.models.map(m => m.model)))];
    const table = renderTable(document, { caption: `${title} by model`, columns: ["Bucket", ...modelIds, "Total"], rows: d.buckets.map(bucket => {
      const label = bucketLabel(bucket.key, query.tz, d.bucketSize === "hour"); const toggle = keyed(action(document, label, () => select(bucket.key)), `table-bucket-${bucket.key}`); toggle.setAttribute("data-bucket", String(bucket.key)); toggle.setAttribute("aria-pressed", String(query.buckets.includes(bucket.key)));
      return [toggle, ...modelIds.map(id => { const value = bucket.models.find(m => m.model === id)?.value; return value ? formatValue(value, query.unit) : "0"; }), formatValue(bucket.total, query.unit)];
    }) });
    const section = panel("daily", title, svg, table, summary);
    const instructions = element(document, "p", "Cmd/Ctrl-click to toggle buckets. Arrows move; Space or Cmd/Ctrl+Enter toggles. Escape clears.", "sr-only"); instructions.id = "overview-bucket-help"; svg.setAttribute("aria-describedby", instructions.id); section.append(instructions); return section;
  }
  function models(d: OverviewDataV4): HTMLElement {
    if (!d.models.length) { const empty = emptyPanel("models", "Models", "No calls in this selection."); if (d.unpriced.length) empty.append(element(document, "p", unpriced(d), "models-foot")); return empty; }
    const summary = element(document, "div", undefined, "summary-chips"); summary.append(chip("Models", String(d.models.length)), chip(query.unit === "credits" ? "Credits" : "Tokens", formatValue(d.selectedTotal, query.unit)), chip("Top", `${d.models[0]!.id} · ${percent(d.models[0]!.share)}`));
    const list = element(document, "div", undefined, "model-list");
    for (const [i, model] of d.models.entries()) {
      const row = element(document, "div", undefined, "model-row"); row.append(element(document, "span", String(i + 1), "rank mono"), renderModelMarker(document, model.style), element(document, "span", model.id, "model-name mono"), element(document, "span", formatValue(model.value, query.unit), "model-amount mono"));
      const track = svgNode("svg", { viewBox: "0 0 100 4", preserveAspectRatio: "none", class: "model-share", "aria-hidden": "true" }); track.append(svgNode("rect", { x: 0, y: 0, width: 100, height: 4, class: "model-share-track" }), svgNode("rect", { x: 0, y: 0, width: model.share * 100, height: 4, fill: /^#[0-9a-f]{6}$/i.test(model.style.color) ? model.style.color : "currentColor" }));
      const note = element(document, "div", undefined, "model-note"); note.append(element(document, "span", model.note), element(document, "span", percent(model.share), "mono")); row.append(track, note); list.append(row);
    }
    const table = renderTable(document, { caption: "Models in the selection", columns: ["Model", query.unit === "credits" ? "Credits" : "Tokens", "Share", "Main source"], rows: d.models.map(m => [m.id, formatValue(m.value, query.unit), percent(m.share), m.note]) });
    const section = panel("models", "Models", svgNode("svg"), table, summary), pair = section.children[0]!, graphic = pair.children[2]!; graphic.replaceChildren(list);
    if (d.unpriced.length) section.append(element(document, "p", unpriced(d), "models-foot")); return section;
  }
  function unpriced(d: OverviewDataV4): string { return d.unpriced.map(u => `${u.calls} unpriced ${u.calls === 1 ? "call" : "calls"}: ${u.reason}`).join(" · "); }
  function openSession(row: SessionRow): void { if (row.id) ctx.navigate({ page: "session", id: row.id, unit: query.unit, tz: query.tz }); }
  function sessionName(row: SessionRow, table = false): HTMLElement {
    const n = row.id ? keyed(action(document, row.name, () => openSession(row)), `session-${table ? "table-name" : "name"}-${row.id}`) : element(document, "span", row.name);
    n.className = "session-name"; if (row.project) { const project = element(document, "span", row.project, "project-pill"); const group = element(document, "div", undefined, "session-identity"); group.append(n, project); return group; } return n;
  }
  function breakdown(row: SessionRow, index: number): HTMLElement {
    const stack = element(document, "div", undefined, "role-stack"); stack.setAttribute("role", "group"); stack.setAttribute("aria-label", `${row.name} role breakdown`);
    const width = 420, total = amount(row.value, query.unit); let x = 0;
    // SVG carries the proportional geometry. HTML tooltips remain in the same focus target.
    const svg = svgNode("svg", { viewBox: `0 0 ${width} 32`, preserveAspectRatio: "none", class: "role-stack-svg" });
    for (const split of row.roles) {
      const n = amount(split.value, query.unit), share = total !== null && total > 0 && n !== null ? n / total : split.share;
      if (n === 0 && split.value.calls === 0) continue;
      const w = Math.max(0, share * width), group = keyed(svgNode("g", { tabindex: 0, role: "img", class: "role-segment", "data-role": split.role, "aria-label": `${roleNames[split.role]}, ${formatValue(split.value, "credits")} credits, ${formatValue(split.value, "tokens")} tokens, ${percent(share)}, ${split.runs} runs`, "aria-describedby": `role-tip-${index}-${split.role}` }), `role-${index}-${split.role}`);
      group.append(svgNode("rect", { x, y: 0, width: w, height: 32, fill: `var(--usage-role-${split.role})` }));
      if (share >= .14) group.append(svgNode("text", { x: x + w / 2, y: 21, "text-anchor": "middle", class: "segment-share" }, percent(share)));
      const tip = element(document, "div", undefined, "role-tooltip"); tip.id = `role-tip-${index}-${split.role}`; tip.setAttribute("role", "tooltip"); tip.hidden = true; tip.append(element(document, "h3", roleNames[split.role]), element(document, "p", `${formatValue(split.value, "credits")} credits · ${formatValue(split.value, "tokens")} tokens`, "mono"), element(document, "p", `${percent(share)} · ${split.runs} runs`, "mono"));
      const show = () => { tip.hidden = false; }, hide = () => { tip.hidden = true; };
      group.addEventListener("pointerenter", show); group.addEventListener("pointerleave", hide); group.addEventListener("focus", show); group.addEventListener("blur", hide);
      group.addEventListener("keydown", e => { if ((e as KeyboardEvent).key === "Escape") { e.stopPropagation(); hide(); } });
      svg.append(group); stack.append(tip); x += w;
    }
    stack.append(svg); return stack;
  }
  function sessions(d: SessionsData): HTMLElement {
    if (!d.rows.length) return emptyPanel("sessions", "Sessions", "No sessions in this selection.");
    const summary = element(document, "div", undefined, "sessions-context"); const chips = element(document, "div", undefined, "summary-chips"); chips.append(chip("Sessions", String(d.total)), chip("Subagent runs", String(d.summary.runs)), chip("Top 3 share", percent(d.summary.top3Share)));
    const legend = element(document, "div", undefined, "role-legend"); legend.setAttribute("aria-label", "Session roles");
    for (const role of roles) { const key = element(document, "span", roleNames[role], "role-key"); key.setAttribute("data-role", role); legend.append(key); } summary.append(chips, legend);
    const table = renderTable(document, { caption: "Sessions in the selected range", columns: ["Session", "Last active", "Breakdown", query.unit === "credits" ? "Credits" : "Tokens", "Runs"], rows: d.rows.map((r, i) => [sessionName(r), formatLocalTime(r.lastActive, query.tz), breakdown(r, i), formatValue(r.value, query.unit), String(r.runs)]) }); table.className = "data-table sessions-table";
    const numeric = renderTable(document, { caption: "Exact session role values", columns: ["Session", "Last active", ...roles.map(r => roleNames[r]), query.unit === "credits" ? "Credits" : "Tokens", "Runs"], rows: d.rows.map(r => [sessionName(r, true), formatLocalTime(r.lastActive, query.tz), ...roles.map(role => { const v = r.roles.find(v => v.role === role)?.value; return v ? formatValue(v, query.unit) : "0"; }), formatValue(r.value, query.unit), String(r.runs)]) });
    const section = panel("sessions", "Sessions", svgNode("svg"), numeric, summary);
    const pair = section.children[0]!, graphic = pair.children[2]!; graphic.replaceChildren(table);
    for (const t of [table, numeric]) {
      const body = t.children[2]!; Array.from(body.children).forEach((line, i) => { const row = d.rows[i]!; if (!row.id) return;
        line.setAttribute(t === table ? "data-session" : "data-session-table", row.id); line.setAttribute("tabindex", "0"); keyed(line, `${t === table ? "session-row" : "session-table-row"}-${row.id}`);
        line.addEventListener("click", e => { if (!nodes(line).some(n => n !== line && n.tagName.toLowerCase() === "button" && n.contains(e.target as Node))) openSession(row); });
        line.addEventListener("keydown", e => { if ((e as KeyboardEvent).key === "Enter" && e.target === line) { e.preventDefault(); openSession(row); } });
      });
    }
    const sortControls = element(document, "div", undefined, "session-sort"); sortControls.setAttribute("role", "group"); sortControls.setAttribute("aria-label", "Sort sessions");
    for (const [key, label] of [["credits", query.unit === "credits" ? "Credits" : "Tokens"], ["last-active", "Last active"], ["runs", "Runs"]] as const) { const b = keyed(action(document, label, () => { sort = key; void loadSessions(false); }), `session-sort-${key}`); b.setAttribute("aria-pressed", String(sort === key)); sortControls.append(b); }
    // Sort controls sit beside the heading, not in a second boxed region.
    pair.children[0]!.append(sortControls);
    if (d.nextOffset !== null) section.append(keyed(action(document, `Show all ${d.total}`, () => { void loadSessions(true); }), "sessions-expand"));
    return section;
  }
  function flow(d: OverviewDataV4): HTMLElement {
    if (!d.flow.edges.length) return emptyPanel("flow", "Where it went", "No calls in this selection.");
    const section = element(document, "section", undefined, "overview-panel"); section.setAttribute("data-panel", "flow");
    const pair = renderFlow(document, d.flow, query.unit, "overview-flow"); nodes(pair.children[0]!).filter(n => n.tagName.toLowerCase() === "button").forEach((n, i) => keyed(n, `flow-view-${i}`)); section.append(pair); return section;
  }
  function paint(): void {
    if (disposed || !data) return;
    const key = focusKey(); if (paceNode) disposePace(paceNode);
    paceNode = renderPace(document, data.pace, ctx.now()); keyed(paceNode.children[0]!, "pace");
    const grid = element(document, "div", undefined, "overview-grid"); grid.append(daily(data), models(data));
    root.replaceChildren(paceNode, controls(), grid, sessions(sessionData ?? data.sessions), flow(data)); root.setAttribute("aria-busy", "false"); restoreFocus(key);
  }
  async function loadSessions(expand: boolean): Promise<void> {
    if (!data || disposed) return;
    const gen = ++sessionsGeneration; sessionsController?.abort(); sessionsController = new AbortController(); const signal = sessionsController.signal;
    const expectedRevision = revision, frozen = structuredClone(query); const expectedGeneration = generation;
    let current = sessionData ?? data.sessions, offset = expand ? current.nextOffset : 0;
    let rows = expand ? [...current.rows] : [];
    const previousLength = rows.length, expansionFocused = expand && focusKey() === "sessions-expand";
    const control = nodes(root).find(n => n.getAttribute("data-focus") === (expand ? "sessions-expand" : `session-sort-${sort}`)) as HTMLButtonElement | undefined;
    if (control) { control.disabled = true; control.setAttribute("aria-busy", "true"); }
    try {
      do {
        const p = params({ ...frozen, range: "custom" }); p.set("sort", sort); p.set("offset", String(offset ?? 0)); p.set("limit", expand ? "100" : "10");
        const reply = await ctx.client.get<SessionsData>("/api/sessions", p, signal);
        if (disposed || signal.aborted || gen !== sessionsGeneration || expectedGeneration !== generation) return;
        if (reply.revision !== expectedRevision) { void refresh(); return; }
        rows.push(...reply.data.rows); current = { ...reply.data, rows, offset: 0 }; const next = reply.data.nextOffset;
        if (next !== null && next <= (offset ?? 0)) throw new Error("Invalid sessions page"); offset = next;
      } while (expand && offset !== null);
      sessionData = current; paint();
      if (expansionFocused && focusKey() === null) {
        const firstNew = current.rows.slice(previousLength).find(row => row.id);
        if (firstNew) restoreFocus(`${representation(document, "overview-sessions") === "table" ? "session-table-row" : "session-row"}-${firstNew.id}`);
      }
    } catch (error) {
      if (!disposed && !signal.aborted && gen === sessionsGeneration) {
        const section = nodes(root).find(n => n.getAttribute("data-panel") === "sessions") as HTMLElement | undefined;
        if (section) sectionState(section, "error", errorCopy(error), canRetry(error) ? () => { void loadSessions(expand); } : undefined);
      }
    } finally { if (control) { control.disabled = false; control.setAttribute("aria-busy", "false"); } }
  }
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    const gen = ++generation; ++sessionsGeneration; sessionsController?.abort(); controller?.abort(); controller = new AbortController(); const signal = controller.signal;
    if (!data) sectionState(root, "loading", "Loading usage…"); else root.setAttribute("aria-busy", "true");
    loading = (async () => {
      try {
        const reply = await ctx.client.get<OverviewDataV4>("/api/overview", params(query), signal);
        if (disposed || signal.aborted || gen !== generation) return;
        data = reply.data; for (const model of [...data.models, ...data.flow.models]) modelColors.set(model.id, model.style.color); query = structuredClone(data.range); revision = reply.revision; sessionData = undefined;
        fromInput = localInput(query.from); toInput = localInput(query.to);
        ctx.navigate({ page: "overview", query }, { replace: true }); paint();
        if (sort !== "credits") await loadSessions(false);
      } catch (error) { if (!disposed && !signal.aborted && gen === generation) { if (paceNode) disposePace(paceNode); sectionState(root, "error", errorCopy(error), canRetry(error) ? () => { void refresh(); } : undefined); } }
    })(); return loading;
  }
  const clickAway = (event: Event) => { if (!query.buckets.length || !event.target) return; const target = event.target as Node;
    let ancestor = target as Element | null;
    while (ancestor) {
      if (["button", "input", "select", "a"].includes(ancestor.tagName?.toLowerCase()) || ancestor.hasAttribute?.("data-bucket") || ancestor.hasAttribute?.("data-controls")) return;
      ancestor = ancestor.parentElement;
    }
    clearSelection();
  };
  const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) clearSelection(); };
  document.addEventListener("click", clickAway); document.addEventListener("keydown", escape);
  function dispose(): void { if (disposed) return; disposed = true; ++generation; ++sessionsGeneration; controller?.abort(); sessionsController?.abort(); if (paceNode) disposePace(paceNode); document.removeEventListener("click", clickAway); document.removeEventListener("keydown", escape); ctx.signal.removeEventListener("abort", dispose); root.className = originalClass; }
  ctx.signal.addEventListener("abort", dispose, { once: true }); void refresh();
  return { refresh, dispose };
}
