import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { UsageConfig } from "./config.js";
import type { UsageRuntime } from "./runtime.js";
import { COPILOT_RATE_VERSIONS } from "./rates.js";
import { calibrationFallback } from "./calibration.js";
import { toAicDisplay } from "./aic-display.js";
import { safeTimestamp } from "./dashboard-selection.js";

// Never show arbitrary error messages, source payloads, paths, account identities or raw JSON.
const codes = new Set([
  "usage-worker-failed", "usage-worker-oom", "usage-worker-unavailable", "usage-ledger-unavailable",
  "usage-ingest-failed", "usage-ingest-lease-lost", "usage-ingest-lease-busy", "credential-unavailable",
  "credential-read-failed", "missing-credit-counter", "invalid-payload", "payload-too-large", "fetch-failed",
  "request-timeout", "save-failed", "lease-busy", "lease-lost", "lease-stale", "release-failed", "stop-timeout",
  "missing-auth", "missing-counter", "http-error", "malformed-json", "payload-limit", "lease-storage",
  "clock-skew", "clock-jump", "lease-row-corrupt", "schedule-corrupt", "corrupt-owner", "network", "timeout", "internal",
]);
function safeCode(value: string | null | undefined): string {
  if (!value) return "none";
  return codes.has(value) || /^http-[1-5][0-9]{2}$/.test(value) ? value : "unknown-error (redacted)";
}
const label = (value: string) => stripTerminalSequences(value).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120);
const number = (value: number | null | undefined): string => typeof value === "number" && Number.isFinite(value) ? String(value) : "unavailable";

/** A pure diagnosis: snapshot is the worker's last published view, not a DB query. */
export function usageDoctorLines(snapshot: ReturnType<UsageRuntime["snapshot"]>, config: UsageConfig): { ok: boolean; lines: readonly string[] } {
  const { health, counter, reconciliation, progress } = snapshot;
  const lines = [`- usage: footer=${config.footer ? "enabled" : "disabled"} poll=${config.counterPoll ? "enabled" : "disabled"}; alerts not implemented`,
    `- usage backfill=${snapshot.backfill}${progress ? ` progress=${progress.sourcesCompleted}/${progress.sourcesTotal} sources` : " progress=unavailable"}`];
  const followerNotice = snapshot.errorCode === "usage-ingest-lease-lost" || snapshot.errorCode === "usage-ingest-lease-busy";
  const role = followerNotice ? "follower" : snapshot.ingestRole;
  lines.push(`- usage ingest: ${role === "follower" ? "follower (another pi session owns ingestion)" : role ?? "not published yet"}`);
  if (health) {
    lines.push(`- usage ledger: schema=${health.schemaVersion} calls=${health.calls} sources=${health.sources} parse_errors=${health.parseErrors} source_errors=${health.sourceErrors} aggregate=${health.aggregateCalls} possible_overlaps=${health.possibleOverlaps ?? 0}`);
    if (health.parseErrors) lines.push(`- usage parse errors: ${health.parseErrors} (lifetime total)`);
    if (health.sourceErrors) lines.push(`- usage source errors: ${health.sourceErrors} (lifetime total; includes missing deleted worktrees or projects)`);
    lines.push(`- usage unpriced models: ${health.unpricedModels.length ? health.unpricedModels.slice(0, 20).map(label).join(", ") : "none"}`);
  } else lines.push("- usage ledger: not published yet; no main-thread open or creation");
  if (counter) {
    const reason = counter.errorCode === "missing-auth" ? " (no Copilot login)" : "";
    lines.push(`- usage counter: ${counter.availability}${reason}; lease role=${counter.role}; age_ms=${number(counter.snapshotAgeMs)} stale=${counter.availability === "stale"}`);
    lines.push(`- usage counter: credits_used=${number(counter.latest?.creditsUsed)} last_success=${number(counter.lastSuccessAt)} last_attempt=${number(counter.lastAttemptAt)} next_poll=${number(counter.nextPollAt)} error=${safeCode(counter.errorCode)} notice=${safeCode(counter.notice?.code)}`);
  } else lines.push(`- usage counter: ${config.counterPoll ? "unavailable" : "disabled"}; lease role=inactive`);
  const calibration = config.calibration === "off" ? calibrationFallback("off") : snapshot.calibration ?? calibrationFallback();
  const utc = (ts: number | null) => ts !== null && safeTimestamp(ts) ? new Date(ts).toISOString() : "unavailable";
  lines.push(`- usage calibration: status=${calibration.status} factor=${calibration.status === "implausible" ? `${number(calibration.computedAic > 0 ? calibration.counterDelta / calibration.computedAic : null)} (rejected)` : number(calibration.factor)} window_utc=${utc(calibration.windowStart)}..${utc(calibration.windowEnd)} covered_hours=${Number.isFinite(calibration.coveredHours) ? calibration.coveredHours.toFixed(1) : "unavailable"} computed_aic=${number(calibration.computedAic)} counter_delta=${number(calibration.counterDelta)} unpriced_calls=${number(calibration.unpricedCalls)} method=trailing-7d-ratio${calibration.status === "calibrated" ? " (estimated; account-wide)" : " (published fallback)"}`);
  if (reconciliation) {
    const display = toAicDisplay(reconciliation.computedAIC, reconciliation.unpricedCalls, calibration);
    const primary = display.primaryAic === null ? null : Number(display.primaryAic.toPrecision(12));
    const gap = reconciliation.gap;
    lines.push(`- usage comparison (estimated): computed=${number(reconciliation.computedAIC)} counter=${number(reconciliation.counterAIC)} gap=${typeof gap === "number" && gap > 0 ? "+" : ""}${number(gap)} ratio=${number(reconciliation.ratio)} unpriced_calls=${reconciliation.unpricedCalls} primary=${number(primary)} basis=${display.basis} published_estimate=${number(display.publishedAic)}`);
  } else lines.push("- usage comparison (estimated): unavailable");
  lines.push("- usage comparison: billing accuracy unresolved; account counter includes other clients and machines");
  for (const rate of COPILOT_RATE_VERSIONS) lines.push(`- usage rates (estimated): ${rate.id} effective=${rate.effectiveFrom} source_as_of=${rate.sourceAsOf}; ${rate.source}`);
  if (snapshot.errorCode && !followerNotice) lines.push(`- usage worker: error=${safeCode(snapshot.errorCode)}`);
  const ok = (!snapshot.errorCode || followerNotice) && snapshot.backfill !== "failed";
  return { ok, lines };
}
