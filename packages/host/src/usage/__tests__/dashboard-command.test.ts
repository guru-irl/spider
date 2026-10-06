import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { paths } from "@spider/db-core";
vi.mock("../../build-id.js", () => ({ LOADED_BUILD: { sha: "abc1234", builtAt: "2026-10-05T01:02:03.000Z", version: "fixture-command", dirty: false } }));
import { registerSlashCommands } from "../../slash.js";
import { randomBytes } from "node:crypto";
import { startUsageHttpServer } from "../server.js";
import { OVERVIEW_ROUTES } from "../query-overview.js";
import { UsageRuntime } from "../runtime.js";
import type { UsageRoots } from "../discovery.js";
import { writeServerRecord } from "../server-lock.js";
const closeServers: (() => Promise<void>)[] = [];

const launch = vi.hoisted(() => vi.fn());
vi.mock("../server-runtime.js", async importOriginal => ({
  ...await importOriginal<typeof import("../server-runtime.js")>(), ensureUsageServer: launch,
}));
function harness() {
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const events: ((...args: unknown[]) => unknown)[] = [];
  const exec = vi.fn(async (_command: string, _args: string[], _options?: unknown) => ({ code: 0, stdout: "", stderr: "", killed: false }));
  const sendMessage = vi.fn();
  const notify = vi.fn();
  const setWidget = vi.fn();
  const pi = { registerCommand: (name: string, opts: any) => commands.set(name, opts.handler),
    registerTool: () => {},
    on: (_event: string, callback: (...args: unknown[]) => unknown) => { events.push(callback); return () => {}; }, exec, sendMessage } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", hasUI: true, cwd: paths.globalRoot, ui: { notify, setWidget } } as unknown as ExtensionCommandContext;
  return { pi, ctx, commands, events, exec, sendMessage, notify, setWidget };
}
afterEach(async () => { for (const close of closeServers.splice(0)) await close(); rmSync(join(paths.globalRoot, "usage-server"), { recursive: true, force: true }); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); launch.mockReset(); rmSync(join(paths.globalRoot, "config.json"), { force: true }); });

it("only usage slash can open browser", async () => {
  // Opening on registration/lifecycle/control, trusting a child, or showing a nonce in a transcript breaks this gate.
  const module = await import("../dashboard-command.js").catch(() => undefined);
  expect(module, "usage command implementation exists").toBeDefined();
  const h = harness();
  mkdirSync(paths.globalRoot, { recursive: true });
  writeFileSync(join(paths.globalRoot, "config.json"), '{"usage.calibration":"off"}');
  const bundleUrl = new URL("file:///synthetic/extension.js?build=fixture");
  module!.registerUsageDashboardCommand(h.pi, bundleUrl);
  expect([...h.commands.keys()]).toEqual(["usage"]);
  for (const event of h.events) await event({}, h.ctx);
  expect(launch).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
  registerSlashCommands(h.pi as never, { run: async () => ({ content: "synthetic control result" }), alreadyRegistered: new Set(["usage"]) });
  await h.commands.get("spider")!("usage", h.ctx);
  expect(launch).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  await h.commands.get("usage")!("", h.ctx);
  expect(launch).not.toHaveBeenCalled();
  vi.stubEnv("PI_SUBAGENT_CHILD", "");
  for (const mode of ["print", "json", "rpc"]) await h.commands.get("usage")!("", { ...h.ctx, mode } as ExtensionCommandContext);
  await h.commands.get("usage")!("unexpected", h.ctx);
  expect(launch).not.toHaveBeenCalled();
  launch.mockResolvedValue({ pid: 123, port: 2345, bootstrapUrl: "http://127.0.0.1:2345/bootstrap?nonce=synthetic-nonce",
    reused: false, serverBuild: "synthetic@2026-10-06T00:00:00.000Z", rateVersions: ["synthetic-rate"] });
  h.sendMessage.mockClear(); h.notify.mockClear();
  await h.commands.get("usage")!("", h.ctx);
  expect(launch).toHaveBeenCalledOnce();
  expect(launch.mock.calls[0][0]).toMatchObject({ bundleUrl, calibrationMode: "off", calibrationConfigFile: join(paths.globalRoot, "config.json"),
    serverBuild: "abc1234@2026-10-05T01:02:03.000Z", lockFile: join(paths.globalRoot, "usage-server", "lock.json"),
    roots: { ledgerFile: join(paths.globalRoot, "usage.db"), registryDb: join(paths.globalRoot, "spider.db"),
      sessionsDir: join(getAgentDir(), "sessions"), authPath: join(getAgentDir(), "auth.json"), leaseDir: join(paths.globalRoot, "usage-leases") } });
  expect(h.exec).toHaveBeenCalledWith(process.platform === "darwin" ? "open" : "xdg-open", ["http://127.0.0.1:2345/bootstrap?nonce=synthetic-nonce"], { timeout: 5000, cwd: join(paths.globalRoot, "usage-server") });
  expect(h.sendMessage).not.toHaveBeenCalled();
  expect(JSON.stringify(h.notify.mock.calls)).not.toContain("nonce");
  expect(JSON.stringify(h.notify.mock.calls)).toContain("synthetic@2026-10-06T00:00:00.000Z");
  expect(JSON.stringify(h.notify.mock.calls)).toContain("synthetic-rate");
});

