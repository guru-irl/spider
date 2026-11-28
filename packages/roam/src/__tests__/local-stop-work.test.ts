import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { migrate, openDb, type Db } from "@spider/db-core";
import { recordLocation } from "@spider/db-core/roam/catalog";
import { writeLocal } from "@spider/db-core/roam/local-state";
import type { MachineId } from "@spider/db-core/roam/types";
import { createReplica } from "@spider/db-core/testutil";
import * as hcModule from "@spider/herdr/client/hc";
import { HerdrError } from "@spider/herdr/client/parse";
import { HERDR_LABELS, type Owner, type TerminalSummary } from "@spider/herdr/contracts";
import { createJobStore, jobJournalRoot, type JournalJob } from "@spider/herdr/jobs/store";
import { reapStoppedSessionRuns } from "../../../subagents/src/reaper";
import type { RunRow } from "../../../subagents/src/run-store";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import type { RelocateAdapterOptions, SessionId } from "../relocate/types";

vi.mock("node:fs/promises", { spy: true });

const machine = "11111111-1111-4111-8111-111111111111" as MachineId;
const foreign = "22222222-2222-4222-8222-222222222222" as MachineId;
const id = "33333333-3333-4333-8333-333333333333" as SessionId;
const other = "44444444-4444-4444-8444-444444444444" as SessionId;
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});

async function stopWork(options: RelocateAdapterOptions) {
  const { createStopWork } = await import("../relocate/local-stop-work");
  return createStopWork(options);
}

function fixture() {
  const global = createReplica("global", machine), replica = createReplica("worktree", machine);
  cleanup.push(global.close, replica.close);
  const checkout = join(global.root, "checkout"), cwd = join(checkout, "subdir");
  mkdirSync(cwd, { recursive: true });
  const project = openDb(join(checkout, ".spider", "project.db"));
  cleanup.push(() => project.close());
  migrate(project, "worktree", { machineId: machine, globalRoot: global.root });
  const key = replica.storeKey;
  global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(checkout);
  writeLocal(global.db, "mapping-redirect", key, replica.db.raw.name);
  recordLocation(global.db, { sessionId: id, stores: ["global", key], home: null, cwd, file: join(global.root, "session.jsonl") });
  for (const db of [project, replica.db]) for (const session of [id, other]) {
    db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,1)").run(session);
    db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,1,'active')").run(session);
  }
  const unused = (): never => { throw new Error("Unexpected Stop work effect"); };
  const journal = {} as RelocateAdapterOptions["journal"];
  const git: RelocateAdapterOptions["git"] = {
    run: async (path, argv) => {
      expect(path).toBe(cwd);
      expect(argv).toEqual(["git", "rev-parse", "--show-toplevel"]);
      return Buffer.from(`${checkout}\n`);
    },
    journal, limits: DEFAULT_LIMITS, scratch: join(global.root, "git"), worktreeCommand: null,
  };
  const config: RelocateAdapterOptions["config"] = {
    enabled: true, role: "box", machineId: machine, hubMachineId: foreign, peers: [], discoveryRoots: [],
    coreUnit: "core", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom(),
  };
  const options: RelocateAdapterOptions = {
    root: global.root, globalDb: global.db, config, journal, git, limits: DEFAULT_LIMITS,
    homes: { read: unused, list: unused, initialize: unused, compareAndSwap: unused },
    sync: { start: unused, stop: unused, sync: unused, barriers: unused },
    transport: { resolve: unused, bootstrapProbe: unused, exec: unused, run: unused, read: unused, write: unused },
    clock: { now: Date.now, later: unused },
    workspaceImport: { ...git, resolveCommonRepository: unused, lastExportedSnapshot: unused, verifiedArtifactPath: unused },
  };
  return { options, checkout, project, replica: replica.db };
}

function run(db: Db, name: string, inputs: Partial<RunRow> = {}) {
  const row = { session_id: id, status: "running", pid: 98761, pid_start_time: "old-birth", host_pid: process.pid, origin_machine: machine, ...inputs };
  db.prepare(`INSERT INTO runs (id,agent,session_id,status,pid,pid_start_time,host_pid,origin_machine) VALUES (?, 'fixture', ?, ?, ?, ?, ?, ?)`)
    .run(name, row.session_id, row.status, row.pid, row.pid_start_time, row.host_pid, row.origin_machine);
}
function state(db: Db, name: string) {
  return (db.prepare("SELECT status FROM runs WHERE id=?").get(name) as { status: string }).status;
}

