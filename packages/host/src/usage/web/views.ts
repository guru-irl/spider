export type { DashboardPage, DashboardPageContext, DashboardPageMount, DashboardRouteV4 } from "../dashboard-v4-contract.js";
import type { Period, Filter } from "../dashboard-contract.js";
import type { DashboardClient } from "./client.js";
export type ViewRoute = { view: "overview" | "explorer" | "session" | "run" | "context" | "cache" | "reconciliation" | "rates"; id?: string; period?: Period; filters?: readonly Filter[]; mode?: "chart" | "table" };
export type ViewContext = { document: Document; root: HTMLElement; client: DashboardClient; id?: string; period: Period; filters: readonly Filter[]; signal: AbortSignal; navigate(route: ViewRoute): void; idleMs?(): number; requestStarted?(): void; clearFilters?(): void };
/** Suspension never disposes or changes DOM. false pauses polling, true also
 * aborts/fences owned requests. Resume restarts timers; refresh uses the retained
 * Refresh path (including page pins) and must not move focus. */
export type MountedView = { dispose(): void; suspend?(abort: boolean): void; resume?(): void; refresh?(): void };
export type ViewMount = (ctx: ViewContext) => Promise<MountedView>;