it("reuse command mints a new nonce", async () => {
  // Extension registration must expose /usage, and caching a launcher result would replay an already-consumed nonce.
  const extension = await import("../../extension.js"); const h = harness();
  const sourceUrl = extension.loadedBundle.url;
  extension.loadedBundle.url = "file:///synthetic/extension.js";
  try { extension.default(h.pi as never); } finally { extension.loadedBundle.url = sourceUrl; }
  expect(h.commands.has("usage"), "extension registers the dashboard command").toBe(true);
  const real = await vi.importActual<typeof import("../server-runtime.js")>("../server-runtime.js");
  launch.mockImplementation(real.ensureUsageServer);
  const instanceId = randomBytes(16).toString("hex"), secret = randomBytes(32).toString("base64url");
  const server = await startUsageHttpServer({ instanceId, secret, serverBuild: "synthetic@2026-10-06T00:00:00.000Z",
    reader: undefined, routes: OVERVIEW_ROUTES, html: "<!doctype html><title>fixture</title>" });
  closeServers.push(server.close);
  const dir = join(paths.globalRoot, "usage-server"); mkdirSync(dir, { mode: 0o700 });
  await writeServerRecord(join(dir, "lock.json"), { version: 1, instanceId, secret, pid: process.pid, port: server.port,
    processIdentity: (await real.usageProcessIdentity(process.pid))!, serverBuild: "synthetic@2026-10-06T00:00:00.000Z" });
  const urls: string[] = [];
  for (let i = 0; i < 2; i++) {
    await h.commands.get("usage")!("", h.ctx);
    expect(h.exec.mock.calls.length, JSON.stringify(h.notify.mock.calls)).toBe(i + 1);
    const url = h.exec.mock.calls.at(-1)![1][0]; urls.push(url);
    const bootstrap = new URL(url);
    const response = await real.localUsageRequest(server.port, bootstrap.pathname + bootstrap.search);
    expect(response.status).toBe(303); expect(response.headers.location).toBe("/");
    expect((await real.localUsageRequest(server.port, bootstrap.pathname + bootstrap.search)).status).toBe(401);
  }
  expect(urls[0]).not.toBe(urls[1]); expect(urls.every(url => !url.includes(secret))).toBe(true);
  expect(h.exec).toHaveBeenCalledTimes(2);
  expect(h.sendMessage).not.toHaveBeenCalled(); expect(JSON.stringify(h.notify.mock.calls)).not.toContain("nonce=");
});