it("settles only proven absent local runs of this session", async () => {
  const { options, project, replica } = fixture();
  run(project, "own-gone"); // host_pid is alive, but the verified owner has exited and its PID was recycled.
  run(project, "own-unknown", { pid: 98762, pid_start_time: null });
  run(replica, "probe-unreadable", { pid: 98763 });
  run(replica, "already-terminal", { pid: 98764, status: "cancelled" });
  run(replica, "replica-gone", { pid: 98765 });
  run(replica, "no-child-terminal", { pid: null, status: "done" });
  run(project, "other-session", { session_id: other });
  run(replica, "foreign-origin", { origin_machine: foreign });

  const proveAbsent = async (row: Readonly<RunRow>): Promise<boolean> => {
    if (row.pid === 98763) throw new Error("process identity unreadable");
    // In particular, a live child without a birth identity is not gone,
    // even after an acknowledged signal or a terminal run status.
    return row.pid === 98761 || row.pid === 98765;
  };
  const blockers = await (await stopWork(options)).settleRuns(id, proveAbsent);
  expect({
    ownGone: state(project, "own-gone"), ownUnknown: state(project, "own-unknown"),
    otherSession: state(project, "other-session"), foreignOrigin: state(replica, "foreign-origin"),
    unreadable: state(replica, "probe-unreadable"), replicaGone: state(replica, "replica-gone"),
  }).toEqual({ ownGone: "cancelled", ownUnknown: "running", otherSession: "running", foreignOrigin: "running", unreadable: "running", replicaGone: "cancelled" });
  expect(blockers).toHaveLength(3);
  for (const name of ["own-unknown", "probe-unreadable", "already-terminal"]) expect(blockers).toContainEqual({ kind: "check", reason: expect.stringContaining(name) });
  expect(project.prepare("SELECT session_id, payload FROM run_events WHERE run_id='own-gone' AND type='status'").all())
    .toEqual([{ session_id: id, payload: JSON.stringify({ status: "cancelled" }) }]);
  expect(replica.prepare("SELECT 1 FROM run_events WHERE run_id='already-terminal'").all()).toEqual([]);
});

it.each(["host_pid", "pid_start_time", "origin_machine", "session_id"] as const)("keeps a run pending if %s changes after the absence probe", async field => {
  const { project } = fixture();
  run(project, "changed");
  const values = { host_pid: process.pid + 1, pid_start_time: "new-birth", origin_machine: foreign, session_id: other };
  const result = await reapStoppedSessionRuns({ db: project, sessionId: id, proveAbsent: async row => {
    expect(row).toMatchObject({ id: "changed", session_id: id, host_pid: process.pid, pid: 98761, pid_start_time: "old-birth" });
    project.prepare(`UPDATE runs SET ${field}=? WHERE id='changed'`).run(values[field]);
    return true;
  } });
  expect(result).toEqual({ reaped: [], blockers: ["changed"] });
  expect(state(project, "changed")).toBe("running");
});

it("does not rewrite a natural exit that wins the settlement race", async () => {
  const { project } = fixture();
  run(project, "natural-completion");
  const result = await reapStoppedSessionRuns({ db: project, sessionId: id, proveAbsent: async () => {
    project.prepare("UPDATE runs SET status='done' WHERE id='natural-completion'").run();
    return true;
  } });
  expect(result).toEqual({ reaped: [], blockers: [] });
  expect(state(project, "natural-completion")).toBe("done");
  expect(project.prepare("SELECT 1 FROM run_events WHERE run_id='natural-completion'").all()).toEqual([]);
});

const nonce = "a".repeat(32);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
function evidence(job: JournalJob, changes: Record<string, unknown> = {}) {
  const request = encode({ version: 1, jobId: job.id, nonce });
  const receipt = encode({ version: 1, jobId: job.id, nonce, requestSha256: digest(request), indexSha256: "b".repeat(64),
    outcome: "exited", exitCode: 0, signal: null, finishedAt: 100, stdoutBytes: 0, stderrBytes: 0, ...changes });
  return { request, receipt };
}

