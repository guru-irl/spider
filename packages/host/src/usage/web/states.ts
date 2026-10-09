/// <reference types="vite/client" />
import "./states.css";
import { mountOverviewStates, pageMount as overview } from "./states-overview.js";
import { mountSessionStates, pageMount as session } from "./states-session.js";
import { mountCalibrationStates, pageMount as calibration } from "./states-calibration.js";
import { startDashboard } from "./app.js";
import { defaultOverview } from "./navigation.js";
import { renderStateExamples } from "./state-examples.js";
import { element } from "./dom.js";
import { renderFlow } from "./flow.js";

import type { FixtureStateCase } from "../__tests__/fixtures/redesign-contract.js";
import type { DashboardPageMount, DashboardRouteV4, OverviewDataV4 } from "../dashboard-v4-contract.js";
const mounts = { overview, session, calibration } satisfies Record<DashboardRouteV4["page"], DashboardPageMount>;
async function componentStates(root: HTMLElement, cases: readonly FixtureStateCase[]): Promise<void> {
  const document = root.ownerDocument;
  // These snapshots use the real mounts, then dispose all live work. A loading
  // example is deliberately frozen, not an unsettled catalogue request.
  for (const page of ["overview", "session", "calibration"] as const) {
    const title = page[0]!.toUpperCase() + page.slice(1), section = element(document, "section", undefined, "state-example"), content = element(document, "div");
    section.append(element(document, "h2", `${title} loading`), content); root.append(section);
    const route: DashboardRouteV4 = page === "overview" ? { page, query: defaultOverview(Date.now(), "UTC") } : page === "session" ? { page, id: "session-garden", unit: "credits", tz: "UTC" } : { page };
    const app = startDashboard({ document, root: content, history: false, initialRoute: route, mounts, client: {
      get: (_path, _params, signal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }); }),
    } });
    const main = content.querySelector("main"), classes = main?.className; app.dispose(); if (main && classes !== undefined) main.className = classes;
  }
  const variant = async (page: DashboardRouteV4["page"], name: string, decorate: (root: HTMLElement) => void, change?: (data: OverviewDataV4) => void) => {
    const base = cases.find(c => c.page === page && c.scenario === "default"); if (!base) return;
    const example = structuredClone(base); example.name = name;
    const body = example.responses["/api/overview"]?.body; if (change && body && "data" in body) change(body.data as OverviewDataV4);
    const wrapper: DashboardPageMount = ctx => {
      const pageMount = mounts[page](ctx);
      return { async refresh() { await pageMount.refresh(); decorate(ctx.root); }, dispose: () => pageMount.dispose() };
    };
    const container = element(document, "div"); root.append(container); await renderStateExamples(container, { [page]: wrapper }, [example]);
  };
  for (const page of ["overview", "session", "calibration"] as const) await variant(page, `${page[0]!.toUpperCase() + page.slice(1)} tables`, root => {
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) if (button.textContent === "Table") button.click();
  });
  await variant("overview", "Pace popover", root => root.querySelector<HTMLButtonElement>(".pace-trigger")?.click());
  await variant("overview", "Pace short fill", root => root.querySelector<HTMLButtonElement>(".pace-trigger")?.click(), data => { data.pace = { ...data.pace, used: 2, remaining: 98 }; });
  await variant("overview", "Overview selected buckets", () => {}, data => { data.range.buckets = data.buckets.filter(b => b.total.calls > 0).map(b => b.key); });
  await variant("session", "Pinned run", root => root.querySelector<SVGElement>(".run-route")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
export function renderFixtureStates(document: Document, root: HTMLElement, cases: readonly FixtureStateCase[]): void {
  root.replaceChildren();
  for (const example of cases.filter(c => c.page === "overview")) {
    const section = element(document, "section"); section.append(element(document, "h2", example.name)); root.append(section);
    const body = example.responses["/api/overview"]?.body;
    if (body && "data" in body) section.append(renderFlow(document, (body.data as OverviewDataV4).flow, "credits", `example-${example.name}`));
    else section.append(element(document, "p", "Could not load usage. Retry."));
  }
}
async function start(): Promise<void> {
  const root = document.getElementById("states-root"); if (!root) return;
  try { const response = await fetch("/api/fixture-states"); if (!response.ok) throw new Error(); const cases = await response.json() as readonly FixtureStateCase[]; root.replaceChildren();
    for (const mountStates of [mountOverviewStates, mountSessionStates, mountCalibrationStates]) {
      const examples = element(document, "div"); root.append(examples); await mountStates(examples, cases);
    }
    const components = element(document, "div"); root.append(components); await componentStates(components, cases);
    root.setAttribute("data-settled", "true"); }
  catch { root.textContent = "Fixture states unavailable"; }
}
if (typeof document !== "undefined") void start();
