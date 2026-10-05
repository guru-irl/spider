import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { paths } from "@spider/db-core";
import { controlConfig } from "../../control.js";
import { registerUsage } from "../mount.js";
import { registerSlashCommands } from "../../slash.js";
import { applyConfigEdit, applyConfigUnset } from "../../control/config-cmd.js";
const workers = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    options: any; commands: any[] = [];
    constructor(_url: URL, options: any) { super(); this.options = options; workers.instances.push(this); }
    unref() {} postMessage(command: any) { this.commands.push(command); if (command.type === "stop") this.emit("message", { type: "stopped" }); }
    terminate = vi.fn(async () => 0);
  } };
});
vi.mock("../ledger.js", () => ({ openUsageLedger: () => { throw new Error("main-thread ledger forbidden"); } }));
let root: string, previous: string;
let registration: ReturnType<typeof registerUsage>;
let handlers: Map<string, Set<Function>>;
let pi: ExtensionAPI, ctx: ExtensionContext;
const footer = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); workers.instances.length = 0; footer.mockReset();
  root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "usage-controller-")); previous = paths.globalRoot; paths.globalRoot = root;
  vi.spyOn(paths, "projectRoot").mockReturnValue(join(root, "local")); mkdirSync(join(root, "local"));
  handlers = new Map();
  pi = { on: (name: string, handler: Function) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(handler); return () => handlers.get(name)?.delete(handler); }, getThinkingLevel: () => "high", getSessionName: () => undefined } as unknown as ExtensionAPI;
  ctx = { cwd: root, mode: "tui", hasUI: true, ui: { setFooter: footer }, sessionManager: { getEntries: () => [], getSessionFile: () => "fixture.jsonl", getSessionId: () => "fixture" }, getContextUsage: () => undefined } as unknown as ExtensionContext;
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
});
afterEach(async () => { await emit("session_shutdown"); paths.globalRoot = previous; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
async function emit(name: string) { for (const handler of [...handlers.get(name) ?? []]) await handler({}, ctx); }
it("registration is inert and parent session_start lazily starts worker with public roots", async () => {
  registration = registerUsage(pi, "file:///fixture/extension.js"); expect(workers.instances).toHaveLength(0); expect(footer).not.toHaveBeenCalled();
  await emit("session_start"); await vi.advanceTimersByTimeAsync(1);
  expect(workers.instances).toHaveLength(1);
  expect(workers.instances[0].options.workerData.command).toMatchObject({ poll: true, child: false, roots: { ledgerFile: join(root, "usage.db"), registryDb: join(root, "spider.db"), sessionsDir: join(process.env.PI_CODING_AGENT_DIR!, "sessions"), authPath: join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), leaseDir: join(root, "usage-leases") } });
  expect(footer).toHaveBeenCalledTimes(1);
  await emit("session_shutdown"); expect(workers.instances[0].terminate).toHaveBeenCalledTimes(1); expect(footer).toHaveBeenLastCalledWith(undefined);
});
it("published worker snapshot is the doctor's only usage input", async () => {
  registration = registerUsage(pi, "file:///fixture/extension.js"); expect(registration.doctor().lines.join("\n")).toMatch(/not published/);
  await emit("session_start"); await vi.advanceTimersByTimeAsync(1);
  workers.instances[0].emit("message", { type: "snapshot", backfill: "running", progress: { sourcesCompleted: 2, sourcesTotal: 4 }, health: { schemaVersion: 1, calls: 123, sources: 4, parseErrors: 0, sourceErrors: 0, aggregateCalls: 0, unpricedModels: [], lastIngestAt: 1 }, counter: { availability: "disabled", role: "inactive", latest: null }, reconciliation: null });
  expect(registration.doctor().lines.join("\n")).toMatch(/calls=123/); expect(registration.doctor().lines.join("\n")).toMatch(/2\/4/);
});
it("config reload hot-applies footer/poll and ignores manual local overrides", async () => {
  registration = registerUsage(pi, "file:///fixture/extension.js"); await emit("session_start"); await vi.advanceTimersByTimeAsync(1);
  writeFileSync(join(root, "local/config.json"), JSON.stringify({ "usage.footer": true, "usage.counterPoll": true }));
  controlConfig("set", root, "usage.footer", false, "global"); controlConfig("set", root, "usage.counterPoll", false, "global"); registration.reload();
  expect(footer).toHaveBeenLastCalledWith(undefined); expect(workers.instances[0].commands).toContainEqual({ type: "configure", poll: false });
  expect(registration.doctor().lines.join("\n")).toMatch(/footer=disabled poll=disabled/);
});
it.each(["rpc", "print", "json"] as const)("parent %s starts ledger worker without a terminal footer", async mode => {
  ctx = { ...ctx, mode }; registration = registerUsage(pi, "file:///fixture/extension.js"); await emit("session_start"); await vi.advanceTimersByTimeAsync(1);
  expect(workers.instances).toHaveLength(1); expect(footer).not.toHaveBeenCalled();
});
it("child session_start starts neither footer nor worker", async () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "1"); registration = registerUsage(pi, "file:///fixture/extension.js"); await emit("session_start"); await vi.advanceTimersByTimeAsync(1);
  expect(workers.instances).toHaveLength(0); expect(footer).not.toHaveBeenCalled();
});
it.each(["set usage.footer false", "unset usage.footer"])("slash config %s rejects local edits and accepts explicit global", async args => {
  const commands = new Map<string, Function>(), messages: any[] = [];
  registerSlashCommands({ registerCommand: (name, definition) => commands.set(name, definition.handler), sendMessage: message => messages.push(message) }, {
    alreadyRegistered: new Set(), run: async a => {
      const r = a.op === "unset" ? applyConfigUnset(root, String(a.key), a.scope === "global" ? "global" : "local") : applyConfigEdit(root, String(a.key), String(a.value), a.scope === "global" ? "global" : "local");
      return r.ok ? { details: r } : { error: r.error };
    },
  });
  await commands.get("spider")!(`config ${args}`, ctx); expect(messages.at(-1).details.result.error).toMatch(/global/);
  await commands.get("spider")!(`config ${args} --global`, ctx); expect(messages.at(-1).details.result.details).toMatchObject({ ok: true, scope: "global", key: "usage.footer" });
});
