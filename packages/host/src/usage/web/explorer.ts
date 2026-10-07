import type { Dimension, Filter, FilterValue, Page, Period, UsageMeasure } from "../dashboard-contract.js";
import type { ExplorerData, ExplorerRow } from "../query-explorer.js";
import type { ViewContext, MountedView, ViewMount } from "./views.js";
import { action, element, liveMessage, updateEvidence } from "./dom.js";
import { DashboardClientError, errorCopy, canRetry } from "./client.js";
import { formatAicDisplay, formatTokens, tokenObservation, tokenList, tokenCell, datedText, numericText } from "./format.js";
import { renderTable, tableRegion } from "./tables.js";
import { representation, selectRepresentation } from "./representation.js";
import { analysisProse } from "./analysis-shared.js";

// Only presentation state is retained across Explorer remounts, scoped to its document.
const presentation = new WeakMap<Document, { labels: Map<string, string>; unavailable: Set<string>; focus: boolean; notice: string }>();
// Task 6's final contract adds missing selections. Keep this adapter local until that snapshot lands.
export type ExplorerFilter = Filter | { field: Dimension; kind: "missing"; value?: never };
function normalizeFilter(filter: ExplorerFilter | { field: Dimension; value: null; kind?: "raw" | "id" }): ExplorerFilter | undefined {
  if (!filter || !dimensions.includes(filter.field)) return;
  if (filter.kind === "missing") return filter.value === undefined ? { field: filter.field, kind: "missing" } : undefined;
  if (filter.value === null && (filter.kind === "raw" || filter.kind === undefined)) return { field: filter.field, kind: "missing" };
  if (filter.kind === "id" && typeof filter.value === "string" && filter.value.length) return filter;
}
const filterKey = (filter: ExplorerFilter): string => filter.kind === "missing" ? JSON.stringify([filter.field, "missing"]) : JSON.stringify([filter.field, filter.kind ?? "raw", filter.value]);
const uniqueFilters = (filters: readonly ExplorerFilter[]): ExplorerFilter[] => [...new Map(filters.map(filter => [filterKey(filter), filter])).values()];
const dimensionLabels: Record<Dimension, string> = {
  project: "Project", repo: "Repository", session: "Session", actor: "Actor", role: "Role", agent: "Agent", provider: "Provider", model: "Model",
  requestedModel: "Requested model", thinking: "Thinking", run: "Run", runName: "Run name", phase: "Phase", parentRun: "Parent run", auxPurpose: "Auxiliary purpose", api: "API", day: "Day",
};
function labelled(document: Document, text: string, control: HTMLElement): HTMLElement {
  const label = element(document, "label"), line = element(document, "div"); line.append(control);
  label.append(element(document, "span", text, "muted"), line); return label;
}
const dimensions: readonly Dimension[] = ["project", "repo", "session", "actor", "role", "agent", "provider", "model",
  "requestedModel", "thinking", "run", "runName", "phase", "parentRun", "auxPurpose", "api", "day"];
