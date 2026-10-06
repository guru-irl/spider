import "./theme.css";
import type { Period } from "../dashboard-contract.js";
import type { DashboardClient } from "./client.js";
import type { ViewRoute, ViewMount, MountedView } from "./views.js";
import { createDashboardClient } from "./client.js";
import { action, element, liveMessage } from "./dom.js";
import { loadFonts } from "./fonts.js";
import { mountOverview } from "./overview.js";
export type DashboardOptions = { document?: Document; root?: HTMLElement; client?: DashboardClient; now?: () => number; initialRoute?: ViewRoute; mounts?: Partial<Record<ViewRoute["view"], ViewMount>> };
export function startDashboard(options: DashboardOptions = {}): MountedView {
  const document = options.document ?? globalThis.document;
  const root = options.root ?? document.getElementById("usage-app") ?? document.body;
  const client = options.client ?? createDashboardClient();
  const clock = options.now ?? Date.now;
  const now = clock(); const date = new Date(now);
  let route: ViewRoute = { view: "overview", ...options.initialRoute };
  let period = route.period ?? { start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end: now };
  let filters = route.filters ?? [];
  let rollingMonth = !route.period;
  const lifetime = new AbortController(); let controller: AbortController | undefined, view: MountedView | undefined, generation = 0, disposed = false;
  const shell = element(document, "div", undefined, "usage-shell");
  const rail = element(document, "nav", undefined, "usage-rail"); rail.setAttribute("aria-label", "Usage views");
  rail.append(element(document, "p", "Usage ledger", "rail-title"));
  const main = element(document, "main", undefined, "usage-main");
  const header = element(document, "header", undefined, "period-header"), content = element(document, "div");
  main.append(header, content); shell.append(rail, main); root.replaceChildren(shell);
  const mounts: Partial<Record<ViewRoute["view"], ViewMount>> = { overview: mountOverview, ...options.mounts };
  const buttons = new Map<ViewRoute["view"], HTMLButtonElement>();
  for (const [key, label] of [["overview", "Overview"], ["explorer", "Explorer"], ["session", "Session"], ["run", "Run"], ["context", "Context"], ["cache", "Cache"], ["reconciliation", "Reconciliation"], ["rates", "Rates"]] as const) {
    const button = action(document, label, () => navigate({ view: key })); buttons.set(key, button); rail.append(button);
  }
  function navigate(next: ViewRoute, focusAfterRetry = false): void {
    if (disposed) return;
    ++generation; const current = generation;
    controller?.abort(); view?.dispose(); view = undefined; controller = new AbortController();
    if (next.period) rollingMonth = false;
    period = next.period ?? period; filters = next.filters ?? filters; route = { ...next, period, filters };
    for (const [key, button] of buttons) { if (key === route.view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); }
    header.replaceChildren(element(document, "p", `${new Date(period.start).toISOString()} to ${new Date(period.end).toISOString()} UTC`, "period-label"),
      element(document, "p", filters.length ? `Selected filters: ${filters.map(filter => `${filter.field} = ${filter.value === null ? "Unknown (null)" : filter.value}`).join("; ")}` : "All recorded usage", "slice-label"));
    content.replaceChildren();
    const mount = mounts[route.view];
    if (!mount) {
      content.append(element(document, "h1", buttons.get(route.view)?.textContent ?? "Usage"), element(document, "p", "This view is not included in this build."), action(document, "Return to Overview", () => navigate({ view: "overview" })));
      return;
    }
    void mount({ document, root: content, client, id: route.id, get period(): Period {
      if (rollingMonth) {
        const end = clock(), date = new Date(end);
        period = { start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end };
        const label = header.firstElementChild;
        if (label) label.textContent = `${new Date(period.start).toISOString()} to ${new Date(period.end).toISOString()} UTC`;
      }
      return period;
    }, filters, signal: controller.signal, navigate, clearFilters() { navigate({ ...route, period: rollingMonth ? undefined : period, filters: [] }, true); } }).then(mounted => {
      if (disposed || current !== generation) mounted.dispose(); else {
        view = mounted;
        if (focusAfterRetry && (document.activeElement === document.body || !document.activeElement)) {
          const heading = content.querySelector<HTMLElement>("h1, h2, h3");
          if (heading) { heading.setAttribute("tabindex", "-1"); heading.focus(); }
        }
      }
    }).catch(() => {
      if (disposed || current !== generation) return;
      const error = liveMessage(document); error.textContent = "Could not load this view. Retry.";
      const retry = action(document, "Retry", () => navigate({ ...route, period: rollingMonth ? undefined : period }, document.activeElement === retry));
      content.append(error, retry);
      if (focusAfterRetry && document.activeElement === document.body) retry.focus();
    });
  }
  void loadFonts(document, lifetime.signal);
  navigate(route);
  return { dispose() { if (disposed) return; disposed = true; ++generation; lifetime.abort(); controller?.abort(); view?.dispose(); } };
}
// Task 5a bundles this module as an IIFE. There is no host import or runtime Vite.
if (typeof document !== "undefined") {
  const autoStart = () => { const root = document.getElementById("usage-app"); if (root) startDashboard({ root }); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoStart, { once: true });
  else autoStart();
}
