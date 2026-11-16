import { afterEach, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runExec } from "@spider/context";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReplica } from "@spider/db-core/testutil";
import { appendRunEvent } from "@spider/db-core";
import { RunStore, PipelineCoordinator, RunEventTailer, getCoordinators, teardownAll } from "@spider/subagents";
import type { FederationBlockers, SessionAddress } from "@spider/intercom/protocol";
import type { JournalJob } from "@spider/herdr/jobs/store";
import { inspectBlockers, readLocalBackgroundJobs, type BlockerPorts, type LocalBackgroundJob, type LocalRoute } from "../blockers";

afterEach(() => vi.unstubAllEnvs());

async function waitForReceipt(file: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("Fixture job did not finish");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

it.each([
  { name: "top-level", child: "0", top: "unrelated", session: "owner", expected: "owner" },
  { name: "child", child: "1", top: "owner", session: "child", expected: "owner" },
  { name: "child without a top-level ID", child: "1", top: "", session: "child", expected: undefined },
])("records the $name session owner in a local background manifest", async ({ child, top, session, expected }) => {
  vi.stubEnv("PI_SUBAGENT_CHILD", child);
  vi.stubEnv("PI_SPIDER_TOP_SESSION_ID", top);
  vi.stubEnv("PI_SPIDER_SESSION_ID", "intermediate");
  const root = mkdtempSync(join(process.cwd(), ".spider/scratch/roam-blockers-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  let receipt: string | undefined;
  try {
    const result = await runExec({ language: "javascript", code: "setTimeout(() => {}, 400)", background: true, timeout: 50 }, { cwd: root, sessionId: session } as never);
    const job = result.details.backgroundJob;
    if (!job) throw new Error("Fixture job did not detach");
    receipt = job.receipt;
    const manifest = await vi.waitFor(() => {
      const current = JSON.parse(readFileSync(job.manifest, "utf8"));
      if (!current.childPid) throw new Error("Fixture command has not started");
      return current;
    }, { timeout: 2000, interval: 20 });
    expect(manifest.ownerSessionId).toBe(expected);
    expect(manifest.supervisorPid).toBe(result.details.pid);
  } finally {
    if (receipt) await waitForReceipt(receipt);
    rmSync(root, { recursive: true, force: true });
  }
}, 5000);

const ownAddress: SessionAddress = { sessionId: "owner", scopeId: null };
const otherAddress: SessionAddress = { sessionId: "other", scopeId: null };
const emptyIntercom = (partial: Partial<FederationBlockers> = {}): FederationBlockers => ({
  asks: [], pendingDispatch: [], unknownOutcomes: [], unobservedReceipts: [], ...partial,
});

function remoteJob(id: string, patch: Partial<JournalJob> = {}): JournalJob {
  const owner = {
    sessionId: "owner", generation: "generation", cwd: "/fixture", sessionFile: null, name: null,
    terminal: { coreId: "core", terminalId: "terminal", address: "terminal", socket: "/fixture/socket", sessionNamespace: "fixture" },
  } as JournalJob["owner"];
  return {
    version: 1, id: id as JournalJob["id"], owner, machine: "box-1.invalid" as JournalJob["machine"], kind: "exec",
    phase: { kind: "running", address: "box-1.invalid/terminal" as never, releasedAt: 1 },
    viewer: null, remoteDirectory: "/fixture/remote", localDirectory: "/fixture/local", detached: true,
    noticeMode: "async", notice: "pending", nonce: "nonce", releaseDeadlineAt: 1, originalFinish: null,
    output: null, callerOwned: true, uncertain: false, evidenceConflict: false, noticeDelivered: false,
    settledMarked: false, terminalExpired: false, updatedAt: 1, ...patch,
  };
}

const finished = (id: string, patch: Partial<JournalJob> = {}) => remoteJob(id, {
  phase: { kind: "finished", address: "box-1.invalid/terminal" as never, result: { exitCode: 0, reason: "exited", signal: null, finishedAt: 2 } },
  output: { complete: true, summary: "fixture" }, notice: "observed", noticeDelivered: true, settledMarked: true, ...patch,
});

type InventoryCase = {
  name: string; idle?: boolean; queued?: boolean; draft?: string;
  activity?: { busy: boolean; shell: boolean; prompt: boolean };
  broker?: FederationBlockers; bridge?: FederationBlockers; routes?: readonly LocalRoute[];
  topJobs?: readonly JournalJob[]; childJobs?: readonly JournalJob[]; localJobs?: readonly LocalBackgroundJob[];
  ids: readonly string[]; kinds: readonly string[];
};

const cases: InventoryCase[] = [
  { name: "request", idle: false, ids: ["owner"], kinds: ["session-busy"] },
  { name: "retry", idle: false, ids: ["owner"], kinds: ["session-busy"] },
  { name: "compaction", idle: false, ids: ["owner"], kinds: ["session-busy"] },
  { name: "queued prompt", queued: true, ids: ["owner"], kinds: ["queued-prompt"] },
  { name: "editor draft", draft: "unfinished", ids: ["owner"], kinds: ["editor-draft"] },
  { name: "whitespace draft", draft: " ", ids: ["owner"], kinds: ["editor-draft"] },
  { name: "direct shell", activity: { busy: false, shell: true, prompt: false }, ids: ["owner"], kinds: ["direct-shell"] },
  { name: "open prompt", activity: { busy: false, shell: false, prompt: true }, ids: ["owner"], kinds: ["ui-prompt"] },
  { name: "overlay or command", activity: { busy: true, shell: false, prompt: false }, ids: ["owner"], kinds: ["interactive-activity"] },
  { name: "inbound ask", broker: emptyIntercom({ asks: [{ id: "ask-in", from: otherAddress, to: ownAddress }] }), ids: ["ask-in"], kinds: ["intercom-ask-inbound"] },
  { name: "outbound ask", bridge: emptyIntercom({ asks: [{ id: "ask-out", from: ownAddress, to: otherAddress }] }), ids: ["ask-out"], kinds: ["intercom-ask-outbound"] },
  { name: "pending dispatch", broker: emptyIntercom({ pendingDispatch: ["dispatch"] }), ids: ["dispatch"], kinds: ["intercom-dispatch"] },
  { name: "uncertain dispatch", bridge: emptyIntercom({ unknownOutcomes: ["unknown"] }), ids: ["unknown"], kinds: ["intercom-unknown"] },
  { name: "unobserved receipt", bridge: emptyIntercom({ unobservedReceipts: ["receipt"] }), ids: ["receipt"], kinds: ["intercom-receipt"] },
  { name: "local route", routes: [{ id: "local-mail", fromSessionId: "other", toSessionId: "owner", route: "local" }], ids: ["local-mail"], kinds: ["intercom-local-route"] },
  { name: "unknown route", routes: [{ id: "mirror-1", fromSessionId: "owner", toSessionId: "other", route: "unknown" }], ids: ["mirror-1"], kinds: ["intercom-route-unknown"] },
  { name: "running remote job", topJobs: [remoteJob("remote")], ids: ["remote"], kinds: ["remote-job"] },
  { name: "active remote job with uncertainty", topJobs: [remoteJob("active-unknown", { uncertain: true })], ids: ["active-unknown", "active-unknown"], kinds: ["remote-job", "remote-receipt"] },
  { name: "child remote job", childJobs: [remoteJob("child-job")], ids: ["child-job"], kinds: ["remote-job"] },
  { name: "failed launch with pending cleanup", topJobs: [remoteJob("cleanup", { phase: { kind: "launch-failed", error: "fixture" }, terminalReleased: true })], ids: ["cleanup"], kinds: ["remote-job"] },
  { name: "settled failed launch", topJobs: [remoteJob("settled-failure", { phase: { kind: "launch-failed", error: "fixture" }, terminalReleased: true, settledMarked: true })], ids: [], kinds: [] },
  { name: "unsettled remote receipt", topJobs: [finished("unsettled", { uncertain: true })], ids: ["unsettled"], kinds: ["remote-receipt"] },
  { name: "unknown remote outcome", topJobs: [finished("unknown-outcome", { phase: { kind: "finished", address: "box-1.invalid/terminal" as never, result: { exitCode: null, reason: "unknown", signal: null, finishedAt: 2 } } })], ids: ["unknown-outcome"], kinds: ["remote-receipt"] },
  { name: "incomplete remote output", topJobs: [finished("partial-output", { output: { complete: false, summary: "partial" } })], ids: ["partial-output"], kinds: ["remote-receipt"] },
  { name: "conflicting remote evidence", topJobs: [finished("conflict", { evidenceConflict: true })], ids: ["conflict"], kinds: ["remote-receipt"] },
  { name: "unobserved remote completion", childJobs: [finished("completion", { notice: "submitted" })], ids: ["completion"], kinds: ["remote-completion"] },
  { name: "foreign remote job", topJobs: [remoteJob("foreign-remote", { owner: { ...remoteJob("base").owner, sessionId: "other" as never } })], ids: [], kinds: [] },
  { name: "bridge route without settlement", routes: [{ id: "bridge-mail", fromSessionId: "owner", toSessionId: "other", route: "bridge" }], ids: ["bridge-mail"], kinds: ["intercom-bridge-route"] },
  { name: "bridge route with receipt", routes: [{ id: "bridge-mail", fromSessionId: "owner", toSessionId: "other", route: "bridge", settlement: { kind: "receipt", messageId: "bridge-mail" } }], ids: [], kinds: [] },
  { name: "bridge route with outcome", routes: [{ id: "bridge-mail", fromSessionId: "owner", toSessionId: "other", route: "bridge", settlement: { kind: "outcome", messageId: "bridge-mail" } }], ids: [], kinds: [] },
  { name: "bridge route with delivered record", routes: [{ id: "bridge-mail", fromSessionId: "owner", toSessionId: "other", route: "bridge", settlement: { kind: "delivered", messageId: "bridge-mail" } }], ids: [], kinds: [] },
  { name: "bridge settlement for another message", routes: [{ id: "bridge-mail", fromSessionId: "owner", toSessionId: "other", route: "bridge", settlement: { kind: "receipt", messageId: "other-mail" } }], ids: ["bridge-mail"], kinds: ["intercom-bridge-route"] },
  { name: "bridge settlement with unknown evidence", routes: [{ id: "bridge-mail", fromSessionId: "owner", toSessionId: "other", route: "bridge", settlement: { kind: "unknown" as never, messageId: "bridge-mail" } }], ids: ["bridge-mail"], kinds: ["intercom-bridge-route"] },
  { name: "pending dispatch despite a bridge receipt", broker: emptyIntercom({ pendingDispatch: ["bridge-mail"] }), routes: [{ id: "bridge-mail", fromSessionId: "owner", toSessionId: "other", route: "bridge", settlement: { kind: "receipt", messageId: "bridge-mail" } }], ids: ["bridge-mail"], kinds: ["intercom-dispatch"] },
  { name: "owned local job", localJobs: [{ id: "local", ownerSessionId: "owner", state: "running" }], ids: ["local"], kinds: ["local-job"] },
  { name: "unowned running job", localJobs: [{ id: "legacy", ownerSessionId: null, state: "running" }], ids: ["legacy"], kinds: ["local-job"] },
  { name: "settled jobs and foreign work", localJobs: [{ id: "finished", ownerSessionId: "owner", state: "finished" }, { id: "dead", ownerSessionId: null, state: "dead" }, { id: "foreign", ownerSessionId: "other", state: "running" }], topJobs: [finished("observed")], ids: [], kinds: [] },
];

it.each(cases)("returns exact blockers without stopping work: $name", async testCase => {
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  const cancelledWork: string[] = [];
  const ctx = {
    mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "owner" },
    isIdle: () => testCase.idle ?? true, hasPendingMessages: () => testCase.queued ?? false,
    ui: { getEditorText: () => testCase.draft ?? "" },
    abort: () => cancelledWork.push("request"), shutdown: () => cancelledWork.push("session"),
  } as unknown as ExtensionContext;
  const activity = testCase.activity ?? { busy: false, shell: false, prompt: false };
  const ports: BlockerPorts = {
    sessionId: "owner", address: ownAddress,
    activity: { busy: () => activity.busy, bashRunning: () => activity.shell, promptOpen: () => activity.prompt },
    broker: async () => testCase.broker ?? emptyIntercom(), bridge: () => testCase.bridge ?? emptyIntercom(),
    localRoutes: async () => testCase.routes ?? [], topLevelJobs: async () => testCase.topJobs ?? [],
    childJobs: async () => testCase.childJobs ?? [], localJobs: async () => testCase.localJobs ?? [],
  };
  try {
    const blockers = await inspectBlockers(ctx, [replica.db], ports);
    const blockerIds = blockers.map(blocker => blocker.id);
    expect(blockerIds).toEqual(testCase.ids);
    expect(blockers.map(blocker => blocker.kind)).toEqual(testCase.kinds);
    expect(blockers.every(blocker => blocker.detail.length > 0)).toBe(true);
    expect(cancelledWork).toEqual([]);
  } finally { replica.close(); }
}, 5000);

function idleContext(sessionId = "owner"): ExtensionContext {
  return {
    mode: "tui", hasUI: true, sessionManager: { getSessionId: () => sessionId },
    isIdle: () => true, hasPendingMessages: () => false, ui: { getEditorText: () => "" },
  } as unknown as ExtensionContext;
}

function idlePorts(sessionId = "owner", patch: Partial<BlockerPorts> = {}): BlockerPorts {
  return {
    sessionId, address: { sessionId, scopeId: null },
    activity: { busy: () => false, bashRunning: () => false, promptOpen: () => false },
    broker: async () => emptyIntercom(), bridge: () => emptyIntercom(), localRoutes: async () => [],
    topLevelJobs: async () => [], childJobs: async () => [], localJobs: async () => [], ...patch,
  };
}

const sourceFailures: { name: string; patch: Partial<BlockerPorts> }[] = [
  { name: "activity", patch: { activity: { busy: () => { throw new Error("fixture"); }, bashRunning: () => false, promptOpen: () => false } } },
  { name: "broker", patch: { broker: async () => { throw new Error("fixture"); } } },
  { name: "bridge", patch: { bridge: () => { throw new Error("fixture"); } } },
  { name: "local-routes", patch: { localRoutes: async () => { throw new Error("fixture"); } } },
  { name: "top-level-jobs", patch: { topLevelJobs: async () => { throw new Error("fixture"); } } },
  { name: "child-jobs", patch: { childJobs: async () => { throw new Error("fixture"); } } },
  { name: "local-jobs", patch: { localJobs: async () => { throw new Error("fixture"); } } },
];

it.each(sourceFailures)("refuses to report idle when $name evidence is unavailable", async ({ name, patch }) => {
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    const blockers = await inspectBlockers(idleContext(), [replica.db], idlePorts("owner", patch));
    expect(blockers.map(({ kind, id }) => [kind, id])).toEqual([["blocker-source-unavailable", name]]);
    expect(blockers[0].detail).toContain(name);
  } finally { replica.close(); }
}, 5000);

it("reports missing activation and store evidence instead of an empty inventory", async () => {
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    const noPorts = await inspectBlockers(idleContext(), [replica.db]);
    expect(noPorts.map(({ kind, id }) => [kind, id])).toEqual([["blocker-source-unavailable", "activation"]]);
    const noStores = await inspectBlockers(idleContext(), [], idlePorts());
    expect(noStores.map(({ kind, id }) => [kind, id])).toEqual([["blocker-source-unavailable", "run-stores"]]);
  } finally { replica.close(); }
}, 5000);

