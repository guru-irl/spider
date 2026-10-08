import type { FixtureStateCase } from "../__tests__/fixtures/redesign-contract.js";
import type { DashboardPageMount, DashboardRouteV4 } from "../dashboard-v4-contract.js";
import { startDashboard } from "./app.js";
import { createDashboardClient } from "./client.js";
import { defaultOverview } from "./navigation.js";
import { element } from "./dom.js";
export function fixtureClient(example: FixtureStateCase): import("./client.js").DashboardClient {
  return createDashboardClient(async input => {
    const url = new URL(String(input), "http://fixture.invalid"), reply = example.responses[url.pathname];
    if (!reply) throw new Error("Unexpected fixture API path");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  });
}
export async function renderStateExamples(root: HTMLElement, mounts: Partial<Record<DashboardRouteV4["page"], DashboardPageMount>>, cases: readonly FixtureStateCase[]): Promise<void> {
  root.replaceChildren();
  for (const example of cases) {
    const section = element(root.ownerDocument, "section", undefined, "state-example"), content = element(root.ownerDocument, "div"); section.append(element(root.ownerDocument, "h2", example.name), content); root.append(section);
    const path = Object.keys(example.responses).find(p => p.startsWith("/api/session/") && (example.scenario !== "unknown-session" || example.responses[p]!.status === 404));
    const route: DashboardRouteV4 = example.page === "calibration" ? { page: "calibration" } : example.page === "session" ? { page: "session", id: path?.slice(13) ?? "", unit: "credits", tz: "UTC" } : { page: "overview", query: defaultOverview(Date.now(), "UTC") };
    const app = startDashboard({ document: root.ownerDocument, root: content, history: false, initialRoute: route, mounts, client: fixtureClient(example) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([app.refresh(), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]); }
    finally { clearTimeout(timer); app.dispose(); }
  }
}
