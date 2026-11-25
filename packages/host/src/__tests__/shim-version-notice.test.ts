import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths, setGlobalDbPathForTests } from "@spider/db-core";
import { cleanupScratch, scratchDbPath } from "@spider/db-core/testutil";
import spiderExtension from "../extension";
import { openSessionRunDb } from "../session-run-db";
import { agentsHostFixture } from "./fixtures/agents-host";
import { hostUnitPorts, withPiEvents } from "./fixtures/pi-events";

const notice = "spider shim is out of date: run npm run link (or npm run dev:link) and restart pi";
const originalGlobalRoot = paths.globalRoot;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  paths.globalRoot = originalGlobalRoot;
  setGlobalDbPathForTests(null);
  vi.unstubAllEnvs();
  cleanupScratch();
});

function fixture(piVersion?: string) {
  const root = mkdtempSync(join(dirname(scratchDbPath("shim-notice")), "session-"));
  execFileSync("git", ["init", "-q", root]);
  const global = join(root, "global");
  paths.globalRoot = global;
  setGlobalDbPathForTests(join(global, "global.db"));
  vi.stubEnv("SPIDER_GLOBAL_ROOT", global);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  const { db } = openSessionRunDb(root, "shim-session");
  db.prepare("INSERT INTO runs (id, session_id, agent, name, status, step_count, token_count, started_at) VALUES ('r1','shim-session','worker','one','running',1,0,1)").run();
  db.close();

  const hooks = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const pi = withPiEvents({
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      return () => { hooks.set(name, (hooks.get(name) ?? []).filter(fn => fn !== handler)); };
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
  });
  const h = agentsHostFixture();
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, getContextUsage: () => undefined,
    ui: { ...h.ui, setStatus() {}, setFooter() {} },
    sessionManager: { getSessionId: () => "shim-session", getSessionFile: () => null, getEntries: () => [], getBranch: () => [] },
  };
  spiderExtension(pi as never, { ...hostUnitPorts, piVersion });
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
  };
  cleanup.push(async () => { await emit("session_shutdown", { reason: "exit" }); h.close(); rmSync(root, { recursive: true, force: true }); });
  return { h, ctx, emit, commands, tools };
}

it("reports a stale shim on startup and in doctor while the agents list stays usable", async () => {
  const f = fixture();
  await f.emit("session_start");
  expect(f.h.ui.notify.mock.calls.filter(([text]) => text === notice)).toEqual([[notice, "warning"]]);
  const report = await f.tools.get("spider")!.execute("doctor", { action: "control", command: "doctor" }, undefined, undefined, f.ctx);
  expect(report.details.lines).toContain(`- ${notice}`);

  const open = f.commands.get("agents")!.handler("", f.ctx);
  await f.h.settle();
  expect(f.h.focuses).toEqual(["selector"]);
  expect(f.h.focused()).not.toBe(f.h.view.editor);
  await f.h.send("\r");
  expect(f.h.ui.notify).toHaveBeenCalledWith("Run detail needs a relinked spider shim: run npm run link (or npm run dev:link) and restart pi", "info");
  expect(f.h.ui.custom).toHaveBeenCalledTimes(1);
  await f.h.send("\u001b");
  await open;
  expect(f.h.focused()).toBe(f.h.view.editor);
  await f.emit("session_start");
  expect(f.h.ui.notify.mock.calls.filter(([text]) => text === notice)).toEqual([[notice, "warning"]]);
});

it("reports missing shim version metadata in spider control doctor", async () => {
  const f = fixture();
  const report = await f.tools.get("spider")!.execute("doctor", { action: "control", command: "doctor" }, undefined, undefined, f.ctx);
  expect(report.details.lines).toContain(`- ${notice}`);
});

it("does not suggest relinking when the shim supplies the pi version", async () => {
  const f = fixture("1.2.0");
  await f.emit("session_start");
  expect(f.h.ui.notify.mock.calls.filter(([text]) => text === notice)).toEqual([]);
  const report = await f.tools.get("spider")!.execute("doctor", { action: "control", command: "doctor" }, undefined, undefined, f.ctx);
  expect(report.details.lines).not.toContain(`- ${notice}`);
});
