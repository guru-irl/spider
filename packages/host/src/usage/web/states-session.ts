import type { FixtureStateCase } from "../__tests__/fixtures/redesign-contract.js";
import type { SessionData } from "../dashboard-v4-contract.js";
import { renderStateExamples } from "./state-examples.js";
import { mountSession } from "./session.js";
export { mountSession as pageMount };
export const page = "session";
export function sessionStateCases(cases: readonly FixtureStateCase[]): readonly FixtureStateCase[] {
  const sessions = structuredClone(cases.filter(example => example.page === "session"));
  const base = sessions.find(example => example.scenario === "default");
  if (!base) return sessions;
  const path = Object.keys(base.responses).find(path => path.startsWith("/api/session/"));
  if (!path) return sessions;
  const body = base.responses[path]!.body;
  if (!("data" in body)) return sessions;
  const derive = (name: string, edit: (data: SessionData) => void) => {
    const example = structuredClone(base); example.name = name;
    edit((example.responses[path]!.body as { data: SessionData }).data); sessions.push(example);
  };
  derive("Session run marks", data => {
    const run = data.runs.find(r => r.start !== null && r.end !== null); if (!run) return;
    data.runs = (["completed", "cancelled", "failed", "running", null] as const).map((status, i) => ({ ...structuredClone(run), id: `example-mark-${i}`, name: `Route ${i + 1}`, status, start: status === "running" ? data.span!.end - 20 * 60000 : run.start! + i * 20 * 60000, end: status === "running" ? null : run.end! + i * 20 * 60000 })); data.stats.runs = 5;
    const original = run.value, runValue = { ...original, credits: original.credits === null ? null : original.credits * 5,
      tokens: Object.fromEntries(Object.entries(original.tokens).map(([k, v]) => [k, v === null ? null : v * 5])) as typeof original.tokens,
      calls: original.calls * 5, unpricedCalls: original.unpricedCalls * 5 };
    const edges = [...data.flow.edges.filter(e => !["workers", "reviewers", "scouts", "other-runs"].includes(e.role)), { role: "workers" as const, model: run.model!, value: runValue, share: 0 }];
    const sum = (values: readonly typeof original[]): typeof original => ({
      credits: values.every(v => v.credits === null) ? null : values.reduce((n, v) => n + (v.credits ?? 0), 0),
      tokens: Object.fromEntries(Object.keys(original.tokens).map(k => { const key = k as keyof typeof original.tokens; return [k, values.every(v => v.tokens[key] === null) ? null : values.reduce((n, v) => n + (v.tokens[key] ?? 0), 0)]; })) as typeof original.tokens,
      calls: values.reduce((n, v) => n + v.calls, 0), unpricedCalls: values.reduce((n, v) => n + v.unpricedCalls, 0),
    });
    data.total = sum(edges.map(e => e.value));
    data.models = data.models.map(m => { const value = sum(edges.filter(e => e.model === m.id).map(e => e.value)); return { ...m, value, share: (value.credits ?? 0) / (data.total.credits || 1) }; });
    data.flow = { total: structuredClone(data.total), models: structuredClone(data.models), edges: edges.map(e => ({ ...e, share: (e.value.credits ?? 0) / (data.total.credits || 1) })) };
    if (data.span) data.idleGaps = [{ start: data.span.start + 60000, end: data.span.start + 61 * 60000, cacheWriteCredits: 0.5 }];
  });
  derive("Own calls only", data => {
    data.runs = []; data.compaction = []; data.idleGaps = [];
    data.stats = { runs: 0, ownCalls: data.total.calls, compaction: 0, idleGaps: 0 };
    data.ownCallBins = data.span ? [{ ...data.span, value: structuredClone(data.total) }] : [];
    data.activePeriods = data.span ? [data.span] : [];
    data.flow = { total: structuredClone(data.total), models: structuredClone(data.models), edges: data.models.map(m => ({ role: "own", model: m.id, value: structuredClone(m.value), share: m.share })) };
  });
  derive("Session without recorded calls", data => {
    data.span = null; data.runs = []; data.ownCallBins = []; data.compaction = []; data.idleGaps = []; data.activePeriods = []; data.models = [];
    data.total = { credits: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, prompt: 0, total: 0, reasoning: null, cacheWrite1h: null }, calls: 0, unpricedCalls: 0 };
    data.stats = { runs: 0, ownCalls: 0, compaction: 0, idleGaps: 0 }; data.flow = { total: structuredClone(data.total), models: [], edges: [] };
  });
  return sessions;
}
export function mountSessionStates(root: HTMLElement, cases: readonly FixtureStateCase[]): Promise<void> {
  return renderStateExamples(root, { session: ctx => {
    const mounted = mountSession(ctx);
    return { refresh: mounted.refresh, dispose() { const classes = ctx.root.className; mounted.dispose(); ctx.root.className = classes; } };
  } }, sessionStateCases(cases));
}
