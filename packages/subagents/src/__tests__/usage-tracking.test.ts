import { afterEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openDbAt, type Db } from "@spider/db-core";
import { Runner } from "../runner";
import type { ChildSpawnSpec } from "../pi-args";
import { RunStore } from "../run-store";
import { RunEventTailer } from "../event-tailer";
import { createEventGate, ownRpcChild, MAX_BUFFERED_EVENTS, MAX_BUFFERED_PERSISTED } from "../rpc-child";
import { defaultSpawner } from "../spawn-default";
import { runUsageSummary } from "../usage";
import { detachShared, adoptShared, resetSharedRegistryForTests, disposeSessionRegistries } from "../child-registry";
import { teardownAll, getChild } from "../coordinators";
import { resolve } from "node:path";
const usageWriteFailure = vi.hoisted(() => ({ disposal: false, compaction: false }));
vi.mock("@spider/db-core", async original => {
  const actual = await original<typeof import("@spider/db-core")>();
  return { ...actual, appendRunEvent: (...args: Parameters<typeof actual.appendRunEvent>) => {
    if (usageWriteFailure.compaction && args[1].type === "spider_compaction") throw Error("fixture disposal compaction failure");
    return actual.appendRunEvent(...args);
  } };
});
vi.mock("../usage", async original => {
  const actual = await original<typeof import("../usage")>();
  return { ...actual, recordRunUsage: (...args: Parameters<typeof actual.recordRunUsage>) => {
    if (usageWriteFailure.disposal) throw Error("fixture disposal usage failure");
    return actual.recordRunUsage(...args);
  } };
});
const testScratchPath = (name: string) => resolve(".spider/scratch/usage-tracking-tests", name);

const usage = { input: 10, output: 3, cacheRead: 5, cacheWrite: 2, cacheWrite1h: 1, reasoning: 2, totalTokens: 20,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 } };
const message = { type: "message_end", message: { role: "assistant", provider: "fixture", model: "requested", responseModel: "actual",
  api: "openai-responses", content: [{ type: "text", text: "report" }], stopReason: "stop", timestamp: 1, usage } };
