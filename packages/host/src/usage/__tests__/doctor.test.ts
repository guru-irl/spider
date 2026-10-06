import { describe, expect, it, vi } from "vitest";
import type { UsageRuntimeSnapshot } from "../protocol.js";
import { calibrationFallback } from "../calibration.js";
import { usageDoctorLines } from "../doctor.js";
vi.mock("../ledger.js", () => ({ openUsageLedger: () => { throw new Error("main-thread ledger open forbidden"); }, openUsageLedgerReadOnly: () => { throw new Error("main-thread ledger open forbidden"); } }));
const config = { calibration: "auto" as "auto" | "off", footer: true, counterPoll: true, alertsSessionCredits: 0, alertsRunCredits: 0 };
const fixture = (): UsageRuntimeSnapshot => ({
  health: { schemaVersion: 1, calls: 5, sources: 2, parseErrors: 3, sourceErrors: 4, unpricedModels: ["github-copilot/fixture-model"], aggregateCalls: 1, lastIngestAt: 1 },
  counter: { availability: "available", role: "owner", lastAttemptAt: 100, lastSuccessAt: 100, nextPollAt: 600100, snapshotAgeMs: 2000, errorCode: null, notice: null, latest: { ts: 100, creditsUsed: 10, entitlement: 100, raw: { token: "fixture-secret" } } },
  backfill: "running", progress: { sourcesCompleted: 1, sourcesTotal: 2 },
  reconciliation: { windowStart: 1, windowEnd: 2, computedAIC: 12, counterAIC: 10, gap: -2, ratio: 1.2, unpricedCalls: 1, estimated: true }, errorCode: null,
});
describe("usage doctor", () => {
  it("reports schema counts parse/source errors aggregate estimates backfill progress and rate provenance", () => {
    const result = usageDoctorLines(fixture(), config);
    expect(result.ok).toBe(true);
    const text = result.lines.join("\n");
    for (const pattern of [/schema=1/, /calls=5/, /sources=2/, /parse_errors=3/, /source_errors=4/, /aggregate=1/, /unpriced.*fixture-model/, /backfill=running.*1\/2/, /lease.*owner/, /estimated/, /copilot-public-2026-10-04/, /effective.*2026-10-01/, /source.*2026-10-04/, /https:\/\/docs.github.com/]) expect(text).toMatch(pattern);
  });
  it("missing Copilot login is informational, not a health failure", () => {
    const s = fixture();
    s.counter = { ...s.counter!, availability: "unavailable", latest: null, errorCode: "missing-auth" };
    const result = usageDoctorLines(s, config);
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toMatch(/counter: unavailable \(no Copilot login\)/);
  });
  it.each(["unavailable", "stale", "disabled"] as const)("%s counter and unavailable comparison are informational", availability => {
    const s = fixture(); s.counter = { ...s.counter!, availability, errorCode: "http-503" }; s.reconciliation = null;
    expect(usageDoctorLines(s, config).ok).toBe(true);
  });
  it.each(["usage-worker-failed", "usage-worker-oom", "usage-worker-unavailable", "usage-ledger-unavailable", "usage-ingest-failed"])("real fault %s fails health despite an available counter", errorCode => {
    const s = fixture(); s.errorCode = errorCode;
    expect(usageDoctorLines(s, config).ok).toBe(false);
  });
  it("failed backfill is unhealthy even without a worker error", () => {
    const s = fixture(); s.backfill = "failed";
    expect(usageDoctorLines(s, config).ok).toBe(false);
  });
  it("unavailable counter is not zero", () => {
    const s = fixture(); s.counter = { ...s.counter!, availability: "unavailable", latest: null, snapshotAgeMs: null };
    const text = usageDoctorLines(s, config).lines.join("\n");
    expect(text).toMatch(/counter.*unavailable/); expect(text).not.toMatch(/credits_used=0/);
  });
  it("reports latest successful snapshot age and stale failure", () => {
    const s = fixture(); s.counter = { ...s.counter!, availability: "stale", errorCode: "http-401", notice: { code: "lease-stale", at: 1 }, snapshotAgeMs: 1800000 };
    const text = usageDoctorLines(s, config).lines.join("\n");
    expect(text).toMatch(/stale/); expect(text).toMatch(/age_ms=1800000/); expect(text).toMatch(/credits_used=10/); expect(text).toMatch(/http-401/); expect(text).toMatch(/lease-stale/);
  });
  it("shows signed comparison without claiming reconciliation", () => {
    const text = usageDoctorLines(fixture(), config).lines.join("\n");
    expect(text).toMatch(/estimated.*gap=-2.*ratio=1.2/);
    expect(text).not.toMatch(/reconciled|exact billing/);
    const s = fixture(); s.reconciliation = { ...s.reconciliation!, counterAIC: 0, gap: -12, ratio: null };
    expect(usageDoctorLines(s, config).lines.join("\n")).toMatch(/gap=-12.*ratio=unavailable/);
    s.reconciliation = { ...s.reconciliation!, counterAIC: 15, gap: 3, ratio: 0.8 };
    expect(usageDoctorLines(s, config).lines.join("\n")).toMatch(/gap=\+3/);
  });
  it("no ledger yet is a non-creating diagnosis", () => {
    const result = usageDoctorLines({ health: null, counter: null, backfill: "pending", reconciliation: null, errorCode: null }, config);
    expect(result.lines.join("\n")).toMatch(/ledger.*not published/);
    expect(result.ok).toBe(true);
    expect(usageDoctorLines({ health: null, counter: null, backfill: "failed", reconciliation: null, errorCode: "usage-worker-unavailable" }, config).ok).toBe(false);
  });
  it.each(["missing-auth", "missing-counter", "http-error", "malformed-json", "payload-limit", "lease-storage", "clock-skew", "clock-jump", "lease-row-corrupt", "schedule-corrupt", "corrupt-owner", "network", "timeout", "internal"])("preserves published diagnostic %s without arbitrary messages", code => {
    const s = fixture(); s.counter!.errorCode = code; s.counter!.notice = { code, at: 1 };
    const text = usageDoctorLines(s, config).lines.join("\n");
    expect(text).toContain(`error=${code}`); expect(text).toContain(`notice=${code}`);
  });
  it("sanitizes errors and never prints credentials or raw bodies", () => {
    const s = fixture(); s.errorCode = "Bearer fixture-secret\nraw body";
    s.counter!.errorCode = "{\"access_token\":\"fixture-secret\"}";
    s.counter!.notice = { code: "https://example.invalid/?token=fixture-secret", at: 1 };
    s.health!.unpricedModels = ["\u001b[31mgithub-copilot/fixture-model\nspoof"];
    const text = usageDoctorLines(s, config).lines.join("\n");
    expect(text).not.toMatch(/fixture-secret|access_token|raw body|example.invalid|\u001b/);
    expect(text).toMatch(/redacted|unknown-error/);
  });
});