it.each([
  { name: "activation", patch: { sessionId: "other" } },
  { name: "intercom address", patch: { address: otherAddress } },
])("does not borrow another session's $name evidence", async ({ patch }) => {
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    const blockers = await inspectBlockers(idleContext(), [replica.db], idlePorts("owner", patch));
    expect(blockers.map(({ kind, id }) => [kind, id])).toEqual([["blocker-source-unavailable", "activation"]]);
  } finally { replica.close(); }
}, 5000);

it("still reports bridge work when the broker cannot be inspected", async () => {
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    const ports = idlePorts("owner", { broker: async () => { throw new Error("fixture"); },
      bridge: () => emptyIntercom({ pendingDispatch: ["bridge-mail"] }) });
    const blockers = await inspectBlockers(idleContext(), [replica.db], ports);
    expect(blockers.map(({ kind, id }) => [kind, id])).toEqual([
      ["blocker-source-unavailable", "broker"], ["intercom-dispatch", "bridge-mail"],
    ]);
  } finally { replica.close(); }
}, 5000);

it("retains a pending bridge message and fails closed when the broker is unreadable", async () => {
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    const route: LocalRoute = { id: "bridge-mail", fromSessionId: "owner", toSessionId: "other", route: "bridge" };
    const broker = async () => { throw new Error("fixture"); };
    const blockers = await inspectBlockers(idleContext(), [replica.db], idlePorts("owner", { broker, localRoutes: async () => [route] }));
    expect(blockers.map(({ kind, id }) => [kind, id])).toEqual([
      ["blocker-source-unavailable", "broker"], ["intercom-bridge-route", "bridge-mail"],
    ]);
    expect(blockers[1].detail).toContain("bridge-mail");
    const settled = { ...route, settlement: { kind: "receipt", messageId: "bridge-mail" } } as LocalRoute;
    expect((await inspectBlockers(idleContext(), [replica.db], idlePorts("owner", { broker, localRoutes: async () => [settled] }))).map(b => [b.kind, b.id])).toEqual([["blocker-source-unavailable", "broker"]]);
  } finally { replica.close(); }
}, 5000);