const dbs: Db[] = [], files: string[] = [];
const streams: PassThrough[] = [];
afterEach(() => { usageWriteFailure.compaction = false; usageWriteFailure.disposal = false; teardownAll(); resetSharedRegistryForTests(); for (const s of streams.splice(0)) s.destroy(); for (const db of dbs.splice(0)) if (db.raw.open) db.close(); vi.restoreAllMocks(); for (const path of files.splice(0)) rmSync(path, { force: true }); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(mode: "rpc" | "print" = "rpc", failLaunch = false, failAccounting = false) {
  const path = testScratchPath(`usage-${randomUUID()}.db`), db = openDbAt(path, "project"); dbs.push(db); files.push(path);
  const store = new RunStore(db), reports: any[] = [], completions: string[] = [];
  let finish!: (v: { exitCode: number; result?: string }) => void;
  const exit = new Promise<{ exitCode: number; result?: string }>(r => { finish = r; });
  let gate!: ReturnType<typeof createEventGate>, sink!: (event: any) => void;
  const runner = new Runner(db, "owner", process.cwd(), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("usage-runs"), dbPath: path, childMode: mode,
    reportUsage: (run: any) => { if (failAccounting) throw Error("fixture accounting failure"); reports.push(run.id); },
    onComplete: (_run: any, status: string) => completions.push(status),
    spawn: (spec: ChildSpawnSpec) => { sink = spec.onRpcEvent!; gate = createEventGate(sink, (spec as any).model); if (failLaunch) { gate.report(message); throw Error("fixture launch failure"); } return { wait: () => exit, kill: () => finish({ exitCode: 137 }), detach() {}, bindEvents: gate.bind, unbindEvents: gate.unbind }; },
  } as any);
  return { db, store, runner, path, reports, completions, finish, bind: (sink: (e: any) => void) => gate.bind(sink), event: (e: any) => gate.report(e), sink: (e: any) => sink(e) };
}

// Break: only RPC protocol events reach the run DB, or usage lands in the lossy buffer.
it.each(["rpc", "print"] as const)("persists %s assistant usage, excludes other roles and updates the running token total", async mode => {
  const f = fixture(mode), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  f.event(message); f.event(message);
  f.event({ ...message, message: { ...message.message, role: "toolResult" } });
  expect(f.store.get(row.id)?.token_count).toBe(40);
  const rows = f.db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='spider_usage'").all(row.id) as any[];
  expect(rows.map(r => JSON.parse(r.payload))).toEqual([
    { type: "spider_usage", provider: "fixture", model: "actual", usage }, { type: "spider_usage", provider: "fixture", model: "actual", usage },
  ]);
  f.finish({ exitCode: 0, result: "report" }); await tick();
});

it("reports partial usage from a failed launch", () => {
  const f = fixture("rpc", true), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  expect(row).toMatchObject({ status: "failed", token_count: 20 });
  expect(f.reports).toEqual([row.id]);
});

it("parks usage independently of non-persisted overflow and replays before adopted finalization", async () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  f.event(message); await detachShared("owner"); f.db.close();
  f.event(message);
  for (let i = 0; i < MAX_BUFFERED_EVENTS + 10; i++) f.event({ type: "message_start", message: { role: "user", content: "noise" } });
  f.finish({ exitCode: 0, result: "report" }); await tick();
  const db = openDbAt(f.path, "project"); dbs.push(db);
  const store = new RunStore(db), reports: number[] = [];
  const next = new Runner(db, "owner", process.cwd(), { store, tailer: new RunEventTailer(db), scratchRoot: testScratchPath("usage-adopt"), dbPath: f.path,
    spawn: () => { throw Error("must adopt"); }, reportUsage: () => reports.push(store.get(row.id)!.token_count) } as any);
  expect(adoptShared("owner", entry => next.adopt(entry)).adopted).toEqual([row.id]); await tick();
  expect(store.get(row.id)?.token_count).toBe(40);
  expect(reports).toEqual([40]);
  expect(f.reports).toEqual([]);
  expect(adoptShared("owner", entry => next.adopt(entry)).adopted).toEqual([]);
});

it("preserves parked usage when a child self-finalized and is disposed without adoption", async () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  await detachShared("owner"); f.event(message); f.store.finish(row.id, { status: "done", result: "report" });
  f.finish({ exitCode: 0, result: "report" }); await tick();
  await disposeSessionRegistries("owner", "fixture shutdown");
  expect(f.store.get(row.id)?.token_count).toBe(20);
  expect(f.db.prepare("SELECT COUNT(*) n FROM run_events WHERE type='spider_usage'").get()).toEqual({ n: 1 });
});

it("reports partial usage even when the run was terminal-cancelled before its pipe closed", async () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  f.event(message); getChild("owner", row.id)!.kill("fixture killed"); await tick();
  expect(f.store.get(row.id)).toMatchObject({ status: "cancelled", token_count: 20 });
  expect(f.reports).toEqual([row.id]);
});

it("extracts authoritative usage from real RPC JSONL events", async () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  streams.push(child.stdin, child.stdout, child.stderr);
  const rpc = ownRpcChild(child as unknown as ChildProcess, "fixture", f.sink);
  child.stdout.write(JSON.stringify(message) + "\n");
  expect(f.store.get(row.id)?.token_count).toBe(20);
  child.emit("exit", 0); rpc.unbindEvents(); f.finish({ exitCode: 0, result: "report" }); await tick();
});

