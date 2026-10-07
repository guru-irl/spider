import "./theme.css";
import type { Period } from "../dashboard-contract.js";
import type { DashboardClient } from "./client.js";
import type { ViewRoute, ViewMount, MountedView } from "./views.js";
import { createDashboardClient, errorCopy } from "./client.js";
import { action, element, liveMessage } from "./dom.js";
import { loadFonts } from "./fonts.js";
import { readableKey, periodTimes, aicKey } from "./format.js";
import { mountOverview } from "./overview.js";
import { mountExplorer } from "./explorer.js";
import { mountSession, mountRun } from "./detail.js";
import { mountContext } from "./context.js";
import { mountCache } from "./cache.js";
import { mountReconciliation } from "./reconciliation.js";
import { mountRates } from "./rates.js";
import { hashRoute, routeHash } from "./navigation.js";
import { configureRepresentation, clearRepresentation } from "./representation.js";
export type DashboardOptions = { document?: Document; root?: HTMLElement; client?: DashboardClient; now?: () => number; initialRoute?: ViewRoute; mounts?: Partial<Record<ViewRoute["view"], ViewMount>> };
export function startDashboard(options: DashboardOptions = {}): MountedView {
  const document = options.document ?? globalThis.document;
  const root = options.root ?? document.getElementById("usage-app") ?? document.body;
  const client = options.client ?? createDashboardClient();
  const clock = options.now ?? Date.now;
  const now = clock(); const date = new Date(now);
  const window = document.defaultView;
  let route: ViewRoute = options.initialRoute ?? hashRoute(window?.location.hash ?? "");
  let currentHash = window?.location.hash ?? "";
  let period = route.period ?? { start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end: now };
  let filters = route.filters ?? [];
  let rollingMonth = !route.period;
  const detailIds = new Map<"session" | "run", string>();
  const lifetime = new AbortController(); let controller: AbortController | undefined, view: MountedView | undefined, generation = 0, disposed = false;
  const shell = element(document, "div", undefined, "usage-shell");
  const rail = element(document, "nav", undefined, "usage-rail"); rail.setAttribute("aria-label", "Usage views");
  rail.append(element(document, "p", "Usage ledger", "rail-title"));
  const main = element(document, "main", undefined, "usage-main");
  const header = element(document, "header", undefined, "period-header"), content = element(document, "div");
  main.append(header, content); shell.append(rail, main); root.replaceChildren(shell);
  const mounts: Partial<Record<ViewRoute["view"], ViewMount>> = { overview: mountOverview, explorer: mountExplorer, session: mountSession, run: mountRun, context: mountContext, cache: mountCache, reconciliation: mountReconciliation, rates: mountRates, ...options.mounts };
  function writeHash(replace = false): void {
    if (!window) return;
    const hash = routeHash({ ...route, period: rollingMonth ? undefined : period });
    if (hash !== window.location.hash) window.history[replace ? "replaceState" : "pushState"](null, "", hash);
    currentHash = hash;
  }
  function restoreHash(): void {
    if (disposed || !window || currentHash === window.location.hash) return;
    currentHash = window.location.hash;
    const restored = hashRoute(currentHash);
    rollingMonth = !restored.period;
    navigate(restored, false, "restore");
  }
  window?.addEventListener("hashchange", restoreHash);
  window?.addEventListener("popstate", restoreHash);
  let wakePending = false;
  let suspended = false, hiddenAt: number | undefined;
  let lastActivity = clock();
  let idleTimer: ReturnType<typeof setTimeout> | undefined, resumeTimer: ReturnType<typeof setTimeout> | undefined;
  function pause(): void {
    clearTimeout(resumeTimer); resumeTimer = undefined;
    if (disposed || suspended) return;
    suspended = true;
    view?.suspend?.(true);
  }
  function checkIdle(): void {
    idleTimer = undefined;
    if (disposed || suspended || !mounts[route.view]) return;
    const remaining = 300000 - (clock() - (hiddenAt ?? lastActivity));
    if (remaining <= 0) pause();
    else idleTimer = setTimeout(checkIdle, remaining);
  }
  function armIdle(): void {
    clearTimeout(idleTimer); idleTimer = undefined;
    if (!disposed && !suspended && mounts[route.view]) checkIdle();
  }
  function activity(): void {
    if (disposed || document.visibilityState !== "visible") return;
    const now = clock();
    // High-frequency passive events only record activity once per second.
    if (now - lastActivity >= 1000 || suspended) lastActivity = now;
    if (suspended) { suspended = false; view?.resume?.(); armIdle(); wakePending = true; }
    if (!wakePending) return;
    // Collapse wake events into one bounded in-place Refresh, never a remount.
    if (resumeTimer === undefined) resumeTimer = setTimeout(() => {
      resumeTimer = undefined;
      if (!disposed && document.visibilityState === "visible") { wakePending = false; view?.refresh?.(); }
    }, 300);
  }
  function requestStarted(): void {
    wakePending = false;
    clearTimeout(resumeTimer); resumeTimer = undefined;
  }
  function visibility(): void {
    if (document.visibilityState !== "visible") {
      clearTimeout(resumeTimer); resumeTimer = undefined;
      if (hiddenAt === undefined) hiddenAt = clock();
      view?.suspend?.(false); armIdle();
      return;
    }
    const wasHidden = hiddenAt !== undefined; hiddenAt = undefined;
    if (!view && !controller) { navigate({ ...route, period: rollingMonth ? undefined : period }); return; }
    const wasSuspended = suspended; activity();
    if (wasHidden && !wasSuspended) { view?.resume?.(); lastActivity = clock(); armIdle(); }
  }
  const activityEvents = ["keydown", "pointerdown", "pointermove", "wheel", "click", "input", "change", "touchstart"];
  for (const event of activityEvents) document.addEventListener(event, activity, { passive: true, capture: true });
  document.addEventListener("visibilitychange", visibility);
  const buttons = new Map<ViewRoute["view"], HTMLButtonElement>();
  for (const [key, label] of [["overview", "Overview"], ["explorer", "Explorer"], ["session", "Session"], ["run", "Run"], ["context", "Context"], ["cache", "Cache"], ["reconciliation", "Reconciliation"], ["rates", "Rates"]] as const) {
    const button = action(document, label, () => navigate({ view: key, id: key === "session" || key === "run" ? detailIds.get(key) : undefined })); buttons.set(key, button); rail.append(button);
  }
  function navigate(next: ViewRoute, focusAfterRetry = false, history: "push" | "replace" | "restore" = "push"): void {
    if (disposed) return;
    clearTimeout(resumeTimer); resumeTimer = undefined; wakePending = false; suspended = false; lastActivity = clock();
    ++generation; const current = generation;
    controller?.abort(); view?.dispose(); view = undefined; controller = new AbortController();
    if (next.period) rollingMonth = false;
    period = next.period ?? period; filters = next.filters ?? filters; route = { ...next, period, filters, mode: next.mode ?? route.mode ?? "chart" };
    if ((route.view === "session" || route.view === "run") && route.id) detailIds.set(route.view, route.id);
    configureRepresentation(document, route.mode!);
    if (history !== "restore") writeHash(history === "replace");
    for (const [key, button] of buttons) { if (key === route.view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); }
    const slice = element(document, "p", filters.length ? "Selected filters: " : "All recorded usage", "slice-label");
    filters.forEach((filter, i) => {
      const missing = String(filter.kind) === "missing" || filter.value === null;
      const selection = element(document, "span", `${i ? "; " : ""}${readableKey(filter.field)}${missing ? ": " : " = "}`);
      const value = element(document, "span", missing ? "No value" : filter.value ?? "", missing ? "missing-value" : undefined);
      if (missing) value.setAttribute("aria-label", "No value (missing)");
      selection.append(value); slice.append(selection);
    });
    const periodLabel = element(document, "p", undefined, "period-label"); periodLabel.append(periodTimes(document, period.start, period.end, true));
    header.replaceChildren(periodLabel, slice, aicKey(document));
    content.replaceChildren();
    const mount = mounts[route.view];
    armIdle();
    if (!mount) {
      content.append(element(document, "h1", buttons.get(route.view)?.textContent ?? "Usage"), element(document, "p", "This view is not included in this build."), action(document, "Return to Overview", () => navigate({ view: "overview" })));
      return;
    }
    if (document.visibilityState !== "visible") { controller = undefined; hiddenAt ??= clock(); armIdle(); return; }
    void mount({ document, root: content, client, get id() { return route.id; }, get period(): Period {
      if (rollingMonth) {
        const end = clock(), date = new Date(end);
        period = { start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end };
        const label = header.firstElementChild;
        if (label) label.replaceChildren(periodTimes(document, period.start, period.end, true));
      }
      return period;
    }, get filters() { return filters; }, signal: controller.signal, navigate, requestStarted, idleMs() { return clock() - lastActivity; }, clearFilters() { navigate({ ...route, period: rollingMonth ? undefined : period, filters: [] }, true); } }).then(mounted => {
      if (disposed || current !== generation) mounted.dispose(); else {
        view = mounted;
        if (suspended || document.visibilityState !== "visible") view.suspend?.(suspended);
        if (focusAfterRetry && (document.activeElement === document.body || !document.activeElement)) {
          const heading = content.querySelector<HTMLElement>("h1, h2, h3");
          if (heading) { heading.setAttribute("tabindex", "-1"); heading.focus(); }
        }
      }
    }).catch(cause => {
      if (disposed || current !== generation) return;
      const recovery = { clearFilters() { navigate({ ...route, period: rollingMonth ? undefined : period, filters: [] }, true); } };
      const error = liveMessage(document); error.textContent = errorCopy(cause, recovery);
      const retry = action(document, "Retry", () => navigate({ ...route, period: rollingMonth ? undefined : period }, document.activeElement === retry));
      content.append(error, retry);
      if (error.textContent.includes("Clear filters")) content.append(action(document, "Clear filters", recovery.clearFilters));
      if (focusAfterRetry && document.activeElement === document.body) retry.focus();
    });
  }
  void loadFonts(document, lifetime.signal);
  navigate(route, false, "replace");
  return { dispose() {
    if (disposed) return; disposed = true; ++generation; clearTimeout(idleTimer); clearTimeout(resumeTimer);
    for (const event of activityEvents) document.removeEventListener(event, activity, true);
    document.removeEventListener("visibilitychange", visibility);
    window?.removeEventListener("hashchange", restoreHash); window?.removeEventListener("popstate", restoreHash);
    clearRepresentation(document);
    lifetime.abort(); controller?.abort(); view?.dispose();
  } };
}
// Task 5a bundles this module as an IIFE. There is no host import or runtime Vite.
if (typeof document !== "undefined") {
  const autoStart = () => { const root = document.getElementById("usage-app"); if (root) startDashboard({ root }); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoStart, { once: true });
  else autoStart();
}
