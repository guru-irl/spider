import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb, type Db } from "@spider/db-core";
import { parseTranscript } from "../parse.js";
import { ingestOnce } from "../ingest.js";
import { openUsageLedger, type UsageLedger } from "../ledger.js";
import { openDashboardReader } from "../dashboard-reader.js";
import { queryOverviewV4 } from "../query-overview-v4.js";
import { usageDoctorLines } from "../doctor.js";
import { readUsageConfig } from "../config.js";
import { readCorrectedComponents } from "../query-redesign-shared.js";
import { readMeasure } from "../dashboard-selection.js";
import { assertUsageSchemaVersion, migrateUsageLedger } from "../migrate.js";
import { USAGE_SCHEMA_V4 } from "../schema-v4.js";
import { readFileSync } from "node:fs";
import { UsageJsonLine } from "../jsonl-projection.js";
import { unpricedReasonSql } from "../unpriced-reasons.js";
import { renderSessionRoute } from "../web/session-route.js";
import { sessionFixture } from "./fixtures/redesign-contract.js";
import { PlainDocument, descendants, elements } from "./fixtures/plain-dom.js";
import { COPILOT_RATE_VERSIONS } from "../rates.js";
import { dashboardBatch, dashboardCall } from "./fixtures/dashboard-ledger.js";

const day = 86400000, at = Date.parse("2026-10-15T12:00:00Z");
const usage = { input: 100, output: 200, cacheRead: 300, cacheWrite: 400 };
const cost = { total: 0.1, input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04 };
const header = { type: "session", id: "summary-session", timestamp: new Date(at - day).toISOString() };
const select = (provider: string | null, id = "selection", parentId: string | null = null) => ({ type: "model_change", id, parentId, provider, modelId: "fixture-model" });
const summary = (id: string, type = "compaction", extra = {}) => ({ type, id, timestamp: new Date(at - day / 2).toISOString(), usage: { ...usage, cost }, ...extra });
const call = (id: string, provider = "github-copilot") => ({ type: "message", id, timestamp: new Date(at - day / 2).toISOString(), message: { role: "assistant", provider, model: "gpt-6.1-sol", usage } });
const parse = (...entries: unknown[]) => parseTranscript(entries.map((json, i) => ({ byteOffset: i * 100, json })), { path: "synthetic/summary.jsonl", project: null, repo: null, run: null }).calls;
const legacy = (id: string, extra: Parameters<typeof dashboardCall>[1] = {}) => dashboardCall(id, {
  ts: at - day / 2, sessionId: "summary-session", actor: "compaction", aggregate: true,
  provider: null, model: null, requestedModel: null, piCost: 0.1, usage,
  price: { status: "unpriced", reason: "missing-attribution" }, ...extra,
});
let root: string, file: string, db: Db, ledger: UsageLedger;
beforeEach(() => {
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "compaction-price-")); file = join(root, "fixture.db");
  ledger = openUsageLedger(file); db = openDb(file);
});
afterEach(() => { db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });
const rows = () => db.prepare("SELECT * FROM calls ORDER BY rowid").all() as Record<string, unknown>[];

