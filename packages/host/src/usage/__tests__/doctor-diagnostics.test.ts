import { afterEach, expect, it, vi } from "vitest";
import type { SourceErrorRow } from "../dashboard-contract.js";
import { usageServerCrashCodes as doctorCrashCodes, usageDoctorLines } from "../doctor.js";
import { usageServerCrashCodes as serverCrashCodes } from "../server-runtime.js";
import { sourceErrorLabel } from "../source-error-diagnostics.js";
import { calibrationFallback } from "../calibration.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, DASHBOARD_NOW } from "./fixtures/dashboard-ledger.js";

const config = { calibration: "auto" as const, footer: true, counterPoll: false, alertsSessionCredits: 0, alertsRunCredits: 0 };
let fixture: ReturnType<typeof createDashboardFixture> | undefined;
afterEach(() => { fixture?.close(); fixture = undefined; });

it("ledger diagnostics reuse bounded dashboard label and code redaction", () => {
  fixture = createDashboardFixture(false);
  const paths = Array.from({ length: 11 }, (_, i) => `%2Fsynthetic-private%2Fsource-${i}.jsonl`);
  fixture.ledger.apply(dashboardBatch([dashboardCall("project", { sourceFile: paths[0]!, project: "C:\\synthetic-private\\project-name" })], {
    states: paths.map((path, i) => ({ path, inode: "fixture", size: 10, offset: 10, mtimeMs: DASHBOARD_NOW,
      parseErrors: i + 2, generation: 0, prefixHash: "fixture" })),
    sourceErrors: paths.map(path => ({ path, code: "EACCES", checkedPaths: ["/checked-private/fallback.jsonl"] })),
  }));
  const diagnostics = fixture.ledger.getSourceErrorDiagnostics(20);
  expect(diagnostics.rows).toHaveLength(20);
  expect(diagnostics.truncated).toBe(true);
  expect(diagnostics.rows[0]).toEqual({ sourceLabel: "source-0.jsonl", projectLabel: "project-name", code: "parse-errors", count: 2, lastCheckedAt: DASHBOARD_NOW });
  expect(diagnostics.rows[1]).toEqual({ sourceLabel: "source-0.jsonl", projectLabel: "project-name", code: "EACCES", count: 1, lastCheckedAt: DASHBOARD_NOW });
  expect(JSON.stringify(diagnostics)).not.toMatch(/synthetic-private|checked-private|%2F/);
  expect(() => fixture!.ledger.getSourceErrorDiagnostics(201)).toThrow("invalid-query");
  fixture.db.prepare("DELETE FROM import_state WHERE path=?").run(paths[10]);
  expect(fixture.ledger.getSourceErrorDiagnostics(20)).toMatchObject({ truncated: false });
  expect(fixture.ledger.getSourceErrorDiagnostics(1).rows).toHaveLength(1);
});

