import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createReplica, type ReplicaFixture } from "@spider/db-core/testutil";
import { recordRunUsage, RunStore } from "@spider/subagents";
import { UsageAccounting } from "../usage-accounting.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let replica: ReplicaFixture, store: RunStore, accounting: UsageAccounting;
let appended: { kind: string; provider: string; model: string; note?: string }[];
beforeEach(() => {
  replica = createReplica("worktree", A); store = new RunStore(replica.db); accounting = new UsageAccounting(); appended = [];
  accounting.activate({ sessionManager: { getSessionId: () => "owner", getEntries: () => [],
    appendUsage: (kind: string, provider: string, model: string, _usage: unknown, note?: string) => appended.push({ kind, provider, model, note }) } });
});
afterEach(() => { accounting.shutdown(); replica.close(); vi.unstubAllEnvs(); });
function run(origin: string, withUsage: boolean, model: string) {
  const created = store.create({ sessionId: "owner", agent: "worker", name: model });
  replica.db.prepare("UPDATE runs SET origin_machine=? WHERE id=?").run(origin, created.id);
  if (withUsage) recordRunUsage(replica.db, created.id, { provider: "fixture", model, usage });
  store.finish(created.id, { status: "done" });
  return store.get(created.id)!;
}
function markers(id: string) {
  return replica.db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id=? AND type='spider_usage_reported'").get(id);
}

it("empty origin run is accounted locally", () => {
  const row = run("", true, "legacy");
  accounting.restore(replica.db, "owner");
  expect(appended.map(item => item.model)).toEqual(["legacy"]);
  expect(markers(row.id)).toEqual({ n: 1 });
}, 5000);

it("local origin run is accounted", () => {
  const row = run(A, true, "local");
  accounting.restore(replica.db, "owner");
  expect(appended.map(item => item.model)).toEqual(["local"]);
  expect(markers(row.id)).toEqual({ n: 1 });
}, 5000);

it("foreign origin run is not accounted here", () => {
  const row = run(B, true, "foreign");
  accounting.restore(replica.db, "owner");
  expect(appended).toEqual([]);
  expect(markers(row.id)).toEqual({ n: 0 });
}, 5000);

it("participant state does not change run-origin accounting", () => {
  replica.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES ('owner',1,?)").run(B);
  replica.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('owner',2,'active')").run();
  const legacy = run("", true, "legacy"), local = run(A, true, "local"), foreign = run(B, true, "foreign");
  accounting.restore(replica.db, "owner");
  expect(appended.map(item => item.model).sort()).toEqual(["legacy", "local"]);
  expect(markers(legacy.id)).toEqual({ n: 1 });
  expect(markers(local.id)).toEqual({ n: 1 });
  expect(markers(foreign.id)).toEqual({ n: 0 });
}, 5000);

// Startup restore must not append or mark any foreign run, even with no usage event.
it("startup restore ignores foreign runs", () => {
  const local = run(A, true, "local"), foreign = run(B, true, "foreign"), legacyForeign = run(B, false, "foreign-empty"), legacyLocal = run(A, false, "local-empty");
  accounting.restore(replica.db, "owner");
  expect(appended.map(item => item.model)).toEqual(["local"]);
  expect(markers(local.id)).toEqual({ n: 1 });
  expect(markers(legacyLocal.id)).toEqual({ n: 1 });
  expect(markers(foreign.id)).toEqual({ n: 0 });
  expect(markers(legacyForeign.id)).toEqual({ n: 0 });
  accounting.restore(replica.db, "owner");
  expect(appended.map(item => item.model)).toEqual(["local"]);
}, 5000);

// Direct completion reporting cannot bypass the local-origin check.
it("direct reporting ignores foreign runs", () => {
  const foreign = run(B, true, "foreign"), local = run(A, true, "local");
  accounting.reportRun(replica.db, foreign); accounting.reportRun(replica.db, local);
  expect(appended.map(item => item.model)).toEqual(["local"]);
  expect(markers(foreign.id)).toEqual({ n: 0 });
  expect(markers(local.id)).toEqual({ n: 1 });
}, 5000);

// A colliding live PID and owner do not authorize a foreign run's child sink.
it("child usage recording requires the local run origin", () => {
  const foreign = run(B, false, "foreign"), local = run(A, false, "local");
  replica.db.prepare("UPDATE runs SET pid=? WHERE id IN (?,?)").run(process.pid, foreign.id, local.id);
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  vi.stubEnv("PI_SPIDER_DB_PATH", replica.db.raw.name);
  vi.stubEnv("PI_SPIDER_SESSION_ID", "owner");
  vi.stubEnv("PI_SUBAGENT_RUN_ID", foreign.id);
  accounting.factory("owner")("learner")!({ provider: "fixture", model: "foreign", usage });
  vi.stubEnv("PI_SUBAGENT_RUN_ID", local.id);
  accounting.factory("owner")("learner")!({ provider: "fixture", model: "local", usage });
  const events = replica.db.prepare("SELECT run_id AS id FROM run_events WHERE type='spider_usage' ORDER BY id").all();
  expect(events).toEqual([{ id: local.id }]);
}, 5000);