// Mutants: remove reported-cost pricing, use token rates, or flatten active-provider ancestry.
it.each(["compaction", "branch_summary"])("prices %s from pi cost with the active Copilot provider even in a mixed session", type => {
  const result = parse(header, select("github-copilot"), call("foreign", "fixture-provider"), summary("summary", type, { parentId: "selection" }));
  expect(result[1]).toMatchObject({ provider: "github-copilot", model: null, requestedModel: null, piCost: 0.1,
    price: { status: "priced", aic: 10, components: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, rateVersion: "pi-reported-cost-v1", tier: "reported-cost", confidence: "estimated" } });
});
it("keeps a known non-Copilot summary unpriced despite Copilot call evidence", () => {
  const result = parse(header, call("copilot"), select("fixture-provider"), summary("foreign", "compaction", { parentId: "selection" }));
  expect(result[1]).toMatchObject({ provider: "fixture-provider", price: { status: "unpriced", reason: "unsupported-provider" } });
});
it.each([{ evidence: [] }, { evidence: [call("copilot"), call("foreign", "fixture-provider")] }])("keeps an unknown provider unpriced without exclusive session evidence: $evidence", ({ evidence }) => {
  expect(parse(header, ...evidence, summary("unknown")).at(-1)).toMatchObject({ provider: null, price: { status: "unpriced", reason: "missing-attribution" } });
});
it("uses exclusive same-session call evidence when provider state is unknown", () => {
  expect(parse(header, summary("unknown"), call("copilot")).at(0)).toMatchObject({ provider: "github-copilot", price: { status: "priced", aic: 10 } });
});
it("preserves only supplied cost components and prices recorded zero only without tokens", () => {
  const result = parse(header, select("github-copilot"), summary("partial", "branch_summary", { parentId: "selection", usage: { ...usage, cost: { total: 0.1, input: 0.01 } } }),
    summary("zero", "compaction", { parentId: "selection", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }));
  expect(result[0].price).toMatchObject({ status: "priced", aic: 10, components: { input: 1, output: null, cacheRead: null, cacheWrite: null } });
  expect(result[1].price).toMatchObject({ status: "priced", aic: 0, components: { input: null, output: null, cacheRead: null, cacheWrite: null } });
});
it.each([undefined, { total: -1 }, { total: Infinity }, { total: Number.MAX_VALUE }])("does not fabricate a price for invalid or absent pi cost %j", invalid => {
  expect(parse(header, select("github-copilot"), summary("invalid", "compaction", { parentId: "selection", usage: { ...usage, cost: invalid } }))[0].price)
    .toEqual({ status: "unpriced", reason: "invalid-usage" });
});
it("resolves summary provider on its own branch rather than the latest selection", () => {
  const result = parse(header, select("github-copilot", "copilot"), select("fixture-provider", "foreign", "copilot"),
    summary("old-branch", "branch_summary", { parentId: "copilot" }), summary("new-branch", "compaction", { parentId: "foreign" }));
  expect(result.map(row => row.provider)).toEqual(["github-copilot", "fixture-provider"]);
  expect(result.map(row => row.price.status)).toEqual(["priced", "unpriced"]);
});

// Mutants: omit the provider from compact/persisted state or ignore stored session evidence.
it.each(["state", "evidence"])("ingests appended summaries after reopen using retained provider %s", async basis => {
  const path = join(root, "transcript.jsonl");
  writeFileSync(path, [header, basis === "state" ? select("github-copilot") : call("copilot")].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const discovery = { sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] };
  await ingestOnce(ledger, discovery, at, new AbortController().signal);
  ledger.close(); ledger = openUsageLedger(file);
  appendFileSync(path, JSON.stringify(summary("appended", "branch_summary")) + "\n");
  await ingestOnce(ledger, discovery, at, new AbortController().signal);
  expect(ledger.getSourceErrors()).toEqual([]);
  expect(rows().find(row => row.entry_id === "appended")).toMatchObject({ provider: "github-copilot", model: null, aic: 10, aic_input: 1, aic_output: 2, aic_cache_read: 3, aic_cache_write: 4, rate_version: "pi-reported-cost-v1" });
  const before = rows(); await ingestOnce(ledger, discovery, at, new AbortController().signal); expect(rows()).toEqual(before);
});
it("does not use a Copilot-only appended slice to hide mixed historical session evidence", async () => {
  const path = join(root, "mixed.jsonl");
  writeFileSync(path, [header, call("foreign", "fixture-provider")].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const discovery = { sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] };
  await ingestOnce(ledger, discovery, at, new AbortController().signal);
  appendFileSync(path, [call("copilot"), summary("unknown")].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await ingestOnce(ledger, discovery, at, new AbortController().signal);
  expect(rows().find(row => row.entry_id === "unknown")).toMatchObject({ provider: null, price_status: "unpriced", unpriced_reason: "missing-attribution" });
});

// Mutants: retain the old fingerprint, exclude aggregates, bypass the lease, or reset the cursor.
it("upgrades historical summary pricing once with resumable lease-guarded batches and unchanged facts", () => {
  ledger.apply(dashboardBatch([dashboardCall("evidence", { sessionId: "summary-session", provider: "github-copilot" }),
    legacy("one"), legacy("two"), legacy("three"), legacy("missing-cost", { piCost: null })]));
  const oldFingerprint = createHash("sha256").update(JSON.stringify(COPILOT_RATE_VERSIONS)).digest("hex");
  db.prepare("INSERT INTO ledger_metadata(key,value) VALUES ('reprice-rate-fingerprint',?)").run(oldFingerprint);
  const excluded = new Set(["provider", "aic", "aic_input", "aic_output", "aic_cache_read", "aic_cache_write", "price_status", "unpriced_reason", "rate_version", "tier", "confidence"]);
  const facts = () => rows().map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.has(key))));
  const before = facts();
  expect(ledger.repriceUnpriced(() => true, 1)).toMatchObject({ state: "running", processed: 1, total: 4, repriced: 1, changed: 1 });
  expect(ledger.repriceUnpriced(() => false, 1)).toMatchObject({ state: "running", processed: 1, changed: 0 });
  ledger.close(); ledger = openUsageLedger(file);
  expect(ledger.repriceUnpriced(() => true, 1)).toMatchObject({ state: "running", processed: 2, repriced: 2 });
  expect(ledger.repriceUnpriced(() => true, 10)).toMatchObject({ state: "complete", processed: 4, repriced: 3, changed: 1 });
  expect(rows().slice(1, 4)).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "github-copilot", raw_provider: null, model: null, aic: 10,
    aic_input: null, aic_output: null, aic_cache_read: null, aic_cache_write: null, rate_version: "pi-reported-cost-v1" })]));
  expect(facts()).toEqual(before);
  const revision = db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get();
  expect(ledger.repriceUnpriced(() => true)).toMatchObject({ state: "complete", processed: 4, total: 4, repriced: 3, changed: 0 });
  expect(db.prepare("SELECT value FROM ledger_metadata WHERE key='call-selection-revision'").get()).toEqual(revision);
});
it("historical pricing rejects mixed, foreign, absent and other-session evidence", () => {
  ledger.apply(dashboardBatch([
    dashboardCall("copilot-mixed", { sessionId: "mixed", provider: "github-copilot" }), dashboardCall("foreign-mixed", { sessionId: "mixed", provider: "fixture-provider" }),
    dashboardCall("foreign", { sessionId: "foreign", provider: "fixture-provider" }), dashboardCall("copilot-other", { sessionId: "other", provider: "github-copilot" }),
    legacy("mixed-summary", { sessionId: "mixed" }), legacy("foreign-summary", { sessionId: "foreign" }), legacy("absent-summary", { sessionId: "absent" }), legacy("null-summary", { sessionId: null }),
    legacy("explicit-foreign", { provider: "fixture-provider", sessionId: "other" }),
  ]));
  expect(ledger.repriceUnpriced(() => true)).toMatchObject({ changed: 0 });
  expect(rows().slice(4).every(row => row.price_status === "unpriced" && row.aic === null)).toBe(true);
});

