import { afterEach, expect, it, vi } from "vitest";
import { createHostSessionFixture } from './fixtures/pi-events';
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Home, SessionState } from "@spider/db-core/roam/types";
import { AdmissionClosedError, protectAdmissionApi, registerAdmission, type AdmissionPorts } from "../roam/admission";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRunEvent } from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { RunStore } from "../../../subagents/src/run-store";
import { adoptReloadedChildren } from "../../../subagents/src/actions/run";
import { registerShared, releaseShared } from "../../../subagents/src/child-registry";
import { teardownAll } from "../../../subagents/src/coordinators";

const sessionId = "session-1";
const local = "origin.invalid";
const home: Home = { sessionId, machineId: local, epoch: 3, moveId: null, updatedAt: 1 };
const active: SessionState = { sessionId, epoch: 3, state: "active", moveId: null, freezeSeq: null };
type Snapshot = Awaited<ReturnType<AdmissionPorts["load"]>>;
const snapshot = (changes: Partial<Snapshot> = {}): Snapshot => ({
  home, states: [active], origin: local, participating: true, captureSafe: true,
  unfinishedFreeze: false, initialConflict: false, ...changes,
});

const gates: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const gate of gates.splice(0)) await gate.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function fixture(initial = snapshot(), id = sessionId) {
  const messages: string[] = [], warnings: string[] = [], warningKeys = new Set<string>();
  const calls = { admission: 0, lock: 0, local: 0, released: 0 };
  let current = initial, known = initial.participating, readError: Error | undefined;
  let identityError: Error | undefined, lockError: Error | undefined;
  const ports: AdmissionPorts = {
    expectedEpoch: null,
    async localMachine() { calls.local++; if (identityError) throw identityError; return local; },
    knownParticipant: () => known,
    warnOnce(id, reason) { if (!warningKeys.has(id)) { warningKeys.add(id); warnings.push(reason); } },
    async load() { calls.admission++; if (readError) throw readError; if (current.participating) known = true; return current; },
    async lock() { calls.lock++; if (lockError) throw lockError; return async () => { calls.released++; }; },
  };
  const host = createHostSessionFixture({ cwd: "/fixture", sessionId: id, sessionFile: "/fixture/session.jsonl",
    notify: message => messages.push(message), abort: vi.fn() });
  const handlers = host.hooks, ctx = host.ctx;
  const gate = registerAdmission(host.pi as unknown as ExtensionAPI, ports); gates.push(gate);
  async function emit(name: string, event: object = {}) {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      const value = await handler(event, ctx);
      if (value !== undefined) result = value;
    }
    return result;
  }
  return { gate, ports, calls, ctx, messages, warnings, emit, handlers,
    setSnapshot(value: Snapshot) { current = value; },
    failRead(error: Error, alreadyKnown: boolean) { readError = error; known = alreadyKnown; },
    failIdentity(error: Error) { identityError = error; },
    failLock(error: Error) { lockError = error; },
  };
}

it.each(["untracked", "read-error", "missing-id"] as const)("an exact handoff cannot fall back to ordinary admission: %s", async mode => {
  vi.stubEnv("SPIDER_HERDR_HANDOFF_FILE", "/fixture/handoff.json");
  const f = fixture(snapshot({ home: null, states: [], origin: null, participating: false }), mode === "missing-id" ? "" : sessionId);
  if (mode === "read-error") f.failRead(new Error("unavailable"), false);
  await f.emit("session_start", { reason: "startup" });
  expect(f.gate.inspect().kind).toBe("blocked");
  expect(await f.emit("input", { text: "continue" })).toEqual({ action: "handled" });
  expect(f.calls.lock).toBe(0);
}, 5000);

it("an inherited subagent flag cannot bypass exact handoff admission", async () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  vi.stubEnv("SPIDER_HERDR_HANDOFF_FILE", "/fixture/handoff.json");
  const f = fixture();
  await f.emit("session_start", { reason: "startup" });
  expect(f.calls.lock).toBe(1);
  expect(f.gate.inspect().kind).toBe("ordinary");
}, 5000);

