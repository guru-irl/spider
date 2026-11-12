import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Home, SessionState } from "@spider/db-core/roam/types";
import { protectAdmissionApi, registerAdmission, type AdmissionPorts } from "../roam/admission";

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
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
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
  const pi = { on(name: string, handler: (event: any, ctx: any) => unknown) {
    handlers.set(name, [...handlers.get(name) ?? [], handler]);
    return () => { handlers.set(name, (handlers.get(name) ?? []).filter(entry => entry !== handler)); };
  } } as unknown as ExtensionAPI;
  const ctx = { cwd: "/fixture", mode: "tui", hasUI: true, abort: vi.fn(),
    ui: { notify: (message: string) => messages.push(message) },
    sessionManager: { getSessionId: () => id, getSessionFile: () => "/fixture/session.jsonl" } };
  const gate = registerAdmission(pi, ports); gates.push(gate);
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
  blockedApi.sendMessage({ customType: "fixture", content: "blocked", display: true });
  allowedApi.sendMessage({ customType: "fixture", content: "allowed", display: true });
  expect(blockedSend).not.toHaveBeenCalled();
  expect(allowedSend).toHaveBeenCalledOnce();
  await blocked.gate.close();
  expect(await allowed.emit("input", { text: "continue" })).toBeUndefined();
}, 5000);

it("discovery blocks ordinary work until the owning gate is verified", async () => {
  const f = fixture();
  let finish!: (value: Snapshot) => void;
  f.ports.load = () => new Promise(resolve => { finish = resolve; });
  const starting = f.emit("session_start", { reason: "resume" });
  expect(f.gate.inspect().kind).toBe("blocked");
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
    expect(f.gate.inspect().kind).toBe("blocked");
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
  expect(f.warnings).toHaveLength(1);
}, 5000);

it.each(["read", "identity", "lock"] as const)("known participant %s failure blocks plainly", async failure => {
  const f = fixture();
  if (failure === "read") f.failRead(new Error("SQLITE_BUSY after retries"), true);
  if (failure === "identity") f.failIdentity(new Error("machine.json missing"));
  if (failure === "lock") f.failLock(new Error("session ownership unavailable"));
  await f.emit("session_start", { reason: "resume" });
  expect(f.gate.inspect().kind).toBe("blocked");
  await f.emit("input", { text: "work" });
  expect(f.messages.join(" ")).toContain("Cannot verify this session's home. Retry or run spider roam doctor.");
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
  f.setSnapshot(snapshot({ states: [{ ...active, epoch: 2 }] }));
  await f.emit("session_start", { reason: "reload" });
  expect(f.gate.inspect().kind).toBe("blocked");
  f.setSnapshot(snapshot({ captureSafe: false }));
  await f.emit("session_start", { reason: "reload" });
  expect(f.gate.inspect().kind).toBe("blocked");
}, 5000);
