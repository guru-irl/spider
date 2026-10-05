import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDashboardFixture, DASHBOARD_NOW, DASHBOARD_MONTH } from "./fixtures/dashboard-ledger.js";
import * as ledgerModule from "../ledger.js";
import { openDb } from "@spider/db-core";
import type { ApiErrorCode, ApiErrorBody, Slice } from "../dashboard-contract.js";

let fixture: ReturnType<typeof createDashboardFixture> | undefined;
afterEach(() => { fixture?.close(); fixture = undefined; });

it("wire errors expose all fixed codes and the versioned body", () => {
  expectTypeOf<ApiErrorCode>().toEqualTypeOf<"invalid-query" | "ledger-changed" | "ledger-unavailable" | "unsupported-schema" | "busy" | "not-found"
    | "unauthorized" | "forbidden" | "method-not-allowed" | "response-limit" | "rate-limited" | "internal">();
  expectTypeOf<ApiErrorBody>().toEqualTypeOf<{ apiVersion: 1; error: { code: ApiErrorCode; message: string } }>();
});

it("fixture teardown leaves unrelated caller stubs intact", () => {
  vi.stubEnv("DASHBOARD_CALLER_ENV", "caller-value");
  const local = createDashboardFixture(false);
  local.close();
  try { expect(process.env.DASHBOARD_CALLER_ENV).toBe("caller-value"); } finally { vi.unstubAllEnvs(); }
});

it("invalid slice fails before SQL", async () => {
  const api = await import("../dashboard-selection.js").catch(() => null);
  expect(api, "slice validation API must exist").not.toBeNull();
  for (const query of [
    "start=1", "end=2", "start=1&end=2&start=1", "unknown=1", "start=NaN&end=2",
    "start=-1&end=2", "start=1.1&end=2", "start=3&end=2", "start=0&end=31622400001",
    "start=9007199254740992&end=9007199254740993", "filters={}", "filters=null", "filters=broken",
    `filters=${JSON.stringify(Array(17).fill({ field: "actor", value: "parent" }))}`,
    `filters=${JSON.stringify([{ field: "sourceFile", value: "/private/file" }])}`,
    `filters=${JSON.stringify([{ field: "role", value: 7 }])}`,
    `filters=${JSON.stringify([{ field: "role", value: "x", extra: true }])}`,
    `filters=${JSON.stringify([{ field: "day", value: "2026-02-30" }])}`,
    `filters=${JSON.stringify([{ field: "role", value: "x".repeat(1025) }])}`,
    `filters=${"x".repeat(8193)}`,
  ]) expect(() => api!.parseSlice(new URLSearchParams(query), DASHBOARD_NOW), query).toThrow("invalid-query");
  expect(api!.parseSlice(new URLSearchParams(), DASHBOARD_NOW)).toEqual({ start: DASHBOARD_MONTH, end: DASHBOARD_NOW, filters: [] });
  const slice: Slice = { start: DASHBOARD_MONTH, end: DASHBOARD_NOW, filters: [
    { field: "role", value: null }, { field: "model", value: "Unknown" }, { field: "day", value: "2026-10-02" },
  ] };
  expect(api!.parseSlice(new URLSearchParams({ start: String(slice.start), end: String(slice.end), filters: JSON.stringify(slice.filters) }), DASHBOARD_NOW)).toEqual(slice);
  const compiled = api!.compileSlice(slice, { sessionId: "fixture-session" });
  expect(compiled.sql).toContain("c.session_id = ?");
  expect(compiled.sql).toContain("c.role IS ?");
  expect(compiled.params).toContain(null);
  expect(compiled.params).toContain("Unknown");
  expect(() => api!.compileSlice({ ...slice, start: NaN })).toThrow("invalid-query");
});