it("inspects every owning run store and excludes foreign replicas without changing either store", async () => {
  const machine = "11111111-1111-4111-8111-111111111111";
  const first = createReplica("worktree", machine), second = createReplica("worktree", machine);
  try {
    const a = new RunStore(first.db), b = new RunStore(second.db);
    const queued = a.create({ sessionId: "owner", agent: "worker" }).id;
    const paused = b.create({ sessionId: "owner", agent: "worker" }).id;
    second.db.prepare("UPDATE runs SET status='paused' WHERE id=?").run(paused);
    const detached = b.create({ sessionId: "owner", agent: "worker" }).id;
    b.start(detached);
    appendRunEvent(second.db, { runId: detached, sessionId: "owner", ts: 1, type: "child_supervisor", payload: { version: 1, directory: "fixture" } });
    const completion = a.create({ sessionId: "owner", agent: "worker" }).id;
    a.finish(completion, { status: "done" });
    appendRunEvent(first.db, { runId: completion, sessionId: "owner", ts: 2, type: "child_supervisor", payload: { version: 1, directory: "fixture" } });
    const delivered = a.create({ sessionId: "owner", agent: "worker" }).id;
    a.finish(delivered, { status: "done" });
    appendRunEvent(first.db, { runId: delivered, sessionId: "owner", ts: 3, type: "child_supervisor", payload: { version: 1, directory: "fixture" } });
    appendRunEvent(first.db, { runId: delivered, sessionId: "owner", ts: 4, type: "completion_delivered" });
    second.db.prepare("INSERT INTO runs(id,session_id,agent,status,origin_machine) VALUES(?,?,?,?,?)")
      .run("foreign-run", "owner", "worker", "running", "22222222-2222-4222-8222-222222222222");
    appendRunEvent(second.db, { runId: "foreign-run", sessionId: "owner", ts: 1, type: "completion_delivered" });
    second.db.prepare("INSERT INTO runs(id,session_id,agent,status,origin_machine) VALUES(?,?,?,?,?)")
      .run(queued, "owner", "worker", "queued", machine);
    b.create({ sessionId: "other", agent: "worker" });
    const snapshot = () => [first.db, second.db].map(db => ({
      runs: db.prepare("SELECT id,status,ended_at FROM runs ORDER BY id").all(),
      events: db.prepare("SELECT COUNT(*) AS n FROM run_events").get(),
    }));
    const before = snapshot(), cancelledWork: string[] = [];
    const ctx = { ...idleContext(), abort: () => cancelledWork.push("request"), shutdown: () => cancelledWork.push("session") } as ExtensionContext;
    const blockers = await inspectBlockers(ctx, [first.db, second.db], idlePorts());
    expect(blockers.map(blocker => blocker.id)).toEqual([...([queued, paused, detached, completion].sort()), delivered]);
    expect(blockers.map(blocker => blocker.kind)).toEqual(["run", "run", "run", "run", "run-completion"]);
    expect(blockers.at(-1)?.detail).toContain(delivered);
    expect(snapshot()).toEqual(before);
    expect(cancelledWork).toEqual([]);
  } finally { first.close(); second.close(); }
}, 5000);