it.each(["usage-ingest-lease-lost", "usage-ingest-lease-busy"])("doctor treats %s as follower information", errorCode => {
  const result = usageDoctorLines({ ...fixture(), errorCode }, config);
  expect(result.ok).toBe(true);
  expect(result.lines.join("\n")).toContain("ingest: follower (another pi session owns ingestion)");
});

it("doctor reports calibration evidence and fallback", () => {
  const s = fixture();
  s.calibration = { ...calibrationFallback(), status: "calibrated", factor: 0.56, windowStart: 0, windowEnd: 86400000,
    coveredHours: 24, computedAic: 1000, counterDelta: 560, unpricedCalls: 2 };
  const lines = usageDoctorLines(s, { ...config, calibration: "auto" }).lines;
  expect(lines.filter(line => line.startsWith("- usage calibration:"))).toHaveLength(1);
  expect(lines.join("\n")).toMatch(/status=calibrated.*factor=0.56.*1970-01-01T00:00:00.000Z.*1970-01-02T00:00:00.000Z.*covered_hours=24.*computed_aic=1000.*counter_delta=560.*unpriced_calls=2.*method=trailing-7d-ratio/);
  expect(lines.join("\n")).toContain("primary=6.72 basis=calibrated published_estimate=12");
  for (const status of ["uncalibrated", "implausible", "off"] as const) {
    s.calibration = { ...s.calibration, status, factor: status === "implausible" ? 2 : null };
    const text = usageDoctorLines(s, { ...config, calibration: "auto" }).lines.join("\n");
    expect(text).toContain(`status=${status}`); expect(text).toContain("published fallback");
    expect(text).toContain("primary=12 basis=published published_estimate=12");
    expect(text).not.toMatch(/synthetic-token|account_login|raw body/);
  }
  delete s.calibration;
  expect(usageDoctorLines(s, { ...config, calibration: "off" }).lines.join("\n")).toContain("status=off");
});

it("doctor rounds covered hours and labels raw implausible factors rejected", () => {
  const s = fixture();
  s.calibration = { ...calibrationFallback(), status: "implausible", factor: 2, coveredHours: 24.123456, computedAic: 1000, counterDelta: 2500 };
  const text = usageDoctorLines(s, config).lines.join("\n");
  expect(text).toContain("covered_hours=24.1"); expect(text).not.toContain("24.123456");
  expect(text).toContain("factor=2.5 (rejected)"); expect(text).toContain("published fallback");
});
