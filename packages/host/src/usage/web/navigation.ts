import type { Dimension, Filter } from "../dashboard-contract.js";
import type { ViewRoute } from "./views.js";
import { supportedDetailId } from "./detail-id.js";
const views = ["overview", "explorer", "session", "run", "context", "cache", "reconciliation", "rates"] as const;
const dimensions: readonly Dimension[] = ["project", "repo", "session", "actor", "role", "agent", "provider", "model", "requestedModel", "thinking", "run", "runName", "phase", "parentRun", "auxPurpose", "api", "day"];
export function routeHash(route: ViewRoute): string {
  const params = new URLSearchParams({ view: route.view });
  if (route.id !== undefined) params.set("id", route.id);
  if (route.period) { params.set("start", String(route.period.start)); params.set("end", String(route.period.end)); }
  if (route.filters?.length) params.set("filters", JSON.stringify(route.filters));
  return `#${params}`;
}
export function hashRoute(hash: string): ViewRoute {
  const fallback: ViewRoute = { view: "overview", filters: [], mode: "chart" };
  try {
    if (!hash || hash.length > 16384) return fallback;
    // URLSearchParams tolerates malformed escapes; reject them before parsing.
    decodeURIComponent(hash.slice(1));
    const params = new URLSearchParams(hash.slice(1)), view = params.get("view"), mode = params.get("mode") ?? "chart";
    if (!views.includes(view as ViewRoute["view"]) || !["chart", "table"].includes(mode)) return fallback;
    if ([...params.keys()].some((key, i, keys) => keys.indexOf(key) !== i || !["view", "mode", "id", "start", "end", "filters"].includes(key))) return fallback;
    const route: ViewRoute = { view: view as ViewRoute["view"], mode: mode as ViewRoute["mode"], filters: [] };
    const start = params.get("start"), end = params.get("end");
    if (start !== null || end !== null) {
      if (start === null || end === null || !/^\d+$/.test(start) || !/^\d+$/.test(end)) return fallback;
      const a = Number(start), b = Number(end);
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b <= a || b > 8640000000000000) return fallback;
      route.period = { start: a, end: b };
    }
    const id = params.get("id");
    if (id !== null) { if (!supportedDetailId(id)) return fallback; route.id = id; }
    if (params.has("filters")) {
      const filters: unknown = JSON.parse(params.get("filters")!);
      if (!Array.isArray(filters) || filters.length > 16 || filters.some(f => !f || !dimensions.includes(f.field) ||
        (f.kind === "missing" ? f.value !== undefined : ![undefined, "raw", "id"].includes(f.kind) || typeof f.value !== "string" || f.value.length > 1024))) return fallback;
      route.filters = filters as Filter[];
    }
    return route;
  } catch { return fallback; }
}