async function herdrJob(f: ReturnType<typeof fixture>, session: SessionId, name: string, isChild = false) {
  const sessionId = session as unknown as Owner["sessionId"];
  const owner = {
    sessionId, generation: "fixture-generation", cwd: f.checkout, sessionFile: null, name: null,
    terminal: { coreId: "core", terminalId: "owner", address: "core/owner", socket: join(f.options.root, "hc.sock"), sessionNamespace: "fixture" },
  } as Owner;
  const runId = isChild ? "fixture-run" as JournalJob["runId"] : undefined;
  const store = createJobStore(jobJournalRoot(f.options.root), sessionId, runId);
  const job: JournalJob = {
    version: 1, id: name as JournalJob["id"], ...(runId ? { runId } : {}), owner, machine: "job-machine" as JournalJob["machine"],
    kind: "exec", phase: { kind: "running", address: "job-machine/job-terminal" as Owner["terminal"]["address"], releasedAt: 10 },
    remoteDirectory: `/runtime/${"c".repeat(32)}`, localDirectory: join(store.directory, "logs", name), viewer: null,
    nonce, releaseDeadlineAt: 20, originalFinish: null, output: null, detached: true, callerOwned: true, uncertain: false,
    evidenceConflict: false, noticeMode: "async", notice: "pending", noticeDelivered: false,
    settledMarked: false, terminalExpired: false, updatedAt: 10,
  };
  const save = () => store.write({ version: 1, sessionId, revision: 1, updatedAt: 10, jobs: [job],
    ...(runId ? { child: { id: runId, pid: process.pid, startIdentity: "writer", ended: true } } : {}) });
  await save();
  return { job, store, save };
}

function mockJobReads(job: JournalJob, bytes: () => { request: Buffer; receipt: Buffer; receiptDigest?: string }, terminal?: TerminalSummary) {
  const reads: string[] = [];
  const client: Pick<ReturnType<typeof hcModule.createHcClient>, "get" | "fileRead" | "identity" | "dispose"> = {
    async identity() { return job.owner.terminal; },
    async get(address) {
      reads.push(`get ${address}`);
      if (terminal) return terminal;
      throw new HerdrError("not_found", "terminal is gone");
    },
    async fileRead(on, path) {
      reads.push(`${on} ${path}`);
      expect(on).toBe(job.machine);
      const { request, receipt, receiptDigest } = bytes();
      switch (path) {
        case `${job.remoteDirectory}/request.json`: return request;
        case `${job.remoteDirectory}/request.json.sha256`: return Buffer.from(digest(request));
        case `${job.remoteDirectory}/receipt.json`: return receipt;
        case `${job.remoteDirectory}/receipt.json.sha256`: return Buffer.from(receiptDigest ?? digest(receipt));
        default: throw new Error(`Unexpected job file read: ${path}`);
      }
    },
    dispose() {},
  };
  const connect = vi.spyOn(hcModule, "createHcClient").mockReturnValue(client as ReturnType<typeof hcModule.createHcClient>);
  return { reads, connect, client };
}

function manifest(checkout: string, name: string, session: SessionId) {
  const directory = join(checkout, ".spider", "scratch", "bg", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "job.json"), encode({ schema: 1, id: name, cwd: checkout, ownerSessionId: session,
    argv: ["fixture"], windowsHide: false, startedAt: "2026-01-01T00:00:00.000Z", childPid: process.pid }));
}

