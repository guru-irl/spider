import { afterEach, beforeEach, expect, it } from "vitest";
import { openDashboardReader } from "../dashboard-reader.js";
import type { DashboardQueryContext, DashboardReader } from "../dashboard-contract.js";
import type { CallRow, RunMeta } from "../ledger.js";
import type { SessionData } from "../dashboard-v4-contract.js";
import { querySession, sessionRoute } from "../query-session.js";
import { flowFromCube, modelRows, readUsageCube, sessionRows, sumValues } from "../query-redesign-shared.js";
import { createDashboardFixture, dashboardBatch, dashboardCall, type DashboardFixture } from "./fixtures/dashboard-ledger.js";

const APR = Date.UTC(2030, 3, 1), MAY = Date.UTC(2030, 4, 1), JUN = Date.UTC(2030, 5, 1), JUL = Date.UTC(2030, 6, 1), D = 86400000;
let f: DashboardFixture, reader: DashboardReader, ctx: DashboardQueryContext;
const run = (id: string, agent: string | null, role: string | null = null): RunMeta => ({ id, agent, role, dbPath: "synthetic/runs.db", sessionId: "parent-session", parentRunId: null, project: null, repo: null, name: id, model: null, thinking: null, phase: null, startedAt: MAY - D, endedAt: JUN + D, status: "done" });
const priced = (id: string, ts: number, credits = 2, extra: Partial<CallRow> = {}) => dashboardCall(id, { ts, price: { status: "priced", aic: credits, components: { input: credits, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "synthetic", tier: "base", confidence: "estimated" }, ...extra });
const data = (params = "") => sessionRoute("parent-session").handle(ctx, new URLSearchParams(params)) as SessionData;
function seed(calls: CallRow[], runs: RunMeta[] = [], now = JUN + 15 * D) {
  f.ledger.apply(dashboardBatch(calls.map(call => call.actor === "subagent" ? { ...call, sessionId: "child-session" } : call), { runs, sessions: [{ id: "parent-session", ownerSessionId: null, name: "Synthetic session", nameSource: "name", nameOrder: 1, project: "synthetic", firstActivity: APR, lastActivity: JUL }, { id: "child-session", ownerSessionId: "parent-session", name: "Synthetic child", nameSource: "name", nameOrder: 1, project: "synthetic", firstActivity: APR, lastActivity: JUL }] }));
  reader?.close(); reader = openDashboardReader(f.file, { instanceId: "synthetic", serverBuild: "fixture", now: () => now, calibrationMode: () => "off" })!; ctx = reader.snapshot(c => c);
}
beforeEach(() => { f = createDashboardFixture(false); });
afterEach(() => { reader?.close(); f.close(); });

// Mutant: drop calls.agent/runs_meta.agent or prefer agent over a non-null role.
it("null roles use call and metadata agents in flow and four-role session breakdowns", () => {
  const agents = ["worker", "implementer", "reviewer", "scout", "planner", "tester", "architect", null];
  seed(agents.map((agent, i) => priced(`c${i}`, MAY + i, i + 1, { actor: "subagent", runId: `r${i}`, agent: i % 2 ? null : agent })), agents.map((agent, i) => run(`r${i}`, i % 2 ? agent : null)));
  const cube = readUsageCube(ctx, { range: "custom", from: MAY, to: JUN, tz: "UTC", unit: "credits", buckets: [] });
  expect(flowFromCube(cube).edges.map(e => [e.role, e.value.credits])).toEqual([["workers", 3], ["reviewers", 3], ["scouts", 4], ["other-runs", 26]]);
  expect(sessionRows(cube)[0]!.roles.map(r => [r.role, r.value.credits])).toEqual([["own", null], ["workers", 3], ["reviewers", 3], ["others", 30]]);
  const session = data(`from=${MAY}&to=${JUN}`);
  expect(session.runs.map(r => r.role)).toEqual(["worker", "implementer", "reviewer", "scout", "planner", "tester", "architect", "other"]);
  expect(session.runs.map(r => r.roleGroup)).toEqual(["workers", "workers", "reviewers", "others", "others", "others", "others", "others"]);
});
it("an explicit role overrides the agent for both the Role column and group", () => {
  seed([priced("override", MAY, 2, { actor: "subagent", runId: "override", role: "reviewer", agent: "planner" })], [run("override", "planner", "reviewer")]);
  const session = data();
  expect(session.runs[0]).toMatchObject({ role: "reviewer", roleGroup: "reviewers" });
  expect(session.flow.edges[0]).toMatchObject({ role: "reviewers" });
});
// Mutant: null out a partly unpriced aggregate instead of retaining SUM(aic).
it.each([{ known: [2, 3], want: 5, unpriced: 0 }, { known: [2], want: 2, unpriced: 1 }, { known: [], want: null, unpriced: 2 }, { known: [0], want: 0, unpriced: 1 }])("priced credits remain visible with $unpriced unpriced calls ($want)", ({ known, want, unpriced }) => {
  seed([...known.map((credits, i) => priced(`priced-${i}`, MAY + i, credits, { actor: "subagent", runId: "r", model: "model-synthetic", agent: "planner" })), ...Array.from({ length: unpriced }, (_, i) => dashboardCall(`unknown-${i}`, { ts: MAY + 10 + i, price: { status: "unpriced", reason: "unknown-model" }, actor: "subagent", runId: "r", model: "model-synthetic", agent: "planner" }))], [run("r", "planner")]);
  const session = data(), cube = readUsageCube(ctx, { range: "custom", from: MAY, to: JUN, tz: "UTC", unit: "credits", buckets: [] });
  for (const v of [session.total, session.runs[0]!.value, session.models[0]!.value, session.flow.edges[0]!.value, modelRows(cube)[0]!.value, flowFromCube(cube).edges[0]!.value, sumValues(session.flow.edges.map(e => e.value))]) expect(v).toMatchObject({ credits: want, unpricedCalls: unpriced });
});
it("a role spanning priced and entirely unpriced models retains priced totals and both flow edges", () => {
  seed([priced("known-model", MAY, 2, { actor: "subagent", runId: "r", model: "model-priced", agent: "planner" }), dashboardCall("unknown-model", { ts: MAY + 1, actor: "subagent", runId: "r", model: "model-unpriced", agent: "planner", price: { status: "unpriced", reason: "unknown-model" } })], [run("r", "planner")]);
  const session = data();
  for (const v of [session.total, session.flow.total, session.runs[0]!.value, sumValues(session.models.map(m => m.value)), sumValues(session.flow.edges.map(e => e.value))]) expect(v).toMatchObject({ credits: 2, calls: 2, unpricedCalls: 1 });
  expect(session.flow.edges.map(e => [e.role, e.model, e.value.credits, e.value.unpricedCalls])).toEqual([["other-runs", "model-priced", 2, 0], ["other-runs", "model-unpriced", null, 1]]);
});
// Mutant: keep lifetime candidates rather than filter after canonical selection.
it("range is half open across totals runs flow models own calls compaction and idle gaps", () => {
  seed([priced("old", APR, 99), priced("before", MAY - 1, 88, { actor: "subagent", runId: "old-run" }), priced("from", MAY, 2), priced("own-next", MAY + 10 * 60000, 3), priced("run", MAY + 1, 5, { actor: "subagent", runId: "in-run" }), priced("compact", MAY + 2, 7, { actor: "compaction" }), priced("bg", MAY + 3, 11, { actor: "aux" }), priced("to", JUN, 77, { actor: "subagent", runId: "later-run" })], [run("old-run", "worker"), run("in-run", "reviewer"), run("later-run", "worker")]);
  const session = data(`from=${MAY}&to=${JUN}`);
  expect(session.span).toMatchObject({ first: APR, last: JUN });
  expect(session.range).toEqual({ from: MAY, to: JUN });
  expect(session.total).toMatchObject({ credits: 28, calls: 5 });
  expect(session.runs.map(r => r.id)).toEqual(["in-run"]);
  expect(sumValues(session.models.map(m => m.value))).toEqual(session.total);
  expect(sumValues(session.flow.edges.map(e => e.value))).toEqual(session.total);
  expect(session.stats).toEqual({ runs: 1, ownCalls: 2, compaction: 1, idleGaps: 1 });
  expect(session.ownCallBins).toHaveLength(1); expect(session.ownCallBins[0]!.value.credits).toBe(5);
  expect(session.compaction.map(c => c.ts)).toEqual([MAY + 2]);
  expect(session.idleGaps.map(g => [g.start, g.end])).toEqual([[MAY, MAY + 10 * 60000]]);
});
it("default opens the billing month only when it contains canonical activity", () => {
  seed([priced("first", APR, 2), priced("current", JUN + 3 * D, 3)]);
  expect(data()).toMatchObject({ range: { from: JUN, to: JUL }, total: { credits: 3, calls: 1 } });
});
it("a session with no current-month activity opens its last calendar month even across a hole", () => {
  seed([priced("first", APR, 2), priced("last", MAY + 5 * D, 3)]);
  expect(data()).toMatchObject({ range: { from: MAY, to: JUN }, billingMonth: { from: JUN, to: JUL }, total: { credits: 3, calls: 1 } });
});
it("counter reset period is used rather than the calendar month", () => {
  seed([priced("bill", MAY + 25 * D, 4), priced("calendar", JUN + 12 * D, 9)], [], JUN + 5 * D);
  f.ledger.insertCounter({ ts: JUN + D, creditsUsed: 10, resetDate: "2030-06-10", accountLogin: "synthetic", raw: {} });
  expect(data()).toMatchObject({ range: { from: Date.UTC(2030, 4, 10), to: Date.UTC(2030, 5, 10) }, total: { credits: 4 } });
});
it.each([
  ["Asia/Kolkata", "2030-05-31T18:30:00Z", "2030-06-30T18:30:00Z"],
  ["America/Los_Angeles", "2030-06-01T07:00:00Z", "2030-07-01T07:00:00Z"],
])("billing month snaps UTC calendar dates to local day bounds in %s", (tz, from, to) => {
  seed([priced("current", JUN + 10 * D)]);
  const month = { from: Date.parse(from), to: Date.parse(to) };
  expect(data(`tz=${tz}`)).toMatchObject({ range: month, billingMonth: month, total: { calls: 1 } });
});
it.each([
  ["Asia/Kolkata", "2030-05-01T00:30:00Z", "2030-04-30T18:30:00Z", "2030-05-31T18:30:00Z"],
  ["America/Los_Angeles", "2030-05-01T00:30:00Z", "2030-04-01T07:00:00Z", "2030-05-01T07:00:00Z"],
  ["America/Los_Angeles", "2030-03-15T00:30:00Z", "2030-03-01T08:00:00Z", "2030-04-01T07:00:00Z"],
])("fallback uses the last activity's local month including DST in %s (%s)", (tz, last, from, to) => {
  seed([priced("last", Date.parse(last))]);
  expect(data(`tz=${tz}`)).toMatchObject({ range: { from: Date.parse(from), to: Date.parse(to) }, total: { calls: 1 } });
});
it.each([
  ["Asia/Kolkata", "2030-05-09T18:30:00Z", "2030-06-09T18:30:00Z"],
  ["America/Los_Angeles", "2030-05-10T07:00:00Z", "2030-06-10T07:00:00Z"],
])("counter billing-period dates snap to local days in %s", (tz, from, to) => {
  seed([priced("bill", MAY + 25 * D)], [], JUN + 5 * D);
  f.ledger.insertCounter({ ts: JUN + D, creditsUsed: 10, resetDate: "2030-06-10", accountLogin: "synthetic", raw: {} });
  expect(data(`tz=${tz}`)).toMatchObject({ range: { from: Date.parse(from), to: Date.parse(to) }, billingMonth: { from: Date.parse(from), to: Date.parse(to) } });
});
it("rejects invalid Session timezones rather than ignoring them", () => {
  seed([priced("own", MAY)]);
  expect(() => data("tz=Not/AZone")).toThrowError(expect.objectContaining({ code: "invalid-query" }));
});
it("an explicitly empty range retains the whole span but no activity or run metadata", () => {
  seed([priced("first", APR), priced("last", JUN)], [run("r", "worker")]);
  const session = data(`from=${MAY}&to=${MAY + D}`);
  expect(session.span).toMatchObject({ first: APR, last: JUN });
  expect(session.total).toMatchObject({ calls: 0, credits: null });
  for (const rows of [session.runs, session.ownCallBins, session.compaction, session.idleGaps, session.activePeriods, session.flow.edges, session.models]) expect(rows).toEqual([]);
});
it("metadata-only sessions return no run activity in an explicit range", () => {
  seed([], [run("metadata-only", "worker")]);
  expect(data(`from=${MAY}&to=${JUN}`)).toMatchObject({ span: null, runs: [], stats: { runs: 0 }, total: { calls: 0 } });
});
it.each(["from=1", "to=2", "from=2&to=2", "from=3&to=2", "from=-1&to=2", "from=1.5&to=2", "from=1e3&to=2000", "from=&to=2", "from=NaN&to=2", "from=1&to=8640000000000001", "from=1&from=1&to=2"])("rejects invalid range %s", params => {
  seed([priced("own", MAY)]);
  expect(() => data(params)).toThrowError(expect.objectContaining({ code: "invalid-query" }));
});