it("mount and dashboard command resolve identical roots", async () => {
  // A second root resolver could silently send HTTP to a different ledger from pi.
  const mount = await import("../mount.js");
  expect((mount as any).resolveUsageRoots, "shared root resolver exists").toBeTypeOf("function");
  const command = await import("../dashboard-command.js"); const h = harness();
  launch.mockRejectedValue(new Error("synthetic-private-path"));
  command.registerUsageDashboardCommand(h.pi, "file:///synthetic/extension.js");
  await h.commands.get("usage")!("", h.ctx);
  const roots = mount.resolveUsageRoots();
  const lifecycle = new Map<string, ((event: unknown, ctx: ExtensionCommandContext) => unknown)[]>();
  const mountPi = { ...h.pi, on: (name: string, callback: (event: unknown, ctx: ExtensionCommandContext) => unknown) => {
    const callbacks = lifecycle.get(name) ?? []; callbacks.push(callback); lifecycle.set(name, callbacks); return () => {};
  } } as unknown as ExtensionAPI;
  let mountedRoots: UsageRoots | undefined;
  // Runtime.start owns native worker spawning. Preserve construction/root resolution without spawning a source .ts bundle.
  vi.spyOn(UsageRuntime.prototype, "start").mockImplementation(function (this: UsageRuntime) {
    mountedRoots = (this as unknown as { options: { roots: UsageRoots } }).options.roots;
  });
  vi.spyOn(paths, "projectRoot").mockReturnValue(paths.globalRoot);
  mount.registerUsage(mountPi, "file:///synthetic/extension.js");
  try {
    for (const start of lifecycle.get("session_start") ?? []) await start({}, { ...h.ctx, mode: "print" } as ExtensionCommandContext);
    expect(mountedRoots).toEqual(roots);
    expect(launch.mock.calls[0][0].roots).toEqual(mountedRoots);
  } finally { for (const stop of lifecycle.get("session_shutdown") ?? []) await stop({}, h.ctx); }
  expect(roots.ledgerFile).toBe(join(paths.globalRoot, "usage.db"));
  expect(launch.mock.calls[0][0].lockFile).toBe(join(paths.globalRoot, "usage-server", "lock.json"));
  expect(JSON.stringify(h.notify.mock.calls)).not.toContain("synthetic-private-path");
});

for (const outcome of ["timeout", "nonzero", "ENOENT"] as const) it(`opener ${outcome} prints a manual fallback without using a deleted session cwd`, async () => {
  const { registerUsageDashboardCommand } = await import("../dashboard-command.js");
  const h = harness();
  const deleted = join(paths.globalRoot, "deleted-session"); mkdirSync(deleted, { recursive: true }); rmSync(deleted, { recursive: true });
  const dir = join(paths.globalRoot, "usage-server"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const url = "http://127.0.0.1:2345/bootstrap?nonce=synthetic-fallback";
  launch.mockResolvedValue({ bootstrapUrl: url, serverBuild: "fixture", rateVersions: [] });
  h.exec.mockImplementation(async (_command, _args, options) => {
    // pi.exec defaults to the session cwd. A deleted cwd must not reach spawn.
    const { statSync } = await import("node:fs");
    statSync((options as { cwd?: string })?.cwd ?? deleted);
    if (outcome === "ENOENT") throw Object.assign(new Error("private opener output"), { code: "ENOENT" });
    return { code: 1, stdout: "private output", stderr: "private output", killed: outcome === "timeout" };
  });
  const printed = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  registerUsageDashboardCommand(h.pi, "file:///synthetic/extension.js");
  await h.commands.get("usage")!("", { ...h.ctx, hasUI: false, cwd: deleted });
  expect(h.exec).toHaveBeenCalledWith(process.platform === "darwin" ? "open" : "xdg-open", [url], { timeout: 5000, cwd: dir });
  expect(printed.mock.calls.map(call => String(call[0])).join("")).toContain(url);
  expect(h.setWidget).not.toHaveBeenCalled();
  const notifications = JSON.stringify(h.notify.mock.calls);
  expect(notifications).not.toContain(url); expect(notifications).not.toContain("private");
  if (outcome === "timeout") {
    expect(notifications).toContain("browser is opening"); expect(notifications).not.toContain("usage-browser-failed");
    expect(h.notify).toHaveBeenCalledWith(expect.any(String), "info");
  } else {
    expect(notifications).toContain("usage-browser-failed"); expect(h.notify).toHaveBeenCalledWith(expect.any(String), "error");
  }
});

for (const outcome of ["timeout", "nonzero", "ENOENT"] as const) it(`TUI opener ${outcome} shows a temporary widget, never stdout`, async () => {
  vi.useFakeTimers();
  const { registerUsageDashboardCommand } = await import("../dashboard-command.js");
  const h = harness();
  const url = "http://127.0.0.1:2345/bootstrap?nonce=synthetic-widget";
  launch.mockResolvedValue({ bootstrapUrl: url, serverBuild: "fixture", rateVersions: [] });
  h.exec.mockImplementation(async () => {
    if (outcome === "ENOENT") throw new Error("private opener output");
    return { code: 1, stdout: "private output", stderr: "private output", killed: outcome === "timeout" };
  });
  const printed = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  registerUsageDashboardCommand(h.pi, "file:///synthetic/extension.js");
  await h.commands.get("usage")!("", h.ctx);
  expect(printed).not.toHaveBeenCalled();
  expect(h.setWidget).toHaveBeenCalledWith("spider-usage-url", [
    `Open the usage dashboard: ${url}`, "This link works once and expires in 60 s",
  ]);
  expect(h.notify).toHaveBeenCalledWith("Opening the usage dashboard", "info");
  expect(JSON.stringify(h.notify.mock.calls)).not.toMatch(/nonce=|private/);
  await vi.advanceTimersByTimeAsync(59999);
  expect(h.setWidget).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.setWidget).toHaveBeenLastCalledWith("spider-usage-url", undefined);
  expect(vi.getTimerCount()).toBe(0);
});

