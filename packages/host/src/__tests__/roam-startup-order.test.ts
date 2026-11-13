import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { openDbAt, paths, setGlobalDbPathForTests } from "@spider/db-core";
import spiderExtension from "../extension";
import { HostEmbeddingRuntime } from "../embedding-runtime";
import * as admission from "../roam/admission";
import * as roamCli from "@spider/roam/cli";

const trace = vi.hoisted(() => ({ startupCalls: [] as string[] }));
vi.mock("../usage/mount.js", () => ({
  registerUsage(pi: { on(name: string, handler: () => void): void }, _url: unknown, admitted: () => boolean) {
    pi.on("session_start", () => { if (admitted()) trace.startupCalls.push("usage"); });
    return { reload() {}, snapshot() {}, readPanel: async () => null, doctor: async () => ({ ok: true, lines: [] }) };
  },
}));
vi.mock("../herdr/mount.js", () => ({
  effectiveHerdrConfigPath: () => null, standardHerdrConfigPath: () => "",
  mountHerdr(pi: { on(name: string, handler: () => void): void }, options: { admitted: () => boolean }) {
    pi.on("session_start", () => { if (options.admitted()) trace.startupCalls.push("feed"); });
    return { enabled: () => false, execution: () => ({}), guard: async () => undefined, dispose: async () => {} };
  },
}));
vi.mock("@spider/organism", async importOriginal => {
  const actual = await importOriginal<typeof import("@spider/organism")>();
  return { ...actual, registerOrganism(_host: unknown, pi: { on(name: string, handler: () => void): void }, _deps: unknown, _error: unknown, admitted: () => boolean) {
    pi.on("session_start", () => { if (admitted()) trace.startupCalls.push("organism"); });
  } };
});
vi.mock("@spider/superpowers", async importOriginal => {
  const actual = await importOriginal<typeof import("@spider/superpowers")>();
  return { ...actual, registerSuperpowers: () => { trace.startupCalls.push("superpowers"); } };
});
vi.mock("@spider/subagents", async importOriginal => {
  const actual = await importOriginal<typeof import("@spider/subagents")>();
  return { ...actual,
    reapOrphanRuns: async () => { trace.startupCalls.push("reaper"); return {}; },
    pollPendingMessages: async () => { trace.startupCalls.push("messages"); },
    adoptReloadedChildren: () => { trace.startupCalls.push("adoption"); },
  };
});

let root = "";
const initialGlobalRoot = paths.globalRoot;
afterEach(() => {
  paths.globalRoot = initialGlobalRoot;
  setGlobalDbPathForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
  trace.startupCalls.length = 0;
});

it("blocked startup calls no reaper usage trigger feed or organism", async () => {
  const base = resolve(".spider/scratch/roam-startup-order");
  mkdirSync(base, { recursive: true });
  root = mkdtempSync(join(base, "case-"));
  const cwd = join(root, "workspace"), globalRoot = join(root, "global");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "-q", cwd]);
  vi.stubEnv("GIT_CEILING_DIRECTORIES", root);
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  vi.stubEnv("HOME", root);
  paths.globalRoot = globalRoot;
  vi.stubEnv("SPIDER_GLOBAL_ROOT", globalRoot);
  setGlobalDbPathForTests(join(globalRoot, "spider.db"));
  const global = openDbAt(join(globalRoot, "spider.db"), "global");
  const worktreeFile = join(cwd, ".spider", "project.db");
  const worktree = openDbAt(worktreeFile, "worktree");
  const file = join(root, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd }) + "\n");
  worktree.prepare("INSERT INTO sessions(id, reason, started_at, origin_machine) VALUES (?, ?, ?, ?)").run("session-1", "unchanged", 1, "destination.invalid");
  worktree.prepare("INSERT INTO roam_sessions(session_id, epoch, state) VALUES (?, ?, ?)").run("session-1", 1, "retired");
  global.prepare("INSERT INTO session_homes(session_id, machine_id, epoch, updated_at) VALUES (?, ?, ?, ?)").run("session-1", "destination.invalid", 1, 1);
  const globalVersion = global.raw.pragma("data_version", { simple: true }) as number;
  const worktreeVersion = worktree.raw.pragma("data_version", { simple: true }) as number;
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const commands = new Map<string, { handler(args: string, ctx: unknown): unknown }>(), notices: string[] = [], sent: unknown[] = [];
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => unknown) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; },
    registerTool() {}, registerCommand(name: string, command: { handler(args: string, ctx: unknown): unknown }) { commands.set(name, command); },
    registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
    sendMessage(message: unknown) { sent.push(message); }, sendUserMessage() {}, appendEntry() { trace.startupCalls.push("trigger"); },
  };
  const ctx = { cwd, mode: "tui", hasUI: true, ui: { notify(text: string) { notices.push(text); } }, abort() {}, isIdle: () => true,
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => file, getSessionName: () => null, getEntries: () => [], getBranch: () => [], getLeafId: () => null } };
  vi.spyOn(HostEmbeddingRuntime.prototype, "start").mockImplementation(() => { trace.startupCalls.push("embedding"); });
  const createPorts = admission.createAdmissionPorts;
  vi.spyOn(admission, "createAdmissionPorts").mockImplementation(options => {
    const ports = createPorts(options), load = ports.load;
    ports.load = async id => { trace.startupCalls.push("admission"); return load(id); };
    return ports;
  });
  spiderExtension(pi as never);
  for (const handler of hooks.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);
  const files = [global.raw.name, worktree.raw.name].flatMap(file => [file, `${file}-wal`, `${file}-shm`]);
  const fingerprint = () => files.map(file => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null);
  const beforeDoctor = fingerprint();
  await commands.get("spider")!.handler("roam doctor", ctx);
  expect(notices.join("\n")).toMatch(/roam.*disabled/i);
  notices.length = 0;
  await commands.get("doctor")!.handler("", ctx);
  expect(notices.join("\n")).toMatch(/roam.*disabled/i);
  expect(sent).toEqual([]);
  expect(fingerprint()).toEqual(beforeDoctor);
  const session = worktree.prepare("SELECT reason FROM sessions WHERE id = ?").get("session-1") as { reason: string };
  const dbWritesAfterBlock = (global.raw.pragma("data_version", { simple: true }) as number) - globalVersion +
    (worktree.raw.pragma("data_version", { simple: true }) as number) - worktreeVersion;
  global.close();
  worktree.close();
  expect(session.reason).toBe("unchanged");
  expect(dbWritesAfterBlock).toBe(0);
  expect(trace.startupCalls).toEqual(["admission"]);
}, 5000);

