import "./detail.css";
import type { CalibrationResult, UsageMeasure } from "../dashboard-contract.js";
import type { DetailCall, DetailData, DetailLink } from "../query-detail.js";
import type { MountedView, ViewContext } from "./views.js";
import { action, element, liveMessage, updateEvidence } from "./dom.js";
import { DashboardClientError, canRetry, errorCopy } from "./client.js";
import { formatAicDisplay, formatTokens, tokenList, numericText, datedText, utcTime } from "./format.js";
import { chartWithTable } from "./charts.js";
import { renderTable, tableRegion } from "./tables.js";
import { detailRoute } from "./detail-navigation.js";

function evidence(measure: UsageMeasure): string {
  return [`${formatTokens(measure.calls)} calls`, `${formatTokens(measure.unpricedCalls)} unpriced`, `${formatTokens(measure.aggregateCalls)} aggregate`,
    measure.possibleOverlap ? "Possible overlap" : "", measure.possibleUndercount ? "Possible undercount" : "", measure.pendingData ? "Pending data" : ""].filter(Boolean).join(" · ");
}
function measureCells(document: Document, measure: UsageMeasure, calibration: CalibrationResult): HTMLElement[] {
  const aic = formatAicDisplay(measure.aicDisplay, measure.unpricedCalls, calibration);
  return [numericText(document, aic.primary), numericText(document, aic.secondary), tokenList(document, measure.tokens, "recorded")];
}
function accountingText(measure: UsageMeasure): string {
  return `${evidence(measure)} · ${measure.aicDisplay.basis === "back-applied" ? "calibrated, back-applied" : measure.aicDisplay.basis}`;
}
const prose = (document: Document, text: string) => element(document, "div", text, "detail-prose");
function proseAction(document: Document, label: string, onClick: () => void): HTMLButtonElement {
  const button = action(document, label, onClick); button.className += " detail-prose"; return button;
}
function renderTimeline(ctx: ViewContext, data: DetailData): HTMLElement {
  const section = element(ctx.document, "section"); section.append(element(ctx.document, "h2", "Call timeline"), element(ctx.document, "p", "All selected calls in this slice, independent of the calls page.", "muted"));
  if (!data.timeline.length) { section.append(element(ctx.document, "p", "No recorded calls in this period")); return section; }
  const charts = element(ctx.document, "div", undefined, "small-multiples");
  for (const basis of ["calibrated", "back-applied", "published"] as const) {
    const points = data.timeline.filter(point => point.measure.aicDisplay.basis === basis);
    if (points.length) charts.append(chartWithTable(ctx.document, {
      title: `Timeline AIC · ${basis === "back-applied" ? "calibrated, back-applied" : basis}`,
      unit: basis === "published" ? "estimated-aic" : basis === "back-applied" ? "back-applied-aic" : "calibrated-aic", subsets: "recorded",
      points: points.map(point => {
        const display = formatAicDisplay(point.measure.aicDisplay, point.measure.unpricedCalls, data.calibration);
        return { ...point, value: point.measure.aicDisplay.primaryAic, tokens: point.measure.tokens, lowerBound: point.measure.unpricedCalls > 0,
          note: `${display.primary} · ${display.secondary} · ${basis === "back-applied" ? "calibrated, back-applied" : basis} · ${evidence(point.measure)}` };
      })
    }));
  }
  for (const [token, name] of [["input", "input"], ["cacheRead", "cache read"], ["cacheWrite", "cache write"], ["prompt", "prompt"], ["output", "output"], ["cacheWrite1h", "cache write 1h"], ["reasoning", "reasoning"]] as const) {
    const subset = token === "cacheWrite1h" || token === "reasoning";
    if (!subset || data.timeline.some(point => point.measure.tokens[token] !== null)) charts.append(chartWithTable(ctx.document, {
      title: `Timeline ${name} tokens${subset ? " (subset)" : ""}`, unit: "tokens", subsets: "recorded",
      points: data.timeline.map(point => ({ ...point, value: point.measure.tokens[token], tokens: point.measure.tokens, note: evidence(point.measure) }))
    }));
  }
  section.append(charts); return section;
}
function renderSelected(ctx: ViewContext, data: DetailData): HTMLElement {
  const { document } = ctx, section = element(document, "div", undefined, "overview-evidence");
  const cells = measureCells(document, data.totals, data.calibration);
  const pricing = data.totals.unpricedCalls ? data.totals.aicDisplay.primaryAic === null
    ? "No priced AIC is recorded; unpriced usage is not zero." : "AIC is a lower bound; unpriced calls are not included in the amount."
    : data.totals.aicDisplay.primaryAic === null ? "No priced AIC is recorded." : "AIC is approximate; tokens are recorded.";
  const accounting = prose(document, ""); accounting.append(numericText(document, `${accountingText(data.totals)} · ${data.accounting.message} · ${pricing}`));
  if (data.accounting.coveringRunId !== null) accounting.append(action(document, `Covering run · ${data.accounting.coveringRunId}`, () => ctx.navigate(detailRoute(ctx, "run", data.accounting.coveringRunId!))));
  section.append(tableRegion(document, renderTable(document, { caption: "Selected usage", columns: ["Observation", "Primary AIC (approximate)", "Published estimate", "Tokens (subsets not additive)", "Accounting evidence"], rows: [[prose(document, `Selected ${data.kind}`), ...cells.slice(0, 3), accounting]] })),
    element(document, "p", "Prompt tokens = input + cache read + cache write. Total tokens = prompt + output. Subsets are not additive totals.", "muted"),
    calibrationEvidence(document, data),
    element(document, "p", "Calibration is account-wide. Billing lag and quantization limit the fit; it does not prove exact billing or completeness.", "muted"));
  section.append(element(document, "p", data.contextFillMessage));
  for (const [heading, availability] of [["Composition", data.composition], ["Carry cost", data.carry], ["Item reuse", data.itemReuse]] as const) {
    const unavailable = element(document, "section"); unavailable.append(element(document, "h2", heading), element(document, "p", availability.message)); section.append(unavailable);
  }
  return section;
}
function calibrationEvidence(document: Document, data: DetailData): HTMLElement {
  const legend = element(document, "p", undefined, "calibration-evidence");
  legend.append(datedText(document, formatAicDisplay(data.totals.aicDisplay, data.totals.unpricedCalls, data.calibration).legend));
  if (data.totals.aicDisplay.primaryAic !== null) legend.append(element(document, "span", " · cal means calibrated; ? means calibration unavailable; est means published estimate with calibration off."));
  return legend;
}
function renderCalls(ctx: ViewContext, rows: readonly DetailCall[], calibration: CalibrationResult): HTMLElement {
  const latencyRecorded = rows.some(row => row.latencyMs !== null);
  return tableRegion(ctx.document, renderTable(ctx.document, { caption: "Recorded calls", columns: ["Call", "UTC time", "Primary AIC (approximate)", "Published estimate", "Tokens (subsets not additive)", "Evidence", "Attribution", ...(latencyRecorded ? ["Recorded latency"] : [])],
    rows: rows.map(row => {
      const attribution = prose(ctx.document, "");
      for (const [label, value] of [["Project", row.project?.label], ["Repo", row.repo?.label], ["Actor", row.actor], ["Role", row.role], ["Agent", row.agent], ["Run name", row.runName], ["Phase", row.phase], ["Purpose", row.auxPurpose], ["Provider", row.provider], ["Model", row.model], ["Requested model", row.requestedModel], ["Thinking", row.thinking], ["API", row.api]] as const) {
        if (value !== null && value !== undefined) attribution.append(element(ctx.document, "p", `${label}: ${value}`));
      }
      for (const [label, kind, id] of [["Session", "session", row.sessionId], ["Run", "run", row.runId], ["Parent run", "run", row.parentRunId]] as const) {
        if (id !== null) attribution.append(action(ctx.document, `${label} · ${id}`, () => ctx.navigate(detailRoute(ctx, kind, id))));
      }
      const cells = measureCells(ctx.document, row.measure, calibration); let accounting = accountingText(row.measure);
      if (row.aggregate) accounting += " · Aggregate report; per-call transcript detail unavailable";
      if (row.measure.unpricedCalls) accounting += row.measure.aicDisplay.primaryAic === null ? " · No priced AIC is recorded; unpriced usage is not zero." : " · AIC is a lower bound; unpriced calls are not included in the amount.";
      const note = prose(ctx.document, ""); note.append(numericText(ctx.document, accounting));
      return [row.id, utcTime(ctx.document, row.ts), ...cells, note, attribution, ...(latencyRecorded ? [row.latencyMs === null ? "Not recorded" : numericText(ctx.document, `${formatTokens(row.latencyMs)} ms`)] : [])];
    }) }));
}
function renderLinks(ctx: ViewContext, rows: readonly DetailLink[]): HTMLElement {
  const labels = { child: "Child run", parent: "Parent run", run: "Run", "reporting-session": "Reporting session", "transcript-session": "Child transcript session" };
  return tableRegion(ctx.document, renderTable(ctx.document, { caption: "Relationships", columns: ["Relationship", "Destination", "State"], rows: rows.map(row => [
    prose(ctx.document, labels[row.relationship]), row.id === null ? prose(ctx.document, row.label) : proseAction(ctx.document, `${row.label} · ${row.id.slice(-8)}`, () => ctx.navigate(detailRoute(ctx, row.kind, row.id!))), prose(ctx.document, row.ongoing ? "Ongoing" : "Recorded")])
  }));
}
export async function mountDetail(ctx: ViewContext & { kind: "session" | "run"; id: string }): Promise<MountedView> {
  const { document, root } = ctx, section = element(document, "section", undefined, "detail-view"), heading = element(document, "h1", `${ctx.kind === "session" ? "Session" : "Run"} · ${ctx.id}`);
  heading.setAttribute("tabindex", "-1"); section.append(heading);
  const message = liveMessage(document), linkMessage = liveMessage(document), content = element(document, "div"), callSection = element(document, "section", undefined, "detail-calls"), callContent = element(document, "div");
  callSection.append(element(document, "h2", "Calls"), callContent);
  let disposed = false, sequence = 0, controller: AbortController | undefined, cursor: string | undefined, nextCursor: string | null = null;
  let calibration: CalibrationResult; let selectedPeriod = ctx.period; let hasData = false;
  let lastActivity = Date.now(), loading = false, linksLoading = false, paused = false, linksPaused = false, linksFailed = false, suspended = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let linkController: AbortController | undefined, linkSequence = 0, linkCursor: string | undefined, linkNextCursor: string | null = null;
  const linkPrevious: (string | undefined)[] = [];
  const linkSection = element(document, "section"), linkContent = element(document, "div"); linkSection.append(element(document, "h2", "Related sessions and runs"), linkContent);
  const linkNext = action(document, "Next page", () => { if (!linkNextCursor || linkNext.disabled) return; void readLinksPage(linkNextCursor, [...linkPrevious, linkCursor]); });
  const linkBack = action(document, "Previous page", () => { if (!linkPrevious.length || linkBack.disabled) return; void readLinksPage(linkPrevious.at(-1) ?? null, linkPrevious.slice(0, -1)); });
  const linkPaging = element(document, "div", undefined, "view-actions"); linkPaging.setAttribute("role", "group"); linkPaging.setAttribute("aria-label", "Related sessions and runs pages"); linkPaging.append(linkBack, linkNext); linkBack.disabled = linkNext.disabled = true; linkSection.append(linkPaging);
  const previous: (string | undefined)[] = [];
  const next = action(document, "Next page", () => { if (!nextCursor || next.disabled) return; void read("page", nextCursor, [...previous, cursor]); });
  const back = action(document, "Previous page", () => { if (!previous.length || back.disabled) return; void read("page", previous.at(-1) ?? null, previous.slice(0, -1)); });
  const refresh = action(document, "Refresh", () => { void read("fresh"); }), retry = action(document, "Retry", () => { void read(hasData ? "page" : "fresh"); }); retry.hidden = true;
  const linkRetry = action(document, "Retry", () => { void readLinksPage(); }); linkRetry.hidden = true;
  const clear = action(document, "Clear filters", () => ctx.clearFilters?.()), linkClear = action(document, "Clear filters", () => ctx.clearFilters?.()); clear.hidden = linkClear.hidden = true;
  const controls = element(document, "div", undefined, "view-actions"); controls.append(refresh);
  const paging = element(document, "div", undefined, "view-actions"); paging.setAttribute("role", "group"); paging.setAttribute("aria-label", "Calls pages"); paging.append(back, next); next.disabled = back.disabled = true;
  callSection.append(message, retry, clear, paging); linkSection.append(linkMessage, linkRetry, linkClear); section.append(controls, content, callSection, linkSection); root.append(section);
  function paramsFor(pageCursor?: string | null): URLSearchParams {
    // A cursor's query hash includes the server-resolved window. Both pagers
    // use that pinned period, never the live rolling getter, until fresh page 1.
    const params = new URLSearchParams({ kind: ctx.kind, id: ctx.id, start: String(selectedPeriod.start), end: String(selectedPeriod.end), filters: JSON.stringify(ctx.filters), limit: "50" }); if (pageCursor) params.set("cursor", pageCursor); return params;
  }
  function showLinks(page: DetailData["links"]): void {
    updateEvidence(linkContent, renderLinks(ctx, page.rows)); linkNextCursor = page.nextCursor;
    linkNext.disabled = !linkNextCursor; linkBack.disabled = !linkPrevious.length;
  }
  function hideRetry(button: HTMLButtonElement, target: HTMLElement = heading): void { if (document.activeElement === button) target.focus(); button.hidden = true; }
  const callsHeading = callSection.firstElementChild as HTMLElement, linksHeading = linkSection.firstElementChild as HTMLElement;
  callsHeading.setAttribute("tabindex", "-1"); linksHeading.setAttribute("tabindex", "-1");
  function failed(error: unknown, source: "calls" | "links"): void {
    if (error instanceof DashboardClientError && error.code === "ledger-changed") {
      controller?.abort(); linkController?.abort(); ++sequence; ++linkSequence;
      cursor = linkCursor = undefined; nextCursor = linkNextCursor = null; previous.length = linkPrevious.length = 0; hasData = false;
      content.replaceChildren(); callContent.replaceChildren(); linkContent.replaceChildren();
      next.disabled = back.disabled = linkNext.disabled = linkBack.disabled = true;
      loading = linksLoading = false;
    } else if (source === "links") {
      linkNext.disabled = !linkNextCursor; linkBack.disabled = !linkPrevious.length;
    } else { next.disabled = !nextCursor; back.disabled = !previous.length; }
    const status = source === "links" ? linkMessage : message, retryButton = source === "links" ? linkRetry : retry;
    status.textContent = errorCopy(error, ctx); retryButton.hidden = !canRetry(error);
    const clearButton = source === "links" ? linkClear : clear;
    clearButton.hidden = !(error instanceof DashboardClientError && error.code === "unknown-filter-id" && ctx.clearFilters);
    const terminal = status.textContent === "Run /usage again" || !canRetry(error);
    if (source === "links") { linksPaused = terminal; linksFailed = true; } else paused = terminal;
    if (error instanceof DashboardClientError && error.code === "ledger-changed") {
      paused = linksPaused = true; retry.hidden = linkRetry.hidden = true;
    }
  }
  async function readLinksPage(target: string | null | undefined = linkCursor, history = linkPrevious, preserveFocus = false): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    ctx.requestStarted?.();
    linkController?.abort(); linkController = new AbortController(); const current = ++linkSequence;
    linksLoading = true; linkNext.disabled = linkBack.disabled = true; linkMessage.textContent = "Loading relationships"; if (!preserveFocus) hideRetry(linkRetry); hideRetry(linkClear);
    try {
      const response = await ctx.client.get<DetailData["links"]>("/api/detail-links", paramsFor(target), linkController.signal);
      if (disposed || ctx.signal.aborted || current !== linkSequence) return;
      linkCursor = target ?? undefined; const committed = [...history]; linkPrevious.splice(0, linkPrevious.length, ...committed);
      showLinks(response.data); hideRetry(linkRetry, linksHeading); linkMessage.textContent = "Relationships updated"; linksPaused = linksFailed = false;
    } catch (error) { if (!disposed && !ctx.signal.aborted && current === linkSequence) { failed(error, "links"); } }
    finally { if (current === linkSequence) linksLoading = false; }
  }
  async function read(mode: "fresh" | "page" | "current", target: string | null | undefined = cursor, history = previous, preserveFocus = false): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    ctx.requestStarted?.();
    if (mode === "fresh") {
      cursor = linkCursor = target = undefined; previous.length = linkPrevious.length = 0; history = [];
      nextCursor = linkNextCursor = null; hasData = false;
      selectedPeriod = ctx.period; linksPaused = linksFailed = false; linkMessage.textContent = "Loading relationships"; hideRetry(linkRetry); hideRetry(linkClear); linkController?.abort(); ++linkSequence; linksLoading = false; linkNext.disabled = linkBack.disabled = true;
    } else if (mode === "current" && cursor === undefined && linkCursor === undefined) {
      // Refreshing page 1 can advance the rolling month. A cursor in either
      // pager instead keeps their common window pinned.
      selectedPeriod = ctx.period; nextCursor = linkNextCursor = null; hasData = false; linkNext.disabled = linkBack.disabled = true;
    }
    const linksAtStart = linkSequence;
    if (mode === "current" && (linkCursor !== undefined || (preserveFocus && linksFailed))) void readLinksPage(linkCursor, linkPrevious, preserveFocus);
    controller?.abort(); controller = new AbortController(); const current = ++sequence;
    loading = true; message.textContent = "Loading usage"; if (!preserveFocus) hideRetry(retry); hideRetry(clear); next.disabled = back.disabled = true;
    const params = paramsFor(target);
    try {
      const response = await ctx.client.get<DetailData>("/api/detail", params, controller.signal);
      if (disposed || ctx.signal.aborted || current !== sequence) return;
      const data = response.data; paused = false; hasData = true;
      if (mode !== "page") {
        selectedPeriod = response.period; calibration = data.calibration;
        const label = ctx.kind === "run" ? data.calls.rows.find(row => row.runId === ctx.id)?.runName : undefined;
        heading.textContent = `${ctx.kind === "session" ? "Session" : "Run"} · ${label || ctx.id}`;
        updateEvidence(content, renderSelected(ctx, data), renderTimeline(ctx, data));
        if (linksAtStart === linkSequence && !linksLoading && !linksFailed) { showLinks(data.links); linkMessage.textContent = "Relationships updated"; }
      }
      // Cursor pages use the first page's calibration for a stable slice basis.
      // Row measures still carry their own published/back-applied evidence.
      updateEvidence(callContent, renderCalls(ctx, data.calls.rows, calibration)); nextCursor = data.calls.nextCursor;
      cursor = target ?? undefined; const committed = [...history]; previous.splice(0, previous.length, ...committed);
      next.disabled = !nextCursor; back.disabled = !previous.length; message.replaceChildren(element(document, "span", "Updated "), utcTime(document, response.generatedAt)); hideRetry(retry, callsHeading);
    } catch (error) {
      if (disposed || ctx.signal.aborted || current !== sequence) return;
      failed(error, "calls");
    } finally { if (current === sequence) loading = false; }
  }
  const activity = () => { lastActivity = Date.now(); };
  document.addEventListener("keydown", activity); document.addEventListener("pointerdown", activity);
  const stop = () => { if (timer !== undefined) clearInterval(timer); timer = undefined; };
  const start = () => {
    if (disposed || suspended || timer !== undefined) return;
    timer = setInterval(() => {
      if (!disposed && !suspended && !paused && !linksPaused && !loading && !linksLoading && document.visibilityState === "visible" && (ctx.idleMs?.() ?? Date.now() - lastActivity) < 300000 && !controls.contains(document.activeElement) && !content.contains(document.activeElement) && !callSection.contains(document.activeElement) && !linkSection.contains(document.activeElement)) void read("current");
    }, 60000);
  };
  const dispose = () => { if (disposed) return; disposed = true; ++sequence; ++linkSequence; controller?.abort(); linkController?.abort(); stop(); document.removeEventListener("keydown", activity); document.removeEventListener("pointerdown", activity); ctx.signal.removeEventListener("abort", dispose); };
  if (ctx.signal.aborted) dispose(); else { ctx.signal.addEventListener("abort", dispose, { once: true }); start(); void read("fresh"); }
  return { dispose,
    suspend(abort) {
      if (disposed) return; suspended = true; stop();
      if (abort) {
        ++sequence; ++linkSequence; controller?.abort(); linkController?.abort(); loading = linksLoading = false;
        next.disabled = !nextCursor; back.disabled = !previous.length; linkNext.disabled = !linkNextCursor; linkBack.disabled = !linkPrevious.length;
      }
    },
    resume() { if (disposed) return; suspended = false; lastActivity = Date.now(); start(); },
    refresh() { if (!loading) void read(hasData ? "current" : "fresh", cursor, previous, true); }
  };
}
function mountIdentity(ctx: ViewContext, kind: "session" | "run"): Promise<MountedView> {
  const id = ctx.id;
  // The shared context exposes getter-only id and period. Do not assign id or spread it.
  if (id !== undefined) return mountDetail(Object.assign(ctx, { kind }) as ViewContext & { kind: "session" | "run"; id: string });
  const section = element(ctx.document, "section"); section.append(element(ctx.document, "h1", kind === "session" ? "Session" : "Run"), element(ctx.document, "p", `Select a ${kind} to see recorded usage.`)); ctx.root.append(section);
  return Promise.resolve({ dispose() {} });
}
export const mountSession = (ctx: ViewContext): Promise<MountedView> => mountIdentity(ctx, "session");
export const mountRun = (ctx: ViewContext): Promise<MountedView> => mountIdentity(ctx, "run");
