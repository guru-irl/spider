import "./theme.css";
import { mountOverview } from "./overview.js";
import { mountSession } from "./session.js";
import { mountCalibration } from "./calibration.js";
import type { DashboardRouteV4, DashboardPage, DashboardPageMount, RangeQuery, StatusData } from "../dashboard-v4-contract.js";
import type { DashboardClient } from "./client.js";
import { createDashboardClient, errorCopy, canRetry, DashboardClientError } from "./client.js";
import { action, element, sectionState } from "./dom.js";
import { loadFonts } from "./fonts.js";
import { formatLocalTime } from "./format.js";
import { defaultOverview, hashRoute, routeHash } from "./navigation.js";
import { clearRepresentation } from "./representation.js";
const productionMounts = { overview: mountOverview, session: mountSession, calibration: mountCalibration } satisfies Record<DashboardRouteV4["page"], DashboardPageMount>;
export type DashboardOptions = { document?: Document; root?: HTMLElement; client?: DashboardClient; now?: () => number; history?: boolean; initialRoute?: DashboardRouteV4; mounts?: Partial<Record<DashboardRouteV4["page"], DashboardPageMount>> };
export function startDashboard(options: DashboardOptions = {}): DashboardPage {
  const document = options.document ?? globalThis.document;
  const root = options.root ?? document.getElementById("usage-app") ?? document.body;
  const client = options.client ?? createDashboardClient(), now = options.now ?? Date.now, window = options.history === false ? null : document.defaultView;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let route = options.initialRoute ?? hashRoute(window?.location.hash ?? "", now(), tz);
  let overview: RangeQuery = route.page === "overview" ? route.query : { ...defaultOverview(now(), tz), unit: route.page === "session" ? route.unit : "credits" };
  let disposed = false, page: DashboardPage | undefined, pageController: AbortController | undefined;
  const lifetime = new AbortController(); let statusController: AbortController | undefined, statusGeneration = 0;
  let timer: ReturnType<typeof setInterval> | undefined, mountPending = false, lastActivity = now();
  const activityKinds = ["keydown", "pointerdown", "pointermove", "wheel", "input"] as const;
  let currentHash = window?.location.hash ?? "", historyIndex = 0;
  const shell = element(document, "div", undefined, "usage-shell"), header = element(document, "header", undefined, "topbar");
  const brand = action(document, "", () => navigate({ page: "overview", query: overview })); brand.className = "brand"; brand.setAttribute("aria-label", "Spider overview");
  const svg = (path: string, viewBox: string, className: string) => {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"), ink = document.createElementNS("http://www.w3.org/2000/svg", "path");
    icon.setAttribute("viewBox", viewBox); icon.setAttribute("class", className); icon.setAttribute("fill", "none"); icon.setAttribute("stroke", "currentColor"); icon.setAttribute("stroke-width", "1.5"); icon.setAttribute("stroke-linecap", "round"); icon.setAttribute("stroke-linejoin", "round"); icon.setAttribute("aria-hidden", "true"); ink.setAttribute("d", path); icon.append(ink); return icon;
  };
  brand.append(svg("M28 3v50M3 28h50M10.32 10.32l35.36 35.36M45.68 10.32L10.32 45.68M28 19l6.36 2.64L37 28l-2.64 6.36L28 37l-6.36-2.64L19 28l2.64-6.36ZM28 11l12.02 4.98L45 28l-4.98 12.02L28 45l-12.02-4.98L11 28l4.98-12.02ZM28 3l17.68 7.32L53 28l-7.32 17.68L28 53l-17.68-7.32L3 28l7.32-17.68Z", "0 0 56 56", "web-mark"), element(document, "span", "SPIDER", "wordmark"));
  const nav = element(document, "nav", undefined, "nav"); nav.setAttribute("aria-label", "Usage pages");
  const overviewButton = action(document, "Overview", () => navigate({ page: "overview", query: overview })), calibrationButton = action(document, "Calibration & data", () => navigate({ page: "calibration" })); nav.append(overviewButton, calibrationButton);
  const freshness = element(document, "div", undefined, "freshness"); freshness.setAttribute("role", "status"); freshness.setAttribute("aria-live", "polite"); freshness.setAttribute("data-state", "loading");
  const indicator = element(document, "span", undefined, "freshness-indicator"), dot = element(document, "span", undefined, "status-dot"), updated = element(document, "span", "Last update unavailable", "freshness-tooltip");
  indicator.setAttribute("aria-label", "Last update unavailable"); indicator.setAttribute("tabindex", "0"); dot.setAttribute("aria-hidden", "true"); updated.setAttribute("role", "tooltip"); indicator.append(dot, updated);
  const refreshButton = action(document, "", () => { void refresh(); }); refreshButton.className = "refresh"; refreshButton.setAttribute("aria-busy", "false"); refreshButton.append(svg("M20 10a8 8 0 1 0-2 8M20 4v6h-6", "0 0 24 24", "refresh-icon"), element(document, "span", "Refresh", "sr-only"));
  freshness.append(indicator, refreshButton); header.append(brand, nav, freshness);
  const content = element(document, "main", undefined, "usage-main"); shell.append(header, content); root.replaceChildren(shell);
  function readDepth(): number { const depth: unknown = window?.history.state?.usageDashboardDepth; return typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 0 ? depth : 0; }
  historyIndex = readDepth();
  function writeHash(replace: boolean): void {
    if (!window) return;
    const hash = routeHash(route);
    if (replace || hash !== window.location.hash) {
      if (!replace) ++historyIndex;
      window.history[replace ? "replaceState" : "pushState"]({ usageDashboardDepth: historyIndex }, "", hash);
    }
    currentHash = hash;
  }
  function back(): void { if (window && historyIndex > 0) window.history.back(); else navigate({ page: "overview", query: overview }); }
  function mountPage(): void {
    const restoreFocus = content.contains(document.activeElement);
    pageController?.abort(); page?.dispose(); page = undefined; pageController = new AbortController(); content.replaceChildren();
    overviewButton.removeAttribute("aria-current"); calibrationButton.removeAttribute("aria-current");
    if (route.page !== "session") (route.page === "overview" ? overviewButton : calibrationButton).setAttribute("aria-current", "page");
    if (restoreFocus) (route.page === "calibration" ? calibrationButton : overviewButton).focus();
    if (route.page === "session" && !route.id) { sectionState(content, "empty", "Session not found"); content.append(action(document, "Back", back)); return; }
    if (document.visibilityState !== "visible") { mountPending = true; return; }
    mountPending = false;
    if (statusGeneration === 0) void status();
    const mount = (options.mounts ?? productionMounts)[route.page];
    if (!mount) { sectionState(content, "empty", "This section is not included in this build."); return; }
    try { page = mount({ document, root: content, client, route, signal: pageController.signal, navigate, get overview() { return overview; }, now, back }); }
    catch (error) { sectionState(content, "error", errorCopy(error), canRetry(error) ? mountPage : undefined); if (route.page === "session" && error instanceof DashboardClientError && error.code === "not-found") content.append(action(document, "Back", back)); }
  }
  function navigate(next: DashboardRouteV4, opts?: { replace?: boolean }): void {
    if (disposed) return;
    route = next; if (next.page === "overview") overview = next.query; else if (next.page === "session") overview = { ...overview, unit: next.unit };
    writeHash(!!opts?.replace);
    // Reconciliation from a page changes only its URL and remembered state.
    if (!opts?.replace) mountPage();
  }
  function restore(): void { if (disposed || !window || window.location.hash === currentHash) return; currentHash = window.location.hash; historyIndex = readDepth(); route = hashRoute(currentHash, now(), tz); if (route.page === "overview") overview = route.query; else if (route.page === "session") overview = { ...overview, unit: route.unit }; mountPage(); }
  async function status(): Promise<void> {
    const gen = ++statusGeneration; statusController?.abort(); statusController = new AbortController();
    try {
      const reply = await client.get<StatusData>("/api/status", new URLSearchParams(), statusController.signal);
      if (disposed || gen !== statusGeneration || statusController.signal.aborted) return;
      const at = reply.data.lastIngestAt;
      const fresh = at !== null && Number.isFinite(at) && now() - at <= 300000;
      freshness.setAttribute("data-state", fresh ? "fresh" : "stale");
      const label = at === null || !Number.isFinite(at) ? "Last update unavailable" : `Last update ${formatLocalTime(at, tz)}${fresh ? "" : ". Older than five minutes"}`;
      indicator.setAttribute("aria-label", label); indicator.setAttribute("title", label); updated.textContent = label;
    } catch { if (!disposed && gen === statusGeneration) { freshness.setAttribute("data-state", "stale"); indicator.setAttribute("aria-label", "Last update unavailable"); indicator.setAttribute("title", "Last update unavailable"); updated.textContent = "Last update unavailable"; } }
  }
  let refreshGeneration = 0;
  async function refresh(): Promise<void> {
    if (disposed || route.page === "session" && !route.id) return;
    const gen = ++refreshGeneration; refreshButton.setAttribute("aria-busy", "true");
    try { await Promise.all([status(), page?.refresh().catch(() => {})]); } finally { if (!disposed && gen === refreshGeneration) refreshButton.setAttribute("aria-busy", "false"); }
  }
  function activity(): void {
    const wasIdle = now() - lastActivity > 300000; lastActivity = now();
    if (!disposed && wasIdle && document.visibilityState === "visible") void refresh();
  }
  function visibility(): void {
    clearInterval(timer); timer = undefined;
    if (!disposed && document.visibilityState === "visible") {
      if (mountPending) mountPage();
      timer = setInterval(() => {
        if (document.visibilityState !== "visible" || route.page === "session" && !route.id) return;
        if (now() - lastActivity > 300000) void status(); else void refresh();
      }, 60000);
    }
  }
  for (const kind of activityKinds) document.addEventListener(kind, activity, { passive: true, capture: true });
  document.addEventListener("visibilitychange", visibility); window?.addEventListener("hashchange", restore); window?.addEventListener("popstate", restore);
  void loadFonts(document, lifetime.signal); writeHash(true); mountPage(); visibility();
  return { refresh, dispose() { if (disposed) return; disposed = true; ++statusGeneration; clearInterval(timer); lifetime.abort(); statusController?.abort(); pageController?.abort(); page?.dispose(); for (const kind of activityKinds) document.removeEventListener(kind, activity, true); document.removeEventListener("visibilitychange", visibility); window?.removeEventListener("hashchange", restore); window?.removeEventListener("popstate", restore); clearRepresentation(document); } };
}
if (typeof document !== "undefined") {
  const start = () => { const root = document.getElementById("usage-app"); if (root) startDashboard({ root }); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
}
