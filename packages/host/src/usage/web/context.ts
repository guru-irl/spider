import type { ContextData } from "../dashboard-contract.js";
import type { MountedView, ViewContext, ViewRoute } from "./views.js";
import { action, element, liveMessage, updateEvidence } from "./dom.js";
import { DashboardClientError, canRetry, errorCopy } from "./client.js";
import { supportedDetailId } from "../dashboard-keys.js";
import { utcTime } from "./format.js";
import { detailRoute } from "./detail-navigation.js";

export async function mountContext(ctx: ViewContext): Promise<MountedView> {
  const { document } = ctx, section = element(document, "section"), heading = element(document, "h1", "Context"); heading.setAttribute("tabindex", "-1"); section.append(heading);
  const message = liveMessage(document), content = element(document, "div", undefined, "overview-evidence"), links = element(document, "nav", undefined, "view-actions"); links.setAttribute("aria-label", "Recorded usage evidence");
  links.append(element(document, "p", "See Overview and Session/Run for recorded tokens and primary AIC."));
  for (const [view, label] of [["overview", "Overview"], ["session", "Session"], ["run", "Run"]] as const) {
    links.append(action(document, label, () => {
      const id = ctx.filters.find(filter => filter.field === view && filter.kind === "id")?.value;
      const route: ViewRoute = view === "overview" ? { view, filters: ctx.filters } : detailRoute(ctx, view, supportedDetailId(id) ? id : undefined);
      ctx.navigate(route);
    }));
  }
  let disposed = false, sequence = 0, controller: AbortController | undefined;
  let lastActivity = Date.now(), loading = false, shutdown = false, suspended = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const refresh = action(document, "Refresh", () => { void read(); }), retry = action(document, "Retry", () => { void read(); }); retry.hidden = true;
  const clear = action(document, "Clear filters", () => ctx.clearFilters?.()); clear.hidden = true;
  const controls = element(document, "div", undefined, "view-actions"); controls.append(refresh, retry, clear); section.append(controls, message, content, links); ctx.root.append(section);
  async function read(preserveFocus = false): Promise<void> {
    if (disposed || ctx.signal.aborted) return;
    ctx.requestStarted?.();
    controller?.abort(); controller = new AbortController(); const current = ++sequence;
    loading = true; message.textContent = "Loading context availability"; if ((!preserveFocus && document.activeElement === retry) || document.activeElement === clear) heading.focus(); if (!preserveFocus) retry.hidden = true; clear.hidden = true;
    const params = new URLSearchParams({ start: String(ctx.period.start), end: String(ctx.period.end), filters: JSON.stringify(ctx.filters) });
    try {
      const response = await ctx.client.get<ContextData>("/api/context", params, controller.signal);
      if (disposed || ctx.signal.aborted || current !== sequence) return;
      shutdown = false; const data = response.data; const evidence: HTMLElement[] = [element(document, "p", data.contextFillMessage)];
      for (const [heading, availability] of [["Composition", data.composition], ["Carry cost", data.carry], ["Item reuse", data.itemReuse]] as const) {
        const placeholder = element(document, "section"); placeholder.append(element(document, "h2", heading), element(document, "p", availability.message)); evidence.push(placeholder);
      }
      updateEvidence(content, ...evidence); message.replaceChildren(element(document, "span", "Updated "), utcTime(document, response.generatedAt)); if (document.activeElement === retry) heading.focus(); retry.hidden = true;
    } catch (error) { if (!disposed && !ctx.signal.aborted && current === sequence) { message.textContent = errorCopy(error, ctx); shutdown = message.textContent === "Run /usage again" || !canRetry(error); retry.hidden = !canRetry(error); clear.hidden = !(error instanceof DashboardClientError && error.code === "unknown-filter-id" && ctx.clearFilters); } }
    finally { if (current === sequence) loading = false; }
  }
  const activity = () => { lastActivity = Date.now(); };
  document.addEventListener("keydown", activity); document.addEventListener("pointerdown", activity);
  const stop = () => { if (timer !== undefined) clearInterval(timer); timer = undefined; };
  const start = () => {
    if (disposed || suspended || timer !== undefined) return;
    timer = setInterval(() => {
      if (!disposed && !suspended && !shutdown && !loading && document.visibilityState === "visible" && (ctx.idleMs?.() ?? Date.now() - lastActivity) < 300000 && !controls.contains(document.activeElement) && !content.contains(document.activeElement) && !links.contains(document.activeElement)) void read();
    }, 60000);
  };
  const dispose = () => { if (disposed) return; disposed = true; ++sequence; controller?.abort(); stop(); document.removeEventListener("keydown", activity); document.removeEventListener("pointerdown", activity); ctx.signal.removeEventListener("abort", dispose); };
  if (ctx.signal.aborted) dispose(); else { ctx.signal.addEventListener("abort", dispose, { once: true }); start(); void read(); }
  return { dispose,
    suspend(abort) { if (disposed) return; suspended = true; stop(); if (abort) { ++sequence; controller?.abort(); loading = false; } },
    resume() { if (disposed) return; suspended = false; lastActivity = Date.now(); start(); },
    refresh() { if (!loading) void read(true); }
  };
}