it.each([
  { name: "matching notice", notice: "matching", file: "owner", blocked: false },
  { name: "legacy unkeyed notice before a matching notice", notice: "legacy", file: "owner", blocked: false },
  { name: "missing notice", notice: "none", file: "owner", blocked: true },
  { name: "notice for another run", notice: "other", file: "owner", blocked: true },
  { name: "different custom message type", notice: "wrong-type", file: "owner", blocked: true },
  { name: "malformed matching entry", notice: "none", file: "invalid-entry", blocked: true },
  { name: "unreadable session file", notice: "matching", file: "unreadable", blocked: true },
  { name: "missing physical file despite cached notice", notice: "matching", file: "deleted", blocked: true },
  { name: "notice in another session file", notice: "matching", file: "foreign", blocked: true },
  { name: "malformed session tail", notice: "matching", file: "corrupt", blocked: true },
])("requires the owning session file for a delivered child completion: $name", async ({ notice, file, blocked }) => {
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    const store = new RunStore(replica.db);
    const run = store.create({ sessionId: "owner", agent: "worker", name: "bravo" }).id;
    store.finish(run, { status: "done" });
    appendRunEvent(replica.db, { runId: run, sessionId: "owner", ts: 1, type: "child_supervisor", payload: { version: 1, directory: "fixture" } });
    appendRunEvent(replica.db, { runId: run, sessionId: "owner", ts: 2, type: "completion_delivered" });
    const directory = join(replica.root, "sessions"); mkdirSync(directory);
    const manager = SessionManager.create(replica.root, directory, { id: file === "foreign" ? "other" : "owner" });
    manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
    if (notice === "legacy") manager.appendCustomMessageEntry("spider.subagent_done", "legacy", true);
    if (notice !== "none") manager.appendCustomMessageEntry(notice === "wrong-type" ? "other.message" : "spider.subagent_done", "done", true, { runId: notice === "other" ? "different-run" : run });
    const path = manager.getSessionFile(); if (!path) throw new Error("Fixture has no session file");
    if (file === "invalid-entry") appendFileSync(path, JSON.stringify({ type: "custom_message", customType: "spider.subagent_done", parentId: null, timestamp: "fixture", details: { runId: run } }) + "\n");
    if (file === "corrupt") appendFileSync(path, "{broken\n");
    const before = readFileSync(path, "utf8"), mode = statSync(path).mode & 0o777;
    if (file === "deleted") rmSync(path);
    let inspectPath = path;
    if (file === "unreadable") {
      chmodSync(path, 0);
      try { const fd = openSync(path, "r"); closeSync(fd); inspectPath = directory; } catch { /* The fixture really is unreadable. */ }
    }
    try {
      const sessionManager = { getSessionId: () => "owner", getSessionFile: () => inspectPath, getEntries: () => manager.getEntries() };
      const ctx = { ...idleContext(), sessionManager } as unknown as ExtensionContext;
      const blockers = await inspectBlockers(ctx, [replica.db], idlePorts());
      expect(blockers.map(({ kind, id }) => [kind, id])).toEqual(blocked ? [["run-completion", run]] : []);
      if (blocked) expect(blockers[0].detail).toBe(`Waiting for bravo's completion notice to be recorded (run ${run}).`);
    } finally { if (file === "unreadable") chmodSync(path, mode); }
    if (file !== "deleted") expect(readFileSync(path, "utf8")).toBe(before);
  } finally { replica.close(); }
}, 5000);

