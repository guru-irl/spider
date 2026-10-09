import { afterEach, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { openDbAt, type Db } from "@spider/db-core";
import { RunStore, recordRunUsage } from "@spider/subagents";
import { AgentStore, AgentDetail } from "@spider/ui";
import { makeAsyncNotifier } from "../../../subagents/src/actions/run";
import { createRunSource } from "../agents/run-source";
import { renderSpiderResult, renderSubagentDone } from "../render-result";
import { makeRunCostFormatter } from "../run-credits";

const dbs: Db[] = [], files: string[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const file of files.splice(0)) rmSync(file, { force: true }); });
const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s, glyph: "🕸" };
const usage = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200,
  cost: { input: 0.2, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
function fixture() {
  const file = resolve(`.spider/scratch/credits-tui/fixture-${randomUUID()}.db`);
  const db = openDbAt(file, "project"); dbs.push(db); files.push(file);
  const runs = new RunStore(db), { id } = runs.create({ sessionId: "owner", agent: "worker" });
  recordRunUsage(db, id, { provider: "github-copilot", model: "fixture", usage }, "compaction", 1);
  runs.finish(id, { status: "done", result: "fixture output" });
  return { db, runs, id };
}
// Break: the run card ignores its host-owned formatter or the provider attribution is lost.
it("renders injected credit text on collapsed and expanded run cards", () => {
  const f = fixture(), row = createRunSource(f.db, "owner").getRun(f.id);
  const formatRunCost = (costs: readonly { provider?: string; cost: number }[]) => {
    expect(costs).toEqual([{ provider: "github-copilot", cost: 0.3 }]);
    return "60 credits";
  };
  for (const expanded of [false, true]) {
    expect(renderSpiderResult({ details: { run: row } }, { expanded }, theme, { args: { action: "run" }, formatRunCost }).render(120).join("\n"))
      .toContain("1.2k tokens · 60 credits · 1 compaction");
  }
});
// Break: the agents store drops usage attribution or does not use the current formatter on render.
it("renders the latest credit text on the agents detail without rescanning usage", () => {
  const f = fixture(); let text = "60 credits";
  const store = new AgentStore(createRunSource(f.db, "owner"), Date.now, () => text); store.start();
  try {
    const detail = new AgentDetail(store, f.id, theme);
    expect(detail.render(120).join("\n")).toContain("1.2k tokens · 60 credits · 1 compaction");
    text = "90 credits";
    expect(detail.render(120).join("\n")).toContain("1.2k tokens · 90 credits · 1 compaction");
  } finally { store.stop(); }
});
// Break: the notifier does not persist converted text or the completion renderer discards it.
it("persists injected credits in new completion notices and renders them on both views", () => {
  const f = fixture(), messages: any[] = [];
  makeAsyncNotifier({ db: f.db, formatRunCost: () => "60 credits", pi: { sendMessage: (message: any) => messages.push(message) } })
    (f.runs.get(f.id), "done", "fixture output");
  expect(messages[0].content.split("\n")[1]).toBe("1,200 tokens · 60 credits · 1 compaction");
  for (const expanded of [false, true]) expect(renderSubagentDone(messages[0], { expanded }, theme).render(120).join("\n"))
    .toContain("1.2k tokens · 60 credits · 1 compaction");
});

// Break: one surface drops provider splitting, the correction, formatting, or the compaction suffix.
it.each([
  { name: "calibrated", factor: 2, provider: "github-copilot", cost: 0.3, want: "60 credits" },
  { name: "published", provider: "github-copilot", cost: 0.3, want: "30 credits" },
  { name: "non-Copilot", factor: 2, provider: "other-provider", cost: 0.3, want: "$0.30" },
  { name: "unknown", factor: 2, provider: "unknown", cost: 0.3, want: "$0.30" },
  { name: "mixed", factor: 2, provider: "github-copilot", cost: 0.06, other: 0.4, want: "12 credits + $0.40" },
  { name: "tiny", provider: "github-copilot", cost: 0.0001, want: "<0.1 credits" },
  { name: "separators", provider: "github-copilot", cost: 12.345, want: "1,235 credits" },
])("renders $name credits on every surface using real host conversion", item => {
  const f = fixture();
  // Replace only fixture events, retaining the compaction count through the next record.
  f.db.prepare("DELETE FROM run_events WHERE run_id=?").run(f.id);
  f.db.prepare("UPDATE runs SET token_count=0 WHERE id=?").run(f.id);
  recordRunUsage(f.db, f.id, { provider: item.provider, model: "fixture", usage: { ...usage, cost: { ...usage.cost, total: item.cost } } }, "compaction", 1);
  if (item.other !== undefined) recordRunUsage(f.db, f.id, { provider: "other-provider", model: "fixture", usage: { ...usage, totalTokens: 0, input: 0, output: 0, cost: { ...usage.cost, total: item.other } } });
  const formatRunCost = makeRunCostFormatter(() => item.factor === undefined ? undefined : { calibration: { status: "calibrated", factor: item.factor } });
  const source = createRunSource(f.db, "owner"), store = new AgentStore(source, Date.now, formatRunCost); store.start();
  const want = `1.2k tokens · ${item.want} · 1 compaction`;
  try { expect(new AgentDetail(store, f.id, theme).render(120).join("\n")).toContain(want); }
  finally { store.stop(); }
  const messages: any[] = [];
  makeAsyncNotifier({ db: f.db, formatRunCost, pi: { sendMessage: (message: any) => messages.push(message) } })(f.runs.get(f.id), "done", "fixture output");
  expect(messages[0].content.split("\n")[1]).toBe(`1,200 tokens · ${item.want} · 1 compaction`);
  for (const expanded of [false, true]) {
    expect(renderSpiderResult({ details: { run: source.getRun(f.id) } }, { expanded }, theme, { args: { action: "run" }, formatRunCost }).render(120).join("\n")).toContain(want);
    expect(renderSubagentDone(messages[0], { expanded }, theme).render(120).join("\n")).toContain(want);
  }
});

// Break: old persisted completion details are inferred from their model and rewritten to credits.
it("keeps old persisted dollar notices unchanged even with a Copilot model", () => {
  const message = { details: { status: "done", model: "github-copilot/fixture", tokenCount: 1200, cost: 0.3, compactionCount: 1 }, content: "old notice" };
  for (const expanded of [false, true]) expect(renderSubagentDone(message, { expanded }, theme).render(120).join("\n"))
    .toContain("1.2k tokens · $0.30 · 1 compaction");
});
