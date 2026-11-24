import { withPiEvents, hostUnitPorts } from './fixtures/pi-events';
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RunStore, registerShared, setSink, detachShared, getShared, resetSharedRegistryForTests, type SharedHandle } from "@spider/subagents";
import { clearActions } from "../dispatch";
import { openSessionRunDb } from "../session-run-db";
import spiderExtension from "../extension";
import { getCoordinators } from "../../../subagents/src/coordinators";

function fakePi() {
  const hooks = new Map<string, ((...args: any[]) => unknown)[]>();
  const sendMessage = vi.fn();
  return {
    hooks, sendMessage, getSessionName: () => undefined,
    registerTool: () => {}, registerCommand: () => {}, registerShortcut: () => {},
    registerMessageRenderer: () => {}, registerEntryRenderer: () => {},
    on: (name: string, fn: (...args: any[]) => unknown) => {
      hooks.set(name, [...hooks.get(name) ?? [], fn]);
      return () => hooks.set(name, (hooks.get(name) ?? []).filter((handler) => handler !== fn));
    },
    async emit(name: string, event: unknown, ctx?: unknown) { for (const fn of hooks.get(name) ?? []) await fn(event, ctx); },
  };
}

let scratch: string;
const hosts: ReturnType<typeof fakePi>[] = [];
beforeEach(() => {
  resetSharedRegistryForTests();
  const base = resolve(".spider/scratch/build-id");
  mkdirSync(base, { recursive: true });
  scratch = mkdtempSync(join(base, "reload-adopt-"));
  vi.stubEnv("GIT_CEILING_DIRECTORIES", base);
  vi.stubEnv("PI_SUBAGENT_CHILD", "1"); // build the activation without organism work
});
afterEach(async () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  for (const pi of hosts.splice(0)) await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  clearActions(); resetSharedRegistryForTests();
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

it("session_start adopts a detached child despite invalid childMode config and notifies once", async () => {
  const sessionId = `${scratch}:reload`;
  const ctx = { cwd: scratch, ui: { notify() {} }, sessionManager: { getSessionId: () => sessionId, getEntries: () => [] } };
  const { db, dbPath } = openSessionRunDb(scratch, sessionId);
  const store = new RunStore(db);
  const { id } = store.create({ sessionId, agent: "worker", name: "bg", task: "t" });
  store.start(id);
  let exit!: (v: { exitCode: number; result?: string }) => void;
  const done = new Promise<{ exitCode: number; result?: string }>(r => { exit = r; });
  const handle: SharedHandle = { wait: () => done, kill: () => {}, killAsync: async () => {} };
  registerShared({ runId: id, sessionId, dbPath, mode: "rpc", handle, survivable: true });
  setSink(id, () => { throw new Error("the old activation must not be called"); });
  await detachShared(sessionId, { ttlMs: 60_000 });
  exit({ exitCode: 0, result: "survived the reload" });
  await tick();

  // Adoption never spawns, so a typo applied by /reload must not lose a running child.
  writeFileSync(join(scratch, ".spider", "config.json"), JSON.stringify({ "subagents.childMode": "typo" }));

  // New activation, built after the old one detached.
  const pi = fakePi(); hosts.push(pi);
  spiderExtension(withPiEvents(pi as never), hostUnitPorts);
  vi.stubEnv("PI_SUBAGENT_CHILD", "0"); // session_start reads the identity at call time
  await pi.emit("session_start", { type: "session_start", reason: "reload" }, ctx);
  await tick();

  const notices = pi.sendMessage.mock.calls.filter(c => c[0]?.customType === "spider.subagent_done");
  expect(notices).toHaveLength(1);
  expect(notices[0][0].content).toContain("survived the reload");
  expect((db.prepare("SELECT status FROM runs WHERE id=?").get(id) as any).status).toBe("done");
  expect(getShared(id)).toBeUndefined();
});

it.each(["tui", "rpc"] as const)("adopted notices use the session's %s delivery mode", async (mode) => {
  const sessionId = `${scratch}:${mode}`;
  const notify = vi.fn();
  const ctx = { cwd: scratch, mode, ui: { notify, setFooter: () => {} }, getContextUsage: () => null,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getEntries: () => [] } };
  const { db, dbPath } = openSessionRunDb(scratch, sessionId);
  const store = new RunStore(db);
  const { id } = store.create({ sessionId, agent: "worker", name: "bg", task: "t" });
  store.start(id);
  let exit!: (value: { exitCode: number; result: string }) => void;
  const done = new Promise<{ exitCode: number; result: string }>((resolve) => { exit = resolve; });
  const handle: SharedHandle = { wait: () => done, kill: () => {}, killAsync: async () => {} };
  registerShared({ runId: id, sessionId, dbPath, mode: "rpc", handle, survivable: true });
  setSink(id, () => { throw new Error("old activation"); });
  await detachShared(sessionId, { ttlMs: 60_000 });
  writeFileSync(join(scratch, ".spider", "config.json"), JSON.stringify({ "usage.footer": false, "usage.counter.poll": false, "usage.calibration": "off" }));

  const pi = fakePi(); hosts.push(pi);
  spiderExtension(withPiEvents(pi as never), hostUnitPorts);
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  await pi.emit("session_start", { type: "session_start", reason: "reload" }, ctx);
  db.prepare("INSERT INTO run_events (run_id,session_id,ts,type,summary,payload) VALUES (?,?,?,?,?,?)")
    .run(id, sessionId, Date.now(), "escalation", "Needs attention", JSON.stringify({ severity: "warning" }));
  getCoordinators(sessionId, () => { throw new Error("missing tailer"); }).tailer!.poll();
  exit({ exitCode: 0, result: "finished" });
  await tick();

  expect(pi.sendMessage.mock.calls.filter((call) => call[0]?.customType === "spider.escalation")).toHaveLength(1);
  expect(pi.sendMessage.mock.calls.filter((call) => call[0]?.customType === "spider.subagent_done")).toHaveLength(1);
  if (mode === "tui") expect(notify).not.toHaveBeenCalled();
  else {
    expect(notify).toHaveBeenCalledWith("Needs attention", "warning");
    expect(notify).toHaveBeenCalledWith('subagent "bg" done', "info");
  }
});