it("doctor shows bounded redacted source diagnostics", () => {
  const sourceErrors: SourceErrorRow[] = Array.from({ length: 21 }, (_, i) => ({
    sourceLabel: `%2Fsynthetic-private%2Fsource-${i}.jsonl`, projectLabel: "C:\\synthetic-private\\project-name",
    code: i === 1 ? "unknown-aux-purpose" : "EACCES", count: i + 1, lastCheckedAt: DASHBOARD_NOW,
  }));
  sourceErrors[2] = { ...sourceErrors[2]!, code: "/private/secret-code", sourceLabel: "\u001b[31m/source-private/source-2.jsonl\u001b[0m" };
  sourceErrors[3] = { ...sourceErrors[3]!, projectLabel: "%252Fproject-private%252Fproject-name" };
  const snapshot = { health: { schemaVersion: 3, calls: 0, sources: 0, parseErrors: 0, sourceErrors: 0, aggregateCalls: 0, unpricedModels: ["\u001b[31mUnknown model\u001b[0m"], lastIngestAt: null }, counter: null, backfill: "pending" as const, reconciliation: null, errorCode: null,
    calibration: { ...calibrationFallback(), status: "calibrated" as const, factor: 0.56, windowStart: 0, windowEnd: 86400000,
      coveredHours: 24, computedAic: 1000, counterDelta: 560, unpricedCalls: 2 } };
  const diagnostics = { sourceErrors, truncated: false, serverFailures: [], now: DASHBOARD_NOW };
  const before = structuredClone({ snapshot, diagnostics });
  const result = usageDoctorLines(snapshot, config, diagnostics);
  const rows = result.lines.filter(line => line.startsWith("- usage source diagnostic:"));
  expect(result.lines).toContain("- usage unpriced models: Unknown model");
  expect(rows).toHaveLength(20);
  expect(rows[0]).toContain("code=EACCES count=1 source=source-0.jsonl project=project-name");
  expect(rows[1]).toContain("code=unknown-aux-purpose count=2");
  expect(rows[2]).toBe("- usage source diagnostic: code=source-error count=3 source=source-2.jsonl project=project-name");
  const text = result.lines.join("\n");
  expect(text).not.toMatch(/synthetic-private|source-private|project-private|secret-code|%2F|%252F|\u001b|source-20\.jsonl/);
  expect(text).toMatch(/source diagnostics.*truncated.*\/usage/);
  expect(result.lines.find(line => line.startsWith("- usage calibration:"))).toBe("- usage calibration: status=calibrated factor=0.56 window_utc=1970-01-01T00:00:00.000Z..1970-01-02T00:00:00.000Z covered_hours=24.0 computed_aic=1000 counter_delta=560 unpriced_calls=2 method=trailing-7d-ratio (estimated; account-wide)");
  expect({ snapshot, diagnostics }).toEqual(before);
  expect(usageDoctorLines(snapshot, config, { ...diagnostics, sourceErrors: sourceErrors.slice(0, 1), truncated: true }).lines.join("\n")).toMatch(/truncated.*\/usage/);
  expect(usageDoctorLines(snapshot, config, { ...diagnostics, sourceErrors: sourceErrors.slice(0, 1) }).lines.join("\n")).not.toContain("truncated");
});

it("doctor uses snapshot diagnostics and describes recorded and current source counts", () => {
  const snapshot = { health: { schemaVersion: 3, calls: 0, sources: 1, parseErrors: 4, sourceErrors: 1, aggregateCalls: 0, unpricedModels: [], lastIngestAt: null },
    counter: null, backfill: "complete" as const, reconciliation: null, errorCode: null, ingestRole: "follower" as const,
    sourceErrorDiagnostics: { rows: [{ code: "parse-errors", count: 4, sourceLabel: "source.jsonl", projectLabel: "Unknown project", lastCheckedAt: DASHBOARD_NOW }], truncated: false } };
  const text = usageDoctorLines(snapshot, config).lines.join("\n");
  expect(text).toContain("another ingest participant");
  expect(text).toMatch(/parse errors: 4.*recorded/);
  expect(text).toMatch(/source errors: 1.*current/);
  expect(text).not.toContain("lifetime total");
  expect(text).toContain("code=parse-errors count=4 source=source.jsonl project=Unknown project");
});