it("does not expire a delivered but unrecorded cancelled child completion", async () => {
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    const store = new RunStore(replica.db);
    const run = store.create({ sessionId: "owner", agent: "worker", name: "bravo" }).id;
    replica.db.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(run);
    appendRunEvent(replica.db, { runId: run, sessionId: "owner", ts: 1, type: "completion_delivered" });
    const blockers = await inspectBlockers(idleContext(), [replica.db], idlePorts());
    expect(blockers.map(({ kind, id }) => [kind, id])).toEqual([["run-completion", run]]);
    expect(blockers[0].detail).toBe(`Waiting for bravo's completion notice to be recorded (run ${run}).`);
  } finally { replica.close(); }
}, 5000);

it("includes the live pending pipeline once across stores without stopping it", async () => {
  const machine = "11111111-1111-4111-8111-111111111111";
  const first = createReplica("worktree", machine), second = createReplica("worktree", machine);
  const store = new RunStore(first.db);
  const runner = { runAsync: () => { const { id } = store.create({ sessionId: "owner", agent: "worker" }); store.start(id); return store.get(id); } };
  const coordinator = new PipelineCoordinator({ db: first.db, globalDb: first.db, store, runner, pi: {}, sessionId: "owner" } as never);
  getCoordinators("owner", () => ({ tailer: new RunEventTailer(first.db), pipelines: [coordinator], children: new Map() }));
  try {
    const { pipelineId, firstRunId } = coordinator.start({ pipeline: [{ agent: "worker" }, { agent: "worker" }], handoff: "intercom" });
    store.finish(firstRunId, { status: "done" });
    const blockers = await inspectBlockers(idleContext(), [first.db, second.db], idlePorts());
    expect(blockers.map(({ kind, id }) => [kind, id])).toEqual([["pipeline", pipelineId]]);
    expect(store.get(firstRunId)?.status).toBe("done");
  } finally { coordinator.dispose(); teardownAll(); first.close(); second.close(); }
}, 5000);

