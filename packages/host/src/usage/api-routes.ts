import type { DashboardRoute } from "./dashboard-contract.js";
import { RESPONSE_CAPS_V4, type SessionData } from "./dashboard-v4-contract.js";
import { OVERVIEW_V4_ROUTES } from "./query-overview-v4.js";
import { CALIBRATION_V4_ROUTES } from "./query-calibration.js";
import { sessionRoute } from "./query-session.js";
const focused: readonly DashboardRoute[] = [
  ...OVERVIEW_V4_ROUTES, ...CALIBRATION_V4_ROUTES,
  { path: "/api/session/<id>", handle(ctx, query, id) { return sessionRoute(id!).handle(ctx, query); },
    responsePeriod(ctx, _query, data) { return (data as SessionData).span ?? { start: ctx.now(), end: ctx.now() }; } },
];
export const DASHBOARD_ROUTES: readonly DashboardRoute[] = focused.map(route => ({
  ...route, responseCap: RESPONSE_CAPS_V4[route.path as keyof typeof RESPONSE_CAPS_V4],
}));