// Mutants: suppress summary updates/revision or retain worker-snapshot after pricing.
it("recomputes calibration, month totals, Compaction credits and doctor unpriced diagnostics", () => {
  ledger.apply(dashboardBatch([dashboardCall("evidence", { ts: at - 3 * day, sessionId: "summary-session", provider: "github-copilot", price: { status: "priced", aic: 0, components: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, rateVersion: "fixture", tier: "fixture", confidence: "estimated" } }), legacy("summary", { piCost: 10 })]));
  ledger.insertCounter({ ts: at - 2 * day, creditsUsed: 0, raw: {} }); ledger.insertCounter({ ts: at, creditsUsed: 500, raw: {} });
  const reader = openDashboardReader(file, { instanceId: "fixture", serverBuild: "fixture", now: () => at, calibrationMode: () => "auto" })!;
  const overview = () => reader.snapshot(ctx => queryOverviewV4(ctx, { range: "month", from: at - 15 * day, to: at, tz: "UTC", unit: "credits", buckets: [] }));
  try {
    expect(ledger.getCalibration("auto").computedAic).toBe(0);
    expect(overview().flow.edges.find(edge => edge.role === "compaction")?.value.credits).toBeNull();
    ledger.apply(dashboardBatch([], { publishedSnapshot: { type: "snapshot", health: ledger.health(at), backfill: "complete",
      counter: { availability: "disabled", role: "inactive", lastAttemptAt: null, lastSuccessAt: null, nextPollAt: null, snapshotAgeMs: null, errorCode: null, notice: null, latest: null },
      reconciliation: { windowStart: at - 2 * day, windowEnd: at, computedAIC: 0, counterAIC: null, gap: null, ratio: null, unpricedCalls: 1, estimated: true } } }));
    const revision = reader.revision();
    expect(ledger.health(at).unpricedBillingPeriod).toEqual({ models: [], withoutModel: 1 });
    expect(ledger.repriceUnpriced(() => true)).toMatchObject({ state: "complete", changed: 1 });
    expect(reader.revision()).not.toBe(revision); expect(ledger.getPublishedSnapshot()).toBeUndefined();
    expect(ledger.getCalibration("auto")).toMatchObject({ status: "calibrated", computedAic: 1000, factor: 0.5, unpricedCalls: 0 });
    const view = overview();
    expect(view.total.credits).toBe(500); expect(view.pace.used).toBe(500);
    expect(view.flow.edges.find(edge => edge.role === "compaction")?.value).toMatchObject({ credits: 500, calls: 1, unpricedCalls: 0 });
    expect(ledger.summarize(at - 2 * day, at)).toMatchObject({ aic: 1000, unpricedCalls: 0 });
    expect(ledger.health(at).unpricedBillingPeriod).toEqual({ models: [], withoutModel: 0 });
    const diagnosis = usageDoctorLines({ health: ledger.health(at), backfill: "complete", errorCode: null, counter: null, reconciliation: null }, readUsageConfig({}, {}).value);
    expect(diagnosis.lines).toContain("- usage unpriced (this billing period): none");
  } finally { reader.close(); }
});