it("inspects local manifests for both sessions without changing or cancelling their jobs", async () => {
  const root = mkdtempSync(join(process.cwd(), ".spider/scratch/roam-local-jobs-"));
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    const child = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
    await once(child, "close");
    if (!child.pid) throw new Error("Fixture process did not start");
    const manifest = (id: string, extra: Record<string, unknown>, receipt = false) => {
      const dir = join(root, "bg", id); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "job.json"), JSON.stringify({ schema: 1, id, cwd: root, windowsHide: false, startedAt: "fixture", ...extra }));
      if (receipt) writeFileSync(join(dir, "exit.json"), JSON.stringify({ schema: 1, state: "exited", exitCode: 0, signal: null, supervisorPid: child.pid }));
    };
    manifest("legacy", { childPid: process.pid });
    manifest("owned", { ownerSessionId: "owner", childPid: process.pid });
    manifest("foreign", { ownerSessionId: "other", childPid: process.pid });
    manifest("dead", { supervisorPid: child.pid });
    manifest("finished", { supervisorPid: child.pid }, true);
    const legacy = join(root, "bg", "legacy", "job.json"), before = readFileSync(legacy, "utf8");
    const jobs = await readLocalBackgroundJobs([root]);
    expect(jobs.map(({ id, state }) => [id, state])).toEqual([
      ["dead", "dead"], ["finished", "finished"], ["foreign", "running"], ["legacy", "running"], ["owned", "running"],
    ]);
    const ports = (sessionId: string) => idlePorts(sessionId, { localJobs: () => readLocalBackgroundJobs([root]) });
    expect((await inspectBlockers(idleContext("owner"), [replica.db], ports("owner"))).map(b => b.id)).toEqual(["legacy", "owned"]);
    expect((await inspectBlockers(idleContext("other"), [replica.db], ports("other"))).map(b => b.id)).toEqual(["foreign", "legacy"]);
    expect(readFileSync(legacy, "utf8")).toBe(before);
  } finally { replica.close(); rmSync(root, { recursive: true, force: true }); }
}, 5000);