it("admission finishes before first session upsert", async () => {
  const f = fixture(snapshot({ home: { ...home, machineId: "destination.invalid" } }));
  const startupCalls: string[] = [];
  const load = f.ports.load;
  f.ports.load = async id => { startupCalls.push("admission"); return load(id); };
  await f.emit("session_start", { reason: "resume" });
  if (f.gate.inspect().kind === "ordinary") startupCalls.push("session-upsert");
  expect(startupCalls).toEqual(["admission"]);
  expect(f.gate.inspect().kind).toBe("blocked");
}, 5000);

it("independent sessions in one process keep separate admission gates", async () => {
  const blocked = fixture(snapshot({ home: { ...home, machineId: "destination.invalid" } }));
  await blocked.emit("session_start", { reason: "resume" });
  const allowed = fixture(snapshot({ home: null, states: [], origin: null, participating: false }), "ordinary-session");
  await allowed.emit("session_start", { reason: "resume" });
  expect(await blocked.emit("input", { text: "continue" })).toEqual({ action: "handled" });
  expect(await allowed.emit("input", { text: "continue" })).toBeUndefined();
  const blockedSend = vi.fn(), allowedSend = vi.fn();
  const blockedApi = protectAdmissionApi({ sendMessage: blockedSend } as unknown as ExtensionAPI, blocked.gate);
  const allowedApi = protectAdmissionApi({ sendMessage: allowedSend } as unknown as ExtensionAPI, allowed.gate);
  expect(() => blockedApi.sendMessage({ customType: "fixture", content: "blocked", display: true })).toThrow(AdmissionClosedError);
  allowedApi.sendMessage({ customType: "fixture", content: "allowed", display: true });
  expect(blockedSend).not.toHaveBeenCalled();
  expect(allowedSend).toHaveBeenCalledOnce();
  await blocked.gate.close();
  expect(await allowed.emit("input", { text: "continue" })).toBeUndefined();
}, 5000);

it("redelivers a supervised completion exactly once after a closed gate reopens", async () => {
  const f = fixture(snapshot());
  const machine = "11111111-1111-4111-8111-111111111111";
  const worktree = createReplica("worktree", machine), global = createReplica("global", machine);
  const id = "closed-gate-run", directory = join(worktree.root, "supervisor");
  mkdirSync(directory);
  worktree.db.prepare("INSERT INTO runs(id,session_id,agent,status,child_mode) VALUES (?, ?, 'worker', 'running', 'rpc')").run(id, sessionId);
  appendRunEvent(worktree.db, { runId: id, sessionId, ts: Date.now(), type: "child_supervisor", payload: { version: 1, directory } });
  global.db.prepare("INSERT INTO run_routes(run_id,session_id,db_path) VALUES (?,?,?)").run(id, sessionId, worktree.db.raw.name);
  const delivered: any[] = [];
  let signal!: () => void;
  const completion = new Promise<void>(resolve => { signal = resolve; });
  const pi = protectAdmissionApi({ sendMessage: (message: any) => { delivered.push(message); signal(); } } as unknown as ExtensionAPI, f.gate);
  const ctx = { db: worktree.db, globalDb: global.db, sessionId, cwd: worktree.root, runDbPath: worktree.db.raw.name, pi };
  try {
    await f.emit("session_start", { reason: "resume" });
    let exit!: (value: { exitCode: number; result: string }) => void;
    const outcome = new Promise<{ exitCode: number; result: string }>(resolve => { exit = resolve; });
    const handle = { durable: true, wait: () => outcome, kill() {}, detach() {} };
    const entry = registerShared({ runId: id, sessionId, dbPath: worktree.db.raw.name, mode: "rpc", handle, survivable: true });
    entry.state = "independent";
    expect(adoptReloadedChildren(ctx)).toEqual({ adopted: [id], refused: [] });
    await f.gate.close();
    writeFileSync(join(directory, "exit.json"), JSON.stringify({ exitCode: 0, result: "durable result" }));
    exit({ exitCode: 0, result: "durable result" });
    await Promise.resolve();
    expect(new RunStore(worktree.db).get(id)?.status).toBe("done");
    expect(delivered).toEqual([]);
    expect(worktree.db.prepare("SELECT count(*) AS n FROM run_events WHERE run_id=? AND type='completion_delivered'").get(id)).toEqual({ n: 0 });
    expect(global.db.prepare("SELECT run_id FROM run_routes WHERE run_id=?").get(id)).toEqual({ run_id: id });
    f.setSnapshot(snapshot());
    await f.emit("session_start", { reason: "resume" });
    expect(f.gate.inspect().kind).toBe("ordinary");
    expect(adoptReloadedChildren(ctx)).toEqual({ adopted: [id], refused: [] });
    await completion;
    expect(delivered).toHaveLength(1);
    expect(delivered[0].content).toContain("durable result");
    expect(worktree.db.prepare("SELECT count(*) AS n FROM run_events WHERE run_id=? AND type='completion_delivered'").get(id)).toEqual({ n: 1 });
    expect(global.db.prepare("SELECT run_id FROM run_routes WHERE run_id=?").get(id)).toBeUndefined();
    adoptReloadedChildren(ctx);
    expect(delivered).toHaveLength(1);
  } finally { teardownAll(); releaseShared(id); worktree.close(); global.close(); }
}, 5000);

