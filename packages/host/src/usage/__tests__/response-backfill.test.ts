import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@spider/db-core";
import { openUsageLedger, type UsageLedger } from "../ledger.js";
import { backfillResponseMetadata, forgetResponseMetadata } from "../response-backfill.js";
import { dashboardBatch, dashboardCall } from "./fixtures/dashboard-ledger.js";
import type { Discovery, SourceInfo } from "../discovery.js";

let root: string, ledger: UsageLedger, db: Db;
const at = Date.parse("2026-10-04T12:00:00Z");
const signal = () => new AbortController().signal;
function source(name: string): SourceInfo { return { path: join(root, `${name}.jsonl`), project: null, repo: null, run: null }; }
const discovery = (sources: SourceInfo[]): Discovery => ({ sources, runs: [], errors: [] });
function line(id: string, extra = {}) { return { type: "message", id, timestamp: new Date(at).toISOString(), message: {
  role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", thinkingLevel: "low", durationMs: 32, latencyMs: 99,
  usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }, ...extra,
} }; }
function write(s: SourceInfo, entries: unknown[]) { writeFileSync(s.path, entries.map(e => JSON.stringify(e)).join("\n") + "\n"); }
function seed(s: SourceInfo, ids: string[]) {
  const info = statSync(s.path);
  ledger.apply(dashboardBatch(ids.map(id => dashboardCall(id, { sourceFile: s.path })), { states: [{ path: s.path,
    inode: `${info.dev}:${info.ino}`, size: info.size, offset: info.size, mtimeMs: info.mtimeMs, generation: 0, parseErrors: 0, prefixHash: "fixture" }] }));
}
const metadata = () => db.prepare("SELECT entry_id,latency_ms,thinking_level,provider_thinking_level,tool_call_id,tool_duration_ms FROM calls ORDER BY entry_id").all();
function billing() {
  const columns = (db.prepare("PRAGMA table_xinfo(calls)").all() as { name: string }[]).map(c => c.name)
    .filter(name => !["latency_ms", "thinking_level", "provider_thinking_level", "tool_call_id", "tool_duration_ms"].includes(name));
  return { calls: db.prepare(`SELECT rowid,${columns.join(",")} FROM calls ORDER BY id`).all(),
    selected: db.prepare("SELECT id FROM selected_usage_calls ORDER BY id").all(), cursors: db.prepare("SELECT * FROM import_state ORDER BY path").all() };
}
beforeEach(() => { root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "response-backfill-")); ledger = openUsageLedger(join(root, "usage.db")); db = openDb(join(root, "usage.db")); });
afterEach(() => { vi.restoreAllMocks(); db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });

it("resumes after reopening the ledger without touching billing, attribution or import cursors", async () => {
  const s = source("history"); write(s, [line("one"), line("two", { thinkingLevel: "high", providerThinkingLevel: "native", durationMs: 45 }), line("not-stored")]); seed(s, ["one", "two"]);
  const before = billing(), budget = Buffer.byteLength(JSON.stringify(line("one"))) + 1;
  const first = await backfillResponseMetadata(ledger, discovery([s]), at, signal(), () => true, budget);
  expect(first).toMatchObject({ complete: false, bytesRead: budget, sourcesCompleted: 0 });
  expect(ledger.getResponseMetadataCheckpoint(s.path)).toMatchObject({ offset: budget, complete: false });
  expect(metadata()[0]).toMatchObject({ latency_ms: 32, thinking_level: "low" });
  expect(metadata()[1]).toMatchObject({ latency_ms: null, thinking_level: null });
  ledger.close(); forgetResponseMetadata(s.path); ledger = openUsageLedger(join(root, "usage.db"));
  const next = await backfillResponseMetadata(ledger, discovery([s]), at, signal(), () => true, 65536);
  expect(next).toMatchObject({ complete: true, sourcesCompleted: 1, sourcesUnavailable: 0 });
  expect(next.bytesRead).toBe(statSync(s.path).size - budget);
  expect(metadata()[1]).toMatchObject({ latency_ms: 45, thinking_level: "high", provider_thinking_level: "native" });
  expect(billing()).toEqual(before);
  expect((await backfillResponseMetadata(ledger, discovery([s]), at, signal(), () => true, 65536)).bytesRead).toBe(0);
});

