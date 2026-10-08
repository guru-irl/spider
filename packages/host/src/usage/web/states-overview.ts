import type { DashboardPageMount } from "../dashboard-v4-contract.js";
import type { FixtureStateCase } from "../__tests__/fixtures/redesign-contract.js";
import { mountOverview } from "./overview-v4.js";
import { renderStateExamples } from "./state-examples.js";
export const pageMount: DashboardPageMount = mountOverview;
export const page = "overview" as const;
export function mountOverviewStates(root: HTMLElement, cases: readonly FixtureStateCase[]): Promise<void> {
  return renderStateExamples(root, { overview: mountOverview }, cases.filter(example => example.page === "overview"));
}