it("blocks local jobs whose process group and child evidence conflict", async () => {
  const root = mkdtempSync(join(process.cwd(), ".spider/scratch/roam-conflicting-jobs-"));
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    const exited = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
    await once(exited, "close"); if (!exited.pid) throw new Error("Fixture process did not start");
    const orphan = join(root, "bg", "orphan"), conflict = join(root, "bg", "conflict");
    const childConflict = join(root, "bg", "child-conflict"), invalid = join(root, "bg", "invalid-pid");
    for (const dir of [orphan, conflict, childConflict, invalid]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(orphan, "job.json"), JSON.stringify({ schema: 1, id: "orphan", ownerSessionId: "owner", supervisorPid: exited.pid, childPid: process.pid }));
    writeFileSync(join(conflict, "job.json"), JSON.stringify({ schema: 1, id: "conflict", ownerSessionId: "owner", supervisorPid: exited.pid }));
    writeFileSync(join(conflict, "exit.json"), JSON.stringify({ schema: 1, state: "exited", exitCode: 0, signal: null, supervisorPid: process.pid }));
    writeFileSync(join(childConflict, "job.json"), JSON.stringify({ schema: 1, id: "child-conflict", ownerSessionId: "owner", supervisorPid: exited.pid, childPid: exited.pid }));
    writeFileSync(join(childConflict, "exit.json"), JSON.stringify({ schema: 1, state: "exited", exitCode: 0, signal: null, supervisorPid: exited.pid, childPid: process.pid }));
    writeFileSync(join(invalid, "job.json"), JSON.stringify({ schema: 1, id: "invalid-pid", ownerSessionId: "owner", supervisorPid: "invalid" }));
    writeFileSync(join(invalid, "exit.json"), JSON.stringify({ schema: 1, state: "exited", exitCode: 0, signal: null, supervisorPid: exited.pid }));
    expect(await readLocalBackgroundJobs([root])).toEqual([
      { id: "child-conflict", ownerSessionId: "owner", state: "unknown" },
      { id: "conflict", ownerSessionId: "owner", state: "unknown" },
      { id: "invalid-pid", ownerSessionId: "owner", state: "unknown" },
      { id: "orphan", ownerSessionId: "owner", state: "unknown" },
    ]);
    const ports = idlePorts("owner", { localJobs: () => readLocalBackgroundJobs([root]) });
    expect((await inspectBlockers(idleContext(), [replica.db], ports)).map(b => b.id)).toEqual(["child-conflict", "conflict", "invalid-pid", "orphan"]);
  } finally { replica.close(); rmSync(root, { recursive: true, force: true }); }
}, 5000);

it("does not trust an ambiguous receipt or incomplete local manifest as proof of idleness", async () => {
  const root = mkdtempSync(join(process.cwd(), ".spider/scratch/roam-uncertain-jobs-"));
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    const ambiguous = join(root, "bg", "ambiguous"), incomplete = join(root, "bg", "incomplete");
    mkdirSync(ambiguous, { recursive: true }); mkdirSync(incomplete, { recursive: true });
    writeFileSync(join(ambiguous, "job.json"), JSON.stringify({ schema: 1, id: "ambiguous", ownerSessionId: "owner" }));
    writeFileSync(join(ambiguous, "exit.json"), JSON.stringify({ schema: 1, state: "exited", exitCode: 0, signal: null }));
    expect(await readLocalBackgroundJobs([root])).toEqual([
      { id: "ambiguous", ownerSessionId: "owner", state: "unknown" },
      { id: "incomplete", ownerSessionId: null, state: "unknown" },
    ]);
    const ports = (sessionId: string) => idlePorts(sessionId, { localJobs: () => readLocalBackgroundJobs([root]) });
    expect((await inspectBlockers(idleContext("owner"), [replica.db], ports("owner"))).map(b => b.id)).toEqual(["ambiguous", "incomplete"]);
    expect((await inspectBlockers(idleContext("other"), [replica.db], ports("other"))).map(b => b.id)).toEqual(["incomplete"]);
  } finally { replica.close(); rmSync(root, { recursive: true, force: true }); }
}, 5000);