it("tokens do not double-count subsets", async () => {
  fixture = createDashboardFixture(false);
  const { dashboardCall, dashboardBatch } = await import("./fixtures/dashboard-ledger.js");
  fixture.ledger.apply(dashboardBatch([dashboardCall("tokens")]));
  const selection = await import("../dashboard-selection.js");
  expect(selection).toHaveProperty("readMeasure", expect.any(Function));
  const { openDashboardReader } = await import("../dashboard-reader.js");
  const reader = openDashboardReader(fixture.file, { instanceId: "fixture-instance", now: () => DASHBOARD_NOW, serverBuild: "fixture-build" })!;
  try {
    reader.snapshot(ctx => {
      const measure = selection.readMeasure(ctx, { start: DASHBOARD_MONTH, end: DASHBOARD_NOW, filters: [] });
      expect(measure.tokens).toEqual({ input: 10, cacheRead: 20, cacheWrite: 30, output: 10,
        cacheWrite1h: 5, reasoning: 4, prompt: 60, total: 70 });
      expect(Object.keys(measure).sort()).toEqual(["calls", "pricedCalls", "unpricedCalls", "aggregateCalls", "tokens",
        "aic", "aicDisplay", "aicComponents", "piCost", "possibleOverlap", "possibleUndercount", "pendingData", "estimated"].sort());
      expect(measure.aicDisplay).toEqual({ primaryAic: 1, publishedAic: 1, basis: "published" });
      expect(ctx.calibration.current(ctx.calibrationMode).status).toBe("uncalibrated");
      expect(measure.aicComponents).toEqual({ input: 0.1, cacheRead: 0.2, cacheWrite: 0.3, output: 0.4 });
    });
  } finally { reader.close(); }
});

