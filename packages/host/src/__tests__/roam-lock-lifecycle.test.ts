import { withPiEvents, hostUnitPorts } from './fixtures/pi-events';
import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, paths, SCHEMA_VERSION, setGlobalDbPathForTests } from "@spider/db-core";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { claimIdLock } from "@spider/herdr/sessions/id-lock";
import { processStartTime } from "../../../subagents/src/process-identity";
import { HostEmbeddingRuntime } from "../embedding-runtime";
import { LOADED_BUILD } from "../build-id";
import spiderExtension from "../extension";

vi.mock("@spider/herdr/sessions/id-lock", async original => {
  const actual = await original<typeof import("@spider/herdr/sessions/id-lock")>();
  return { ...actual, claimIdLock: (root: string, id: string, identity: any, probe: any, options: any = {}) =>
    actual.claimIdLock(root, id, identity, probe, { ...options, bootId: async () => "boot-fixture" }) };
});
vi.mock("../usage/mount.js", () => ({ registerUsage: () => ({ reload() {}, snapshot() {}, readPanel: async () => null, doctor: async () => ({ ok: true, lines: [] }) }) }));
vi.mock("@spider/organism", async original => ({ ...await original<typeof import("@spider/organism")>(), registerOrganism() {} }));
vi.mock("@spider/subagents", async original => ({ ...await original<typeof import("@spider/subagents")>(),
  reapOrphanRuns: async () => ({}), pollPendingMessages: async () => {}, adoptReloadedChildren() {} }));

let root = "";
const initialGlobalRoot = paths.globalRoot;
afterEach(() => {
  paths.globalRoot = initialGlobalRoot; setGlobalDbPathForTests(null);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

it("retains both locks through reload and releases them on quit", async () => {
  const base = resolve(".spider/scratch/roam-lock-lifecycle");
  mkdirSync(base, { recursive: true }); root = mkdtempSync(join(base, "case-"));
  const cwd = join(root, "workspace"), globalRoot = join(root, "global"), herdrRoot = join(globalRoot, "herdr");
  mkdirSync(cwd, { recursive: true }); mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "-q", cwd]);
  vi.stubEnv("GIT_CEILING_DIRECTORIES", root); vi.stubEnv("PI_SUBAGENT_CHILD", "0"); vi.stubEnv("HC_TERMINAL_ID", "");
  paths.globalRoot = globalRoot; vi.stubEnv("SPIDER_GLOBAL_ROOT", globalRoot); setGlobalDbPathForTests(join(globalRoot, "spider.db"));
  const global = openDbAt(join(globalRoot, "spider.db"), "global");
  const machine = (global.prepare("SELECT machine_id FROM roam_meta WHERE id = 1").get() as { machine_id: string }).machine_id;
  const worktree = openDbAt(join(cwd, ".spider", "project.db"), "worktree");
  worktree.prepare("UPDATE roam_meta SET store_key = ?, capture_enabled = 1 WHERE id = 1").run("worktree:fixture:current");
  worktree.prepare("INSERT INTO sessions(id, reason, started_at, origin_machine) VALUES (?, ?, ?, ?)").run("session-1", "fixture", 1, machine);
  worktree.prepare("INSERT INTO roam_sessions(session_id, epoch, state) VALUES (?, ?, ?)").run("session-1", 1, "active");
  const file = join(root, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "session-1", cwd }) + "\n");
  const ctx = { cwd, mode: "tui", hasUI: false, ui: { notify() {} }, abort() {}, isIdle: () => true,
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => file, getSessionName: () => null, getEntries: () => [], getBranch: () => [] } };
  vi.spyOn(HostEmbeddingRuntime.prototype, "start").mockImplementation(() => {});
  const startIdentity = processStartTime(process.pid)!;
  expect(startIdentity).toBeTruthy();
  const competitor = { pid: 987654, startIdentity: "other-start" };
  const probe = async (pid: number) => pid === process.pid ? { kind: "live" as const, startIdentity } : { kind: "absent" as const };
  const claimOther = () => claimIdLock(herdrRoot, "session-1", competitor, probe);
  const activate = async (reason: "resume" | "reload") => {
    const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const pi = {
      on(name: string, handler: (event: any, ctx: any) => unknown) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; },
      registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
      getSessionName: () => null, sendMessage() {}, sendUserMessage() {}, appendEntry() {},
    };
    spiderExtension(withPiEvents(pi as never), hostUnitPorts);
    for (const handler of hooks.get("session_start") ?? []) await handler({ reason }, ctx);
    return async (reason: "reload" | "quit") => { for (const handler of hooks.get("session_shutdown") ?? []) await handler({ reason }, ctx); };
  };
  const leases = createSessionLeases(herdrRoot);
  const firstShutdown = await activate("resume");
  expect(await leases.get(file)).toMatchObject({ pid: process.pid, startIdentity });
  await expect(claimOther()).rejects.toThrow(/owner/i);
  await firstShutdown("reload");
  expect(await leases.get(file)).toMatchObject({ pid: process.pid, startIdentity });
  await expect(claimOther()).rejects.toThrow(/owner/i);
  const secondShutdown = await activate("reload");
  expect((worktree.prepare("SELECT reason FROM sessions WHERE id = ?").get("session-1") as { reason: string }).reason).toBe("reload");
  const reloadedPresence = await createProcessPresence(herdrRoot).list();
  expect(reloadedPresence.find(row => row.pid === process.pid)).toMatchObject({ build: LOADED_BUILD, capabilities: { roamSchema: SCHEMA_VERSION } });
  expect(await leases.get(file)).toMatchObject({ pid: process.pid, startIdentity });
  await expect(claimOther()).rejects.toThrow(/owner/i);
  await secondShutdown("quit");
  expect(await leases.get(file)).toBeNull();
  const after = await claimOther(); await after.release();
  worktree.close(); global.close();
}, 5000);
