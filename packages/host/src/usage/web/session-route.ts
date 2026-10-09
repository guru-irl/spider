import type { Period } from "../dashboard-contract.js";
import type { SessionData, SessionRun, Unit } from "../dashboard-v4-contract.js";
import { niceAxis } from "./charts.js";
import { modelShape } from "./model-style.js";
import { element } from "./dom.js";
import { formatValue, formatTokens, formatLocalTime } from "./format.js";

export type RouteLayout = {
  branches: readonly { runId: string | null; side: -1 | 1; height: number; startX: number; endX: number }[];
  breaks: readonly { period: Period; startX: number; width: number }[];
  maxValue: number;
};
const NS = "http://www.w3.org/2000/svg", BASE = 214, EXTENT = 156, LEFT = 78, RIGHT = 28;
const amount = (r: SessionRun, unit: Unit) => (unit === "credits" ? r.value.credits : r.value.tokens.total) ?? 0;
export function formatDuration(ms: number | null): string {
  if (ms === null) return "unavailable";
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.round(ms / 60000); return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
function geometry(data: SessionData, unit: Unit, requestedWidth: number) {
  const span = data.span;
  const sorted = [...data.runs].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || (a.id ?? a.name).localeCompare(b.id ?? b.name));
  const runs = sorted.filter(r => span && r.start !== null && (r.end !== null || r.status === "running"));
  const periods: Period[] = data.idleGaps.filter(g => g.end - g.start > 1800000).map(g => ({ start: g.start, end: g.end }));
  if (span && data.activePeriods.length) {
    let end = span.start;
    for (const p of [...data.activePeriods].sort((a, b) => a.start - b.start)) {
      if (p.start - end > 1800000) periods.push({ start: end, end: p.start });
      end = Math.max(end, p.end);
    }
    if (span.end - end > 1800000) periods.push({ start: end, end: span.end });
  }
  const candidates: Period[] = [];
  if (span) for (const p of periods.sort((a, b) => a.start - b.start)) {
    const q = { start: Math.max(p.start, span.start), end: Math.min(p.end, span.end) };
    if (q.end <= q.start) continue;
    const last = candidates.at(-1); if (last && q.start <= last.end) last.end = Math.max(last.end, q.end); else candidates.push(q);
  }
  // Own-call idle does not imply worker idle. A run keeps its full time width,
  // and only inactive remnants longer than thirty minutes can become breaks.
  const collapsed: Period[] = [];
  for (const p of candidates) {
    let start = p.start;
    for (const run of runs) {
      const end = run.status === "running" ? span!.end : run.end!;
      if (end <= start) continue;
      if (run.start! >= p.end) break;
      if (run.start! - start > 1800000) collapsed.push({ start, end: run.start! });
      start = Math.max(start, end);
      if (start >= p.end) break;
    }
    if (p.end - start > 1800000) collapsed.push({ start, end: p.end });
  }
  // Many breaks may require horizontal scrolling, never shrinking a 28px break.
  const width = Math.max(Number.isFinite(requestedWidth) ? requestedWidth : 1200, LEFT + RIGHT + collapsed.length * 28 + 100);
  const duration = span ? Math.max(0, span.end - span.start) : 0;
  const active = duration - collapsed.reduce((sum, p) => sum + p.end - p.start, 0);
  const scale = active > 0 ? (width - LEFT - RIGHT - 28 * collapsed.length) / active : 0;
  const x = (ts: number) => {
    if (!span) return LEFT;
    const t = Math.max(span.start, Math.min(ts, span.end)); let removed = 0, fixed = 0;
    for (const p of collapsed) {
      if (t <= p.start) break;
      const part = Math.min(t, p.end) - p.start; removed += part; fixed += 28 * part / (p.end - p.start);
    }
    return LEFT + (t - span.start - removed) * scale + fixed;
  };
  const maxValue = Math.max(0, ...runs.map(r => amount(r, unit)));
  const placed: { start: number; end: number; side: -1 | 1 }[] = [];
  const branches = runs.map(r => {
    const start = r.start!, end = r.status === "running" ? span!.end : r.end!;
    const penalty = (side: -1 | 1) => placed.reduce((sum, p) => sum + (p.side === side ? Math.max(0, Math.min(end, p.end) - Math.max(start, p.start)) : 0), 0);
    const above = penalty(-1), below = penalty(1);
    const side: -1 | 1 = above === below ? (placed.length % 2 ? 1 : -1) : above < below ? -1 : 1;
    placed.push({ start, end, side });
    return { runId: r.id, side, height: maxValue > 0 ? amount(r, unit) / niceAxis(maxValue).ceiling * EXTENT : 0, startX: x(start), endX: x(end) };
  });
  const layout: RouteLayout = { branches, breaks: collapsed.map(period => ({ period, startX: x(period.start), width: 28 })), maxValue };
  return { layout, runs, x, width };
}
export function layoutSessionRoute(data: SessionData, unit: Unit, width: number): RouteLayout { return geometry(data, unit, width).layout; }
const controls = new WeakMap<HTMLElement, { pin(id: string | null): void; dispose(): void }>();
export function pinSessionRun(route: HTMLElement, id: string | null): void { controls.get(route)?.pin(id); }
export function disposeSessionRoute(route: HTMLElement): void { controls.get(route)?.dispose(); controls.delete(route); }
export function renderSessionRoute(document: Document, data: SessionData, unit: Unit, selectRun: (id: string | null) => void, tz: string = Intl.DateTimeFormat().resolvedOptions().timeZone, leaveRoute?: () => void): HTMLElement {
  const box = element(document, "div", undefined, "route-box"), svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "session-route"); svg.setAttribute("role", "group"); svg.setAttribute("aria-label", "Session route. Arrows move between runs and events; Tab leaves the route; Enter pins a run; Escape clears.");
  const card = element(document, "div", undefined, "route-card"); card.setAttribute("role", "status"); card.setAttribute("aria-live", "polite"); card.hidden = true; const cardFrame = document.createElementNS(NS, "foreignObject"); cardFrame.setAttribute("width", "310"); cardFrame.setAttribute("height", "300"); cardFrame.append(card); box.append(svg);
  let routeWidth = 1200;
  let pinned: string | null = null, hover: SessionRun | null = null, focused: SessionRun | null = null, dismissed = false;
  let groups: { node: SVGGElement; run: SessionRun; branch: RouteLayout["branches"][number] }[] = [], observer: ResizeObserver | undefined;
  let stops: { node: SVGElement; key: string }[] = [], rovingKey: string | undefined;
  const node = <K extends keyof SVGElementTagNameMap>(parent: SVGElement, tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] => {
    const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (text !== undefined) n.textContent = text; parent.append(n); return n;
  };
  const field = (list: HTMLElement, label: string, value: string) => list.append(element(document, "dt", label), element(document, "dd", value, "mono"));
  const sync = () => {
    const run = dismissed ? null : data.runs.find(r => r.id !== null && r.id === pinned) ?? hover ?? focused;
    for (const g of groups) { g.node.setAttribute("class", `run-route${run && g.run !== run ? " is-dim" : run === g.run ? " is-active" : ""}`); g.node.setAttribute("aria-pressed", String(g.run.id !== null && g.run.id === pinned)); }
    card.hidden = !run;
    if (run) {
      const dl = element(document, "dl"); field(dl, "Role", run.role); field(dl, "Thinking", run.thinking ?? "unavailable"); field(dl, "Credits", formatValue(run.value, "credits")); field(dl, "Tokens", formatTokens(run.value.tokens.total)); field(dl, "Duration", formatDuration(run.durationMs)); field(dl, "Status", run.status ?? "unavailable");
      card.replaceChildren(element(document, "h3", run.name), element(document, "p", run.model ?? "unavailable", "card-model mono"), dl);
      const branch = groups.find(g => g.run === run)?.branch;
      if (branch) {
        const width = 310, height = document.defaultView ? card.getBoundingClientRect().height || 270 : 270;
        const apex = (branch.startX + branch.endX) / 2, apexY = BASE + branch.side * branch.height;
        const clampX = (x: number) => Math.max(0, Math.min(routeWidth - width, x)), clampY = (y: number) => Math.max(0, Math.min(430 - height, y));
        const candidates = [apex + 18, apex - width - 18].flatMap(x => [apexY + 12, apexY - height - 12].map(y => ({ x: clampX(x), y: clampY(y) })));
        const score = (p: { x: number; y: number }) => groups.filter(g => g.run !== run).reduce((n, g) => {
          const b = g.branch, top = Math.min(BASE, BASE + b.side * b.height), bottom = Math.max(BASE, BASE + b.side * b.height);
          return n + (p.x < b.endX && p.x + width > b.startX && p.y < bottom && p.y + height > top ? 10000 : 0);
        }, 0) + Math.abs(p.x - apex) + Math.abs(p.y - apexY);
        const position = candidates.sort((a, b) => score(a) - score(b))[0]!;
        cardFrame.setAttribute("x", String(position.x)); cardFrame.setAttribute("y", String(position.y)); cardFrame.setAttribute("height", String(height + 1));
      }
    }
  };
  const pin = (id: string | null) => { pinned = id; dismissed = id === null; selectRun(id); sync(); };
  const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); pin(null); } };
  box.addEventListener("keydown", escape);
  const enroll = (target: SVGElement, key: string) => {
    target.setAttribute("data-route-key", key); target.setAttribute("tabindex", "-1"); stops.push({ node: target, key });
    const activate = () => { rovingKey = key; for (const stop of stops) stop.node.setAttribute("tabindex", stop.node === target ? "0" : "-1"); };
    target.addEventListener("focus", activate);
    target.addEventListener("keydown", event => {
      if (event.key === "Tab" && !event.shiftKey && leaveRoute) { event.preventDefault(); leaveRoute(); }
      else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const index = stops.findIndex(stop => stop.node === target), step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        const next = event.key === "Home" ? 0 : event.key === "End" ? stops.length - 1 : (index + step + stops.length) % stops.length;
        const stop = stops[next]!; rovingKey = stop.key;
        for (const entry of stops) entry.node.setAttribute("tabindex", entry === stop ? "0" : "-1");
        stop.node.focus();
      } else escape(event);
    });
  };
  const eventCard = (target: SVGGElement, key: string, title: string, rows: readonly (readonly [string, string])[]) => {
    enroll(target, key);
    const show = () => { if (pinned !== null) return; hover = focused = null; dismissed = false; sync(); const dl = element(document, "dl"); rows.forEach(([k, v]) => field(dl, k, v)); card.replaceChildren(element(document, "h3", title), dl); card.hidden = false; };
    target.addEventListener("pointerenter", show); target.addEventListener("focus", show);
    target.addEventListener("pointerleave", sync); target.addEventListener("blur", sync);
  };
  const draw = (width: number) => {
    const remembered = stops.find(stop => stop.node === document.activeElement)?.key, wasDismissed = dismissed;
    const { layout, runs, x, width: effectiveWidth } = geometry(data, unit, width); groups = []; stops = []; svg.removeAttribute("tabindex"); svg.replaceChildren(); routeWidth = effectiveWidth; svg.setAttribute("viewBox", `0 0 ${effectiveWidth} 430`); svg.setAttribute("width", String(effectiveWidth)); svg.setAttribute("height", "430"); svg.setAttribute("preserveAspectRatio", "none");
    node(svg, "text", { x: 0, y: 20, class: "axis-title" }, `${unit === "credits" ? "Credits" : "Tokens"} per run`);
    const axis = niceAxis(layout.maxValue), ticks = Math.round(axis.ceiling / axis.step);
    for (let i = 1; i <= ticks && layout.maxValue > 0; i++) for (const side of [-1, 1]) {
      const y = BASE + side * EXTENT * i / ticks; node(svg, "line", { x1: LEFT, x2: effectiveWidth - RIGHT, y1: y, y2: y, class: "route-grid" });
      node(svg, "text", { x: LEFT - 14, y: y + 4, "text-anchor": "end", class: "numeric" }, new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 }).format(axis.step * i));
    }
    node(svg, "text", { x: LEFT - 14, y: BASE + 4, "text-anchor": "end", class: "numeric" }, "0");
    if (data.span) {
      const times = [data.span.start, ...data.activePeriods.flatMap(p => [p.start, p.end]).filter(ts => ts > data.span!.start && ts < data.span!.end), data.span.end];
      const labelWidth = (label: SVGTextElement) => {
        const measured = typeof label.getComputedTextLength === "function" ? label.getComputedTextLength() : 0;
        // Detached SVGs (and structure-only DOM fixtures) have no font metrics yet.
        return measured > 0 ? measured : (label.textContent?.length ?? 0) * 8;
      };
      const endAt = x(data.span.end), endLabel = node(svg, "text", { x: endAt, y: 418, class: "numeric", "text-anchor": "end", "data-time-tick": data.span.end }, formatLocalTime(data.span.end, tz));
      const endLeft = endAt - labelWidth(endLabel); endLabel.remove();
      let lastRight = -Infinity;
      for (const ts of [...new Set(times)].sort((a, b) => a - b)) {
        const end = ts === data.span.end, start = ts === data.span.start, at = x(ts);
        const label = end ? endLabel : node(svg, "text", { x: at, y: 418, class: "numeric", "text-anchor": start ? "start" : "middle", "data-time-tick": ts }, formatLocalTime(ts, tz));
        const width = labelWidth(label), left = at - (end ? width : start ? 0 : width / 2), right = left + width;
        if (!start && !end && (left < lastRight + 8 || right > endLeft - 8)) { label.remove(); continue; }
        if (end) svg.append(label);
        node(svg, "line", { x1: at, x2: at, y1: 391, y2: 396, class: "route-grid" }); lastRight = right;
      }
      node(svg, "line", { x1: LEFT, x2: effectiveWidth - RIGHT, y1: BASE, y2: BASE, class: "own-baseline" });
      for (const [index, bin] of data.ownCallBins.entries()) {
        const g = node(svg, "g", { tabindex: 0, role: "img", "data-event": "own", "aria-label": `Own calls: ${formatValue(bin.value, unit)} ${unit}` });
        node(g, "line", { x1: x(bin.start), x2: x(bin.end), y1: BASE, y2: BASE, class: "own-bin" });
        eventCard(g, `own-${index}`, "Own calls", [["Credits", formatValue(bin.value, "credits")], ["Tokens", formatTokens(bin.value.tokens.total)], ["Calls", formatTokens(bin.value.calls)]]);
      }
      for (const b of layout.breaks) {
        node(svg, "path", { d: `M${b.startX} ${BASE - 5}l5 10 5 -10 5 10 5 -10 8 5`, class: "idle-break" });
        const g = node(svg, "g", { tabindex: 0, role: "img", "aria-label": `Idle break, ${formatDuration(b.period.end - b.period.start)}`, "data-event": "break" });
        node(g, "line", { x1: b.startX, x2: b.startX + 28, y1: BASE, y2: BASE, class: "route-hit" }); eventCard(g, `break-${b.period.start}`, "Idle break", [["Duration", formatDuration(b.period.end - b.period.start)]]);
      }
    }
    runs.forEach((run, index) => {
      const b = layout.branches[index]!, y = BASE + b.side * b.height;
      // Small 45 degree chamfers around vertical legs retain time endpoints even
      // when a short run is more expensive than a long one.
      const j = Math.max(0, Math.min(7, b.height / 2, (b.endX - b.startX) / 4));
      const d = `M${b.startX} ${BASE}l${j} ${b.side * j}V${y - b.side * j}l${j} ${b.side * j}H${b.endX - 2 * j}l${j} ${-b.side * j}V${BASE + b.side * j}L${b.endX} ${BASE}`;
      const g = node(svg, "g", { class: "run-route", tabindex: 0, role: "button", "data-run-id": run.id ?? "", "data-credits": run.value.credits ?? "unavailable", "data-tokens": run.value.tokens.total, "data-height": b.height, "data-side": b.side, "aria-pressed": "false", "aria-label": `${run.role}, ${run.name}, ${formatValue(run.value, unit)} ${unit}, ${run.status ?? "unavailable"}. Enter pins.` });
      const color = run.style && /^#[0-9a-f]{6}$/i.test(run.style.color) ? run.style.color : "var(--usage-muted)";
      node(g, "path", { d, class: "route-casing" }); node(g, "path", { d, class: "route-ink", stroke: color, "stroke-dasharray": run.style && modelShape(run.style.shape) === "square" ? "7 3" : run.style && modelShape(run.style.shape) === "diamond" ? "3 3" : run.style && modelShape(run.style.shape) === "triangle" ? "9 3 2 3" : "none" });
      const markerX = (b.startX + b.endX) / 2, shape = run.style ? modelShape(run.style.shape) : undefined;
      if (shape === "circle") node(g, "circle", { cx: markerX, cy: y, r: 3, fill: color, "data-model-marker": shape });
      else if (shape) node(g, "path", { d: shape === "diamond" ? `M${markerX} ${y - 4}l4 4-4 4-4-4Z` : shape === "square" ? `M${markerX - 3} ${y - 3}h6v6h-6Z` : `M${markerX} ${y - 4}l4 7h-8Z`, fill: color, "data-model-marker": shape });
      const mark = { "data-status-mark": run.status ?? "unavailable", class: `route-status${run.status === "failed" ? " danger" : ""}` };
      if (run.status === "completed") node(g, "circle", { ...mark, cx: b.endX, cy: BASE, r: 4, fill: "var(--usage-ground)" });
      else if (run.status === "running") node(g, "path", { ...mark, d: `M${b.endX + 3} ${BASE - 3}a4 4 0 1 0 0 6`, fill: "var(--usage-ground)" });
      else if (run.status === "cancelled" || run.status === "failed") node(g, "path", { ...mark, d: `M${b.endX - 4} ${BASE - 4}l8 8m0-8-8 8` });
      else node(g, "path", { ...mark, d: `M${b.endX} ${BASE - 4}l4 4-4 4-4-4Z`, "stroke-dasharray": "2 2" });
      node(g, "path", { d, class: "route-hit" }); groups.push({ node: g, run, branch: b });
      enroll(g, `run-${run.id ?? index}`);
      g.addEventListener("pointerenter", () => { dismissed = false; hover = run; sync(); }); g.addEventListener("pointerleave", () => { hover = null; sync(); });
      g.addEventListener("focus", () => { dismissed = false; focused = run; sync(); }); g.addEventListener("blur", () => { focused = null; sync(); });
      g.addEventListener("click", () => { g.focus(); pin(run.id); });
      g.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pin(run.id); }
      });
    });
    for (const [index, c] of data.compaction.entries()) {
      const g = node(svg, "g", { tabindex: 0, role: "img", "data-event": "compaction", "aria-label": `Compaction, ${formatValue(c.value, unit)} ${unit}` }); node(g, "line", { x1: x(c.ts), x2: x(c.ts), y1: BASE - 7, y2: BASE + 7, class: "compaction-tick" }); eventCard(g, `compaction-${index}`, "Compaction", [["Credits", formatValue(c.value, "credits")], ["Tokens", formatTokens(c.value.tokens.total)]]);
    }
    for (const [index, gap] of data.idleGaps.entries()) {
      if (gap.end - gap.start <= 300000 || x(gap.end) - x(gap.start) < 2) continue;
      const g = node(svg, "g", { tabindex: 0, role: "img", "data-event": "idle", "aria-label": `Own-call idle gap, ${formatDuration(gap.end - gap.start)}` }); node(g, "line", { x1: x(gap.start), x2: x(gap.end), y1: BASE, y2: BASE, class: "idle-dotted" }); node(g, "line", { x1: x(gap.start), x2: x(gap.end), y1: BASE, y2: BASE, class: "route-hit" }); eventCard(g, `idle-${index}`, "Idle gap", [["Duration", formatDuration(gap.end - gap.start)], ["Next call cache-write credits", formatValue({ ...data.total, credits: gap.cacheWriteCredits }, "credits")]]);
    }
    // Keep the existing run-first arrow order, then reach all remaining events.
    stops.sort((a, b) => Number(b.node.hasAttribute("data-run-id")) - Number(a.node.hasAttribute("data-run-id")));
    if (!stops.length) {
      const empty = node(svg, "g", { role: "img", "data-event": "route", "aria-label": "Session baseline" });
      node(empty, "line", { x1: LEFT, x2: effectiveWidth - RIGHT, y1: BASE, y2: BASE, class: "own-baseline" }); enroll(empty, "route");
    }
    const current = stops.find(stop => stop.key === rovingKey) ?? stops[0]!; rovingKey = current.key;
    for (const stop of stops) stop.node.setAttribute("tabindex", stop === current ? "0" : "-1");
    svg.append(cardFrame); cardFrame.setAttribute("x", String(Math.max(0, routeWidth - 334))); cardFrame.setAttribute("y", "32");
    dismissed = wasDismissed; sync();
    if (remembered !== undefined) stops.find(stop => stop.key === remembered)?.node.focus();
    dismissed = wasDismissed; if (wasDismissed) sync();
  };
  draw(1200);
  if (typeof ResizeObserver !== "undefined") { observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width; if (width && width > 0) draw(width); }); observer.observe(box); }
  controls.set(box, { pin, dispose() { observer?.disconnect(); box.removeEventListener("keydown", escape); card.hidden = true; } }); return box;
}