it("session_start does nothing when no child is waiting", async () => {
  const pi = fakePi(); hosts.push(pi);
  spiderExtension(withPiEvents(pi as never), hostUnitPorts);
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, { cwd: scratch, ui: { notify() {} }, sessionManager: { getSessionId: () => "none", getEntries: () => [] } });
  expect(pi.sendMessage).not.toHaveBeenCalled();
});

it("an adoption that fails is reported to the user instead of failing silently, and the child keeps a TTL", async () => {
  const sessionId = `${scratch}:refused`;
  const notify = vi.fn();
  const ctx = { cwd: scratch, ui: { notify }, sessionManager: { getSessionId: () => sessionId, getEntries: () => [] } };
  openSessionRunDb(scratch, sessionId); // the session's DB exists, but holds no row for this run
  const handle: SharedHandle = { wait: () => new Promise(() => {}), kill: () => {}, killAsync: async () => {} };
  registerShared({ runId: "ghost-run", sessionId, dbPath: "/nowhere/project.db", mode: "rpc", handle, survivable: true });
  setSink("ghost-run", () => {});
  await detachShared(sessionId, { ttlMs: 60_000 });

  const pi = fakePi(); hosts.push(pi);
  spiderExtension(withPiEvents(pi as never), hostUnitPorts);
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  await pi.emit("session_start", { type: "session_start", reason: "reload" }, ctx);

  expect(notify).toHaveBeenCalledTimes(1);
  expect(String(notify.mock.calls[0][0])).toMatch(/ghost-run.*could not be re-adopted/);
  expect(getShared("ghost-run")?.state).toBe("detached");
  expect(getShared("ghost-run")?.timer).toBeDefined();
});