it("roaming doctor leaves pi's event loop responsive during inspection", async () => {
  const base = resolve(".spider/scratch/roam-startup-order");
  mkdirSync(base, { recursive: true }); root = mkdtempSync(join(base, "responsive-"));
  const globalRoot = join(root, "global"); mkdirSync(globalRoot, { recursive: true });
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", globalRoot); vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  paths.globalRoot = globalRoot; setGlobalDbPathForTests(join(globalRoot, "spider.db"));
  const commands = new Map<string, { handler(args: string, ctx: unknown): unknown }>(), notices: string[] = [];
  const pi = { on() {}, registerTool() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
    registerCommand(name: string, command: { handler(args: string, ctx: unknown): unknown }) { commands.set(name, command); },
    sendMessage() {}, sendUserMessage() {}, appendEntry() {} };
  vi.spyOn(roamCli, "main").mockImplementation(async (_args, io) => {
    const until = Date.now() + 150;
    while (Date.now() < until) { /* Model a slow synchronous inspection. */ }
    io.out("Roaming is disabled.\n"); return 0;
  });
  spiderExtension(pi as never);
  const ctx = { cwd: root, mode: "tui", hasUI: true, ui: { notify(text: string) { notices.push(text); } },
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => null } };
  let done = false;
  const result = Promise.resolve(commands.get("spider")!.handler("roam doctor", ctx)).then(() => { done = true; });
  const finishedBeforeTick = await new Promise<boolean>(resolve => setImmediate(() => resolve(done)));
  await result;
  expect(finishedBeforeTick).toBe(false);
  expect(notices.join("\n")).toMatch(/roam.*disabled/i);
  expect(existsSync(join(globalRoot, "spider.db"))).toBe(false);
}, 5000);

