/// <reference types="vite/client" />
import "./states.css";
import { startDashboard } from "./app.js";
import { element } from "./dom.js";
import { renderFlow } from "./flow.js";
import { renderStateExamples } from "./state-examples.js";
import type { FixtureStateCase } from "../__tests__/fixtures/redesign-contract.js";
import type { DashboardPageMount, DashboardRouteV4, OverviewDataV4 } from "../dashboard-v4-contract.js";
const modules = import.meta.glob<{ page: DashboardRouteV4["page"]; pageMount: DashboardPageMount }>("./states-*.ts", { eager: true });
const mounts: Partial<Record<DashboardRouteV4["page"], DashboardPageMount>> = {};
for (const module of Object.values(modules)) mounts[module.page] = module.pageMount;
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
  const window = document.defaultView;
  const params = new URLSearchParams(window?.location.search ?? ""), page = params.get("page");
  if (["overview", "session", "calibration"].includes(page ?? "")) {
    root.setAttribute("data-mode", "page");
    const route: DashboardRouteV4 | undefined = page === "calibration" ? { page: "calibration" } : page === "session" ? { page: "session", id: params.get("id") ?? (params.get("scenario") === "unknown-session" ? "unknown-session" : "session-garden"), unit: "credits", tz: "UTC" } : undefined;
    const app = startDashboard({ root, mounts, initialRoute: route }); window?.addEventListener("pagehide", () => app.dispose(), { once: true }); return;
  }
  try { const response = await fetch("/api/fixture-states"); if (!response.ok) throw new Error(); const cases = await response.json() as readonly FixtureStateCase[]; renderFixtureStates(document, root, cases); const pages = element(document, "div"); root.append(pages); await renderStateExamples(pages, mounts, cases.filter(c => !!mounts[c.page])); }
  catch { root.textContent = "Fixture states unavailable"; }
}
if (typeof document !== "undefined") void start();
