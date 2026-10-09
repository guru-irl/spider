import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@spider/db-core";
import { openUsageLedger, type UsageLedger } from "../ledger.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { readCorrectedTotal } from "../query-redesign-shared.js";
import { dashboardBatch, dashboardCall } from "./fixtures/dashboard-ledger.js";
import { rateFingerprint } from "../reprice.js";
import { COPILOT_RATE_VERSIONS } from "../rates.js";
import { priceCall } from "../price.js";
import type { RateVersion } from "../types.js";

let root: string, file: string, ledger: UsageLedger, db: Db;
const day = 86400000, at = Date.parse("2026-09-15T12:00:00Z");
const historical = (id: string, extra: Parameters<typeof dashboardCall>[1] = {}) => dashboardCall(id, {
  ts: at - day, provider: "github-copilot", model: "gpt-6.1-sol",
  usage: { input: 10000, output: 0, cacheRead: 0, cacheWrite: 0 },
  price: { status: "unpriced", reason: "no-rate-at-time" }, ...extra,
});
// A missing implementation reports the absent behavior as an assertion, not a collection error.
const pass = (guard = () => true, size = 2) => (ledger as UsageLedger & {
  repriceUnpriced?: (guard: () => boolean, size?: number) => { state: string; processed: number; total: number; repriced: number; changed: number };
}).repriceUnpriced?.(guard, size);
const rows = () => db.prepare("SELECT * FROM calls ORDER BY id").all() as Record<string, unknown>[];
const priceColumns = new Set(["aic", "aic_input", "aic_output", "aic_cache_read", "aic_cache_write", "price_status", "unpriced_reason", "rate_version", "tier", "confidence"]);
const identities = () => rows().map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !priceColumns.has(key))));
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "reprice-")); file = join(root, "usage.db");
  ledger = openUsageLedger(file); db = openDb(file);
});
afterEach(() => { db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });

it("reprices pre-October detail but preserves priced, aggregate, unknown and pre-June rows and all identities", () => {
  ledger.apply(dashboardBatch([
    historical("a-detail"), historical("b-aggregate", { aggregate: true, actor: "compaction" }),
    historical("c-unknown", { model: "unknown" }), historical("d-may", { ts: Date.parse("2026-05-31T23:59:59Z") }),
    historical("e-priced", { price: { status: "priced", aic: 99, components: { input: 99, output: 0, cacheRead: 0, cacheWrite: 0 }, rateVersion: "old", tier: "default", confidence: "estimated" } }),
  ]));
  const before = rows(), identity = identities();
  expect(pass(() => true, 100)).toMatchObject({ state: "complete", processed: 3, total: 3, repriced: 1, changed: 1 });
  expect(rows()[0]).toMatchObject({ price_status: "priced", aic: 2, rate_version: "copilot-public-2026-10-04" });
  expect(rows().slice(1)).toEqual(before.slice(1)); expect(identities()).toEqual(identity);
  const revision = db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get();
  expect(pass()).toMatchObject({ state: "complete", changed: 0 });
  expect(db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get()).toEqual(revision);
});

it("resumes committed batches after reopen and rejects a lost lease without advancing its cursor", () => {
  ledger.apply(dashboardBatch(Array.from({ length: 5 }, (_, i) => historical(`call-${i}`))));
  expect(pass()).toMatchObject({ state: "running", processed: 2, total: 5, repriced: 2 });
  const before = rows();
  expect(pass(() => false)).toMatchObject({ state: "running", processed: 2, changed: 0 }); expect(rows()).toEqual(before);
  ledger.close(); ledger = openUsageLedger(file);
  expect(pass()).toMatchObject({ state: "running", processed: 4, repriced: 4 });
  expect(pass()).toMatchObject({ state: "complete", processed: 5, repriced: 5 });
  expect(ledger.summarize(at - 2 * day, at).aic).toBe(10);
});