// Mutants: ignore plugin attribution, accept malformed qualifiers, or leak details.
it.each(["compaction", "branch_summary"])("uses validated details.summaryModel rate-table attribution for %s before pi cost", type => {
  const result = parse(header, select("fixture-provider"), summary("plugin", type, { parentId: "selection", details: { summaryModel: "github-copilot/gpt-6.1-sol", secret: "synthetic-private-details" } }))[0];
  expect(result).toMatchObject({ provider: "github-copilot", model: "gpt-6.1-sol", requestedModel: "gpt-6.1-sol",
    price: { status: "priced", aic: 0.323, components: { input: 0.02, output: 0.2, cacheRead: 0.003, cacheWrite: 0.1 }, tier: "default" } });
  expect(result.price.status === "priced" && result.price.rateVersion).not.toBe("pi-reported-cost-v1");
  expect(JSON.stringify(result)).not.toContain("synthetic-private-details");
});
it.each([undefined, null, 42, "", "github-copilot", "github-copilot/a/b", "GitHub-Copilot/gpt-6.1-sol", "github-copilot/model bad", "github-copilot/", "github-copilot/" + "a".repeat(115)])("ignores invalid or missing plugin summary model %j and falls back to pi cost", summaryModel => {
  expect(parse(header, select("github-copilot"), summary("plugin", "compaction", { parentId: "selection", details: { summaryModel } }))[0])
    .toMatchObject({ provider: "github-copilot", model: null, price: { status: "priced", aic: 10, rateVersion: "pi-reported-cost-v1" } });
});
it("does not use pi cost to override a valid foreign or unknown plugin model", () => {
  expect(parse(header, select("github-copilot"), summary("foreign", "compaction", { parentId: "selection", details: { summaryModel: "fixture-provider/fixture-model" } }))[0])
    .toMatchObject({ provider: "fixture-provider", model: "fixture-model", price: { status: "unpriced", reason: "unsupported-provider" } });
});
it("projects plugin summaryModel into ingested rows without retaining other details", async () => {
  const path = join(root, "plugin.jsonl");
  writeFileSync(path, [header, summary("plugin", "branch_summary", { details: { summaryModel: "github-copilot/gpt-6.1-sol", privateField: "synthetic-private-details", nested: { summaryModel: "fixture-provider/other" } } })].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await ingestOnce(ledger, { sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] }, at, new AbortController().signal);
  expect(rows()[0]).toMatchObject({ provider: "github-copilot", model: "gpt-6.1-sol", aic_input: 0.02, aic_output: 0.2, aic_cache_read: 0.003, aic_cache_write: 0.1 });
  expect(JSON.stringify(rows())).not.toContain("synthetic-private-details");
  expect(JSON.stringify(ledger.getSourceContext(path))).not.toContain("synthetic-private-details");
});

