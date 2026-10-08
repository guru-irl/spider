import type { DashboardQueryContext } from "./dashboard-contract.js";
import type { CalibrationData, Collector, StatusData } from "./dashboard-v4-contract.js";
import { DAY_MS, safeTimestamp } from "./dashboard-selection.js";
import { createUsageLeaseStore } from "./lease.js";
import { countedUsageSql, storedSelection } from "./schema.js";
import { dashboardLabel } from "./dashboard-identities.js";

function collector(ctx: DashboardQueryContext): Collector {
  // Inspection is read-only and retains TTL and dead-PID rules. A follower's
  // process role is not evidence of who currently holds the shared lease.
  const lease = createUsageLeaseStore(ctx.db, () => {}).inspect("ingest", ctx.now());
  if (lease.role !== "follower" || !lease.owner) return ctx.participantActive?.() ? "dashboard-server" : "none";
  const row = ctx.db.prepare("SELECT value FROM ledger_metadata WHERE key='worker-snapshot'").get() as { value: string } | undefined;
  if (!row || row.value.length > 1024 * 1024) return "none";
  let snapshot: unknown;
  try { snapshot = JSON.parse(row.value); } catch { return "none"; }
  if (!snapshot || typeof snapshot !== "object") return "none";
  const published = (snapshot as { collector?: unknown }).collector;
  if (!published || typeof published !== "object") return "none";
  const identity = published as { kind?: unknown; sessionId?: unknown; owner?: unknown };
  if (identity.owner !== lease.owner) return "none";
  if (identity.kind === "dashboard") return "dashboard-server";
  if (identity.kind !== "pi") return "none";
  return typeof identity.sessionId === "string" && identity.sessionId.length > 0 && identity.sessionId === ctx.viewerSessionId
    ? "this-session" : "another-session";
}
function lastIngestAt(ctx: DashboardQueryContext): number | null {
  const row = ctx.db.prepare("SELECT MAX(last_ingest_at) AS at FROM import_state").get() as { at: number | null };
  const times = [row.at, ctx.status().ingest.lastIngestAt].filter((at): at is number => at !== null && safeTimestamp(at));
  return times.length ? Math.max(...times) : null;
}
export function readIngestionStatus(ctx: DashboardQueryContext): CalibrationData["ingestion"] {
  const now = ctx.now(), start = Math.floor(now / DAY_MS) * DAY_MS;
  const totals = ctx.db.prepare(`SELECT COUNT(inode) AS filesTracked,COALESCE(SUM(parse_errors),0)+COUNT(source_error_code) AS errors FROM import_state`)
    .get() as { filesTracked: number; errors: number };
  const today = ctx.db.prepare(`SELECT COUNT(*) AS calls FROM (${countedUsageSql("c.ts>=? AND c.ts<?",
    "c.run_id,c.is_report,c.source_file", "calls_period_read", storedSelection(ctx.db))})`).get(start, Math.min(now + 1, start + DAY_MS)) as { calls: number };
  return { collector: collector(ctx), lastIngestAt: lastIngestAt(ctx), ...totals, callsToday: today.calls };
}
export function queryStatusV4(ctx: DashboardQueryContext): StatusData {
  const status = ctx.status();
  return { lastIngestAt: lastIngestAt(ctx), collector: collector(ctx), latestCounterAt: status.counter.ts,
    serverBuild: dashboardLabel("model", status.serverBuild) ?? "Unavailable",
    rateVersions: status.rateVersions.map(version => dashboardLabel("model", version) ?? "Unavailable") };
}