it("empty unpriced and priced zero remain distinct", async () => {
  fixture = createDashboardFixture(false);
  const { dashboardCall, dashboardBatch } = await import("./fixtures/dashboard-ledger.js");
  const { readMeasure } = await import("../dashboard-selection.js");
  const { openDashboardReader } = await import("../dashboard-reader.js");
  let mode: "auto" | "off" = "auto";
  const reader = openDashboardReader(fixture.file, { instanceId: "fixture-instance", now: () => DASHBOARD_NOW, serverBuild: "fixture-build", calibrationMode: () => mode })!;
  const slice = { start: DASHBOARD_MONTH, end: DASHBOARD_NOW, filters: [] };
  try {
    const empty = reader.snapshot(ctx => readMeasure(ctx, slice));
    expect(empty.aic).toBeNull();
    expect(empty.aicDisplay.publishedAic).toBeNull();
    expect(empty.tokens.total).toBe(0);
    fixture.ledger.apply(dashboardBatch([dashboardCall("unpriced", { price: { status: "unpriced", reason: "unknown-model" } })]));
    const unknown = reader.snapshot(ctx => readMeasure(ctx, slice));
    expect(unknown.aic).toBeNull();
    expect(unknown.aicDisplay.primaryAic).toBeNull();
    expect(unknown.unpricedCalls).toBe(1);
    fixture.ledger.apply(dashboardBatch([dashboardCall("zero", { price: { status: "priced", aic: 0,
      components: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" } })]));
    const mixed = reader.snapshot(ctx => readMeasure(ctx, slice));
    expect(mixed.aic).toBe(0);
    expect(mixed.aicDisplay).toEqual({ primaryAic: 0, publishedAic: 0, basis: "published" });
    expect(mixed.aicComponents.input).toBe(0);
    fixture.ledger.apply(dashboardBatch([dashboardCall("priced")]));
    mode = "off";
    reader.snapshot(ctx => {
      const lowerBound = readMeasure(ctx, slice);
      expect(lowerBound.aicDisplay).toEqual({ primaryAic: 1, publishedAic: 1, basis: "published" });
      expect(ctx.calibration.current(mode).status).toBe("off");
      expect(ctx.calibration.atMany([1, 2], mode).map(point => point.status)).toEqual(["off", "off"]);
      expect(ctx.calibration.at(1, "auto").status).toBe("uncalibrated");
      expect(ctx.calibration.history(slice, { limit: 31 }, mode)).toEqual({ rows: [], nextCursor: null });
    });
  } finally { reader.close(); }
});

it("phase two availability touches no context tables", async () => {
  fixture = createDashboardFixture();
  const { openDashboardReader } = await import("../dashboard-reader.js");
  const reader = openDashboardReader(fixture.file, { instanceId: "fixture-instance", now: () => DASHBOARD_NOW, serverBuild: "fixture-build" })!;
  try {
    reader.snapshot(ctx => {
      const slice = { start: DASHBOARD_MONTH, end: DASHBOARD_NOW, filters: [], sessionId: "fixture-session", runId: "fixture-run" };
      const prepare = vi.spyOn(ctx.db, "prepare");
      expect(ctx.composition.availability(slice)).toEqual({ status: "unavailable", phase: 2, reason: "not-built", message: "Not available yet (Phase 2)" });
      expect(ctx.composition.availability({ ...slice, sessionId: undefined })).toEqual(ctx.composition.availability(slice));
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
    });
  } finally { reader.close(); }
  const { phase2CompositionProvider } = await import("../composition-provider.js");
  expect(phase2CompositionProvider.availability({ start: 0, end: 0, filters: [] }).phase).toBe(2);
});

it("fixture roots follow global root and restore only owned env keys", () => {
  const parent = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "caller-"));
  const previousGlobal = process.env.SPIDER_GLOBAL_ROOT;
  vi.stubEnv("SPIDER_GLOBAL_ROOT", parent);
  vi.stubEnv("DASHBOARD_CALLER_ENV", "caller-value");
  const home = process.env.HOME;
  const local = createDashboardFixture(false);
  try {
    expect(local.root.startsWith(join(parent, "dashboard-"))).toBe(true);
  } finally { local.close(); }
  try {
    expect(process.env.SPIDER_GLOBAL_ROOT).toBe(parent);
    expect(process.env.HOME).toBe(home);
    expect(process.env.DASHBOARD_CALLER_ENV).toBe("caller-value");
  } finally {
    vi.unstubAllEnvs();
    process.env.SPIDER_GLOBAL_ROOT = previousGlobal;
    rmSync(parent, { recursive: true, force: true });
  }
});

it("filter keys allow up to 1024 bytes", async () => {
  const { parseSlice, compileSlice } = await import("../dashboard-selection.js");
  const value = "x".repeat(1024);
  const slice = parseSlice(new URLSearchParams({ filters: JSON.stringify([{ field: "run", value }]) }), DASHBOARD_NOW);
  expect(compileSlice(slice).params.at(-1)).toBe(value);
  expect(() => parseSlice(new URLSearchParams({ filters: JSON.stringify([{ field: "run", value: "é".repeat(513) }]) }), DASHBOARD_NOW)).toThrow("invalid-query");
});


it.each(["open", "seed"] as const)("fixture restores owned environment when %s throws", stage => {
  const keys = ["HOME", "SPIDER_GLOBAL_ROOT", "PI_CODING_AGENT_DIR", "TMPDIR"];
  const before = keys.map(key => process.env[key]);
  const error = new Error("synthetic setup failure");
  const original = ledgerModule.openUsageLedger;
  let closed: ReturnType<typeof vi.spyOn> | undefined;
  const opener = vi.spyOn(ledgerModule, "openUsageLedger").mockImplementation(file => {
    if (stage === "open") throw error;
    const ledger = original(file);
    closed = vi.spyOn(ledger, "close");
    vi.spyOn(ledger, "apply").mockImplementationOnce(() => { throw error; });
    return ledger;
  });
  try {
    expect(() => createDashboardFixture()).toThrow(error);
    expect(keys.map(key => process.env[key])).toEqual(before);
    if (closed) expect(closed).toHaveBeenCalledOnce();
  } finally { opener.mockRestore(); closed?.mockRestore(); }
});