it("a foreign receipt does not clear an owned job", async () => {
  const f = fixture();
  manifest(f.checkout, "manifest-job", id);
  manifest(f.checkout, "other-manifest-job", other);
  const child = await herdrJob(f, id, "child-herdr-job", true);
  const parent = await herdrJob(f, id, "parent-herdr-job");
  // The parent monitor already collected its receipt. It may have pruned the remote files.
  const address = "job-machine/job-terminal" as Owner["terminal"]["address"];
  parent.job.phase = { kind: "finished", address, result: { exitCode: 0, reason: "exited", signal: null, finishedAt: 100 } };
  parent.job.output = { complete: true, summary: "" };
  parent.job.terminalReleased = true;
  await parent.save();
  mkdirSync(parent.job.localDirectory, { recursive: true });
  writeFileSync(join(parent.job.localDirectory, "receipt.json"), evidence(parent.job).receipt);
  await herdrJob(f, other, "other-session-job", true);
  // Observe the actual journal bytes to reject collection or marker writes by Stop.
  const before = readFileSync(child.store.path);
  let receipt = evidence(child.job, { nonce: "d".repeat(32) });
  const { reads, connect } = mockJobReads(child.job, () => receipt);
  const work = await stopWork(f.options);
  const first = await work.inspect(id);
  expect(first).toEqual({ complete: true, excludedRoots: [process.pid], blockers: expect.arrayContaining([
    { kind: "job", id: "manifest-job", cancelFromOwner: false },
    { kind: "job", id: "child-herdr-job", cancelFromOwner: true },
  ]) });
  expect(first.blockers).toHaveLength(2);
  receipt = evidence(child.job);
  const after = await work.inspect(id);
  expect(after.blockers).toEqual([{ kind: "job", id: "manifest-job", cancelFromOwner: false }]);
  expect(readFileSync(child.store.path)).toEqual(before);
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ env: expect.objectContaining({
    HC_SOCKET: child.job.owner.terminal.socket, HC_SESSION: child.job.owner.terminal.sessionNamespace,
  }) }));
  expect(new Set(reads)).toEqual(new Set([
    "get job-machine/job-terminal",
    ...["request.json", "request.json.sha256", "receipt.json", "receipt.json.sha256"].map(file => `job-machine ${child.job.remoteDirectory}/${file}`),
  ]));
});

it("keeps a job pending when its receipt digest disagrees", async () => {
  const f = fixture();
  const { job } = await herdrJob(f, id, "digest-conflict");
  mockJobReads(job, () => ({ ...evidence(job), receiptDigest: "d".repeat(64) }));
  expect((await (await stopWork(f.options)).inspect(id)).blockers).toEqual([{ kind: "job", id: job.id, cancelFromOwner: true }]);
});

it("keeps a job pending when native exit conflicts with the payload receipt", async () => {
  const f = fixture();
  const { job } = await herdrJob(f, id, "exit-conflict");
  const address = "job-machine/job-terminal" as TerminalSummary["address"];
  mockJobReads(job, () => evidence(job), { address, state: "finished", exitCode: 7, signal: null, reason: "exited", finishedAt: 100,
    status: null, parent: null, labels: {
      [HERDR_LABELS.kind]: "exec", [HERDR_LABELS.session]: id, [HERDR_LABELS.job]: job.id,
      [HERDR_LABELS.machine]: job.machine, [HERDR_LABELS.ownerCore]: "core", [HERDR_LABELS.ownerTerminal]: "owner",
    },
  });
  expect((await (await stopWork(f.options)).inspect(id)).blockers).toEqual([{ kind: "job", id: job.id, cancelFromOwner: false }]);
});

it.each(["store", "background directory", "child journal"] as const)("cannot prove a complete inventory with an unreadable %s", async what => {
  const f = fixture();
  if (what === "store") writeLocal(f.options.globalDb, "mapping-redirect", "worktree:fixture-repo:fixture-workspace", join(f.checkout, "missing.db"));
  if (what === "background directory") {
    mkdirSync(join(f.checkout, ".spider", "scratch"));
    writeFileSync(join(f.checkout, ".spider", "scratch", "bg"), "not a directory");
  }
  if (what === "child journal") {
    const { store } = await herdrJob(f, id, "unreadable-job", true);
    writeFileSync(store.path, "not a journal");
  }
  const work = await stopWork(f.options);
  const unreadable = await work.inspect(id);
  expect(unreadable.complete).toBe(false);
  expect(unreadable.blockers).toContainEqual({ kind: "check", reason: expect.any(String) });
  if (what === "store") expect(await work.settleRuns(id, async () => true)).toContainEqual({ kind: "check", reason: expect.any(String) });
});


it("does not switch an owned job to a replacement Herdr core", async () => {
  const f = fixture();
  const { job } = await herdrJob(f, id, "original-core");
  const { client, reads } = mockJobReads(job, () => evidence(job));
  vi.spyOn(client, "identity").mockResolvedValue({ ...job.owner.terminal, coreId: "replacement" as Owner["terminal"]["coreId"] });
  const work = await stopWork(f.options);
  expect((await work.inspect(id)).blockers).toEqual([{ kind: "job", id: job.id, cancelFromOwner: false }]);
  expect(reads).toEqual([]);
});