it("drains print-mode JSONL stdout through the production spawner", async () => {
  const seen: any[] = [];
  const handle = defaultSpawner({ argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(JSON.stringify(message) + "\n")})`],
    env: {}, cwd: process.cwd(), sessionFile: "", childMode: "print", onRpcEvent: e => seen.push(e) });
  try {
    expect((await handle.wait()).exitCode).toBe(0);
    expect(seen.filter(e => e.type === "spider_usage")).toEqual([{ type: "spider_usage", provider: "fixture", model: "actual", usage }]);
  } finally { if (handle.pid) { try { process.kill(-handle.pid, "SIGKILL"); } catch { /* fixture exited */ } } }
});

// P2: optional accounting cannot suppress completion or replace a launch failure.
it.each([false, true])("still notifies completion when accounting throws (launch failure=%s)", async launchFailure => {
  const f = fixture("rpc", launchFailure, true);
  const row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  if (!launchFailure) { f.finish({ exitCode: 0, result: "report" }); await tick(); }
  expect(f.store.get(row.id)?.status).toBe(launchFailure ? "failed" : "done");
  expect(f.completions).toEqual([launchFailure ? "failed" : "done"]);
  expect(f.db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='warning'").all(row.id)).toContainEqual({ summary: expect.stringContaining("fixture accounting failure") });
});

it("still notifies done when a self-finalized row's accounting throws", async () => {
  const f = fixture("rpc", false, true), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  f.store.finish(row.id, { status: "done", result: "self-finalized" });
  f.finish({ exitCode: 0, result: "report" }); await tick();
  expect(f.store.get(row.id)?.status).toBe("done");
  expect(f.completions).toEqual(["done"]);
  expect(f.db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='warning'").all(row.id)).toContainEqual({ summary: expect.stringContaining("fixture accounting failure") });
});

it("attributes pre-assistant compaction through defaultSpawner RPC to its requested model", async () => {
  const seen: any[] = [];
  const script = `const readline = require('node:readline');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const command = JSON.parse(line);
      if (command.type !== 'prompt') return;
      for (const event of [{type:'response', id:command.id, success:true},
        ${JSON.stringify({ type: "compaction_end", aborted: false, result: { usage } })}, {type:'agent_settled'}])
        process.stdout.write(JSON.stringify(event)+'\\n');
    });`;
  const handle = defaultSpawner({ argv: [process.execPath, "-e", script], env: {}, cwd: process.cwd(), sessionFile: "", childMode: "rpc", prompt: "fixture", model: "fixture/requested", onRpcEvent: event => seen.push(event) });
  try {
    expect((await handle.wait()).exitCode).toBe(0);
    expect(seen.filter(e => e.type === "spider_usage")).toEqual([{ type: "spider_usage", provider: "fixture", model: "requested", purpose: "compaction", compactionCount: 1, usage }]);
  } finally { if (handle.pid) { try { process.kill(-handle.pid, "SIGKILL"); } catch {} } }
});

it("records a warning when disposal replay cannot persist usage", async () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  await detachShared("owner"); f.event(message);
  f.finish({ exitCode: 0, result: "report" }); await tick();
  usageWriteFailure.disposal = true;
  await disposeSessionRegistries("owner", "fixture shutdown");
  expect(f.store.get(row.id)?.token_count).toBe(0);
  expect(f.db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='warning'").all(row.id)).toContainEqual({ summary: expect.stringContaining("fixture disposal usage failure") });
});

it("records a warning when the RPC usage sink cannot persist usage", () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, "prepare").mockImplementation(sql => {
    if (sql.startsWith("UPDATE runs SET token_count")) throw Error("fixture usage write failure");
    return prepare(sql);
  });
  f.event(message);
  expect(f.db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='warning'").all(row.id)).toContainEqual({ summary: expect.stringContaining("fixture usage write failure") });
});

const extras = [
  { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, result: { summary: "summary", usage } },
  { type: "entry_appended", entry: { type: "compaction", id: "boundary", summary: "boundary summary", fromHook: true, usage } },
  { type: "entry_appended", entry: { type: "usage", id: "warm", kind: "cache_warm", provider: "warm-provider", model: "warm-model", usage } },
  { type: "entry_appended", entry: { type: "branch_summary", id: "branch", summary: "branch summary", usage } },
];
// Break: one completion produces both a usage-derived and a boundary-derived count, or aborts count.
it("counts built-in and boundary-draft compactions once each from stored events", async () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", model: "fixture/requested", task: "fixture", context: "fresh" });
  f.event(extras[0]); // Built-in: compaction_end only, not entry_appended in pi 0.87.
  expect(runUsageSummary(f.db, row.id).compactionCount).toBe(1);
  f.event(extras[1]); // Boundary draft: entry_appended only, not compaction_end.
  expect(runUsageSummary(f.db, row.id).compactionCount).toBe(2);
  f.event({ ...extras[0], aborted: true });
  f.event({ type: "compaction_end", aborted: false, result: undefined, errorMessage: "failed" });
  f.event(extras[2]); f.event(extras[3]);
  expect(runUsageSummary(f.db, row.id).compactionCount).toBe(2);
  f.finish({ exitCode: 0, result: "report" }); await tick();
});

// Break: a forwarded usage kind is mistaken for a dedicated successful compaction signal.
it.each(["live", "buffered-before", "buffered-after"])("excludes forwarded compaction-kind usage from counts (%s)", async mode => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", model: "fixture/requested", task: "fixture", context: "fresh" });
  const forwarded = { type: "entry_appended", entry: { type: "usage", kind: "compaction", provider: "fixture", model: "requested", usage } };
  if (mode !== "live") await detachShared("owner");
  if (mode !== "buffered-after") f.event(forwarded);
  if (mode === "live") expect(runUsageSummary(f.db, row.id).compactionCount).toBeUndefined();
  f.event(extras[0]);
  if (mode === "buffered-after") f.event(forwarded);
  if (mode !== "live") f.bind(f.sink);
  expect(runUsageSummary(f.db, row.id).compactionCount).toBe(1);
  expect(f.store.get(row.id)?.token_count).toBe(40);
  expect(runUsageSummary(f.db, row.id).usage[0].usage.cost.total).toBeCloseTo(0.74);
  f.finish({ exitCode: 0, result: "report" }); await tick();
});

it.each([extras[0], extras[1]])("counts successful compactions even when model accounting is skipped ($type)", async event => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  f.event(event);
  expect(runUsageSummary(f.db, row.id)).toMatchObject({ usage: [], compactionCount: 1 });
  expect(f.store.get(row.id)?.token_count).toBe(0);
  f.finish({ exitCode: 0, result: "report" }); await tick();
});

it("counts successful compactions without usage data", async () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  f.event({ type: "compaction_end", aborted: false, result: { summary: "hook summary" } });
  f.event({ type: "entry_appended", entry: { type: "compaction", id: "hook", summary: "boundary" } });
  expect(runUsageSummary(f.db, row.id).compactionCount).toBe(2);
  f.finish({ exitCode: 0, result: "report" }); await tick();
});

it("preserves exact compaction counts when reload aggregates usage and persisted events overflow", async () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  await detachShared("owner");
  f.event(extras[0]); f.event(extras[1]); // Two unpriced compactions.
  f.event(message);
  f.event(extras[0]); f.event(extras[0]); f.event(extras[1]); // Three in one usage group.
  for (let i = 0; i < MAX_BUFFERED_PERSISTED + 10; i++) f.event({ type: "warning", message: "noise" });
  f.bind(f.sink);
  expect(runUsageSummary(f.db, row.id).compactionCount).toBe(5);
  expect(f.store.get(row.id)?.token_count).toBe(80);
  f.finish({ exitCode: 0, result: "report" }); await tick();
});

it("preserves compaction counts during never-adopted disposal replay", async () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  await detachShared("owner"); f.event(extras[0]); f.event(message); f.event(extras[1]); f.event(extras[0]);
  f.finish({ exitCode: 0, result: "report" }); await tick();
  await disposeSessionRegistries("owner", "fixture shutdown");
  expect(runUsageSummary(f.db, row.id).compactionCount).toBe(3);
});

// Break: disposal silently swallows compaction writes or omits the runner's summary.
it("records a warning when disposal replay cannot persist a count-only compaction", async () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  await detachShared("owner"); f.event({ type: "compaction_end", aborted: false, result: { summary: "hook" } });
  f.finish({ exitCode: 0, result: "report" }); await tick();
  usageWriteFailure.compaction = true;
  await disposeSessionRegistries("owner", "fixture shutdown");
  expect(f.store.get(row.id)?.status).toBe("done");
  expect(runUsageSummary(f.db, row.id).compactionCount).toBeUndefined();
  expect(f.db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='warning'").all(row.id)).toContainEqual({ summary: expect.stringContaining("fixture disposal compaction failure") });
});

it("records the runner summary for count-only compactions replayed during disposal", async () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  await detachShared("owner"); f.event({ type: "compaction_end", aborted: false, result: { summary: "hook" } });
  f.finish({ exitCode: 0, result: "report" }); await tick();
  await disposeSessionRegistries("owner", "fixture shutdown");
  expect(f.db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='spider_compaction'").all(row.id)).toEqual([{ summary: "Child compacted." }]);
});

const ignored = [
  { ...extras[0], aborted: true },
  { type: "entry_appended", entry: { type: "custom", usage } },
  { type: "entry_appended", entry: { type: "context_edit", usage } },
];
// I4: both pi protocols must include built-in and boundary compactions, cache warming and branch summaries.
it.each(["rpc", "print"] as const)("counts non-message usage through real %s JSONL without counting unrelated entries", async mode => {
  const f = fixture(mode), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  const events = [message, ...extras, ...ignored];
  if (mode === "rpc") {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    streams.push(child.stdin, child.stdout, child.stderr);
    ownRpcChild(child as unknown as ChildProcess, "fixture", f.sink);
    for (const event of events) child.stdout.write(JSON.stringify(event) + "\n");
    child.emit("exit", 0);
  } else {
    const handle = defaultSpawner({ argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(events.map(e => JSON.stringify(e)).join("\n") + "\n")})`], env: {}, cwd: process.cwd(), sessionFile: "", childMode: "print", onRpcEvent: f.sink });
    try { expect((await handle.wait()).exitCode).toBe(0); }
    finally { if (handle.pid) { try { process.kill(-handle.pid, "SIGKILL"); } catch {} } }
  }
  expect(f.store.get(row.id)?.token_count).toBe(100);
  const records = (f.db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='spider_usage' ORDER BY id").all(row.id) as any[]).map(r => JSON.parse(r.payload));
  expect(records.map(r => [r.provider, r.model, r.purpose])).toEqual([
    ["fixture", "actual", undefined], ["fixture", "actual", "compaction"], ["fixture", "actual", "compaction"],
    ["warm-provider", "warm-model", "cache_warm"], ["fixture", "actual", "branch_summary"],
  ]);
  f.finish({ exitCode: 0, result: "report" }); await tick();
});