it.each(["resume", "reload"])("%s reports pending while ownership is loading without admitting work", async reason => {
  const ordinary = snapshot({ home: null, states: [], origin: null, participating: false });
  const f = fixture(ordinary);
  let finish!: (value: Snapshot) => void, entered!: () => void;
  const loading = new Promise<void>(resolve => { entered = resolve; });
  f.ports.load = () => new Promise(resolve => { finish = resolve; entered(); });
  const starting = f.emit("session_start", { reason });
  await loading;
  const during = f.gate.inspect().kind;
  const input = await f.emit("input", { text: "continue" });
  finish(ordinary);
  await starting;
  expect(during).toBe("pending");
  expect(input).toEqual({ action: "handled" });
  expect(f.gate.inspect().kind).toBe("ordinary");
  expect(f.calls.lock).toBe(0);
}, 5000);

it("discovery blocks ordinary work until the owning gate is verified", async () => {
  const f = fixture();
  let finish!: (value: Snapshot) => void;
  f.ports.load = () => new Promise(resolve => { finish = resolve; });
  const starting = f.emit("session_start", { reason: "resume" });
  expect(f.gate.inspect().kind).toBe("pending");
  expect(await f.emit("input", { text: "continue" })).toEqual({ action: "handled" });
  finish(snapshot());
  await starting;
  expect(f.gate.inspect().kind).toBe("ordinary");
}, 5000);

it("only the admitted lock holder can freeze, and the same freeze is idempotent", async () => {
  const blocked = fixture(snapshot({ home: { ...home, machineId: "destination.invalid" } }));
  await blocked.emit("session_start", { reason: "resume" });
  await expect(blocked.gate.freeze("move-1", 3)).rejects.toThrow();
  expect(blocked.gate.inspect().kind).toBe("blocked");
  const owner = fixture();
  await owner.emit("session_start", { reason: "resume" });
  await owner.gate.freeze("move-1", 3);
  await expect(owner.gate.freeze("move-1", 3)).resolves.toBeUndefined();
  expect(owner.gate.inspect().kind).toBe("control-only");
}, 5000);

it("waiting for admission follows a superseding reload", async () => {
  const ordinary = snapshot({ home: null, states: [], origin: null, participating: false });
  const f = fixture(ordinary);
  let firstFinish!: (value: Snapshot) => void, secondFinish!: (value: Snapshot) => void;
  let firstEntered!: () => void, secondEntered!: () => void, calls = 0;
  const firstLoading = new Promise<void>(resolve => { firstEntered = resolve; });
  const secondLoading = new Promise<void>(resolve => { secondEntered = resolve; });
  f.ports.load = () => new Promise(resolve => {
    calls++;
    if (calls === 1) { firstFinish = resolve; firstEntered(); }
    else { secondFinish = resolve; secondEntered(); }
  });
  const first = f.emit("session_start", { reason: "resume" });
  await firstLoading;
  let settled = false;
  const waiting = f.gate.whenSettled().then(value => { settled = true; return value; });
  const second = f.emit("session_start", { reason: "reload" });
  firstFinish(ordinary);
  await secondLoading;
  await Promise.resolve();
  const settledDuringReload = settled;
  secondFinish(snapshot({ home: { ...home, machineId: "destination.invalid" } }));
  await Promise.all([first, second]);
  const result = await waiting;
  expect(settledDuringReload).toBe(false);
  expect(result.kind).toBe("blocked");
  expect(result.home?.machineId).toBe("destination.invalid");
}, 5000);