it("doctor and server share the crash-code allowlist", () => {
  expect(doctorCrashCodes).toBeInstanceOf(Set);
  expect(doctorCrashCodes).toBe(serverCrashCodes);
});
it.each(["usage-server-busy", "usage-server-not-ready", "usage-server-build-invalid", "usage-server-crashed"])("%s is a recent informational dashboard failure", code => {
  const snapshot = { health: null, counter: null, backfill: "complete" as const, reconciliation: null, errorCode: null };
  const result = usageDoctorLines(snapshot, config, { sourceErrors: [], truncated: false,
    serverFailures: [{ code, mtimeMs: DASHBOARD_NOW - 2 * 3600000 }], now: DASHBOARD_NOW });
  expect(result.ok).toBe(true);
  expect(result.lines.filter(line => line.includes("dashboard server failure"))).toEqual([
    `- Last dashboard server failure: ${code}, 2 hours ago`,
  ]);
});
it("doctor shows only the last three distinct recent codes and expires after seven days", () => {
  const snapshot = { health: null, counter: null, backfill: "complete" as const, reconciliation: null, errorCode: null };
  const result = usageDoctorLines(snapshot, config, { sourceErrors: [], truncated: false, now: DASHBOARD_NOW,
    serverFailures: [
      { code: "usage-server-busy", mtimeMs: DASHBOARD_NOW - 60000 },
      { code: "usage-server-crashed", mtimeMs: DASHBOARD_NOW - 60000 },
      { code: "usage-server-busy", mtimeMs: DASHBOARD_NOW - 60000 },
      { code: "usage-server-not-ready", mtimeMs: DASHBOARD_NOW - 3600000 },
      { code: "usage-server-build-invalid", mtimeMs: DASHBOARD_NOW - 86400000 },
      { code: "/private/secret", mtimeMs: DASHBOARD_NOW },
      { code: "usage-server-spawn-failed", mtimeMs: DASHBOARD_NOW - 7 * 86400000 - 1 },
    ] });
  expect(result.lines.filter(line => line.includes("dashboard server failure"))).toEqual([
    "- Last dashboard server failure: usage-server-busy, 1 minute ago",
    "- Last dashboard server failure: usage-server-crashed, 1 minute ago",
    "- Last dashboard server failure: usage-server-not-ready, 1 hour ago",
  ]);
  expect(result.ok).toBe(true);
  for (const [age, wanted] of [[7 * 86400000, 1], [7 * 86400000 + 1, 0]] as const) {
    const report = usageDoctorLines(snapshot, config, { sourceErrors: [], truncated: false, now: DASHBOARD_NOW,
      serverFailures: [{ code: "usage-server-crashed", mtimeMs: DASHBOARD_NOW - age }] });
    expect(report.lines.filter(line => line.includes("dashboard server failure"))).toHaveLength(wanted);
    expect(report.ok).toBe(true);
  }
});
it.each(["\u001b[31m/private/name.jsonl\u001b[0m", "%1B%5B31m%2Fprivate%2Fname.jsonl%1B%5B0m",
  "\u001b]8;;https://private/path\u0007/private/name.jsonl\u001b]8;;\u0007"])("source labels strip whole terminal sequences: %s", value => {
  expect(sourceErrorLabel(value, "Unknown source")).toBe("name.jsonl");
});

// File mtime must not refresh old rows when a different code is appended today.
it("mounted doctor keeps each real crash write's time and expires old codes", async () => {
  const { paths } = await import("@spider/db-core");
  const { join } = await import("node:path");
  const { rm, readFile } = await import("node:fs/promises");
  const { registerUsage } = await import("../mount.js");
  const { writeUsageServerCrashCode, readUsageServerCrashCodes } = await import("../server-runtime.js");
  const dir = join(paths.globalRoot, "usage-server");
  const pi = { on: () => () => {} } as any;
  const mounted = registerUsage(pi, "file:///synthetic/bundle.mjs");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const now = Date.now();
    vi.setSystemTime(now - 8 * 86400000);
    await writeUsageServerCrashCode(dir, "usage-server-spawn-failed");
    vi.setSystemTime(now - 2 * 3600000);
    await writeUsageServerCrashCode(dir, "usage-server-busy");
    vi.setSystemTime(now);
    await writeUsageServerCrashCode(dir, "usage-server-crashed");
    const lines = (await mounted.doctor()).lines.filter(line => line.includes("dashboard server failure"));
    expect(lines).toEqual([
      "- Last dashboard server failure: usage-server-crashed, 0 seconds ago",
      "- Last dashboard server failure: usage-server-busy, 2 hours ago",
    ]);
    expect(await readUsageServerCrashCodes(dir)).toEqual(["usage-server-spawn-failed", "usage-server-busy", "usage-server-crashed"]);
    expect(await readFile(join(dir, "crash.log"), "utf8")).not.toContain("synthetic");
    vi.setSystemTime(now + 7 * 86400000 + 1);
    expect((await mounted.doctor()).lines.filter(line => line.includes("dashboard server failure"))).toEqual([]);
  } finally { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); }
});

it("mounted doctor checks packaged assets before any dashboard launch", async () => {
  const { registerUsage } = await import("../mount.js");
  const { paths } = await import("@spider/db-core");
  const { join } = await import("node:path");
  const result = await registerUsage({ on: () => () => {} } as any, join(paths.globalRoot, "absent/extension.js")).doctor();
  expect(result.lines.join("\n")).toContain("dashboard-assets: usage-dashboard-missing; rebuild or reinstall spider");
  expect(result.lines.join("\n")).not.toContain(paths.globalRoot);
});
