import { afterEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDbAt, appendRunEvent, type Db } from "@spider/db-core";
import { RunStore, recordRunUsage, Runner, RunEventTailer } from "@spider/subagents";
import { createEventGate } from "../../../subagents/src/rpc-child";
import { AgentStore, AgentDetail } from "@spider/ui";
import { makeAsyncNotifier } from "../../../subagents/src/actions/run";
import { createRunSource } from "../agents/run-source";
import { renderSubagentDone, renderSpiderResult } from "../render-result";
const dbs: Db[] = [], files: string[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.restoreAllMocks(); for (const path of files.splice(0)) rmSync(path, { force: true }); });
const theme = { fg: (_t: string, s: string) => s, bg: (_t: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s, glyph: "🕸" };
const usage = { input: 1_000_000, output: 200_000, cacheRead: 0, cacheWrite: 0, totalTokens: 1_200_000,
  cost: { input: 0.5, output: 0.34, cacheRead: 0, cacheWrite: 0, total: 0.84 } };
function fixture() {
  const path = resolve(`.spider/scratch/usage-display/display-${randomUUID()}.db`), db = openDbAt(path, "project"); dbs.push(db); files.push(path);
  const runs = new RunStore(db), { id } = runs.create({ sessionId: "owner", agent: "worker", name: "fixture" }); runs.start(id);
  return { db, runs, id, path };
}
// Break: an unknown-model compaction is omitted, a warm usage memo is stale, or a surface drops the count.
it("renders two stored compactions, including one with unknown model, on every usage surface", async () => {
  const f = fixture(), messages: any[] = [];
  let event!: (event: Record<string, any>) => void;
  let finish!: (value: { exitCode: number; result: string }) => void;
  const exit = new Promise<{ exitCode: number; result: string }>(resolve => { finish = resolve; });
  const runner = new Runner(f.db, "owner", process.cwd(), {
    store: f.runs, tailer: new RunEventTailer(f.db), dbPath: f.path,
    scratchRoot: resolve(".spider/scratch/usage-display/runs"),
    onComplete: makeAsyncNotifier({ db: f.db, pi: { sendMessage: (m: any) => messages.push(m) } }),
    spawn: spec => {
      event = createEventGate(spec.onRpcEvent).report;
      return { wait: () => exit, kill: () => finish({ exitCode: 137, result: "killed fixture" }), detach() {} };
    },
  });
  const run = runner.runAsync({ agent: "worker", name: "compactor", task: "fixture", context: "fresh" });
  const source = createRunSource(f.db, "owner"), store = new AgentStore(source); store.start();
  try {
    expect(source.getRun(run.id)?.compactionCount).toBeUndefined(); // Warm cache with no data.
    event({ type: "compaction_end", aborted: false, result: { summary: "first", usage } });
    expect(new AgentDetail(store, run.id, theme).render(120).join("\n")).toContain("1 compaction");
    event({ type: "message_start", message: { role: "assistant", provider: "fixture", model: "actual" } });
    event({ type: "entry_appended", entry: { type: "compaction", id: "boundary", summary: "second", usage } });
    const want = "1.2M tokens · $0.84 · 2 compactions";
    expect(new AgentDetail(store, run.id, theme).render(120).join("\n")).toContain(want);
    const restored = new AgentStore(createRunSource(f.db, "owner")); restored.start();
    try { expect(new AgentDetail(restored, run.id, theme).render(120).join("\n")).toContain(want); }
    finally { restored.stop(); }
    finish({ exitCode: 0, result: "fixture report" }); await new Promise(resolve => setImmediate(resolve));
    expect(messages[0].content.split("\n")[1]).toBe("1,200,000 tokens · $0.84 · 2 compactions");
    expect(messages[0].details.compactionCount).toBe(2);
    for (const expanded of [false, true]) {
      expect(renderSubagentDone(messages[0], { expanded }, theme).render(120).join("\n")).toContain(want);
      const result = { details: { run: source.getRun(run.id) } };
      expect(renderSpiderResult(result, { expanded }, theme, { args: { action: "run" } }).render(120).join("\n")).toContain(want);
    }
  } finally { finish({ exitCode: 0, result: "fixture report" }); await new Promise(resolve => setImmediate(resolve)); store.stop(); }
});

it("refreshes and caches count-only compactions without per-render event scans", () => {
  const f = fixture(), source = createRunSource(f.db, "owner");
  const off = source.subscribe(() => {});
  const prepare = f.db.prepare.bind(f.db); let scans = 0;
  vi.spyOn(f.db, "prepare").mockImplementation(sql => { if (sql.startsWith("SELECT payload")) scans++; return prepare(sql); });
  try {
    expect(source.getRun(f.id)?.compactionCount).toBeUndefined();
    appendRunEvent(f.db, { runId: f.id, sessionId: "owner", ts: 1, type: "spider_compaction", payload: { count: 1 } });
    expect(source.getRun(f.id)?.compactionCount).toBe(1);
    expect(source.getRun(f.id)?.compactionCount).toBe(1);
    expect(source.listActive().find(row => row.id === f.id)?.compactionCount).toBe(1);
    expect(scans).toBe(2);
  } finally { off(); }
});

it.each([undefined, 0, 1, 3])("renders matching run-card and completion suffixes (count=%s)", count => {
  const f = fixture(), messages: any[] = [];
  recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage });
  for (let i = 0; i < (count ?? 0); i++) appendRunEvent(f.db, { runId: f.id, sessionId: "owner", ts: i, type: "spider_compaction", payload: { count: 1 } });
  f.runs.finish(f.id, { status: "done", result: "fixture report" });
  makeAsyncNotifier({ db: f.db, pi: { sendMessage: (m: any) => messages.push(m) } })(f.runs.get(f.id), "done", "fixture report");
  const suffix = count ? ` · ${count} compaction${count === 1 ? "" : "s"}` : "";
  expect(messages[0].content.split("\n")[1]).toBe(`1,200,000 tokens · $0.84${suffix}`);
  for (const expanded of [false, true]) {
    const card = renderSpiderResult({ details: { run: { ...f.runs.get(f.id), cost: 0.84, compactionCount: count } } }, { expanded }, theme, { args: { action: "run" } }).render(120).join("\n");
    const completionSuffix = messages[0].content.split("\n")[1].slice("1,200,000 tokens · $0.84".length);
    expect(card).toContain(`1.2M tokens · $0.84${completionSuffix}`);
    expect(completionSuffix).toBe(suffix);
    if (!count) expect(card).not.toContain("compaction");
    const rendered = renderSubagentDone(messages[0], { expanded }, theme).render(120).join("\n");
    expect(rendered).toContain(`1.2M tokens · $0.84${suffix}`);
    if (!count) expect(rendered).not.toContain("compaction");
  }
});

