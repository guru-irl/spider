import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scratchDbPath } from "@spider/db-core/testutil";
import type { Home, SessionState } from "@spider/db-core/roam/types";
import { main } from "@spider/roam/cli";
import { protectAdmissionApi, registerAdmission, type AdmissionPorts } from "../roam/admission";
import { registerSlashCommands } from "../slash";

const roots: string[] = [];
const gates: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const gate of gates.splice(0)) await gate.close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const home: Home = { sessionId: "session-1", machineId: "box-1.invalid", epoch: 3, moveId: null, updatedAt: 1 };
const active: SessionState = { sessionId: "session-1", epoch: 3, state: "active", moveId: null, freezeSeq: null };
function session(changes: Partial<Awaited<ReturnType<AdmissionPorts["load"]>>> = {}) {
  const events = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const sent: unknown[] = [], notices: string[] = [], dispatches: unknown[] = [];
  const api = {
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      events.set(name, [...events.get(name) ?? [], handler]);
      return () => {};
    },
    registerCommand(name: string, command: { handler(args: string, ctx: unknown): unknown }) { commands.set(name, command.handler); },
    sendMessage(message: unknown) { sent.push(message); },
  } as unknown as ExtensionAPI;
  const ports: AdmissionPorts = {
    expectedEpoch: null,
    async localMachine() { return "local.invalid"; },
    knownParticipant() { return true; },
    warnOnce() {},
    async load() { return { home, states: [active], origin: "local.invalid", participating: true,
      captureSafe: true, unfinishedFreeze: false, initialConflict: false, ...changes }; },
    async lock() { return async () => {}; },
  };
  const gate = registerAdmission(api, ports); gates.push(gate);
  const protectedApi = protectAdmissionApi(api, gate);
  const ctx = { cwd: "/fixture", mode: "tui", hasUI: true, abort() {}, ui: { notify(text: string) { notices.push(text); } },
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/fixture/session.jsonl" } };
  registerSlashCommands(protectedApi as never, {
    alreadyRegistered: new Set(),
    async run(args: unknown) { dispatches.push(args); return { content: "normal doctor report" }; },
    ordinaryWorkAllowed: () => gate.inspect().kind === "ordinary",
    waitForAdmission: () => gate.whenSettled(),
    async roamDoctor(args: readonly string[]) {
      const output: string[] = [], errors: string[] = [];
      const code = await main(args, { out: text => output.push(text), err: text => errors.push(text) });
      return { text: [...output, ...errors].join(""), code };
    },
  } as never);
  return { gate, ports, commands, ctx, sent, notices, dispatches,
    async start(reason = "resume") { for (const handler of events.get("session_start") ?? []) await handler({ reason }, ctx); } };
}
function root(): string {
  const result = mkdtempSync(join(dirname(scratchDbPath("roam-slash")), "roam-slash-"));
  roots.push(result);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", result);
  vi.stubEnv("HOME", result);
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  return result;
}

it.each(["resume", "reload"])("normal doctor waits for disabled roaming admission during %s", async reason => {
  root();
  const ordinary = { home: null, states: [], origin: null, participating: false, captureSafe: true, unfinishedFreeze: false, initialConflict: false };
  const f = session(ordinary);
  f.ports.knownParticipant = () => false;
  if (reason === "reload") await f.start();
  let finish!: (value: typeof ordinary) => void, entered!: () => void;
  const loading = new Promise<void>(resolve => { entered = resolve; });
  f.ports.load = () => new Promise(resolve => { finish = resolve; entered(); });
  const starting = f.start(reason);
  await loading;
  const doctor = Promise.resolve(f.commands.get("doctor")!("", f.ctx));
  await Promise.resolve();
  const earlyDispatches = [...f.dispatches], earlyMessages = [...f.sent];
  finish(ordinary);
  await Promise.all([starting, doctor]);
  expect(earlyDispatches).toEqual([]);
  expect(earlyMessages).toEqual([]);
  expect(f.gate.inspect().kind).toBe("ordinary");
  expect(f.dispatches).toEqual([{ action: "control", command: "doctor" }]);
  expect(f.sent).toEqual([expect.objectContaining({ customType: "spider.command", content: "normal doctor report", display: true })]);
  expect(f.notices).toEqual([]);
}, 5000);