// Mutants: drop a column, rowid, index, trigger or metadata during the v4 rebuild.
it("upgrades a v4 fixture to v5 preserving every row, rowid, index and metadata key", () => {
  const old = openDb(join(root, "v4.db"));
  try {
    old.exec(readFileSync(new URL("./fixtures/usage-v3.sql", import.meta.url), "utf8")); old.exec(USAGE_SCHEMA_V4); old.pragma("user_version=4");
    old.exec(`INSERT INTO calls(id,ts,source_file,entry_id,source_generation,session_id,actor,source_kind,input,output,cache_read,cache_write,price_status,unpriced_reason,pi_cost,aggregate,counted,copied,fingerprint)
      VALUES ('summary',42,'synthetic.jsonl','summary',0,'session','compaction','transcript',1,2,3,4,'unpriced','missing-attribution',0.1,1,1,0,'summary');
      UPDATE calls SET rowid=37 WHERE id='summary';
      INSERT INTO ledger_metadata VALUES ('reprice-progress','synthetic-checkpoint');`);
    const allRows = () => Object.fromEntries((old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
      .map(({ name }) => [name, old.prepare(`SELECT * FROM "${name}"`).all()]));
    const before = allRows(), rowids = old.prepare("SELECT rowid,id FROM calls ORDER BY rowid").all();
    const objects = old.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger','view') ORDER BY type,name").all();
    migrateUsageLedger(old);
    expect(old.pragma("user_version")).toBe(5); expect(allRows()).toEqual(before);
    expect(old.prepare("SELECT rowid,id FROM calls ORDER BY rowid").all()).toEqual(rowids);
    expect(old.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger','view') ORDER BY type,name").all()).toEqual(objects);
    expect(() => assertUsageSchemaVersion(old)).not.toThrow();
    old.prepare(`UPDATE calls SET provider='github-copilot',aic=10,price_status='priced',unpriced_reason=NULL,rate_version='pi-reported-cost-v1',tier='reported-cost',confidence='estimated' WHERE id='summary'`).run();
    expect(old.prepare("SELECT aic,aic_input,aic_output,aic_cache_read,aic_cache_write FROM calls WHERE id='summary'").get()).toEqual({ aic: 10, aic_input: null, aic_output: null, aic_cache_read: null, aic_cache_write: null });
    expect(old.prepare("SELECT aic,aic_input FROM calls WHERE id='v1-call'").get()).toEqual({ aic: 10, aic_input: 1 });
    expect(() => old.prepare("UPDATE calls SET rate_version='table-rate' WHERE id='summary'").run()).toThrow(/CHECK/);
    expect(() => old.prepare("UPDATE calls SET aic_input=NULL WHERE id='v1-call'").run()).toThrow(/CHECK/);
    const after = allRows(); migrateUsageLedger(old); expect(allRows()).toEqual(after);
  } finally { old.close(); }
});

// Mutants: SUM ignores missing components or a renderer coerces null to zero.
it.each(["mixed", "reported", "rates"])("keeps %s component totals honest at the query and rendered idle-detail surface", mode => {
  const rate = dashboardCall("rate", { ts: at - day / 2, price: { status: "priced", aic: 10, components: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, rateVersion: "fixture-rate", tier: "fixture-tier", confidence: "estimated" } });
  const reported = legacy("reported", { provider: "github-copilot", price: { status: "priced", aic: 10, components: { input: null, output: null, cacheRead: null, cacheWrite: null }, rateVersion: "pi-reported-cost-v1", tier: "reported-cost", confidence: "estimated" } });
  ledger.apply(dashboardBatch(mode === "mixed" ? [rate, reported] : mode === "rates" ? [rate] : [reported]));
  const reader = openDashboardReader(file, { instanceId: "fixture", serverBuild: "fixture", now: () => at, calibrationMode: () => "off" })!;
  try {
    const measure = reader.snapshot(ctx => readMeasure(ctx, { start: at - day, end: at, filters: [] }));
    expect(measure.aic).toBe(mode === "mixed" ? 20 : 10);
    expect(measure.aicComponents).toEqual(mode === "rates" ? { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } : { input: null, output: null, cacheRead: null, cacheWrite: null });
    if (mode !== "rates") expect(reader.snapshot(ctx => readCorrectedComponents(ctx, ["reported"]).get("reported"))).toEqual({ cacheWriteCredits: null });
    const data = sessionFixture(), doc = new PlainDocument(); data.activePeriods = [{ ...data.span! }];
    data.idleGaps = [{ start: data.span!.start + 60000, end: data.span!.start + 61 * 60000, cacheWriteCredits: measure.aicComponents.cacheWrite }];
    const route = renderSessionRoute(doc.asDocument(), data, "credits", () => {}); doc.body.append(route as never);
    descendants(doc.body).find(node => node.getAttribute("data-event") === "idle")!.dispatchEvent(new Event("focus"));
    const card = descendants(doc.body).find(node => node.className === "route-card")!;
    expect(elements(card, "dd").at(-1)!.textContent).toBe(mode === "rates" ? "4" : "unavailable");
  } finally { reader.close(); }
});

it("ingests missing components as null rather than fabricated zero buckets", async () => {
  const path = join(root, "cost-only.jsonl");
  writeFileSync(path, [header, select("github-copilot"), summary("only-total", "compaction", { usage: { ...usage, cost: { total: 0.1 } } })].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await ingestOnce(ledger, { sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] }, at, new AbortController().signal);
  expect(rows()[0]).toMatchObject({ aic: 10, aic_input: null, aic_output: null, aic_cache_read: null, aic_cache_write: null });
});
it("rolls back an interrupted v5 rebuild before allowing a clean retry", () => {
  const old = openDb(join(root, "rollback-v4.db"));
  try {
    old.exec(readFileSync(new URL("./fixtures/usage-v3.sql", import.meta.url), "utf8")); old.exec(USAGE_SCHEMA_V4); old.pragma("user_version=4");
    const layout = () => old.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
    const before = layout(), facts = old.prepare("SELECT rowid,* FROM calls").all();
    const exec = old.raw.exec.bind(old.raw);
    old.raw.exec = sql => { const result = exec(sql); if (sql.startsWith("INSERT INTO calls_v5")) throw new Error("synthetic-interruption"); return result; };
    try { expect(() => migrateUsageLedger(old)).toThrow("synthetic-interruption"); } finally { old.raw.exec = exec; }
    expect(old.pragma("user_version")).toBe(4); expect(layout()).toEqual(before);
    expect(old.prepare("SELECT rowid,* FROM calls").all()).toEqual(facts);
    migrateUsageLedger(old); expect(old.pragma("user_version")).toBe(5);
  } finally { old.close(); }
});

it.each([undefined, null, "GitHub-Copilot/model", "github-copilot/model/extra", "github-copilot/" + "a".repeat(115), "github-copilot/" + "a".repeat(1024 * 1024)])("drops invalid or oversized summaryModel during streaming projection (case %#)", summaryModel => {
  const line = new UsageJsonLine();
  line.write(Buffer.from(JSON.stringify(summary("projected", "compaction", { details: { summaryModel, privateField: "synthetic-details", nested: { secret: true } } }))));
  const projected = line.finish();
  expect(projected).toMatchObject({ type: "compaction", id: "projected", usage: { cost } });
  expect(projected).not.toHaveProperty("details");
});
it("projects only a valid summaryModel on native summary entries", () => {
  const line = new UsageJsonLine();
  line.write(Buffer.from(JSON.stringify(summary("projected", "branch_summary", { details: { summaryModel: "github-copilot/gpt-6.1-sol", privateField: "synthetic-details", nested: { secret: true } } }))));
  expect(line.finish()).toMatchObject({ details: { summaryModel: "github-copilot/gpt-6.1-sol" } });
  expect(JSON.stringify(line.finish())).not.toContain("privateField");
  const other = new UsageJsonLine(); other.write(Buffer.from(JSON.stringify({ ...call("assistant"), details: { summaryModel: "github-copilot/gpt-6.1-sol" } })));
  expect(other.finish()).not.toHaveProperty("details");
});

it("resumes summary backfill beyond still-unpriceable rows after reopen", () => {
  ledger.apply(dashboardBatch([dashboardCall("evidence", { sessionId: "summary-session", provider: "github-copilot" }), legacy("no-cost", { piCost: null }), legacy("priceable"), legacy("also-priceable")]));
  expect(ledger.repriceUnpriced(() => true, 1)).toMatchObject({ state: "running", processed: 1, repriced: 0 });
  ledger.close(); ledger = openUsageLedger(file);
  expect(ledger.repriceUnpriced(() => true, 1)).toMatchObject({ state: "running", processed: 2, repriced: 1 });
  expect(ledger.repriceUnpriced(() => true, 1)).toMatchObject({ state: "complete", processed: 3, repriced: 2 });
});
it("applies the normal long-context tier to an explicitly recorded summary model", () => {
  const result = parse(header, summary("long", "compaction", { details: { summaryModel: "github-copilot/gpt-6.1-sol" }, usage: { ...usage, input: 300000, cost } }))[0];
  expect(result.price).toMatchObject({ status: "priced", tier: "long-context", components: { input: 120, output: 0.3, cacheRead: 0.006, cacheWrite: 0.2 } });
});

it("deduplicates newly ingested copies against repriced model-less historical summaries", () => {
  ledger.apply(dashboardBatch([dashboardCall("evidence", { sessionId: "summary-session", provider: "github-copilot" }), legacy("same", { sourceFile: "synthetic/native.jsonl" })]));
  expect(ledger.repriceUnpriced(() => true)).toMatchObject({ changed: 1 });
  const copied = parse(header, select("github-copilot"), summary("same"))[0];
  ledger.apply(dashboardBatch([{ ...copied, sourceFile: "synthetic/copy.jsonl", sourceGeneration: 0, copied: true, counted: true, originKey: null, sourceKind: "transcript" }]));
  expect(rows()).toHaveLength(3);
  expect(ledger.summarize(0, at)).toMatchObject({ aic: 11, pricedCalls: 2 });
});

// Removing the effective-date check or either parser call's timestamp breaks these boundaries.
const firstRateAt = Math.min(...COPILOT_RATE_VERSIONS.map(rate => Date.parse(rate.effectiveFrom)));
it.each(["state", "evidence"])("ingests reported-cost summaries at the earliest rate instant, not 1 ms before, using %s", async basis => {
  const path = join(root, "rate-boundary.jsonl");
  writeFileSync(path, [header, basis === "state" ? select("github-copilot") : call("copilot"),
    summary("before", "compaction", { timestamp: new Date(firstRateAt - 1).toISOString() }),
    summary("boundary", "branch_summary", { timestamp: new Date(firstRateAt).toISOString() }),
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await ingestOnce(ledger, { sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] }, at, new AbortController().signal);
  expect(rows().find(row => row.entry_id === "before")).toMatchObject({ price_status: "unpriced", unpriced_reason: "no-rate-at-time", aic: null });
  expect(rows().find(row => row.entry_id === "boundary")).toMatchObject({ price_status: "priced", aic: 10, rate_version: "pi-reported-cost-v1" });
});
it("historical reported-cost pricing leaves pre-rate rows unpriced and prices the boundary instant", () => {
  ledger.apply(dashboardBatch([dashboardCall("evidence", { sessionId: "summary-session", provider: "github-copilot" }),
    legacy("before", { ts: firstRateAt - 1 }), legacy("boundary", { ts: firstRateAt })]));
  const before = rows().find(row => row.entry_id === "before");
  expect(ledger.repriceUnpriced(() => true)).toMatchObject({ state: "complete", processed: 2, repriced: 1, changed: 1 });
  expect(rows().find(row => row.entry_id === "before")).toEqual(before);
  expect(rows().find(row => row.entry_id === "boundary")).toMatchObject({ price_status: "priced", aic: 10 });
  expect(ledger.repriceUnpriced(() => true)).toMatchObject({ state: "complete", changed: 0 });
});
// A totalTokens-only record or optional subset must not sneak through the zero check.
it.each(["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens"])("keeps zero reported cost unpriced with nonzero %s", field => {
  const nonzero = { input: 0, output: 0, cacheRead: 0, cacheWrite: field === "cacheWrite1h" ? 1 : 0, [field]: 1 };
  expect(parse(header, select("github-copilot"), summary("zero", "compaction", { usage: { ...nonzero, cost: { total: 0 } } }))[0].price)
    .toEqual({ status: "unpriced", reason: "reported-cost-zero" });
});
it("ingests zero reported cost as unpriced in queries and doctor, and keeps it unpriced after reprice", async () => {
  const path = join(root, "zero-cost.jsonl");
  writeFileSync(path, [header, select("github-copilot"), summary("zero", "compaction", { usage: { ...usage, cost: { total: 0 } } })]
    .map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await ingestOnce(ledger, { sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] }, at, new AbortController().signal);
  expect(rows()[0]).toMatchObject({ price_status: "unpriced", unpriced_reason: "reported-cost-zero", aic: null });
  expect(db.prepare(`SELECT ${unpricedReasonSql("unpriced_reason")} AS reason FROM calls`).get()).toEqual({ reason: "reported-cost-zero" });
  const before = rows();
  expect(ledger.repriceUnpriced(() => true)).toMatchObject({ changed: 0 });
  expect(rows()).toEqual(before);
  const diagnosis = usageDoctorLines({ health: ledger.health(at), backfill: "complete", errorCode: null, counter: null, reconciliation: null }, readUsageConfig({}, {}).value);
  expect(diagnosis.lines).toContain("- usage unpriced (this billing period): 0 models, 1 calls without a model");
  const reader = openDashboardReader(file, { instanceId: "fixture", serverBuild: "fixture", now: () => at, calibrationMode: () => "off" })!;
  try {
    const view = reader.snapshot(ctx => queryOverviewV4(ctx, { range: "month", from: at - 15 * day, to: at, tz: "UTC", unit: "credits", buckets: [] }));
    expect(view.unpriced).toEqual([{ reason: "reported-cost-zero", calls: 1 }]);
    expect(view.flow.edges.find(edge => edge.role === "compaction")?.value).toMatchObject({ credits: null, unpricedCalls: 1 });
  } finally { reader.close(); }
});
it("historical zero reported cost is priced only when every recorded token count is zero", () => {
  ledger.apply(dashboardBatch([dashboardCall("evidence", { sessionId: "summary-session", provider: "github-copilot" }),
    legacy("nonzero", { piCost: 0 }), legacy("total-only", { piCost: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 } }),
    legacy("empty", { piCost: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, totalTokens: 0 } })]));
  const before = rows().slice(1, 3);
  expect(ledger.repriceUnpriced(() => true)).toMatchObject({ processed: 3, changed: 1 });
  expect(rows().slice(1, 3)).toEqual(before);
  expect(rows().at(-1)).toMatchObject({ price_status: "priced", aic: 0 });
});

// Attributed summaries retain the pre-branch aggregate rate-table basis, even without pi cost.
it.each(["compaction", "branch_summary", "tool"])("prices a directly attributed %s at aggregate default rates, not reported cost", type => {
  const recordedUsage = { ...usage, input: 300000 };
  const entry = type === "tool" ? { ...call("explicit"), message: { role: "toolResult", provider: "github-copilot", model: "gpt-6.1-sol", usage: { ...recordedUsage, source: "compaction" } } }
    : summary("explicit", type, { provider: "github-copilot", model: "gpt-6.1-sol", usage: recordedUsage });
  expect(parse(header, select("fixture-provider"), entry)[0]).toMatchObject({ provider: "github-copilot", model: "gpt-6.1-sol",
    price: { status: "priced", aic: 60.303000000000004, components: { input: 60, output: 0.2, cacheRead: 0.003, cacheWrite: 0.1 }, tier: "aggregate-default-lower-bound" } });
});
it("does not infer billing provider for a summary that records a model without its own provider", () => {
  expect(parse(header, select("github-copilot"), summary("model-only", "compaction", { model: "gpt-6.1-sol" }))[0])
    .toMatchObject({ provider: null, model: "gpt-6.1-sol", price: { status: "unpriced", reason: "missing-attribution" } });
});

// Removing the non-string summary-details guard lets these containers exhaust the metadata budget.
it.each(["array", "object"])("streams a large %s summaryModel without losing the summary usage", shape => {
  const large = Array(400000).fill(123);
  const bytes = Buffer.from(JSON.stringify(summary("large-details", "compaction", { details: { summaryModel: shape === "array" ? large : { values: large } } })));
  const line = new UsageJsonLine();
  for (let start = 0; start < bytes.length; start += 65536) line.write(bytes.subarray(start, start + 65536));
  const projected = line.finish();
  expect(projected).toMatchObject({ type: "compaction", id: "large-details", usage: { ...usage, cost } });
  expect(projected).not.toHaveProperty("details");
  expect(parse(header, select("github-copilot"), projected)[0].price).toMatchObject({ status: "priced", aic: 10 });
});
// Including a rewritten source's old rows poisons the new generation's provider evidence.
it("discards foreign provider evidence from a rewritten source before pricing the new generation", async () => {
  const path = join(root, "rewritten.jsonl");
  const discovery = { sources: [{ path, project: null, repo: null, run: null }], runs: [], errors: [] };
  writeFileSync(path, [header, call("old-foreign", "fixture-provider")].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await ingestOnce(ledger, discovery, at, new AbortController().signal);
  const generation = ledger.getImportState(path)!.generation;
  expect(ledger.getSessionProviders("summary-session")).toEqual(["fixture-provider"]);
  ledger.close(); ledger = openUsageLedger(file);
  writeFileSync(path, [header, call("new-copilot"), summary("new-summary")].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  await ingestOnce(ledger, discovery, at, new AbortController().signal);
  expect(ledger.getSourceErrors()).toEqual([]);
  expect(ledger.getImportState(path)!.generation).toBe(generation + 1);
  expect(rows().some(row => row.entry_id === "old-foreign")).toBe(false);
  expect(rows().find(row => row.entry_id === "new-summary")).toMatchObject({ provider: "github-copilot", raw_provider: null, model: null, aic: 10, rate_version: "pi-reported-cost-v1" });
});
// Without model IS NULL, attributed aggregate rows are incorrectly eligible for the reported-cost pass.
it("excludes modeled aggregate summaries from historical reported-cost candidates", () => {
  ledger.apply(dashboardBatch([dashboardCall("evidence", { sessionId: "summary-session", provider: "github-copilot" }),
    legacy("unknown-model", { provider: "github-copilot", model: "unknown-fixture-model", price: { status: "unpriced", reason: "unknown-model" } }),
    legacy("known-model", { provider: "github-copilot", model: "gpt-6.1-sol" }),
    legacy("model-only", { model: "gpt-6.1-sol" }), legacy("model-less")]));
  const before = rows().slice(1, 4);
  expect(ledger.repriceUnpriced(() => true)).toMatchObject({ state: "complete", processed: 1, total: 1, changed: 1 });
  expect(rows().slice(1, 4)).toEqual(before);
  expect(rows().at(-1)).toMatchObject({ price_status: "priced", aic: 10 });
});