it("sums chain compactions in the existing completion usage lookup", () => {
  const f = fixture(), messages: any[] = [];
  const { id: second } = f.runs.create({ sessionId: "owner", agent: "worker" });
  recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage }, "compaction", 1);
  recordRunUsage(f.db, second, { provider: "fixture", model: "actual", usage }, "compaction", 1);
  const rows = [f.runs.get(f.id), f.runs.get(second)];
  makeAsyncNotifier({ db: f.db, pi: { sendMessage: (m: any) => messages.push(m) } })(rows[1], "done", "fixture report", rows);
  expect(messages[0].content.split("\n")[1]).toBe("2,400,000 tokens · $1.68 · 2 compactions");
});

it("shows unpriced compactions on a terminal run even without accounted tokens", () => {
  const result = { details: { run: { status: "done", token_count: 0, compactionCount: 1 } } };
  expect(renderSpiderResult(result, { expanded: true }, theme, { args: { action: "run" } }).render(120).join("\n")).toContain("0 tokens · 1 compaction");
});

// Break: the host omits event costs from source rows, or the UI hides live and restored totals.
it("injects live and restored tokens and cost into the agents run detail", () => {
  const f = fixture(), store = new AgentStore(createRunSource(f.db, "owner")); store.start();
  try {
    recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage });
    expect(new AgentDetail(store, f.id, theme).render(120).join("\n")).toContain("1.2M tokens · $0.84");
    store.stop();
    const restored = new AgentStore(createRunSource(f.db, "owner")); restored.start();
    try { expect(new AgentDetail(restored, f.id, theme).render(120).join("\n")).toContain("1.2M tokens · $0.84"); }
    finally { restored.stop(); }
  } finally { store.stop(); }
});
it("memoizes run cost across getRun and listActive until token_count changes", () => {
  const f = fixture(), source = createRunSource(f.db, "owner");
  recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage });
  const prepare = f.db.prepare.bind(f.db); let scans = 0;
  vi.spyOn(f.db, "prepare").mockImplementation(sql => { if (sql.startsWith("SELECT payload")) scans++; return prepare(sql); });
  expect(source.getRun(f.id)?.cost).toBe(0.84);
  expect(source.getRun(f.id)?.cost).toBe(0.84);
  expect(source.listActive()[0]?.cost).toBe(0.84);
  expect(scans).toBe(1);
  recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage });
  expect(source.listActive()[0]?.cost).toBe(1.68);
  expect(source.getRun(f.id)?.cost).toBe(1.68);
  expect(scans).toBe(2);
});