it("a changed rate fingerprint revisits still-unpriced calls and a current one skips them", () => {
  ledger.apply(dashboardBatch([historical("unknown", { model: "unknown" })]));
  expect(pass()).toMatchObject({ state: "complete", processed: 1, repriced: 0 });
  ledger.apply(dashboardBatch([historical("later")]));
  expect(pass()).toMatchObject({ state: "complete", changed: 0 });
  expect(rows().find(row => row.id === "later")?.price_status).toBe("unpriced");
  db.prepare("UPDATE ledger_metadata SET value='old-rate-fingerprint' WHERE key='reprice-rate-fingerprint'").run();
  expect(pass()).toMatchObject({ state: "complete", processed: 2, repriced: 1 });
  expect(rows().find(row => row.id === "later")?.aic).toBe(2);
});

it("repricing invalidates cached calibration, corrected totals, reader revisions and published snapshots", () => {
  ledger.apply(dashboardBatch([historical("fit", { usage: { input: 5000000, output: 0, cacheRead: 0, cacheWrite: 0 } })]));
  // Long-context input: 5M * $4/M * 100 = 2000 credits, counter factor = 0.5.
  ledger.insertCounter({ ts: at - 2 * day, creditsUsed: 0, raw: {} });
  ledger.insertCounter({ ts: at, creditsUsed: 1000, raw: {} });
  const reader = openDashboardReader(file, { instanceId: "fixture", serverBuild: "fixture", now: () => at, calibrationMode: () => "auto" })!;
  try {
    ledger.apply(dashboardBatch([], { publishedSnapshot: {
      type: "snapshot", health: ledger.health(), backfill: "complete",
      counter: { availability: "disabled", role: "inactive", lastAttemptAt: null, lastSuccessAt: null, nextPollAt: null, snapshotAgeMs: null, errorCode: null, notice: null, latest: null },
      reconciliation: { windowStart: at - 2 * day, windowEnd: at, computedAIC: 0, counterAIC: null, gap: null, ratio: null, unpricedCalls: 1, estimated: true },
    } }));
    expect(ledger.getPublishedSnapshot()).toBeDefined();
    const before = reader.revision();
    expect(ledger.getCalibration("auto").computedAic).toBe(0);
    expect(reader.snapshot(ctx => readCorrectedTotal(ctx, { start: at - 2 * day, end: at }))).toBeNull();
    expect(pass()).toMatchObject({ state: "complete", changed: 1 });
    expect(reader.revision()).not.toBe(before);
    expect(ledger.getCalibration("auto")).toMatchObject({ status: "calibrated", computedAic: 2000, factor: 0.5 });
    expect(reader.snapshot(ctx => readCorrectedTotal(ctx, { start: at - 2 * day, end: at }))).toBe(1000);
    expect(ledger.getPublishedSnapshot()).toBeUndefined();
  } finally { reader.close(); }
});

// Dropping the cursor must not let persistent unpriced rows hide later priceable calls.
it("resumes past still-unpriceable batches after reopen without completing early", () => {
  ledger.apply(dashboardBatch([
    ...Array.from({ length: 3 }, (_, i) => historical(`unknown-${i}`, { model: "unknown" })),
    ...Array.from({ length: 3 }, (_, i) => historical(`priceable-${i}`)),
  ]));
  expect(pass()).toMatchObject({ state: "running", processed: 2, repriced: 0 });
  ledger.close(); ledger = openUsageLedger(file);
  expect(pass()).toMatchObject({ state: "running", processed: 4, repriced: 1 });
  expect(pass()).toMatchObject({ state: "complete", processed: 6, total: 6, repriced: 3 });
  expect(rows().filter(row => row.price_status === "priced")).toHaveLength(3);
  expect(rows().filter(row => row.model === "unknown").every(row => row.unpriced_reason === "no-rate-at-time")).toBe(true);
});

it("repriced component columns match fresh ingest for all nonzero token buckets", () => {
  const usage = { input: 10000, output: 3000, cacheRead: 3000, cacheWrite: 4000 };
  ledger.apply(dashboardBatch([historical("legacy-components", { usage })]));
  expect(pass()).toMatchObject({ changed: 1 });
  const legacy = rows()[0];
  ledger.apply(dashboardBatch([historical("fresh-components", {
    usage, price: priceCall({ provider: "github-copilot", id: "gpt-6.1-sol" }, usage, at - day),
  })]));
  const fresh = rows().find(row => row.id === "fresh-components")!;
  const columns = (row: Record<string, unknown>) => Object.fromEntries([...priceColumns].map(key => [key, row[key]]));
  expect(columns(legacy)).toEqual(columns(fresh));
  expect(legacy).toMatchObject({ aic_input: 2, aic_output: 3, aic_cache_read: 0.03, aic_cache_write: 1,
    price_status: "priced", unpriced_reason: null, rate_version: "copilot-public-2026-10-04", tier: "default", confidence: "estimated" });
  expect(legacy.aic).toBeCloseTo(6.03);
});

