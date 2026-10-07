import type { DashboardRoute } from "./dashboard-contract.js";
import { OVERVIEW_ROUTES } from "./query-overview.js";
import { EXPLORER_ROUTES } from "./query-explorer.js";
import { DETAIL_ROUTES } from "./query-detail.js";
import { ANALYSIS_ROUTES } from "./query-rates.js";

export const DASHBOARD_ROUTES: readonly DashboardRoute[] = [
  ...OVERVIEW_ROUTES, ...EXPLORER_ROUTES, ...DETAIL_ROUTES, ...ANALYSIS_ROUTES,
];
