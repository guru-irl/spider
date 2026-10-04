import { afterEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import { RunStore, recordRunUsage } from "@spider/subagents";
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
  return { db, runs, id };
}
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
  vi.spyOn(f.db, "prepare").mockImplementation(sql => { if (sql.startsWith("SELECT payload FROM run_events")) scans++; return prepare(sql); });
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
