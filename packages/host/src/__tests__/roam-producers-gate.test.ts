import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HostOrganismRuntime } from "../organism-runtime";
import * as sessionDb from "../session-run-db";
import * as agentsUi from "../agents/agents-ui";
import * as control from "../control";
import { registerOrganism } from "@spider/organism";
import { mountAgentsUI } from "../agents/mount";
import { HostEmbeddingRuntime } from "../embedding-runtime";
import { registerUsage } from "../usage/mount";
import { UsageRuntime } from "../usage/runtime";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("does not open a session DB for refused organism setup or resolution", () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const open = vi.spyOn(sessionDb, "openSessionRunDb").mockImplementation(() => { throw new Error("unexpected DB open"); });
  const runtime = new HostOrganismRuntime(async () => null, undefined, undefined, undefined, () => false);
  const ctx = { cwd: ".spider/scratch", sessionManager: { getSessionId: () => "session-1" } } as unknown as ExtensionContext;
  runtime.recordSetupFailure("resolve", new Error("fixture"), ctx);
  expect(runtime.getSetupFailure("session-1")?.status).toBe("failed");
  expect(open).not.toHaveBeenCalled();
  expect(() => runtime.fromContext(ctx)).toThrow(/ownership/i);
  runtime.dispose();
}, 5000);

it("refused usage registration and embedding startup do not read configuration or context", async () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const hooks = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => hooks.set(name, handler) };
  const config = vi.spyOn(control, "controlConfig").mockImplementation(() => { throw new Error("must not read config"); });
  registerUsage(pi as never, "file:///fixture.js", () => false);
  await hooks.get("session_start")!({}, { cwd: "/fixture" });
  const context = vi.fn(() => { throw new Error("must not read context"); });
  const embeddings = new HostEmbeddingRuntime(context, undefined, { admitted: () => false });
  embeddings.start();
  await embeddings.stop();
  expect(config).not.toHaveBeenCalled();
  expect(context).not.toHaveBeenCalled();
}, 5000);

it("refused usage startup can retry after admission reopens", async () => {
  vi.useFakeTimers();
  let admitted = false;
  const worker = vi.fn(() => { throw new Error("fixture worker"); });
  const runtime = new UsageRuntime({ bundleUrl: "file:///fixture.js", child: false, admitted: () => admitted,
    roots: { registryDb: "", ledgerFile: "", sessionsDir: "", authPath: "", leaseDir: "" },
    supportsWorkers: () => true, workerFactory: worker });
  try {
    runtime.start(false);
    await vi.runAllTimersAsync();
    expect(worker).not.toHaveBeenCalled();
    admitted = true;
    runtime.start(false);
    await vi.runAllTimersAsync();
    expect(worker).toHaveBeenCalledOnce();
  } finally { await runtime.stop(); vi.useRealTimers(); }
}, 5000);

it("usage worker is not launched if admission closes before its deferred startup", async () => {
  vi.useFakeTimers();
  let admitted = true;
  const worker = vi.fn(() => { throw new Error("fixture worker"); });
  const runtime = new UsageRuntime({ bundleUrl: "file:///fixture.js", child: false, admitted: () => admitted,
    roots: { registryDb: "", ledgerFile: "", sessionsDir: "", authPath: "", leaseDir: "" },
    supportsWorkers: () => true, workerFactory: worker });
  try {
    runtime.start(false);
    admitted = false;
    await vi.runAllTimersAsync();
    expect(worker).not.toHaveBeenCalled();
  } finally { await runtime.stop(); vi.useRealTimers(); }
}, 5000);

it("frozen shutdown and compaction do not start organism work", async () => {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const hooks = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => hooks.set(name, handler) };
  const resolveWorker = vi.fn(() => { throw new Error("must not resolve worker"); });
  const branch = vi.fn(() => []);
  const ctx = { sessionManager: { getSessionId: () => "session-1", getBranch: branch } } as unknown as ExtensionContext;
  registerOrganism(null, pi, resolveWorker, undefined, () => false);
  await hooks.get("session_start")!({}, ctx);
  await hooks.get("session_before_compact")!({}, ctx);
  await hooks.get("session_shutdown")!({}, ctx);
  expect(resolveWorker).not.toHaveBeenCalled();
  expect(branch).not.toHaveBeenCalled();
}, 5000);

it("an already mounted agents UI cannot dispatch after admission closes", async () => {
  let admitted = true;
  const install = vi.spyOn(agentsUi, "installAgentsUI").mockReturnValue(() => {});
  vi.spyOn(control, "controlConfig").mockReturnValue(true);
  const dispatch = vi.fn(async () => ({}));
  const pi = { registerShortcut() {} };
  const ctx = { ui: { setWidget() {}, custom: async () => undefined, notify() {} } };
  mountAgentsUI(pi, ctx as never, { db: {} as never, cwd: ".spider/scratch", sessionId: "session-1", admitted: () => admitted, dispatch });
  expect(install).toHaveBeenCalledOnce();
  admitted = false;
  const actions = install.mock.calls[0][2].actions!;
  await actions.kill("run-1");
  expect(dispatch).not.toHaveBeenCalled();
}, 5000);