it("a newer usage command clears the previous widget and cancels its expiry", async () => {
  vi.useFakeTimers();
  const { registerUsageDashboardCommand } = await import("../dashboard-command.js");
  const h = harness();
  launch.mockResolvedValue({ bootstrapUrl: "http://127.0.0.1:2345/bootstrap?nonce=first", serverBuild: "fixture", rateVersions: [] });
  h.exec.mockResolvedValue({ code: 1, stdout: "", stderr: "", killed: false });
  const printed = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  registerUsageDashboardCommand(h.pi, "file:///synthetic/extension.js");
  await h.commands.get("usage")!("", h.ctx);
  await vi.advanceTimersByTimeAsync(30000);
  launch.mockResolvedValue({ bootstrapUrl: "http://127.0.0.1:2345/bootstrap?nonce=second", serverBuild: "fixture", rateVersions: [] });
  await h.commands.get("usage")!("", h.ctx);
  expect(h.setWidget.mock.calls[1]).toEqual(["spider-usage-url", undefined]);
  expect(h.setWidget.mock.calls[2][1][0]).toContain("nonce=second");
  await vi.advanceTimersByTimeAsync(30000);
  expect(h.setWidget).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(30000);
  expect(h.setWidget).toHaveBeenLastCalledWith("spider-usage-url", undefined);
  expect(printed).not.toHaveBeenCalled();
  // A successful replacement also clears a prior fallback immediately.
  await h.commands.get("usage")!("", h.ctx);
  h.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "", killed: false });
  await h.commands.get("usage")!("", h.ctx);
  expect(h.setWidget).toHaveBeenLastCalledWith("spider-usage-url", undefined);
  expect(vi.getTimerCount()).toBe(0);
});

it("session shutdown clears the fallback widget and cancels expiry", async () => {
  vi.useFakeTimers();
  const { registerUsageDashboardCommand } = await import("../dashboard-command.js");
  const h = harness();
  launch.mockResolvedValue({ bootstrapUrl: "http://127.0.0.1:2345/bootstrap?nonce=shutdown", serverBuild: "fixture", rateVersions: [] });
  h.exec.mockResolvedValue({ code: 1, stdout: "", stderr: "", killed: false });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  registerUsageDashboardCommand(h.pi, "file:///synthetic/extension.js");
  await h.commands.get("usage")!("", h.ctx);
  for (const event of h.events) await event({}, h.ctx);
  expect(h.setWidget).toHaveBeenLastCalledWith("spider-usage-url", undefined);
  expect(vi.getTimerCount()).toBe(0);
  const count = h.setWidget.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.setWidget).toHaveBeenCalledTimes(count);
});