it("doctor requested while loading still protects a blocked participant", async () => {
  root();
  const f = session();
  let finish!: (value: Awaited<ReturnType<AdmissionPorts["load"]>>) => void, entered!: () => void;
  const loading = new Promise<void>(resolve => { entered = resolve; });
  f.ports.load = () => new Promise(resolve => { finish = resolve; entered(); });
  const starting = f.start();
  await loading;
  const doctor = Promise.resolve(f.commands.get("doctor")!("", f.ctx));
  finish({ home, states: [active], origin: "local.invalid", participating: true, captureSafe: true, unfinishedFreeze: false, initialConflict: false });
  await Promise.all([starting, doctor]);
  expect(f.gate.inspect().kind).toBe("blocked");
  expect(f.dispatches).toEqual([]);
  expect(f.sent).toEqual([]);
  expect(f.notices.join("\n")).toMatch(/roam.*disabled/i);
}, 5000);

it("read-only doctor runs inside a blocked pi session without transcript writes", async () => {
  root();
  const f = session();
  await f.start();
  expect(f.gate.inspect().kind).toBe("blocked");
  await f.commands.get("spider")!("roam doctor", f.ctx);
  expect(f.notices.join("\n")).toMatch(/roam.*disabled/i);
  expect(f.dispatches).toEqual([]);
  expect(f.sent).toEqual([]);
  f.notices.length = 0;
  await f.commands.get("doctor")!("", f.ctx);
  expect(f.notices.join("\n")).toMatch(/roam.*disabled/i);
  expect(f.dispatches).toEqual([]);
  expect(f.sent).toEqual([]);
}, 5000);

it("shows the blocked-session doctor through RPC and no-UI output", async () => {
  root();
  const f = session(); await f.start();
  f.ctx.mode = "rpc";
  await f.commands.get("spider")!("roam doctor", f.ctx);
  expect(f.notices.join("\n")).toMatch(/roam.*disabled/i);
  f.notices.length = 0;
  f.ctx.mode = "print"; f.ctx.hasUI = false;
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await f.commands.get("spider")!("roam doctor", f.ctx);
    expect(stderr.mock.calls.map(call => String(call[0])).join("")).toMatch(/roam.*disabled/i);
    expect(f.notices).toEqual([]);
    expect(f.sent).toEqual([]);
  } finally { stderr.mockRestore(); }
}, 5000);

it("an admitted pi session reports unavailable remote doctor and invalid options", async () => {
  root();
  const f = session({ home: { ...home, machineId: "local.invalid" } });
  await f.start();
  expect(f.gate.inspect().kind).toBe("ordinary");
  await f.commands.get("spider")!("roam doctor box-1.invalid", f.ctx);
  expect(f.notices.join("\n")).toMatch(/remote doctor.*unavailable/i);
  f.notices.length = 0;
  await f.commands.get("spider")!("roam doctor --write", f.ctx);
  expect(f.notices.join("\n")).toMatch(/invalid arguments/i);
  expect(f.dispatches).toEqual([]);
  expect(f.sent).toEqual([]);
}, 5000);

it("the doctor exception cannot run other blocked commands", async () => {
  root();
  const f = session();
  await f.start();
  const errors: unknown[] = [];
  for (const arg of ["roam enable", "roam doctor box-1.invalid", "roam doctor --write"]) {
    try { await f.commands.get("spider")!(arg, f.ctx); } catch (error) { errors.push(error); }
  }
  expect(errors).toEqual([]);
  expect(f.dispatches).toEqual([]);
  expect(f.sent).toEqual([]);
  expect(f.notices).toHaveLength(3);
  expect(f.notices.join(" ")).not.toMatch(/roam.*disabled/i);
}, 5000);

it("every admission guard message names a command available in the build", async () => {
  root();
  const variants = [
    session(),
    session({ states: [{ ...active, state: "frozen", moveId: "move-1" }] }),
    session({ initialConflict: true }),
    session({ captureSafe: false }),
  ];
  for (const f of variants) {
    await f.start();
    const message = f.gate.inspect().blockers[0]?.detail ?? "";
    expect(message).toMatch(/\/doctor|spider roam doctor/i);
    expect(f.commands.has("doctor")).toBe(true);
    await f.commands.get("doctor")!("", f.ctx);
    expect(f.notices.join("\n")).toMatch(/roam.*disabled/i);
    expect(f.sent).toEqual([]);
  }
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "__tests__") return [];
    const file = join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.name.endsWith(".ts") ? [file] : [];
  });
  const references = files("packages/host/src").flatMap(file =>
    [...readFileSync(file, "utf8").matchAll(/Session ownership is not available; run ([^\."\n]+)\./g)].map(match => match[1]));
  expect(references.length).toBeGreaterThan(0);
  for (const command of new Set(references)) {
    expect(command).toBe("spider roam doctor");
    const output: string[] = [];
    expect(await main(command.split(" ").slice(1), { out: text => output.push(text), err: text => output.push(text) })).toBe(0);
    expect(output.join(" ")).toMatch(/roam.*disabled/i);
  }
}, 5000);