function dimensionControl(document: Document, label: string, optional = false): HTMLSelectElement {
  const select = element(document, "select", undefined, "action"); select.setAttribute("aria-label", label);
  if (optional) { const option = element(document, "option", "No additional group"); option.value = ""; select.append(option); }
  for (const dimension of dimensions) {
    const option = element(document, "option", dimensionLabels[dimension]); option.value = dimension; select.append(option);
  }
  select.value = optional ? "" : "model"; return select;
}
function sliceParams(period: Period, filters: readonly ExplorerFilter[]): URLSearchParams {
  return new URLSearchParams({ start: String(period.start), end: String(period.end), filters: JSON.stringify(filters) });
}
function evidence(measure: UsageMeasure): string {
  return [`${formatTokens(measure.calls)} ${measure.calls === 1 ? "call" : "calls"}; ${formatTokens(measure.unpricedCalls)} unpriced; ${formatTokens(measure.aggregateCalls)} aggregate`,
    measure.possibleOverlap ? "Possible overlap" : "", measure.possibleUndercount ? "Possible undercount" : "", measure.pendingData ? "Pending data" : ""].filter(Boolean).join(" · ");
}
function rowLabel(row: ExplorerRow, i: number): string { return row.labels[i] ?? "No value"; }
function tupleFilters(data: ExplorerData, row: ExplorerRow): ExplorerFilter[] | undefined {
  // A missing key with a non-null label is an unsupported detail id, not SQL NULL.
  if (row.key.some((key, i) => key === null && row.labels[i] !== null)) return undefined;
  return data.groupBy.map((field, i) => row.key[i] === null ? { field, kind: "missing" } : { field, value: row.key[i]!, kind: "id" });
}
function renderPivot(ctx: ViewContext, data: ExplorerData, drill: (row: ExplorerRow) => void): HTMLElement {
  const { document } = ctx, root = element(document, "div", undefined, "overview-evidence");
  const columns = ["Primary AIC (approximate)", "Published estimate", "Tokens (subsets not additive)", "Evidence"];
  const values = (measure: UsageMeasure): string[] => {
    const aic = formatAicDisplay(measure.aicDisplay, measure.unpricedCalls, data.calibration);
    return [aic.primary, aic.secondary, tokenObservation(measure.tokens), evidence(measure)];
  };
  const tableValues = (measure: UsageMeasure): (string | HTMLElement)[] => values(measure).map((value, i) => i === 2 ? tokenCell(document, measure.tokens) : datedText(document, value, text => numericText(document, text)));
  root.append(element(document, "p", "AIC is approximate; tokens are recorded. Pivot cells select the complete tuple, not its labels.", "muted"),
    analysisProse(ctx, formatAicDisplay(data.totals.aicDisplay, data.totals.unpricedCalls, data.calibration).legend, "calibration-evidence"),
    tableRegion(document, renderTable(document, { caption: "Selected usage", columns, rows: [tableValues(data.totals)] })));
  if (!data.rows.length) root.append(element(document, "p", "No rows for this period"));
  const panels = element(document, "div", undefined, "small-multiples");
  for (const basis of ["calibrated", "back-applied", "published"] as const) {
    const rows = data.rows.filter(row => row.measure.aicDisplay.basis === basis); if (!rows.length) continue;
    const titleText = `Pivot rows · ${basis === "back-applied" ? "calibrated, back-applied" : basis}`;
    const panel = element(document, "section", undefined, "chart-panel"); panel.append(element(document, "h3", titleText));
    // Categorical placement uses row order, never fake timestamps or client-side totals.
    const svgNode = <K extends keyof SVGElementTagNameMap>(tag: K) => document.createElementNS("http://www.w3.org/2000/svg", tag);
    const svg = svgNode("svg"); svg.setAttribute("height", String(Math.max(100, rows.length * 28 + 50)));
    svg.setAttribute("role", "img"); svg.setAttribute("aria-label", titleText); svg.setAttribute("class", "pivot-chart");
    const title = svgNode("title"); title.textContent = titleText; svg.append(title);
    const priced = rows.filter(row => row.measure.aicDisplay.primaryAic !== null && Number.isFinite(row.measure.aicDisplay.primaryAic));
    const maximum = Math.max(0, ...priced.map(row => row.measure.aicDisplay.primaryAic!));
    rows.forEach((row, i) => {
      const labels = row.labels.map((_, j) => rowLabel(row, j));
      const group = svgNode("g"), tooltip = svgNode("title"); tooltip.textContent = [...labels, ...values(row.measure)].join(" · "); group.append(tooltip);
      group.setAttribute("aria-hidden", "true");
      const label = svgNode("text"); label.setAttribute("class", "pivot-label"); label.setAttribute("x", "8"); label.setAttribute("y", String(i * 28 + 24));
      const characters = [...labels.join(" · ")];
      if (row.labels.some(label => label === null)) { label.setAttribute("class", "pivot-label missing-value"); label.setAttribute("aria-label", "No value (missing)"); }
      label.textContent = characters.length > 24 ? characters.slice(0, 24).join("") + "…" : characters.join(""); group.append(label);
      const value = row.measure.aicDisplay.primaryAic;
      if (value !== null && Number.isFinite(value)) {
        const dot = svgNode("circle"); dot.setAttribute("cx", `${55 + value / (maximum || 1) * 40}%`);
        dot.setAttribute("cy", String(i * 28 + 20)); dot.setAttribute("r", "3.5"); dot.setAttribute("class", "chart-dot"); group.append(dot);
      }
      svg.append(group);
    });
    // Match the shared chart caption, but keep categorical placement and full tuple evidence.
    const summary = element(document, "p", undefined, "chart-summary");
    const extreme = (value: number): string => {
      const lowerBound = priced.some(row => row.measure.aicDisplay.primaryAic === value && row.measure.unpricedCalls > 0);
      const amount = `${formatTokens(value)}${lowerBound ? "+" : ""} AIC`;
      return basis === "published" ? `~${amount} published estimate` : `${amount} ${basis === "back-applied" ? "calibrated, back-applied" : "calibrated"}`;
    };
    const summaryText = priced.length
      ? `${rows[0]!.labels.map((_, i) => rowLabel(rows[0]!, i)).join(" · ")} to ${rows.at(-1)!.labels.map((_, i) => rowLabel(rows.at(-1)!, i)).join(" · ")} · ${extreme(Math.min(...priced.map(row => row.measure.aicDisplay.primaryAic!)))} minimum · ${extreme(Math.max(...priced.map(row => row.measure.aicDisplay.primaryAic!)))} maximum`
      : "No recorded values in this period";
    summary.append(numericText(document, summaryText));
    svg.setAttribute("aria-label", `${titleText} · ${summary.textContent}`);
    const table = renderTable(document, { caption: titleText, columns: [...data.groupBy.map(field => dimensionLabels[field]), ...columns], rows: rows.map(row => [
      ...row.labels.map((_, i) => {
        const label = rowLabel(row, i);
        const tuple = tupleFilters(data, row);
        const selectable = tuple && uniqueFilters([...(ctx.filters as readonly ExplorerFilter[]).map(normalizeFilter).filter((filter): filter is ExplorerFilter => !!filter), ...tuple]).length <= 16;
        const cell = selectable ? action(document, label, () => drill(row)) : element(document, "span", label);
        if (row.labels[i] === null) { cell.setAttribute("class", `${cell.className} missing-value`.trim()); cell.setAttribute("aria-label", "No value (missing)"); }
        if (selectable) cell.setAttribute("aria-label", `Drill into ${data.groupBy[i]}: ${label}`);
        return cell;
      }), ...tableValues(row.measure),
    ]) });
    const chartId = `chart:explorer:pivot:${basis}`;
    const region = tableRegion(document, table);
    region.hidden = representation(document, chartId) !== "table";
    summary.id = `${region.id}-summary`; svg.setAttribute("aria-describedby", summary.id);
    const graphic = element(document, "div"); graphic.id = `${region.id}-chart`; graphic.append(svg, summary); graphic.hidden = !region.hidden;
    const select = (table: boolean) => {
      region.hidden = !table; graphic.hidden = table;
      chartButton.setAttribute("aria-pressed", String(!table)); tableButton.setAttribute("aria-pressed", String(table));
    };
    const chartButton = action(document, "Chart", () => { select(false); selectRepresentation(document, chartId, "chart"); });
    const tableButton = action(document, "Table", () => { select(true); selectRepresentation(document, chartId, "table"); });
    chartButton.setAttribute("aria-controls", graphic.id); tableButton.setAttribute("aria-controls", region.id);
    const group = element(document, "div", undefined, "view-actions"); group.setAttribute("role", "group"); group.setAttribute("aria-label", "Chart representation"); group.append(chartButton, tableButton);
    select(representation(document, chartId) === "table");
    panel.append(group, graphic, region); panels.append(panel);
  }
  root.append(panels); return root;
}
export async function mountExplorer(ctx: ViewContext): Promise<MountedView> {
  const { document } = ctx;
  const normalized = (ctx.filters as readonly ExplorerFilter[]).map(normalizeFilter);
  const malformed = normalized.some(filter => !filter);
  const filters = uniqueFilters(normalized.filter((filter): filter is ExplorerFilter => !!filter));
  let state = presentation.get(document);
  if (!state) { state = { labels: new Map(), unavailable: new Set(), focus: false, notice: "" }; presentation.set(document, state); }
  const root = element(document, "section", undefined, "usage-explorer overview-evidence"), heading = element(document, "h1", "Explorer");
  heading.setAttribute("tabindex", "-1"); root.append(heading); ctx.root.append(root);
  if (state.focus) { state.focus = false; if (!document.activeElement || document.activeElement === document.body) heading.focus(); }
  const controls = element(document, "div", undefined, "view-actions");
  const field = dimensionControl(document, "Filter field"), prefix = element(document, "input", undefined, "action");
  prefix.type = "search"; prefix.setAttribute("aria-label", "Filter prefix");
  const results = element(document, "div", undefined, "view-actions"), searchMessage = liveMessage(document), searchNotice = liveMessage(document);
  searchMessage.setAttribute("tabindex", "-1"); searchNotice.setAttribute("tabindex", "-1");
  let disposed = false, sequence = 0, timer: ReturnType<typeof setTimeout> | undefined, groupTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingGroup = false, pendingSearch = false;
  let lastActivity = Date.now(), stopped = false, pivotLoading = false, searchLoading = false, paused = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const activity = () => { lastActivity = Date.now(); };
  let searchController: AbortController | undefined, selected: FilterValue | undefined;
  let period = ctx.period, searchPeriod = period;
  const navigate = (filters: readonly ExplorerFilter[]) => {
    if (disposed || ctx.signal.aborted) return;
    state!.focus = true;
    // Only the old ViewRoute type needs bridging; the JSON wire shape already carries missing correctly.
    ctx.navigate({ view: "explorer", filters: uniqueFilters(filters) as readonly Filter[] }); // Omit period: retain rolling or explicit app state.
  };
  const add = action(document, "Add filter", () => {
    if (selected && (selected.id !== null || selected.label === null)) {
      const selection: ExplorerFilter = selected.id === null ? { field: field.value as Dimension, kind: "missing" } : { field: field.value as Dimension, value: selected.id, kind: "id" };
      if (uniqueFilters([...filters, selection]).length <= 16) navigate([...filters, selection]);
    }
  }); add.disabled = true;
  // Inherit the live period getter instead of snapshotting it for the local clear fallback.
  ctx = Object.assign(Object.create(ctx) as ViewContext, { clearFilters: ctx.clearFilters ?? (() => navigate([])) });
  const clear = action(document, "Clear filters", () => ctx.clearFilters?.()); clear.disabled = !filters.length; clear.setAttribute("aria-disabled", String(clear.disabled));
  const active = element(document, "section", undefined, "view-actions"); active.setAttribute("aria-label", "Active filters");
  function activeFilters(): void {
    const pills: HTMLElement[] = [];
    for (const filter of uniqueFilters(filters)) {
      const label = `${dimensionLabels[filter.field]} = ${filter.kind === "missing" ? "No value" : state!.labels.get(filterKey(filter)) ?? "Saved selection (label unavailable in this period)"}`;
      const pill = element(document, "span", undefined, "filter-pill");
      const name = element(document, "span", `${dimensionLabels[filter.field]} = `);
      const value = element(document, "span", label.slice(name.textContent!.length));
      if (filter.kind === "missing") { value.className = "missing-value"; value.setAttribute("aria-label", "No value (missing)"); }
      name.append(value);
      const remove = action(document, "Remove", () => navigate(filters.filter(candidate => filterKey(candidate) !== filterKey(filter))));
      remove.className = "action filter-remove"; remove.setAttribute("aria-label", `Remove filter ${filter.field}`);
      pill.append(name, remove);
      pills.push(pill);
    }
    updateEvidence(active, ...pills);
  }
  activeFilters();
  const filterPanel = element(document, "section"); filterPanel.setAttribute("aria-label", "Filter values");
  let searchCursor: string | undefined, searchNextCursor: string | null = null;
  const searchPrevious: (string | undefined)[] = [];
  type Position = { cursor: string | undefined; previous: (string | undefined)[] };
  let searchCommitted: Position = { cursor: undefined, previous: [] }, searchFailed: Position | undefined;
  function restoreSearch(position: Position): void { searchCursor = position.cursor; searchPrevious.splice(0, searchPrevious.length, ...position.previous); }
  const valuesNext = action(document, "Next page", () => {
    if (searchNextCursor && !searchLoading && !disposed) { activity(); searchPrevious.push(searchCursor); searchCursor = searchNextCursor; void search(++sequence); }
  });
  const valuesBack = action(document, "Previous page", () => {
    if (searchPrevious.length && !searchLoading && !disposed) { activity(); searchCursor = searchPrevious.pop(); void search(++sequence); }
  });
  const valuesRetry = action(document, "Retry", () => { if (searchLoading || valuesRetry.hidden || disposed) return; activity(); if (searchFailed) restoreSearch(searchFailed); void search(++sequence); }); valuesRetry.hidden = true;
  const valuesPaging = element(document, "div", undefined, "view-actions"); valuesPaging.setAttribute("aria-label", "Filter values pages"); valuesPaging.append(valuesBack, valuesNext, valuesRetry);
  function searchVisibility(): void {
    searchNotice.hidden = !searchNotice.textContent; searchMessage.hidden = !searchMessage.textContent;
    results.hidden = !results.children.length;
    valuesPaging.hidden = !searchPrevious.length && !searchNextCursor && valuesRetry.hidden;
  }
  searchVisibility();
  controls.append(labelled(document, "Filter field", field), labelled(document, "Filter prefix", prefix), add, clear);
  filterPanel.append(element(document, "h2", "Filters"), active, controls, searchNotice, searchMessage, results, valuesPaging); root.append(filterPanel);
  const grouping = element(document, "div", undefined, "view-actions");
  const groups = [dimensionControl(document, "Group by 1"), dimensionControl(document, "Group by 2", true), dimensionControl(document, "Group by 3", true)];
  let groupBy: readonly Dimension[] = ["model"], pivotSequence = 0;
  let pivotController: AbortController | undefined;
  const pivotMessage = liveMessage(document), pageNotice = liveMessage(document), pivot = element(document, "div");
  pivotMessage.setAttribute("tabindex", "-1"); pageNotice.setAttribute("tabindex", "-1");
  const initialNotice = state.notice;
  pageNotice.textContent = initialNotice; state.notice = "";
  let cursor: string | undefined, nextCursor: string | null = null;
  const previous: (string | undefined)[] = [];
  let committed: Position = { cursor: undefined, previous: [] }, failed: Position | undefined;
  function restore(position: Position): void { cursor = position.cursor; previous.splice(0, previous.length, ...position.previous); }
  const next = action(document, "Next page", () => { if (nextCursor && !pivotLoading && !disposed) { activity(); previous.push(cursor); cursor = nextCursor; void readPivot(); } });
  const back = action(document, "Previous page", () => { if (previous.length && !pivotLoading && !disposed) { activity(); cursor = previous.pop(); void readPivot(); } });
  const retry = action(document, "Retry", () => { if (pivotLoading || retry.hidden || disposed) return; activity(); if (failed) restore(failed); void readPivot(); }); retry.hidden = true;
  const refresh = action(document, "Refresh", () => { activity(); resetPage(); refreshPivot(); });
  const paging = element(document, "div", undefined, "view-actions"); paging.append(back, next, retry);
  const pivotPanel = element(document, "section"); pivotPanel.setAttribute("aria-label", "Pivot");
  grouping.append(...groups.map((group, i) => labelled(document, `Group by ${i + 1}`, group)), refresh);
  const pivotHeading = element(document, "h2", "Attribution pivot"); pivotHeading.setAttribute("tabindex", "-1");
  pivotPanel.append(pivotHeading, grouping, pageNotice, pivotMessage, pivot, paging); root.append(pivotPanel);
  function pager(panel: HTMLElement, back: HTMLButtonElement, next: HTMLButtonElement, busy: boolean, hasBack: boolean, hasNext: boolean): void {
    panel.setAttribute("aria-busy", String(busy));
    back.setAttribute("aria-disabled", String(busy || !hasBack)); next.setAttribute("aria-disabled", String(busy || !hasNext));
  }
  function resetPage(): void { cursor = undefined; nextCursor = null; previous.length = 0; committed = { cursor, previous: [] }; failed = undefined; }
  let labelController = new AbortController(), labelSequence = 0;
  let resolving: Promise<void> | undefined, revision = "";
  const unavailableKey = (filter: ExplorerFilter) => JSON.stringify([revision, filterKey(filter)]);
  // A fixed error code intentionally contains no raw id. Validate saved filters individually to remove only invalid ones.
  function resolveLabels(force = false): Promise<void> {
    if (resolving) return force ? resolving.then(() => resolveLabels(true)) : resolving;
    const current = labelSequence;
    resolving = (async () => {
      const invalid = new Set<string>();
      await Promise.all(uniqueFilters(filters).map(async filter => {
        if (disposed || ctx.signal.aborted || current !== labelSequence) return;
        if (filter.kind === "missing" || (!force && (state!.labels.has(filterKey(filter)) || state!.unavailable.has(unavailableKey(filter))))) return;
        const unavailable = unavailableKey(filter);
        const params = sliceParams(period, [filter]); params.set("field", filter.field); params.set("prefix", ""); params.set("limit", "1");
        try {
          const response = await ctx.client.get<Page<FilterValue>>("/api/filter-values", params, labelController.signal);
          if (disposed || ctx.signal.aborted || current !== labelSequence) return;
          const row = response.data.rows.find(row => row.id === filter.value);
          if (row?.label !== null && row?.label !== undefined) state!.labels.set(filterKey(filter), row.label);
          else state!.unavailable.add(unavailable);
        } catch (error) {
          if (disposed || ctx.signal.aborted || current !== labelSequence) return;
          if (error instanceof DashboardClientError && error.code === "unknown-filter-id") invalid.add(filterKey(filter));
        }
      }));
      if (disposed || ctx.signal.aborted || current !== labelSequence) return;
      if (invalid.size) {
        state!.notice = "A saved filter no longer matches any data and was removed";
        pageNotice.textContent = state!.notice;
        navigate(filters.filter(filter => !invalid.has(filterKey(filter))));
      } else activeFilters();
    })().finally(() => { if (current === labelSequence) resolving = undefined; });
    return resolving;
  }
  function cursorNotice(error: unknown): string | undefined {
    if (!(error instanceof DashboardClientError)) return;
    if (error.code === "ledger-changed" || error.code === "invalid-query") return "Page link no longer valid. Showing page 1.";
  }
  async function readPivot(user = true, resetNotice = "", focusRetry = document.activeElement === retry, preserveFocus = false): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    if (paused) resume();
    ctx.requestStarted?.();
    pivotController?.abort(); pivotController = new AbortController(); const current = ++pivotSequence; pivotLoading = true;
    const params = sliceParams(period, filters); params.set("groupBy", groupBy.join(",")); params.set("limit", "50");
    if (cursor) params.set("cursor", cursor);
    if (user) pivotMessage.textContent = "Loading pivot";
    pager(pivot, back, next, true, !!previous.length, !!nextCursor); if (!preserveFocus || document.activeElement !== retry) retry.hidden = true;
    try {
      const response = await ctx.client.get<ExplorerData>("/api/explorer", params, pivotController.signal);
      if (disposed || ctx.signal.aborted || current !== pivotSequence) return;
      if (document.activeElement === retry) pivotHeading.focus(); retry.hidden = true;
      period = response.period; revision = response.revision; stopped = false;
      committed = { cursor, previous: [...previous] }; failed = undefined;
      for (const row of response.data.rows) for (const [i, field] of response.data.groupBy.entries()) {
        if (row.key[i] !== null && row.labels[i] !== null) state!.labels.set(filterKey({ field, kind: "id", value: row.key[i]! }), row.labels[i]!);
      }
      updateEvidence(pivot, renderPivot(ctx, response.data, row => {
        const tuple = tupleFilters(response.data, row);
        if (tuple && uniqueFilters([...filters, ...tuple]).length <= 16) navigate([...filters, ...tuple]);
      }));
      nextCursor = response.data.nextCursor;
      if (user) pivotMessage.textContent = `${response.data.rows.length} pivot ${response.data.rows.length === 1 ? "row" : "rows"} on this page`;
      if (user) pageNotice.textContent = resetNotice;
      if (focusRetry && (!document.activeElement || document.activeElement === document.body)) (resetNotice ? pageNotice : heading).focus();
      void resolveLabels();
    } catch (error) {
      if (disposed || ctx.signal.aborted || current !== pivotSequence) return;
      const notice = cursorNotice(error);
      if (notice && cursor) {
        resetPage(); if (user) pageNotice.textContent = notice;
        await readPivot(user, notice, focusRetry); return;
      }
      stopped = !canRetry(error) || error instanceof DashboardClientError && (error.code === "server-unavailable" || error.code === "unauthorized");
      failed = { cursor, previous: [...previous] }; restore(committed);
      pivotMessage.textContent = errorCopy(error, ctx); retry.hidden = !canRetry(error);
      if (focusRetry && (!document.activeElement || document.activeElement === document.body)) (retry.hidden ? pivotMessage : retry).focus();
      if (error instanceof DashboardClientError && error.code === "unknown-filter-id") await resolveLabels(true);
    } finally {
      if (current === pivotSequence) { pivotLoading = false; pager(pivot, back, next, false, !!previous.length, !!nextCursor); }
    }
  }
  function refreshPivot(preserveFocus = false): void {
    if (disposed || ctx.signal.aborted) return;
    if (!cursor) period = ctx.period; pageNotice.textContent = ""; void readPivot(true, "", !preserveFocus && document.activeElement === retry, preserveFocus);
  }
  function regroup(): void {
    pendingGroup = true; activity(); if (groupTimer !== undefined) clearTimeout(groupTimer);
    groupTimer = setTimeout(() => {
      groupTimer = undefined; pendingGroup = false;
      const selected = groups.map(group => group.value).filter(Boolean) as Dimension[];
      if (!selected.length || new Set(selected).size !== selected.length) { pivotMessage.textContent = "Choose one to three different groups."; return; }
      groupBy = selected; resetPage(); period = ctx.period; pageNotice.textContent = ""; void readPivot();
    }, 300);
  }
  for (const group of groups) group.addEventListener("change", regroup);
  function cancelSearch(): void {
    pendingSearch = false; ++sequence; searchController?.abort(); if (timer !== undefined) clearTimeout(timer); timer = undefined;
    selected = undefined; add.disabled = true; results.replaceChildren(); searchLoading = false;
    searchCursor = undefined; searchNextCursor = null; searchPrevious.length = 0; searchCommitted = { cursor: undefined, previous: [] }; searchFailed = undefined; valuesRetry.hidden = true;
    pager(results, valuesBack, valuesNext, false, false, false); searchMessage.textContent = ""; searchNotice.textContent = ""; searchVisibility();
  }
  async function search(current: number, resetNotice = "", focusRetry = document.activeElement === valuesRetry): Promise<void> {
    if (disposed || ctx.signal.aborted || current !== sequence) return;
    if (paused) resume();
    ctx.requestStarted?.();
    searchController?.abort(); searchController = new AbortController(); searchLoading = true;
    selected = undefined; add.disabled = true; valuesRetry.hidden = true;
    pager(results, valuesBack, valuesNext, true, !!searchPrevious.length, !!searchNextCursor);
    const params = sliceParams(searchPeriod, filters);
    params.set("field", field.value); params.set("prefix", [...prefix.value].slice(0, 160).join("")); params.set("limit", "50");
    if (searchCursor) params.set("cursor", searchCursor);
    searchMessage.textContent = "Loading filter values"; searchVisibility();
    try {
      const response = await ctx.client.get<Page<FilterValue>>("/api/filter-values", params, searchController.signal);
      if (disposed || ctx.signal.aborted || current !== sequence) return;
      searchPeriod = response.period;
      searchCommitted = { cursor: searchCursor, previous: [...searchPrevious] }; searchFailed = undefined; results.replaceChildren();
      if (focusRetry && (!document.activeElement || document.activeElement === document.body)) (resetNotice ? searchNotice : heading).focus();
      for (const row of response.data.rows) {
        if (row.id === null && row.label !== null) {
          results.append(element(document, "p", row.count === undefined ? "Value with unsupported id (not selectable)" : `${row.count} with unsupported ${row.count === 1 ? "id" : "ids"}`, "muted"));
        } else {
          const selection: ExplorerFilter = row.id === null ? { field: field.value as Dimension, kind: "missing" } : { field: field.value as Dimension, value: row.id, kind: "id" };
          state!.labels.set(filterKey(selection), row.label ?? "No value");
          const choose = action(document, row.label ?? "No value", () => {
            if (disposed || current !== sequence) return;
            selected = row; add.disabled = uniqueFilters([...filters, selection]).length > 16;
            searchMessage.textContent = add.disabled ? "At most 16 filters. Clear filters to add another." : `Selected ${row.label ?? "No value"}`; searchVisibility();
          });
          if (row.id === null) { choose.className = "action missing-value"; choose.setAttribute("aria-label", "No value (missing)"); }
          results.append(choose);
        }
      }
      searchNextCursor = response.data.nextCursor;
      searchNotice.textContent = resetNotice;
      searchMessage.textContent = response.data.rows.length ? "Choose a value, then Add filter." : "No matching values. Change the prefix.";
    } catch (error) {
      if (disposed || ctx.signal.aborted || current !== sequence) return;
      const notice = cursorNotice(error);
      if (notice && searchCursor) {
        cancelSearch(); searchNotice.textContent = notice; await search(sequence, notice, focusRetry); return;
      }
      searchFailed = { cursor: searchCursor, previous: [...searchPrevious] }; restoreSearch(searchCommitted);
      searchMessage.textContent = errorCopy(error, ctx); valuesRetry.hidden = !canRetry(error);
      if (focusRetry && (!document.activeElement || document.activeElement === document.body)) (valuesRetry.hidden ? searchMessage : valuesRetry).focus();
      if (error instanceof DashboardClientError && error.code === "unknown-filter-id") await resolveLabels(true);
    } finally {
      if (current === sequence) { searchLoading = false; pager(results, valuesBack, valuesNext, false, !!searchPrevious.length, !!searchNextCursor); searchVisibility(); }
    }
  }
  function changed(): void {
    activity(); cancelSearch(); searchMessage.textContent = ""; searchNotice.textContent = ""; searchPeriod = ctx.period;
    prefix.value = [...prefix.value].slice(0, 160).join("");
    pendingSearch = true; const current = sequence; timer = setTimeout(() => { timer = undefined; pendingSearch = false; void search(current); }, 300);
  }
  pager(results, valuesBack, valuesNext, false, false, false); pager(pivot, back, next, false, false, false);
  prefix.addEventListener("input", changed); field.addEventListener("change", changed);
  document.addEventListener("keydown", activity); document.addEventListener("pointerdown", activity);
  function resume(): void {
    if (disposed || ctx.signal.aborted) return;
    paused = false; lastActivity = Date.now(); clearInterval(refreshTimer);
    if (labelController.signal.aborted) labelController = new AbortController();
    if (pendingGroup) regroup();
    if (pendingSearch) changed();
    refreshTimer = setInterval(() => {
    if (!stopped && !pivotLoading && document.visibilityState === "visible" && (ctx.idleMs?.() ?? Date.now() - lastActivity) < 300000 && !root.contains(document.activeElement)) {
      if (!cursor) period = ctx.period;
      void readPivot(false);
    }
    }, 60000);
  }
  resume();
  function dispose(): void {
    if (disposed) return; disposed = true; cancelSearch(); labelController.abort();
    ++pivotSequence; pivotController?.abort(); clearInterval(refreshTimer);
    if (groupTimer !== undefined) clearTimeout(groupTimer);
    document.removeEventListener("keydown", activity); document.removeEventListener("pointerdown", activity);
    for (const group of groups) group.removeEventListener("change", regroup);
    prefix.removeEventListener("input", changed); field.removeEventListener("change", changed); ctx.signal.removeEventListener("abort", dispose);
  }
  ctx.signal.addEventListener("abort", dispose, { once: true });
  if (ctx.signal.aborted) dispose();
  else if (malformed) { state.notice = "Saved filter removed"; pageNotice.textContent = state.notice; navigate(filters); }
  else void readPivot(true, initialNotice);
  return { dispose, resume, refresh() { if (!pivotLoading) refreshPivot(true); }, suspend(abort) {
    paused = true; clearInterval(refreshTimer); refreshTimer = undefined;
    if (abort) {
      if (timer !== undefined) clearTimeout(timer); timer = undefined;
      if (groupTimer !== undefined) clearTimeout(groupTimer); groupTimer = undefined;
      ++sequence; ++pivotSequence; ++labelSequence; searchController?.abort(); pivotController?.abort(); labelController.abort(); resolving = undefined;
      pivotLoading = searchLoading = false;
      pager(pivot, back, next, false, !!previous.length, !!nextCursor); pager(results, valuesBack, valuesNext, false, !!searchPrevious.length, !!searchNextCursor);
    }
  } };
}

/** Pass to startDashboard({ mounts: EXPLORER_MOUNTS }); Task 13 owns default registry integration. */
export const EXPLORER_MOUNTS: Readonly<Record<"explorer", ViewMount>> = { explorer: mountExplorer };