it.each([
  ["version id", (v: RateVersion[]) => { v[0].id += "-changed"; }],
  ["effective date", (v: RateVersion[]) => { v[0].effectiveFrom = "2026-06-02T00:00:00.000Z"; }],
  ["model row", (v: RateVersion[]) => { v[0].models = [...v[0].models, { ...v[0].models[0], id: "added-model" }]; }],
  ["alias", (v: RateVersion[]) => { v[0].models[0].aliases = [...v[0].models[0].aliases, "added-alias"]; }],
  ["validUntil", (v: RateVersion[]) => { v[0].models[0].validUntil = "2026-12-01T00:00:00.000Z"; }],
  ...COPILOT_RATE_VERSIONS.flatMap((version, vi) => version.models.flatMap((model, mi) => [
    [`model ${model.id} id`, (v: RateVersion[]) => { v[vi].models[mi].id += "-changed"; }] as const,
    ...model.tiers.flatMap((tier, ti) => (["input", "output", "cacheRead", "cacheWrite"] as const).map(field =>
      [`model ${model.id} ${tier.name} ${field}`, (v: RateVersion[]) => { v[vi].models[mi].tiers[ti].usdPerMillion[field] += 1; }] as const)),
  ])),
] as const)("rate fingerprint changes with %s and is stable for identical content", (_name, change) => {
  const fingerprint = rateFingerprint;
  const copy = structuredClone(COPILOT_RATE_VERSIONS) as RateVersion[];
  const original = fingerprint(COPILOT_RATE_VERSIONS);
  expect(fingerprint(copy)).toBe(original);
  change(copy);
  expect(fingerprint(copy)).not.toBe(original);
  expect(fingerprint(COPILOT_RATE_VERSIONS)).toBe(original);
});

it.each(["{", "null", "{}", '{"fingerprint":"wrong","cursor":-1}'])("corrupt progress %s resets instead of blocking health and repricing", corrupt => {
  ledger.apply(dashboardBatch([historical("recover-progress")]));
  db.prepare("INSERT INTO ledger_metadata(key,value) VALUES ('reprice-progress',?)").run(corrupt);
  expect(() => ledger.health(at)).not.toThrow();
  expect(ledger.health(at).reprice).toMatchObject({ state: "pending", processed: 0 });
  expect(pass()).toMatchObject({ state: "complete", processed: 1, repriced: 1 });
  expect(rows()[0].price_status).toBe("priced");
});

it("default reprice batch leaves candidates beyond two thousand for the next pass", () => {
  ledger.apply(dashboardBatch(Array.from({ length: 2001 }, (_, i) => historical(`bounded-${i}`))));
  expect(ledger.repriceUnpriced(() => true)).toMatchObject({ state: "running", processed: 2000, total: 2001, repriced: 2000 });
  expect(ledger.repriceUnpriced(() => true)).toMatchObject({ state: "complete", processed: 2001, repriced: 2001 });
});

it("period-scoped unpriced diagnostics use the counter reset date and count model-less calls separately", () => {
  ledger.apply(dashboardBatch([
    historical("old", { ts: Date.parse("2026-08-18"), model: "old-unknown" }),
    historical("current", { ts: Date.parse("2026-09-12"), model: "current-unknown" }),
    historical("no-model", { model: null, price: { status: "unpriced", reason: "missing-attribution" } }),
    historical("future", { ts: Date.parse("2026-10-16"), model: "future-unknown" }),
  ]));
  ledger.insertCounter({ ts: at, creditsUsed: 1, resetDate: "2026-10-10", raw: {} });
  expect(ledger.health(at)).not.toHaveProperty("unpricedModels");
  expect((ledger.health(at) as ReturnType<UsageLedger["health"]> & { unpricedBillingPeriod?: unknown }).unpricedBillingPeriod)
    .toEqual({ models: ["current-unknown"], withoutModel: 1 });
});