it("keeps a job pending when its saved finish conflicts with the collected receipt", async () => {
  const f = fixture();
  const { job, save } = await herdrJob(f, id, "collected-conflict");
  if (job.phase.kind !== "running") throw new Error("Expected running fixture job");
  job.phase = { kind: "finished", address: job.phase.address, result: { exitCode: 7, reason: "exited", signal: null, finishedAt: 100 } };
  job.terminalReleased = true;
  job.output = { complete: true, summary: "" };
  await save();
  mkdirSync(job.localDirectory, { recursive: true });
  writeFileSync(join(job.localDirectory, "receipt.json"), evidence(job).receipt);
  const work = await stopWork(f.options);
  expect((await work.inspect(id)).blockers).toEqual([{ kind: "job", id: job.id, cancelFromOwner: false }]);
});

it("keeps new work pending when it appears during another run's probe", async () => {
  const { project } = fixture();
  run(project, "first");
  const result = await reapStoppedSessionRuns({ db: project, sessionId: id, proveAbsent: async () => {
    run(project, "new");
    return true;
  } });
  expect(result).toEqual({ reaped: ["first"], blockers: ["new"] });
  expect(state(project, "new")).toBe("running");
});

it("does not infer an empty run inventory when the only project store is missing", async () => {
  const f = fixture();
  const differentCheckout = join(f.options.root, "checkout-without-store");
  mkdirSync(differentCheckout);
  // Repoint the recorded cwd to a real working directory without a run store.
  recordLocation(f.options.globalDb, { sessionId: id, stores: ["global"], home: null, cwd: differentCheckout });
  f.options.git = { ...f.options.git, run: async () => Buffer.from(differentCheckout) };
  const work = await stopWork(f.options);
  expect((await work.inspect(id)).complete).toBe(false);
  expect(await work.settleRuns(id, async () => true)).toContainEqual({ kind: "check", reason: expect.any(String) });
});


it.each(["child journal", "local manifest"] as const)("does not turn a failed %s directory read into an empty scan", async kind => {
  const f = fixture();
  let directory: string;
  if (kind === "child journal") {
    const { store } = await herdrJob(f, id, "hidden-by-failed-read", true);
    directory = join(store.directory, "..");
  } else {
    manifest(f.checkout, "hidden-by-failed-read", id);
    directory = join(f.checkout, ".spider", "scratch", "bg");
  }
  const { readdir } = await vi.importActual<typeof fsPromises>("node:fs/promises");
  vi.mocked(fsPromises.readdir).mockImplementation((async (path, options) => {
    if (path === directory) throw Object.assign(new Error("directory vanished during scan"), { code: "ENOENT" });
    return Reflect.apply(readdir, undefined, [path, options]);
  }) as typeof fsPromises.readdir);
  const work = await stopWork(f.options);
  const result = await work.inspect(id).finally(() => vi.mocked(fsPromises.readdir).mockReset());
  expect(result.complete).toBe(false);
  expect(result.blockers).toContainEqual({ kind: "check", reason: expect.any(String) });
});

it("uses a collected payload receipt even when the owner core is unavailable", async () => {
  const f = fixture();
  const { job, save } = await herdrJob(f, id, "collected-offline");
  if (job.phase.kind !== "running") throw new Error("Expected running fixture job");
  job.phase = { kind: "finished", address: job.phase.address, result: { exitCode: 0, reason: "exited", signal: null, finishedAt: 100 } };
  job.output = { complete: true, summary: "" };
  await save();
  mkdirSync(job.localDirectory, { recursive: true });
  writeFileSync(join(job.localDirectory, "receipt.json"), evidence(job).receipt);
  const { client, reads } = mockJobReads(job, () => evidence(job));
  vi.spyOn(client, "identity").mockRejectedValue(new HerdrError("core-unavailable", "Core disconnected"));
  const work = await stopWork(f.options);
  expect(await work.inspect(id)).toEqual({ complete: true, blockers: [], excludedRoots: [] });
  expect(reads).toEqual([]);
});

it("does not read a mismapped store as this session's local replica", async () => {
  const f = fixture();
  run(f.replica, "other-store");
  f.replica.prepare("UPDATE roam_meta SET store_key='worktree:fixture-repo:different-workspace' WHERE id=1").run();
  const work = await stopWork(f.options);
  expect((await work.inspect(id)).complete).toBe(false);
  expect(await work.settleRuns(id, async () => true)).toContainEqual({ kind: "check", reason: expect.any(String) });
  expect(state(f.replica, "other-store")).toBe("running");
});
