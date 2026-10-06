import type { Period, Filter } from "../dashboard-contract.js";
import type { DashboardClient } from "./client.js";
export type ViewRoute = { view: "overview" | "explorer" | "session" | "run" | "context" | "cache" | "reconciliation" | "rates"; id?: string; period?: Period; filters?: readonly Filter[] };
export type ViewContext = { document: Document; root: HTMLElement; client: DashboardClient; id?: string; period: Period; filters: readonly Filter[]; signal: AbortSignal; navigate(route: ViewRoute): void; clearFilters?(): void };
export type MountedView = { dispose(): void };
export type ViewMount = (ctx: ViewContext) => Promise<MountedView>;
