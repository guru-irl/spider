import "./states.css";
import "./app.js";
import { element, action } from "./dom.js";
import { chartWithTable } from "./charts.js";
import { renderTable } from "./tables.js";
import type { FixtureStateCase } from "../__tests__/fixtures/redesign-contract.js";
import type { OverviewDataV4, SessionData, CalibrationData } from "../dashboard-v4-contract.js";

/** Transitional legacy component examples. Page owners extend these with their v4 mounts. */
export function renderFixtureStates(document: Document, root: HTMLElement, cases: readonly FixtureStateCase[]): void {
  root.replaceChildren();
  for (const example of cases) {
    const section = element(document, "section"), heading = element(document, "h2", example.name);
    section.append(heading); root.append(section);
    const path = example.page === "session"
      ? Object.keys(example.responses).find(path => path.startsWith("/api/session/") && (example.scenario !== "unknown-session" || example.responses[path]!.status === 404))!
      : `/api/${example.page}`;
    const response = example.responses[path]!;
    if ("error" in response.body) {
      section.append(element(document, "p", response.body.error.message));
      if (response.status !== 404) section.append(action(document, "Retry", () => { renderFixtureStates(document, root, cases); }));
      continue;
    }
    const data = response.body.data;
    if (example.scenario === "no-data") { section.append(element(document, "p", "No calls recorded")); continue; }
    if (example.scenario === "stale") section.append(element(document, "p", "Stale data"));
    if (example.scenario === "counter-unavailable") section.append(element(document, "p", "Counter unavailable"));
    if (example.scenario === "no-budget") section.append(element(document, "p", "No budget set"));
    if (example.scenario === "over-pace") section.append(element(document, "p", "Over budget"));
    if (example.page === "calibration") {
      const value = data as CalibrationData;
      section.append(renderTable(document, { caption: "Daily correction", columns: ["Day (UTC)", "Published estimate", "Counter"],
        rows: value.daily.map(day => [new Date(day.day).toISOString().slice(0, 10), String(day.publishedEstimate ?? "unavailable"), String(day.counterDelta ?? "unavailable")]) }));
    } else {
      const value = data as OverviewDataV4 | SessionData;
      const periods = "buckets" in value ? value.buckets.map(bucket => ({ start: bucket.start, end: bucket.end, label: bucket.label, value: bucket.total }))
        : value.ownCallBins.map(bin => ({ ...bin, label: new Date(bin.start).toISOString() }));
      section.append(chartWithTable(document, { id: example.name, title: "Recorded tokens", unit: "tokens",
        points: periods.map(period => ({ start: period.start, end: period.end, label: period.label, value: period.value.tokens.total, tokens: period.value.tokens })) }));
      section.append(renderTable(document, { caption: "Models", columns: ["Model", "Credits", "Calls"],
        rows: value.models.map(model => [model.id, String(model.value.credits ?? "unavailable"), String(model.value.calls)]) }));
    }
  }
}
async function start(): Promise<void> {
  const root = document.getElementById("states-root");
  if (!root) return;
  try {
    const response = await fetch("/api/fixture-states");
    if (!response.ok) throw new Error("Fixture states unavailable");
    renderFixtureStates(document, root, await response.json() as readonly FixtureStateCase[]);
  } catch { root.textContent = "Fixture states unavailable"; }
}
if (typeof document !== "undefined") void start();
