import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDbAt, paths, setGlobalDbPathForTests } from "@spider/db-core";
import { createProcessPresence } from "@spider/herdr/sessions/presence";
import { createSessionLeases } from "@spider/herdr/sessions/lease";
import { LOADED_BUILD } from "../build-id";
import { HostEmbeddingRuntime } from "../embedding-runtime";
import spiderExtension from "../extension";

vi.mock("../usage/mount.js", () => ({ registerUsage: () => ({ reload() {}, snapshot() {}, readPanel: async () => null, doctor: async () => ({ ok: true, lines: [] }) }) }));
vi.mock("@spider/organism", async importOriginal => ({ ...await importOriginal<typeof import("@spider/organism")>(), registerOrganism() {} }));
vi.mock("@spider/subagents", async importOriginal => ({
  ...await importOriginal<typeof import("@spider/subagents")>(),
  reapOrphanRuns: async () => ({}), pollPendingMessages: async () => {}, adoptReloadedChildren() {},
}));

let root = "";
const initialGlobalRoot = paths.globalRoot;
afterEach(() => {
  paths.globalRoot = initialGlobalRoot;
  setGlobalDbPathForTests(null);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});
function makeRoot(): string {
  const base = resolve(".spider/scratch/roam-presence");
  mkdirSync(base, { recursive: true });
  root = mkdtempSync(join(base, "case-"));
  return root;
}

it("records the actual loaded build for a non-HC top-level session", async () => {
  const base = makeRoot(), cwd = join(base, "workspace"), globalRoot = join(base, "global");
  mkdirSync(cwd, { recursive: true }); mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "-q", cwd]);
  vi.stubEnv("GIT_CEILING_DIRECTORIES", base); vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  vi.stubEnv("HC_TERMINAL_ID", "");
  paths.globalRoot = globalRoot; vi.stubEnv("SPIDER_GLOBAL_ROOT", globalRoot); setGlobalDbPathForTests(join(globalRoot, "spider.db"));
  const global = openDbAt(join(globalRoot, "spider.db"), "global"); global.close();
  const file = join(base, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "local-session", cwd }) + "\n");
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => unknown) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; },
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
    getSessionName: () => null, sendMessage() {}, sendUserMessage() {}, appendEntry() {},
  };
  const ctx = { cwd, mode: "tui", hasUI: false, ui: { notify() {} }, abort() {}, isIdle: () => true,
    sessionManager: { getSessionId: () => "local-session", getSessionFile: () => file, getSessionName: () => null, getEntries: () => [], getBranch: () => [] } };
  vi.spyOn(HostEmbeddingRuntime.prototype, "start").mockImplementation(() => {});
  spiderExtension(pi as never);
  for (const handler of hooks.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);
  const entries = await createProcessPresence(join(globalRoot, "herdr")).list();
  const own = entries.find(entry => entry.pid === process.pid && entry.sessionId === "local-session");
  for (const handler of hooks.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
  expect(own).toMatchObject({ kind: "top-level", hcAddress: null, build: LOADED_BUILD, capabilities: { roamSchema: 14 } });
}, 5000);

it("a refused non-HC session advertises its build but does not reserve the file", async () => {
  const base = makeRoot(), cwd = join(base, "workspace"), globalRoot = join(base, "global");
  mkdirSync(cwd, { recursive: true }); mkdirSync(globalRoot, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "-q", cwd]);
  vi.stubEnv("GIT_CEILING_DIRECTORIES", base); vi.stubEnv("PI_SUBAGENT_CHILD", "0"); vi.stubEnv("HC_TERMINAL_ID", "");
  paths.globalRoot = globalRoot; vi.stubEnv("SPIDER_GLOBAL_ROOT", globalRoot); setGlobalDbPathForTests(join(globalRoot, "spider.db"));
  const global = openDbAt(join(globalRoot, "spider.db"), "global");
  global.prepare("INSERT INTO session_homes(session_id, machine_id, epoch, updated_at) VALUES (?, ?, ?, ?)").run("foreign-session", "destination.invalid", 1, 1);
  global.close();
  const file = join(base, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "foreign-session", cwd }) + "\n");
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => unknown) { hooks.set(name, [...hooks.get(name) ?? [], handler]); return () => {}; },
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
    getSessionName: () => null, sendMessage() {}, sendUserMessage() {}, appendEntry() {},
  };
  const ctx = { cwd, mode: "tui", hasUI: false, ui: { notify() {} }, abort() {}, isIdle: () => true,
    sessionManager: { getSessionId: () => "foreign-session", getSessionFile: () => file, getSessionName: () => null, getEntries: () => [], getBranch: () => [] } };
  vi.spyOn(HostEmbeddingRuntime.prototype, "start").mockImplementation(() => {});
  spiderExtension(pi as never);
  for (const handler of hooks.get("session_start") ?? []) await handler({ reason: "resume" }, ctx);
  const presence = await createProcessPresence(join(globalRoot, "herdr")).list();
  const lease = await createSessionLeases(join(globalRoot, "herdr")).get(file);
  expect(presence.find(entry => entry.pid === process.pid && entry.sessionId === "foreign-session")).toMatchObject({ build: LOADED_BUILD, capabilities: { roamSchema: 14 } });
  expect(lease).toBeNull();
  for (const handler of hooks.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
}, 5000);

it("legacy presence without build metadata remains unmarked", async () => {
  const presence = createProcessPresence(makeRoot());
  await presence.record({ pid: 123, startIdentity: "start-1", sessionFile: null, sessionName: null, kind: "top-level", hcAddress: null });
  const [entry] = await presence.list();
  expect(entry.build).toBeUndefined();
  expect(entry.capabilities).toBeUndefined();
}, 5000);

it("a repeated presence record retains the currently supplied build", async () => {
  const presence = createProcessPresence(makeRoot());
  const old = { pid: 124, startIdentity: "start-2", sessionFile: null, sessionName: null, kind: "top-level" as const, hcAddress: null };
  await presence.record(old);
  await presence.record({ ...old, build: LOADED_BUILD, capabilities: { roamSchema: 14 } });
  expect(await presence.list()).toEqual([expect.objectContaining({ build: LOADED_BUILD, capabilities: { roamSchema: 14 } })]);
}, 5000);