it("uses a usage entry's own model even before an assistant message", () => {
  const seen: any[] = [], gate = createEventGate(event => seen.push(event));
  gate.report(extras[2]);
  expect(seen.filter(e => e.type === "spider_usage")).toEqual([{ type: "spider_usage", provider: "warm-provider", model: "warm-model", purpose: "cache_warm", usage }]);
});

it("preserves an unqualified run model for pre-assistant compaction", () => {
  const seen: any[] = [], gate = createEventGate(event => seen.push(event), "unqualified");
  gate.report(extras[0]);
  expect(seen.filter(e => e.type === "spider_usage")).toEqual([{ type: "spider_usage", provider: "unknown", model: "unqualified", purpose: "compaction", compactionCount: 1, usage }]);
});

it.each([extras[0], extras[1]])("persists a warning run event for compaction without a known model ($type)", async event => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  f.event(event);
  expect(f.db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='warning'").all(row.id)).toContainEqual({ summary: expect.stringContaining("model unknown") });
  f.finish({ exitCode: 0, result: "report" }); await tick();
});

it("keeps every buffered usage group when other persisted events overflow", async () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  await detachShared("owner");
  f.event(message); f.event(message); f.event(extras[0]);
  f.event({ ...message, message: { ...message.message, provider: "other" } });
  for (let i = 0; i < MAX_BUFFERED_PERSISTED + 10; i++) f.event({ type: "warning", message: "noise" });
  f.bind(f.sink);
  expect(f.store.get(row.id)?.token_count).toBe(80);
  const records = (f.db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='spider_usage'").all(row.id) as any[]).map(r => JSON.parse(r.payload));
  expect(records.map(r => [r.provider, r.model, r.purpose, r.usage.totalTokens])).toEqual([
    ["fixture", "actual", undefined, 40], ["fixture", "actual", "compaction", 20], ["other", "actual", undefined, 20],
  ]);
  f.finish({ exitCode: 0, result: "report" }); await tick();
});

