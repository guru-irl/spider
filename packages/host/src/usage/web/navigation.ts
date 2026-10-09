import type { DashboardRouteV4, RangeQuery, RangePreset } from "../dashboard-v4-contract.js";
import { supportedDetailId } from "./detail-id.js";
export function browserZone(zone: string): string {
  try { return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone; } catch { return "UTC"; }
}
export function defaultOverview(now: number, tz: string): RangeQuery { return { range: "7d", from: now - 7 * 86400000, to: now, tz: browserZone(tz), unit: "credits", buckets: [] }; }
export function routeHash(route: DashboardRouteV4): string {
  if (route.page === "calibration") return "#/calibration";
  if (route.page === "session") {
    const params = new URLSearchParams({ unit: route.unit, tz: route.tz });
    if (route.range) { params.set("from", String(route.range.from)); params.set("to", String(route.range.to)); }
    return `#/session/${encodeURIComponent(route.id)}?${params}`;
  }
  const q = route.query;
  return `#/?${new URLSearchParams({ range: q.range, from: String(q.from), to: String(q.to), tz: q.tz, unit: q.unit, buckets: JSON.stringify(q.buckets) })}`;
}
export function hashRoute(hash: string, now: number = Date.now(), tz: string = "UTC"): DashboardRouteV4 {
  const fallback: DashboardRouteV4 = { page: "overview", query: defaultOverview(now, tz) };
  if (hash.length > 16384) return fallback;
  const [path, raw = ""] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(raw);
  if (path === "/calibration") return { page: "calibration" };
  if (path?.startsWith("/session/")) {
    let id = ""; try { const decoded = decodeURIComponent(path.slice(9)); if (supportedDetailId(decoded)) id = decoded; } catch { /* Invalid ids remain a local Session not-found state. */ }
    const from = params.get("from"), to = params.get("to");
    const valid = from !== null && to !== null && /^\d+$/.test(from) && /^\d+$/.test(to) &&
      params.getAll("from").length === 1 && params.getAll("to").length === 1 &&
      Number.isSafeInteger(Number(from)) && Number.isSafeInteger(Number(to)) && Number(from) < Number(to) && Number(to) <= 8640000000000000;
    return { page: "session", id, unit: params.get("unit") === "tokens" ? "tokens" : "credits", tz: browserZone(params.get("tz") ?? tz),
      ...(valid ? { range: { from: Number(from), to: Number(to) } } : {}) };
  }
  if (path && path !== "/") return fallback;
  try {
    const range = params.get("range") ?? "7d";
    if (!["24h", "7d", "30d", "month", "custom"].includes(range)) return fallback;
    const from = Number(params.get("from")), to = Number(params.get("to"));
    const valid = params.has("from") && params.has("to") && Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to > from && to <= 8640000000000000 && to - from <= 93 * 86400000;
    if (range === "custom" && !valid) return fallback;
    const zone = browserZone(params.get("tz") ?? tz);
    const start = range === "month" ? monthStart(now, zone) : now - (range === "24h" ? 1 : range === "30d" ? 30 : 7) * 86400000;
    const buckets: unknown = JSON.parse(params.get("buckets") ?? "[]");
    if (!Array.isArray(buckets) || buckets.length > 2300 || buckets.some(v => !Number.isSafeInteger(v) || v < 0)) return fallback;
    return { page: "overview", query: { range: range as RangePreset, from: valid ? from : start, to: valid ? to : now, tz: zone, unit: params.get("unit") === "tokens" ? "tokens" : "credits", buckets: [...new Set(buckets)].sort((a, b) => a - b) } };
  } catch { return fallback; }
}

function monthStart(now: number, tz: string): number {
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
  const parts = (ts: number) => { const values = formatter.formatToParts(ts); const n = (type: string) => Number(values.find(p => p.type === type)!.value); return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour"), minute: n("minute"), second: n("second") }; };
  const local = parts(now), target = Date.UTC(local.year, local.month - 1, 1);
  let candidate = target;
  for (let i = 0; i < 4; i++) {
    const p = parts(candidate), delta = target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (!delta) break;
    candidate += delta;
  }
  return candidate;
}