it("fills top-level provider effort and tool result metadata without inferring response thinking from session state", async () => {
  const s = source("kinds");
  const tool = (id: string, extra = {}) => line(id, { role: "toolResult", toolCallId: "shared", durationMs: 19, thinkingLevel: "not-response", ...extra });
  write(s, [{ type: "thinking_level_change", id: "selection", thinkingLevel: "high" }, line("own", { thinkingLevel: undefined }),
    { type: "usage", id: "warm", kind: "cache_warm", timestamp: new Date(at).toISOString(), durationMs: 17,
      providerThinkingLevel: "provider-only", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    tool("tool-one"), tool("tool-two"), tool("nested", { parentToolCallId: "parent" })]);
  seed(s, ["own", "warm", "tool-one", "tool-two", "nested"]); const before = billing();
  await backfillResponseMetadata(ledger, discovery([s]), at, signal(), () => true, 65536);
  const rows = metadata();
  expect(rows.find((r: any) => r.entry_id === "warm")).toMatchObject({ latency_ms: 17, thinking_level: null, provider_thinking_level: "provider-only" });
  expect(rows.find((r: any) => r.entry_id === "own")).toMatchObject({ latency_ms: 32, thinking_level: null });
  expect(rows.find((r: any) => r.entry_id === "tool-one")).toMatchObject({ latency_ms: null, thinking_level: null, tool_call_id: "shared", tool_duration_ms: 19 });
  expect(rows.find((r: any) => r.entry_id === "tool-two")).toMatchObject({ tool_call_id: null, tool_duration_ms: 19 });
  expect(rows.find((r: any) => r.entry_id === "nested")).toMatchObject({ tool_call_id: null, tool_duration_ms: null });
  expect(billing()).toEqual(before);
});

it("bounds huge lines across sources and only checkpoints complete lines", async () => {
  const sources = [source("one"), source("two")];
  for (const [i, s] of sources.entries()) { write(s, [line(`call-${i}`, { content: "private".repeat(20000) })]); seed(s, [`call-${i}`]); }
  const before = billing(); let done = false, passes = 0;
  while (!done && passes++ < 30) {
    const result = await backfillResponseMetadata(ledger, discovery(sources), at, signal(), () => true, 16384);
    expect(result.bytesRead).toBeLessThanOrEqual(16384); done = result.complete;
    expect(billing()).toEqual(before);
  }
  expect(done).toBe(true); expect(passes).toBeGreaterThan(2);
  expect(metadata().map((r: any) => r.latency_ms)).toEqual([32, 32]);
});

it("unavailable sources retain rows and recover independently after restart", async () => {
  const s = source("missing"); write(s, [line("old")]); seed(s, ["old"]); const before = billing();
  renameSync(s.path, `${s.path}.parked`);
  expect(await backfillResponseMetadata(ledger, discovery([s]), at, signal(), () => true, 65536))
    .toMatchObject({ complete: true, sourcesCompleted: 0, sourcesUnavailable: 1, bytesRead: 0 });
  expect(ledger.getResponseMetadataCheckpoint(s.path)?.errorCode).toBe("missing-source");
  ledger.close(); ledger = openUsageLedger(join(root, "usage.db")); renameSync(`${s.path}.parked`, s.path);
  expect(await backfillResponseMetadata(ledger, discovery([s]), at, signal(), () => true, 65536))
    .toMatchObject({ complete: true, sourcesCompleted: 1, sourcesUnavailable: 0 });
  expect(metadata()[0]).toMatchObject({ latency_ms: 32 }); expect(billing()).toEqual(before);
});

it("lost lease and abort discard response updates and their checkpoint together", async () => {
  const s = source("fenced"); write(s, [line("old")]); seed(s, ["old"]); let guards = 0;
  await backfillResponseMetadata(ledger, discovery([s]), at, signal(), () => ++guards === 1, 65536);
  expect(metadata()[0]).toMatchObject({ latency_ms: null }); expect(ledger.getResponseMetadataCheckpoint(s.path)).toBeUndefined();
  const controller = new AbortController(); controller.abort();
  await backfillResponseMetadata(ledger, discovery([s]), at, controller.signal, () => true, 65536);
  expect(ledger.getResponseMetadataCheckpoint(s.path)).toBeUndefined();
  await backfillResponseMetadata(ledger, discovery([s]), at, signal(), () => true, 65536);
  expect(metadata()[0]).toMatchObject({ latency_ms: 32 });
});

it("replays a replaced source after restart and resumes an append from its own checkpoint", async () => {
  const s = source("replace"); write(s, [line("old", { thinkingLevel: undefined, durationMs: undefined, latencyMs: undefined })]); seed(s, ["old"]);
  await backfillResponseMetadata(ledger, discovery([s]), at, signal(), () => true, 65536);
  forgetResponseMetadata(s.path); renameSync(s.path, `${s.path}.old`); write(s, [line("old")]);
  expect((await backfillResponseMetadata(ledger, discovery([s]), at, signal(), () => true, 65536)).bytesRead).toBe(statSync(s.path).size);
  expect(metadata()[0]).toMatchObject({ latency_ms: 32 }); const size = statSync(s.path).size;
  appendFileSync(s.path, JSON.stringify(line("new")) + "\n");
  expect((await backfillResponseMetadata(ledger, discovery([s]), at, signal(), () => true, 65536)).bytesRead).toBe(statSync(s.path).size - size);
  expect(ledger.getProgress().calls).toBe(1);
});

it("keeps an unterminated tail partial and replays it once it is finished", async () => {
  const s = source("torn"), body = JSON.stringify(line("old")); writeFileSync(s.path, body.slice(0, -10)); seed(s, ["old"]);
  expect((await backfillResponseMetadata(ledger, discovery([s]), at, signal(), () => true, 65536)).complete).toBe(false);
  expect(ledger.getResponseMetadataCheckpoint(s.path)).toMatchObject({ offset: 0, complete: false });
  appendFileSync(s.path, body.slice(-10) + "\n");
  expect((await backfillResponseMetadata(ledger, discovery([s]), at, signal(), () => true, 65536)).complete).toBe(true);
  expect(metadata()[0]).toMatchObject({ latency_ms: 32 });
});