it("a second host session cannot reopen or close another session's gate", async () => {
  const base = resolve(".spider/scratch/roam-startup-order");
  mkdirSync(base, { recursive: true }); root = mkdtempSync(join(base, "case-"));
  const cwd = join(root, "workspace"), globalRoot = join(root, "global");
  mkdirSync(cwd, { recursive: true }); mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "-q", cwd]);
  vi.stubEnv("GIT_CEILING_DIRECTORIES", root); vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  paths.globalRoot = globalRoot; vi.stubEnv("SPIDER_GLOBAL_ROOT", globalRoot); setGlobalDbPathForTests(join(globalRoot, "spider.db"));
  const global = openDbAt(join(globalRoot, "spider.db"), "global");
  const worktree = openDbAt(join(cwd, ".spider", "project.db"), "worktree");
  global.prepare("INSERT INTO session_homes(session_id, machine_id, epoch, updated_at) VALUES (?, ?, ?, ?)").run("foreign", "destination.invalid", 1, 1);
  worktree.prepare("INSERT INTO sessions(id, reason, started_at) VALUES (?, ?, ?)").run("foreign", "unchanged", 1);
  worktree.prepare("INSERT INTO roam_sessions(session_id, epoch, state) VALUES (?, ?, ?)").run("foreign", 1, "retired");
  vi.spyOn(HostEmbeddingRuntime.prototype, "start").mockImplementation(() => {});
  function host(id: string) {
    const file = join(root, `${id}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd }) + "\n");
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const pi = {
      on(name: string, handler: (event: any, ctx: any) => unknown) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; },
      registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
      sendMessage() {}, sendUserMessage() {}, appendEntry() {},
    };
    const ctx = { cwd, mode: "tui", hasUI: false, ui: { notify() {} }, abort() {}, isIdle: () => true,
      sessionManager: { getSessionId: () => id, getSessionFile: () => file, getSessionName: () => null, getEntries: () => [], getBranch: () => [], getLeafId: () => null } };
    spiderExtension(pi as never);
    return { async emit(name: string, event: object = {}) {
      let result: unknown;
      for (const handler of hooks.get(name) ?? []) { const next = await handler(event, ctx); if (next !== undefined) result = next; }
      return result;
    } };
  }
  const blocked = host("foreign"), allowed = host("ordinary");
  try {
    await blocked.emit("session_start", { reason: "resume" });
    await allowed.emit("session_start", { reason: "resume" });
    expect(await blocked.emit("input", { text: "continue" })).toEqual({ action: "handled" });
    expect(await allowed.emit("input", { text: "continue" })).toBeUndefined();
    await blocked.emit("session_shutdown", { reason: "quit" });
    expect(await allowed.emit("input", { text: "continue" })).toBeUndefined();
  } finally {
    await allowed.emit("session_shutdown", { reason: "quit" });
    global.close(); worktree.close();
  }
}, 5000);

it("nonparticipating sessions keep existing startup without ID lock", async () => {
  const base = resolve(".spider/scratch/roam-startup-order");
  mkdirSync(base, { recursive: true }); root = mkdtempSync(join(base, "case-"));
  const cwd = join(root, "workspace"), globalRoot = join(root, "global");
  mkdirSync(cwd, { recursive: true }); mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "-q", cwd]);
  vi.stubEnv("GIT_CEILING_DIRECTORIES", root); vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  paths.globalRoot = globalRoot; vi.stubEnv("SPIDER_GLOBAL_ROOT", globalRoot); setGlobalDbPathForTests(join(globalRoot, "spider.db"));
  const global = openDbAt(join(globalRoot, "spider.db"), "global");
  const worktree = openDbAt(join(cwd, ".spider", "project.db"), "worktree");
  worktree.prepare("INSERT INTO sessions(id, reason, started_at) VALUES (?, ?, ?)").run("ordinary-session", "unchanged", 1);
  const file = join(root, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "ordinary-session", cwd }) + "\n");
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => unknown) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; },
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
    sendMessage() {}, sendUserMessage() {}, appendEntry() { trace.startupCalls.push("trigger"); },
  };
  const ctx = { cwd, mode: "tui", hasUI: false, ui: { notify() {} }, abort() {}, isIdle: () => true,
    sessionManager: { getSessionId: () => "ordinary-session", getSessionFile: () => file, getSessionName: () => null, getEntries: () => [], getBranch: () => [] } };
  let nonparticipantIdLockCalls = 0, identityCalls = 0;
  const createPorts = admission.createAdmissionPorts;
  vi.spyOn(admission, "createAdmissionPorts").mockImplementation(options => {
    const ports = createPorts(options), load = ports.load;
    ports.load = async id => { trace.startupCalls.push("admission"); return load(id); };
    ports.lock = async () => { nonparticipantIdLockCalls++; throw new Error("unexpected lock"); };
    ports.localMachine = async () => { identityCalls++; throw new Error("unexpected identity lookup"); };
    return ports;
  });
  vi.spyOn(HostEmbeddingRuntime.prototype, "start").mockImplementation(() => { trace.startupCalls.push("embedding"); });
  spiderExtension(pi as never);
  for (const handler of hooks.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);
  expect(trace.startupCalls[0]).toBe("admission");
  expect(trace.startupCalls).toEqual(expect.arrayContaining(["reaper", "messages", "usage", "embedding", "adoption", "organism", "feed"]));
  expect(nonparticipantIdLockCalls).toBe(0);
  expect(identityCalls).toBe(0);
  expect((worktree.prepare("SELECT reason FROM sessions WHERE id = ?").get("ordinary-session") as { reason: string }).reason).toBe("resume");
  for (const handler of hooks.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
  worktree.close(); global.close();
}, 5000);