it("a superseded pending claim releases before its replacement claims", async () => {
  const f = fixture(), order: string[] = [];
  let finishClaim!: () => void, entered!: () => void, claims = 0;
  const claiming = new Promise<void>(resolve => { entered = resolve; });
  f.ports.lock = async () => {
    order.push("claim"); claims++;
    if (claims > 1) return async () => {};
    return new Promise<() => Promise<void>>(resolve => {
      finishClaim = () => resolve(async () => { order.push("release"); }); entered();
    });
  };
  const stale = f.emit("session_start", { reason: "resume" });
  await claiming;
  const replacement = f.emit("session_start", { reason: "resume" });
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(["claim"]);
  } finally { finishClaim(); await Promise.all([stale, replacement]); }
  expect(order).toEqual(["claim", "release", "claim"]);
  expect(f.gate.inspect().kind).toBe("ordinary");
}, 5000);

it("close waits for a pending claim to be released", async () => {
  const f = fixture(), release = vi.fn(async () => {});
  let finishClaim!: () => void, entered!: () => void;
  const claiming = new Promise<void>(resolve => { entered = resolve; });
  f.ports.lock = () => new Promise<() => Promise<void>>(resolve => {
    finishClaim = () => resolve(release); entered();
  });
  const starting = f.emit("session_start", { reason: "resume" });
  await claiming;
  let closed = false;
  const closing = f.gate.close().then(() => { closed = true; });
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(closed).toBe(false);
    expect(f.gate.inspect().kind).toBe("blocked");
  } finally { finishClaim(); await Promise.all([starting, closing]); }
  expect(release).toHaveBeenCalledOnce();
  expect(f.gate.inspect().kind).toBe("blocked");
}, 5000);

it("a replacement waits for the previous ownership release before claiming", async () => {
  const f = fixture();
  let finishRelease!: () => void, entered!: () => void, claims = 0;
  const releasing = new Promise<void>(resolve => { entered = resolve; });
  f.ports.lock = async () => {
    claims++;
    if (claims > 1) return async () => {};
    return () => new Promise<void>(resolve => { finishRelease = resolve; entered(); });
  };
  await f.emit("session_start", { reason: "resume" });
  f.ctx.sessionManager.getSessionFile = () => "/fixture/replacement.jsonl";
  const stale = f.emit("session_start", { reason: "resume" });
  await releasing;
  const replacement = f.emit("session_start", { reason: "resume" });
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(claims).toBe(1);
    expect(f.gate.inspect().kind).toBe("pending");
  } finally { finishRelease(); await Promise.all([stale, replacement]); }
  expect(claims).toBe(2);
  expect(f.gate.inspect().kind).toBe("ordinary");
}, 5000);

it("a failed superseded release is retried before replacement", async () => {
  const f = fixture();
  let rejectRelease!: (error: Error) => void, entered!: () => void, claims = 0, releases = 0;
  const releasing = new Promise<void>(resolve => { entered = resolve; });
  f.ports.lock = async () => {
    claims++;
    if (claims > 1) return async () => {};
    return () => {
      releases++;
      return releases === 1 ? new Promise<void>((_resolve, reject) => { rejectRelease = reject; entered(); }) : Promise.resolve();
    };
  };
  await f.emit("session_start", { reason: "resume" });
  f.ctx.sessionManager.getSessionFile = () => "/fixture/replacement.jsonl";
  const stale = f.emit("session_start", { reason: "resume" });
  await releasing;
  f.ctx.sessionManager.getSessionFile = () => "/fixture/session.jsonl";
  const replacement = f.emit("session_start", { reason: "resume" });
  await Promise.resolve(); await Promise.resolve();
  rejectRelease(new Error("old release failed"));
  await Promise.all([stale, replacement]);
  expect(releases).toBe(2);
  expect(claims).toBe(2);
  expect(f.gate.inspect().kind).toBe("ordinary");
}, 5000);

