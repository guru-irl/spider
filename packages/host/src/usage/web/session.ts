import "./session.css";
import type { DashboardPage, DashboardPageMount, DashboardPageContext, SessionData, SessionRun, Unit } from "../dashboard-v4-contract.js";
import { action, element, sectionState } from "./dom.js";
import { supportedDetailId } from "./detail-id.js";
import { canRetry, errorCopy, DashboardClientError } from "./client.js";
import { formatLocalTime, formatValue, formatTokens } from "./format.js";
import { renderTable, tableRegion } from "./tables.js";
import { chartPair } from "./charts.js";
import { renderFlow } from "./flow.js";
import { renderModelMarker } from "./model-style.js";
import { disposeSessionRoute, formatDuration, pinSessionRun, renderSessionRoute } from "./session-route.js";

export function mountSession(ctx: DashboardPageContext): DashboardPage {
  const { document, root } = ctx, route = ctx.route;
  root.className = `${root.className} session-page`.trim();
  let unit: Unit = route.page === "session" ? route.unit : "credits", data: SessionData | undefined;
  let disposed = false, generation = 0, controller: AbortController | undefined, graphic: HTMLElement | undefined, pinned: string | null = null;
  let expanded = false, sort = "Start", descending = false;
  const id = route.page === "session" ? route.id : "", tz = route.page === "session" ? route.tz : "UTC";
  const valid = supportedDetailId(id);
  const back = () => {
    const b = action(document, "", ctx.back); b.className = "back"; b.setAttribute("aria-label", "Back");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS("http://www.w3.org/2000/svg", "path"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); path.setAttribute("d", "m10 5-7 7 7 7M3 12h18"); svg.append(path); b.append(svg, element(document, "span", "Back")); return b;
  };
  const state = (kind: "loading" | "empty" | "error", text: string, retry?: () => void) => { disposeGraphic(); sectionState(root, kind, text, retry); const notice = Array.from(root.children); root.replaceChildren(back(), ...notice); };
  const notFound = () => state("empty", "Session not found");
  const disposeGraphic = () => { if (graphic) disposeSessionRoute(graphic); graphic = undefined; };
  const chip = (label: string, value: string) => { const c = element(document, "span", undefined, "stat-chip"); c.append(element(document, "span", label), element(document, "strong", value, "mono")); return c; };
  const status = (run: SessionRun) => element(document, "span", run.status ?? "unavailable", `state-pill${run.status === "failed" ? " danger" : ""}`);
  const runCells = (run: SessionRun, interactive: boolean) => {
    const name = interactive ? action(document, run.name, () => pinSessionRun(graphic!, run.id)) : element(document, "span", run.name);
    const model = element(document, "span", undefined, "run-model mono"); if (run.style) model.append(renderModelMarker(document, run.style)); model.append(element(document, "span", run.model ?? "unavailable"));
    return [run.start === null ? "unavailable" : formatLocalTime(run.start, tz), name, run.role, model, run.thinking ?? "unavailable", formatValue(run.value, "credits"), formatTokens(run.value.tokens.total), formatDuration(run.durationMs), status(run)];
  };
  const columns = ["Start", "Name", "Role", "Model", "Thinking", "Credits", "Tokens", "Duration", "Status"];
  let runRows: HTMLTableRowElement[] = [], runsSection: HTMLElement | undefined;
  const sortButtons = new Map<string, HTMLButtonElement>(), unitButtons = new Map<Unit, HTMLButtonElement>();
  const select = (id: string | null) => {
    pinned = id;
    if (id !== null && runsSection && !expanded && data?.runs.some(r => r.id === id) && !runRows.some(row => row.getAttribute("data-run-row") === id)) { expanded = true; drawRuns(runsSection); }
    for (const row of runRows) { const selected = id !== null && row.getAttribute("data-run-row") === id; row.setAttribute("aria-selected", String(selected)); row.className = selected ? "selected" : ""; }
  };
  const compare = (a: SessionRun, b: SessionRun) => {
    const key = (r: SessionRun): string | number | null => sort === "Start" ? r.start : sort === "Credits" ? r.value.credits : sort === "Tokens" ? r.value.tokens.total : sort === "Duration" ? r.durationMs : sort === "Name" ? r.name : sort === "Role" ? r.role : sort === "Model" ? r.model : sort === "Thinking" ? r.thinking : r.status;
    const x = key(a), y = key(b); if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y)); return (descending ? -order : order) || (a.id ?? a.name).localeCompare(b.id ?? b.name);
  };
  const drawRuns = (section: HTMLElement) => {
    section.replaceChildren(); const head = element(document, "div", undefined, "section-head"); head.append(element(document, "h2", "Subagent runs")); section.append(head);
    if (!data!.runs.length) { section.append(element(document, "p", "No subagent runs", "notice")); runRows = []; return; }
    const summary = element(document, "div", undefined, "summary-chips"); summary.append(chip("Runs", formatTokens(data!.runs.length))); section.append(summary);
    const all = [...data!.runs].sort(compare), visible = expanded ? all : all.slice(0, 20);
    const table = renderTable(document, { caption: "Subagent runs", columns, rows: visible.map(r => runCells(r, true)) }); table.className += " runs-table";
    const header = table.querySelector("thead")!.firstElementChild!;
    Array.from(header.children).forEach((cell, i) => {
      const label = columns[i]!; const b = action(document, label, () => { if (sort === label) descending = !descending; else { sort = label; descending = label === "Credits" || label === "Tokens" || label === "Duration"; } drawRuns(section); sortButtons.get(label)?.focus(); }); b.className = "sort"; sortButtons.set(label, b);
      cell.replaceChildren(b); cell.setAttribute("aria-sort", sort === label ? descending ? "descending" : "ascending" : "none");
    });
    runRows = Array.from(table.querySelector("tbody")!.children) as HTMLTableRowElement[];
    runRows.forEach((row, i) => {
      const run = visible[i]!; row.setAttribute("data-run-row", run.id ?? ""); row.setAttribute("aria-selected", "false"); row.setAttribute("tabindex", "0");
      row.addEventListener("click", () => pinSessionRun(graphic!, run.id));
      row.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pinSessionRun(graphic!, run.id); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); runRows[(i + (event.key === "ArrowDown" ? 1 : -1) + runRows.length) % runRows.length]!.focus(); }
      });
    });
    select(pinned); section.append(tableRegion(document, table));
    if (!expanded && all.length > 20) section.append(action(document, `Show all ${all.length}`, () => { expanded = true; drawRuns(section); runRows[20]?.focus(); }));
  };
  function render(): void {
    if (!data || disposed || ctx.signal.aborted) return;
    const focusedRun = document.activeElement?.getAttribute("data-run-id"), focusedRow = document.activeElement?.getAttribute("data-run-row");
    const dismissedCard = graphic?.lastElementChild && (graphic.lastElementChild as HTMLElement).hidden;
    disposeGraphic(); root.setAttribute("aria-busy", "false");
    const header = element(document, "section", undefined, "session-header"), head = element(document, "div", undefined, "section-head"), units = element(document, "div", undefined, "segmented"); units.setAttribute("role", "group"); units.setAttribute("aria-label", "Unit");
    for (const value of ["credits", "tokens"] as const) { const b = action(document, value === "credits" ? "Credits" : "Tokens", () => { if (unit === value) return; unit = value; ctx.navigate({ page: "session", id, unit, tz }, { replace: true }); render(); unitButtons.get(unit)?.focus(); }); b.setAttribute("aria-pressed", String(unit === value)); unitButtons.set(value, b); units.append(b); }
    head.append(element(document, "h1", data.name), units); header.append(head);
    const chips = element(document, "div", undefined, "session-chips");
    if (data.project) {
      const project = element(document, "span", undefined, "fact-chip project-chip"), folder = document.createElementNS("http://www.w3.org/2000/svg", "svg"), path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      folder.setAttribute("viewBox", "0 0 24 24"); folder.setAttribute("aria-hidden", "true"); path.setAttribute("d", "M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"); folder.append(path); project.append(folder, element(document, "span", "Project"), element(document, "strong", data.project)); chips.append(project);
    }
    if (data.span) chips.append(element(document, "span", `${formatLocalTime(data.span.start, tz)} to ${formatLocalTime(data.span.end, tz)} ${tz}`, "fact-chip mono")); header.append(chips);
    const stats = element(document, "div", undefined, "session-stats");
    for (const [label, value, suffix] of [["Total", formatValue(data.total, unit), unit], ["Subagent runs", formatTokens(data.stats.runs), "runs"], ["Own calls", formatTokens(data.stats.ownCalls), "calls"], ["Compaction", formatTokens(data.stats.compaction), "events"], ["Idle gaps", formatTokens(data.stats.idleGaps), "gaps"]]) {
      const stat = element(document, "div", undefined, "header-stat"), number = element(document, "strong", value, "mono"); if (label === "Total") number.setAttribute("data-session-total", ""); stat.append(element(document, "span", label), number, element(document, "small", suffix)); stats.append(stat);
    }
    header.append(stats); root.replaceChildren(back(), header);
    if (!data.span) { root.append(element(document, "p", "No calls were recorded.", "notice")); return; }
    const routeSection = element(document, "section", undefined, "session-route-section");
    graphic = renderSessionRoute(document, data, unit, select, tz, data.runs.length ? () => runRows[0]?.focus() : undefined);
    const svg = graphic.firstElementChild as SVGElement;
    const table = renderTable(document, { caption: "Session route data", columns, rows: [
      ...data.runs.map(r => runCells(r, false)),
      ...data.ownCallBins.map(bin => [formatLocalTime(bin.start, tz), "Own calls", "own", "unavailable", "unavailable", formatValue(bin.value, "credits"), formatTokens(bin.value.tokens.total), formatDuration(bin.end - bin.start), "unavailable"]),
      ...data.compaction.map(event => [formatLocalTime(event.ts, tz), "Compaction", "compaction", "unavailable", "unavailable", formatValue(event.value, "credits"), formatTokens(event.value.tokens.total), "unavailable", "unavailable"]),
      ...data.idleGaps.map(gap => {
        const credits = element(document, "div", undefined, "idle-cache-credit");
        credits.append(element(document, "span", formatValue({ ...data!.total, credits: gap.cacheWriteCredits }, "credits"), "mono"), element(document, "small", "Next call cache-write credits", "muted"));
        return [formatLocalTime(gap.start, tz), "Idle gap", "idle gap", "unavailable", "unavailable", credits, "unavailable", formatDuration(gap.end - gap.start), "unavailable"];
      }),
    ] });
    const totalRow = element(document, "tr"); totalRow.append(element(document, "td", "Total"), element(document, "td", data.name), element(document, "td", "All roles"), element(document, "td", "All models"), element(document, "td", ""), element(document, "td", formatValue(data.total, "credits")), element(document, "td", formatTokens(data.total.tokens.total)), element(document, "td", formatDuration(data.span.end - data.span.start)), element(document, "td", "")); table.querySelector("tbody")!.append(totalRow);
    const pair = chartPair(document, { id: `session-route-${id}`, title: "Session route", svg, table });
    // The shared pair accepts SVG, while the route also owns its live hover card.
    const chart = Array.from(pair.children).find(n => n.className === "chart-graphic")!; graphic.replaceChildren(svg, ...Array.from(graphic.children)); chart.replaceChildren(graphic);
    const summary = element(document, "div", undefined, "summary-chips"); summary.append(chip("Subagent runs", formatTokens(data.stats.runs)), chip("Span", formatDuration(data.span.end - data.span.start)));
    pair.replaceChildren(pair.firstElementChild!, summary, ...Array.from(pair.children).slice(1)); routeSection.append(pair);
    const legend = element(document, "div", undefined, "session-legend");
    for (const m of data.models) { const key = element(document, "span", undefined, "fact-chip"); key.append(renderModelMarker(document, m.style), element(document, "span", m.id, "mono")); legend.append(key); } routeSection.append(legend); root.append(routeSection);
    const flow = element(document, "section", undefined, "session-flow-section"); const unitFlow = unit === "credits" ? data.flow : { ...data.flow,
      edges: data.flow.edges.map(e => ({ ...e, share: data!.flow.total.tokens.total > 0 ? e.value.tokens.total / data!.flow.total.tokens.total : 0 })),
      models: data.flow.models.map(m => ({ ...m, share: data!.flow.total.tokens.total > 0 ? m.value.tokens.total / data!.flow.total.tokens.total : 0 })),
    }; flow.append(renderFlow(document, unitFlow, unit, `session-flow-${id}`)); root.append(flow);
    const runs = element(document, "section", undefined, "session-runs-section"); root.append(runs); runsSection = runs; drawRuns(runs);
    const models = element(document, "section", undefined, "session-models-section"); models.append(element(document, "h2", "Models in this session"));
    const modelTable = renderTable(document, { caption: "Models in this session", columns: ["Model", "Calls", "Credits", "Tokens", "Share"], rows: data.models.map(m => { const name = element(document, "span", undefined, "run-model mono"); name.append(renderModelMarker(document, m.style), element(document, "span", m.id)); return [name, formatTokens(m.value.calls), formatValue(m.value, "credits"), formatTokens(m.value.tokens.total), `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format((unit === "tokens" ? data!.total.tokens.total > 0 ? m.value.tokens.total / data!.total.tokens.total : 0 : m.share) * 100)}%`]; }) }); models.append(tableRegion(document, modelTable)); root.append(models);
    if (pinned) pinSessionRun(graphic, pinned);
    if (focusedRun) {
      const target = Array.from(graphic.firstElementChild!.children).find(n => n.getAttribute("data-run-id") === focusedRun) as SVGElement | undefined;
      if (target) { target.focus(); if (dismissedCard && pinned === null) pinSessionRun(graphic, null); } else (root.firstElementChild as HTMLElement).focus();
    } else if (focusedRow) (runRows.find(row => row.getAttribute("data-run-row") === focusedRow) ?? root.firstElementChild as HTMLElement).focus();
  }
  async function refresh(): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    if (!valid) { notFound(); return; }
    const gen = ++generation; controller?.abort(); controller = new AbortController(); if (!data) state("loading", "Loading session");
    try {
      const reply = await ctx.client.get<SessionData>(`/api/session/${encodeURIComponent(id)}`, new URLSearchParams({ tz }), controller.signal);
      if (disposed || gen !== generation || ctx.signal.aborted || controller.signal.aborted) return;
      data = reply.data; if (pinned !== null && !data.runs.some(run => run.id === pinned)) pinned = null; render();
    } catch (error) {
      if (disposed || gen !== generation || ctx.signal.aborted || controller.signal.aborted) return;
      if (error instanceof DashboardClientError && error.code === "not-found") notFound(); else state("error", errorCopy(error), canRetry(error) ? () => { void refresh(); } : undefined);
    }
  }
  const abort = () => { controller?.abort(); disposeGraphic(); };
  const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && graphic) pinSessionRun(graphic, null); };
  ctx.signal.addEventListener("abort", abort, { once: true }); root.addEventListener("keydown", escape);
  void refresh();
  return { refresh, dispose() { disposed = true; ++generation; abort(); root.className = root.className.split(" ").filter(name => name !== "session-page").join(" "); ctx.signal.removeEventListener("abort", abort); root.removeEventListener("keydown", escape); } };
}
export const pageMount: DashboardPageMount = mountSession;
export const page = "session";