it("unbinds a disposal replay sink before its DB closes so late events stay buffered", async () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  await detachShared("owner"); f.event(message);
  f.finish({ exitCode: 0, result: "report" }); await tick();
  await disposeSessionRegistries("owner", "fixture shutdown");
  f.event(message);
  const seen: any[] = []; f.bind(e => seen.push(e));
  expect(seen.filter(e => e.type === "spider_usage")).toEqual([{ type: "spider_usage", provider: "fixture", model: "actual", usage }]);
  expect(f.store.get(row.id)?.token_count).toBe(20);
});

it("namespaces accounting records without treating pi usage events as internal run usage", () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", task: "fixture", context: "fresh" });
  f.event({ type: "usage", provider: "fixture", model: "actual", usage });
  expect(f.store.get(row.id)?.token_count).toBe(0);
  f.event(message);
  expect(f.db.prepare("SELECT type FROM run_events WHERE run_id=? AND type='spider_usage'").all(row.id)).toEqual([{ type: "spider_usage" }]);
});

it.each(["rpc", "print"] as const)("attributes %s compaction before the first assistant message to the requested model", async mode => {
  const seen: any[] = [];
  if (mode === "rpc") {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    streams.push(child.stdin, child.stdout, child.stderr);
    (ownRpcChild as any)(child, "fixture", (e: any) => seen.push(e), "fixture/requested");
    child.stdout.write(JSON.stringify(extras[0]) + "\n"); child.emit("exit", 0);
  } else {
    const handle = defaultSpawner({ argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(JSON.stringify(extras[0]) + "\n")})`],
      env: {}, cwd: process.cwd(), sessionFile: "", childMode: "print", model: "fixture/requested", onRpcEvent: (e: any) => seen.push(e) } as any);
    try { expect((await handle.wait()).exitCode).toBe(0); }
    finally { if (handle.pid) { try { process.kill(-handle.pid, "SIGKILL"); } catch {} } }
  }
  expect(seen.filter(e => e.type === "spider_usage")).toEqual([{ type: "spider_usage", provider: "fixture", model: "requested", purpose: "compaction", compactionCount: 1, usage }]);
});

it("passes the run's requested model to the child usage gate before any assistant message", () => {
  const f = fixture(), row = f.runner.runAsync({ agent: "worker", model: "fixture/requested", task: "fixture", context: "fresh" });
  f.event(extras[0]);
  expect(f.store.get(row.id)?.token_count).toBe(20);
  expect(f.db.prepare("SELECT payload FROM run_events WHERE type='spider_usage'").get()).toEqual({ payload: JSON.stringify({ type: "spider_usage", provider: "fixture", model: "requested", usage, purpose: "compaction", compactionCount: 1 }) });
});