const invalidSources: { name: string; patch: Partial<BlockerPorts> }[] = [
  { name: "activity", patch: { activity: { busy: () => null as never, bashRunning: () => false, promptOpen: () => false } } },
  { name: "broker", patch: { broker: async () => null as never } },
  { name: "bridge", patch: { bridge: () => ({}) as never } },
  { name: "broker", patch: { broker: async () => emptyIntercom({ asks: [{ id: "", from: ownAddress, to: otherAddress }] }) } },
  { name: "local-routes", patch: { localRoutes: async () => null as never } },
  { name: "local-routes", patch: { localRoutes: async () => [{ id: "mail", fromSessionId: "owner", toSessionId: "other", route: "missing" }] as never } },
  { name: "top-level-jobs", patch: { topLevelJobs: async () => null as never } },
  { name: "top-level-jobs", patch: { topLevelJobs: async () => [remoteJob("remote", { phase: { kind: "missing" } as never })] } },
  { name: "child-jobs", patch: { childJobs: async () => null as never } },
  { name: "child-jobs", patch: { childJobs: async () => [remoteJob("child", { owner: null as never })] } },
  { name: "local-jobs", patch: { localJobs: async () => null as never } },
  { name: "local-jobs", patch: { localJobs: async () => [{ id: "local", ownerSessionId: "owner", state: "missing" }] as never } },
];

it.each(invalidSources)("blocks when $name returns malformed evidence", async ({ name, patch }) => {
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    const blockers = await inspectBlockers(idleContext(), [replica.db], idlePorts("owner", patch));
    expect(blockers.map(({ kind, id }) => [kind, id])).toEqual([["blocker-source-unavailable", name]]);
  } finally { replica.close(); }
}, 5000);

it("blocks when Pi's idle state is unavailable", async () => {
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    const ctx = { ...idleContext(), isIdle: () => null } as unknown as ExtensionContext;
    const blockers = await inspectBlockers(ctx, [replica.db], idlePorts());
    expect(blockers.map(({ kind, id }) => [kind, id])).toEqual([["blocker-source-unavailable", "pi-state"]]);
  } finally { replica.close(); }
}, 5000);

it("blocks when Pi's editor evidence is not text", async () => {
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    const ctx = { ...idleContext(), ui: { getEditorText: () => 42 } } as unknown as ExtensionContext;
    const blockers = await inspectBlockers(ctx, [replica.db], idlePorts());
    expect(blockers.map(({ kind, id }) => [kind, id])).toEqual([["blocker-source-unavailable", "pi-state"]]);
  } finally { replica.close(); }
}, 5000);

it("blocks when the local job roots are absent or unspecified", async () => {
  const replica = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    for (const roots of [[], [join(replica.root, "missing-scratch")]]) {
      const blockers = await inspectBlockers(idleContext(), [replica.db], idlePorts("owner", { localJobs: () => readLocalBackgroundJobs(roots) }));
      expect(blockers.map(({ kind, id }) => [kind, id])).toEqual([["blocker-source-unavailable", "local-jobs"]]);
    }
  } finally { replica.close(); }
}, 5000);

it.each(["global", "repo"] as const)("declared %s tier does not need a runs table", async tier => {
  const worktree = createReplica("worktree", "11111111-1111-4111-8111-111111111111"), other = createReplica(tier, "11111111-1111-4111-8111-111111111111");
  try {
    const blockers = await inspectBlockers(idleContext(), [other.db, worktree.db], idlePorts());
    expect(blockers).toEqual([]);
    expect(other.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get()).toBeUndefined();
  } finally { other.close(); worktree.close(); }
}, 5000);

it.each(["missing table", "query failure"])("declared worktree tier stays blocked on %s", async failure => {
  const worktree = createReplica("worktree", "11111111-1111-4111-8111-111111111111");
  try {
    if (failure === "missing table") worktree.db.exec("DROP TABLE runs");
    else {
      const prepare = worktree.db.prepare.bind(worktree.db);
      vi.spyOn(worktree.db, "prepare").mockImplementation(sql => { if (sql.includes("FROM runs")) throw new Error("Fixture query failure"); return prepare(sql); });
    }
    const blockers = await inspectBlockers(idleContext(), [worktree.db], idlePorts());
    expect(blockers).toEqual([{ kind: "blocker-source-unavailable", id: "run-store-1", detail: "Cannot inspect run-store-1 blocker evidence." }]);
  } finally { vi.restoreAllMocks(); worktree.close(); }
}, 5000);