// Break: a zero totalTokens record leaves token_count unchanged, hiding its new cost in the memo.
it("refreshes memoized cost when usage has zero totalTokens but nonzero components", () => {
  const f = fixture(), source = createRunSource(f.db, "owner");
  recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage });
  expect(source.getRun(f.id)?.cost).toBe(0.84);
  recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage: { ...usage, cacheRead: 300_000, cacheWrite: 50_000, totalTokens: 0 } });
  // Warm memo must expose the second cost even though the provider omitted the total.
  expect(source.getRun(f.id)?.cost).toBe(1.68);
  expect(source.listActive()[0]?.cost).toBe(1.68);
  expect(f.runs.get(f.id)?.token_count).toBe(2_750_000);
});

// Break N2: replacing an authoritative provider total with the component sum.
it("keeps a nonzero provider total even when it differs from the component sum", () => {
  const f = fixture();
  recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage: { ...usage, totalTokens: 1_500_000 } });
  expect(f.runs.get(f.id)?.token_count).toBe(1_500_000);
  expect(createRunSource(f.db, "owner").getRun(f.id)?.token_count).toBe(1_500_000);
});

it("shows priced run usage in both collapsed and expanded subagent completion messages", () => {
  const f = fixture(), messages: any[] = [];
  recordRunUsage(f.db, f.id, { provider: "fixture", model: "actual", usage }); f.runs.finish(f.id, { status: "done", result: "fixture report" });
  makeAsyncNotifier({ db: f.db, pi: { sendMessage: (m: any) => messages.push(m) } })(f.runs.get(f.id), "done", "fixture report");
  expect(messages[0].details).toMatchObject({ tokenCount: 1_200_000, cost: 0.84 });
  expect(messages[0].content).toContain("tokens · $0.84");
  for (const expanded of [false, true]) expect(renderSubagentDone(messages[0], { expanded }, theme).render(120).join("\n")).toContain("1.2M tokens · $0.84");
});

it.each([undefined, 0, 0.84])("shows only known cost on terminal dispatch rows (cost=%s)", cost => {
  const result = { content: [{ type: "text", text: "failed" }], details: { run: { id: "fixture", agent: "worker", status: "failed", token_count: 1_200_000, cost } } };
  const text = renderSpiderResult(result, { expanded: true }, theme, { args: { action: "run" } }).render(120).join("\n");
  expect(text).toContain("1.2M tokens");
  if (cost === undefined) expect(text).not.toContain("$");
  else expect(text).toContain(cost === 0 ? "$0.00" : "$0.84");
});

it.each(["queued", "running", "done", "failed", "cancelled"])("hides empty usage on a %s run result", status => {
  const result = { content: [{ type: "text", text: "dispatched" }], details: { run: { id: "fixture", agent: "worker", status, token_count: 0 } } };
  expect(renderSpiderResult(result, { expanded: true }, theme, { args: { action: "run" } }).render(120).join("\n")).not.toContain("0 tokens");
});