it("child processes do not install top-level admission hooks or claim locks", async () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  const f = fixture();
  await f.emit("session_start", { reason: "resume" });
  expect(f.calls.admission).toBe(0);
  expect(f.calls.lock).toBe(0);
  expect(f.gate.inspect().kind).toBe("ordinary");
  expect(f.handlers.has("cache_warming_decision")).toBe(false);
}, 5000);

it("nonparticipating sessions keep existing startup without ID lock", async () => {
  const f = fixture(snapshot({ home: null, states: [], origin: null, participating: false }));
  await f.emit("session_start", { reason: "resume" });
  const nonparticipantIdLockCalls = f.calls.lock;
  expect(f.gate.inspect().kind).toBe("ordinary");
  expect(f.gate.inspect().kind === "ordinary").toBe(true);
  expect(nonparticipantIdLockCalls).toBe(0);
  expect(f.calls.local).toBe(0);
}, 5000);

it("nonowner input is handled with a home message", async () => {
  const f = fixture(snapshot({ home: { ...home, machineId: "destination.invalid" } }));
  await f.emit("session_start", { reason: "resume" });
  expect(await f.emit("input", { text: "continue", source: "interactive" })).toEqual({ action: "handled" });
  expect(f.messages.join(" ")).toContain("destination.invalid");
  expect(f.gate.inspect().kind === "ordinary").toBe(false);
}, 5000);

it.each(["before_agent_start", "turn_start"])("nonowner %s aborts the agent", async event => {
  const f = fixture(snapshot({ home: { ...home, machineId: "destination.invalid" } }));
  await f.emit("session_start", { reason: "resume" });
  await f.emit(event);
  expect(f.ctx.abort).toHaveBeenCalledOnce();
}, 5000);

it.each(["session_before_compact", "session_before_tree", "session_before_fork"])("nonowner %s cancels transcript mutation", async event => {
  const f = fixture(snapshot({ home: { ...home, machineId: "destination.invalid" } }));
  await f.emit("session_start", { reason: "resume" });
  expect(await f.emit(event)).toEqual({ cancel: true });
}, 5000);

it("nonowner tool and shell calls return native blocks", async () => {
  const f = fixture(snapshot({ home: { ...home, machineId: "destination.invalid" } }));
  await f.emit("session_start", { reason: "resume" });
  expect(await f.emit("tool_call", { toolName: "write", input: {} })).toMatchObject({ block: true });
  expect(await f.emit("user_bash", { command: "echo unsafe" })).toMatchObject({ result: { exitCode: 1, cancelled: false } });
}, 5000);

it("nonowner shortcuts and direct subprocesses cannot start work", async () => {
  const f = fixture(snapshot({ home: { ...home, machineId: "destination.invalid" } }));
  await f.emit("session_start", { reason: "resume" });
  let shortcut: ((ctx: unknown) => void) | undefined;
  const effect = vi.fn(), exec = vi.fn();
  const pi = { registerShortcut(_key: string, value: { handler: (ctx: unknown) => void }) { shortcut = value.handler; }, exec } as unknown as ExtensionAPI;
  const guarded = protectAdmissionApi(pi, f.gate);
  guarded.registerShortcut("ctrl+alt+k", { handler: effect });
  shortcut!(f.ctx);
  expect(effect).not.toHaveBeenCalled();
  await expect(guarded.exec("unused", [])).rejects.toThrow();
  expect(exec).not.toHaveBeenCalled();
}, 5000);

it("nonowner cache warming stops", async () => {
  const f = fixture(snapshot({ home: { ...home, machineId: "destination.invalid" } }));
  await f.emit("session_start", { reason: "resume" });
  expect(await f.emit("cache_warming_decision", { action: "warm" })).toEqual({ action: "stop" });
}, 5000);

it("all stores must be active", async () => {
  const f = fixture(snapshot({ states: [active, { ...active, state: "retired" }] }));
  await f.emit("session_start", { reason: "resume" });
  expect(f.gate.inspect().kind).toBe("blocked");
  expect(f.gate.inspect().kind === "ordinary").toBe(false);
}, 5000);

it("unfinished freeze blocks despite active rows", async () => {
  const f = fixture(snapshot({ unfinishedFreeze: true }));
  await f.emit("session_start", { reason: "resume" });
  expect(f.gate.inspect().kind).toBe("control-only");
  expect(f.gate.inspect().kind === "ordinary").toBe(false);
}, 5000);

it("reload cannot clear frozen state", async () => {
  const f = fixture(snapshot({ states: [{ ...active, state: "frozen", moveId: "move-1" }] }));
  await f.emit("session_start", { reason: "reload" });
  expect(f.gate.inspect().kind).toBe("control-only");
  await f.emit("session_start", { reason: "reload" });
  expect(f.gate.inspect().kind).toBe("control-only");
  expect(f.gate.inspect().kind === "ordinary").toBe(false);
}, 5000);

it("admission read failure on a nonparticipating session admits and logs once", async () => {
  const f = fixture(snapshot({ home: null, states: [], origin: null, participating: false }));
  f.failRead(new Error("SQLITE_BUSY after retries"), false);
  await f.emit("session_start", { reason: "resume" });
  await f.emit("session_start", { reason: "resume" });
  expect(f.gate.inspect().kind).toBe("ordinary");
  expect(f.calls.lock).toBe(0);
  expect(f.calls.local).toBe(0);
  expect(f.warnings).toEqual(["Cannot verify this session's home. Retry or run /spider roam doctor for details."]);
}, 5000);

it.each(["read", "identity", "lock"] as const)("known participant %s failure blocks plainly", async failure => {
  const f = fixture();
  if (failure === "read") f.failRead(new Error("SQLITE_BUSY after retries"), true);
  if (failure === "identity") f.failIdentity(new Error("machine.json missing"));
  if (failure === "lock") f.failLock(new Error("session ownership unavailable"));
  await f.emit("session_start", { reason: "resume" });
  expect(f.gate.inspect().kind).toBe("blocked");
  await f.emit("input", { text: "work" });
  expect(f.messages.join(" ")).toContain("Cannot verify this session's home. Retry or run /spider roam doctor for details.");
  expect(f.gate.inspect().kind === "ordinary").toBe(false);
}, 5000);

it("a previously observed participant cannot silently become ordinary when its rows disappear", async () => {
  const f = fixture();
  await f.emit("session_start", { reason: "resume" });
  expect(f.gate.inspect().kind).toBe("ordinary");
  f.setSnapshot(snapshot({ home: null, states: [], origin: null, participating: false }));
  await f.emit("session_start", { reason: "reload" });
  expect(f.gate.inspect().kind).toBe("blocked");
  expect(f.gate.inspect().kind === "ordinary").toBe(false);
}, 5000);

it("an active local home remains usable without the hub", async () => {
  const f = fixture();
  await f.emit("session_start", { reason: "resume" });
  expect(f.gate.inspect().kind).toBe("ordinary");
  expect(f.calls.lock).toBe(1);
  expect(f.gate.inspect().kind === "ordinary").toBe(true);
}, 5000);

it("an unassigned origin admits only its active local epoch-one copy", async () => {
  const f = fixture(snapshot({ home: null, states: [{ ...active, epoch: 1 }], origin: local }));
  await f.emit("session_start", { reason: "resume" });
  expect(f.gate.inspect().kind).toBe("ordinary");
  f.setSnapshot(snapshot({ home: null, states: [{ ...active, epoch: 1 }], origin: "destination.invalid" }));
  await f.emit("session_start", { reason: "reload" });
  expect(f.gate.inspect().kind).toBe("blocked");
}, 5000);

it("a conflicting initial home and incompatible epoch never admit", async () => {
  const f = fixture(snapshot({ initialConflict: true }));
  await f.emit("session_start", { reason: "resume" });
  expect(f.gate.inspect().kind).toBe("blocked");
  expect(f.gate.inspect().blockers[0]?.detail).toBe("This session has conflicting initial homes. Run /spider roam doctor for details.");
  f.setSnapshot(snapshot({ states: [{ ...active, epoch: 2 }] }));
  await f.emit("session_start", { reason: "reload" });
  expect(f.gate.inspect().kind).toBe("blocked");
  f.setSnapshot(snapshot({ captureSafe: false }));
  await f.emit("session_start", { reason: "reload" });
  expect(f.gate.inspect().kind).toBe("blocked");
}, 5000);
