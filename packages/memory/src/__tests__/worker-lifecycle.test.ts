import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChildProcess } from "node:child_process";
import { paths } from "@spider/db-core";
import { createWorkerEmbedder, stopEmbeddingWorkers } from "../embeddings/worker";
import { getEmbedderState, getReadyEmbedder, resolveEmbedder, startEmbedderSession, stopEmbedder } from "../embeddings/embedder";
import { onEmbeddingDiagnostic } from "../embeddings/drain-state";

const fixture = vi.hoisted(() => ({
  child: undefined as any, pid: 123 as number | undefined, spawnError: undefined as string | undefined,
  asyncError: undefined as string | undefined, noSend: false, sendError: false, autoExit: true,
  options: undefined as any, executable: "", spawns: 0,
}));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  class FakeChild extends actual.ChildProcess {
    constructor() {
      super(); Object.assign(this, { pid: fixture.pid, connected: !fixture.noSend,
        channel: { ref: vi.fn(), unref: vi.fn() } });
      if (fixture.noSend) this.send = undefined as any;
      if (fixture.asyncError) queueMicrotask(() => this.emit("error", Object.assign(new Error(fixture.asyncError), { code: fixture.asyncError })));
    }
    override unref() { return this; }
    override send(msg: any, callback?: any): boolean {
      if (fixture.sendError && msg.id) { callback?.(new Error("send failed")); return false; }
      callback?.(null);
      if (msg.modelsDir && !fixture.asyncError) queueMicrotask(() => this.emit("message", { type: "ready" }));
      return true;
    }
  }
  return { ...actual, spawn: (executable: string, _args: string[], options: unknown) => {
    fixture.spawns++; fixture.executable = executable; fixture.options = options;
    if (fixture.spawnError) throw Object.assign(new Error(fixture.spawnError), { code: fixture.spawnError });
    return fixture.child = new FakeChild();
  } };
});
const cache = globalThis as typeof globalThis & Record<symbol, unknown>;
const key = Symbol.for("spider.embedder.v3:BGE-small-en-v1.5");
let kill: ReturnType<typeof vi.spyOn>;
let hostKill: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  startEmbedderSession();
  kill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function(this: ChildProcess, signal) {
    if (fixture.autoExit) this.emit("exit", null, signal); return true;
  });
  hostKill = vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(async () => {
  fixture.child?.emit("exit", null, "SIGKILL");
  await stopEmbedder(); await stopEmbeddingWorkers(); delete cache[key];
  Object.assign(fixture, { child: undefined, pid: 123, spawnError: undefined, asyncError: undefined, noSend: false, sendError: false, autoExit: true, spawns: 0 });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

it.each(["EMFILE", "ENOENT", "EAGAIN"])("a synchronous %s spawn failure enters cooldown without any signal", async code => {
  fixture.spawnError = code;
  expect(await resolveEmbedder()).toBeNull();
  expect(getEmbedderState()).toMatchObject({ state: "unavailable", lastError: code, retryAt: expect.any(Number) });
  expect(getReadyEmbedder()).toBeNull(); expect(await resolveEmbedder()).toBeNull();
  expect(fixture.spawns).toBe(1); await stopEmbedder();
  expect(kill).not.toHaveBeenCalled(); expect(hostKill).not.toHaveBeenCalled();
});

it.each([undefined, 0, -1, NaN])("a child with pid %s and no IPC cannot signal the host or group", async pid => {
  fixture.pid = pid; fixture.noSend = true; fixture.asyncError = "EMFILE";
  expect(await resolveEmbedder()).toBeNull();
  expect(getEmbedderState()).toMatchObject({ state: "unavailable", lastError: "EMFILE", retryAt: expect.any(Number) });
  expect(getReadyEmbedder()).toBeNull(); expect(await resolveEmbedder()).toBeNull();
  await stopEmbedder(); expect(kill).not.toHaveBeenCalled(); expect(hostKill).not.toHaveBeenCalled();
});

it.each(["stop", "exit"])("same-tick %s before an async spawn error never signals", async mode => {
  fixture.pid = undefined; fixture.asyncError = "ENOENT";
  const before = new Set(process.listeners("exit"));
  const loading = createWorkerEmbedder(paths.models, () => {});
  if (mode === "stop") await stopEmbeddingWorkers();
  else for (const listener of process.listeners("exit")) if (!before.has(listener)) listener(0);
  expect(await loading).toBeNull();
  expect(kill).not.toHaveBeenCalled(); expect(hostKill).not.toHaveBeenCalled();
});

it("an async EAGAIN spawn error preserves the failure and cooldown without a signal", async () => {
  fixture.pid = undefined; fixture.asyncError = "EAGAIN";
  expect(await resolveEmbedder()).toBeNull();
  expect(getEmbedderState()).toMatchObject({ state: "unavailable", lastError: "EAGAIN", retryAt: expect.any(Number) });
  expect(await resolveEmbedder()).toBeNull(); expect(fixture.spawns).toBe(1);
  expect(kill).not.toHaveBeenCalled(); expect(hostKill).not.toHaveBeenCalled();
});

it("isolates terminal signals and stdio and strips host Node preloads", async () => {
  vi.stubEnv("NODE_OPTIONS", "--inspect --require=host-only.cjs");
  const worker = await createWorkerEmbedder(paths.models, () => {});
  expect(worker).not.toBeNull();
  expect(fixture.options).toMatchObject({ detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
  expect(fixture.options.env.NODE_OPTIONS).toBeUndefined();
  expect(fixture.options.cwd).toBe(paths.models);
});

it("keeps IPC referenced only while embeds are pending", async () => {
  const worker = await createWorkerEmbedder(paths.models, () => {});
  const pending = worker!.embed(["query"]);
  void pending.catch(() => {});
  expect(fixture.child.channel.ref).toHaveBeenCalledTimes(1);
  fixture.child.emit("message", { type: "result", id: 1, vectors: [new Float32Array(384)] });
  expect(await pending).toHaveLength(1);
  expect(fixture.child.channel.unref).toHaveBeenCalledTimes(2);
});

it("cancels embeds on stop and waits for actual child exit with SIGKILL", async () => {
  const before = process.listenerCount("exit"); fixture.autoExit = false;
  const worker = await createWorkerEmbedder(paths.models, () => {});
  const pending = worker!.embed(["query"]).catch(error => error);
  let settled = false;
  const stopped = worker!.stop().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect((await pending).message).toContain("stopped"); expect(settled).toBe(false);
  expect(kill).toHaveBeenCalledWith("SIGKILL");
  let secondSettled = false;
  const secondStop = worker!.stop().then(() => { secondSettled = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(secondSettled).toBe(false);
  fixture.child.emit("exit", null, "SIGKILL"); await stopped; await secondStop;
  expect(process.listenerCount("exit")).toBe(before);
});

it("host exit kills only the live numeric child and removes the hook on exit", async () => {
  const before = new Set(process.listeners("exit"));
  await createWorkerEmbedder(paths.models, () => {});
  for (const listener of process.listeners("exit")) if (!before.has(listener)) listener(0);
  expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(hostKill).not.toHaveBeenCalled();
  expect(process.listeners("exit")).toEqual([...before]);
});

it.each([
  "/usr/bin/node-22", "/usr/bin/nodejs", "/usr/local/bin/node22",
  "/opt/node/v22.19.0/bin/node", "C:\\Program Files\\nodejs\\node.exe", "/fixture/renamed-runtime",
])("accepts a genuine Node executable at %s", async executable => {
  const previous = process.execPath;
  try {
    Object.defineProperty(process, "execPath", { value: executable, configurable: true });
    expect(await resolveEmbedder()).not.toBeNull();
    expect(getEmbedderState()).toMatchObject({ state: "ready" });
    expect(fixture.executable).toBe(executable);
  } finally { Object.defineProperty(process, "execPath", { value: previous, configurable: true }); }
});

it.each(["Bun", "SEA"])("rejects %s by runtime capability even with a Node basename", async runtime => {
  if (runtime === "Bun") Object.defineProperty(process.versions, "bun", { value: "1.3.0", configurable: true });
  else vi.spyOn(process, "getBuiltinModule").mockReturnValue({ isSea: () => true } as any);
  try {
    expect(await resolveEmbedder()).toBeNull();
    expect(getEmbedderState()).toMatchObject({ state: "unavailable", retryAt: expect.any(Number) });
    expect(fixture.spawns).toBe(0); expect(kill).not.toHaveBeenCalled();
  } finally { if (runtime === "Bun") delete (process.versions as Record<string, string | undefined>).bun; }
});

it.each(["missing module", "missing isSea", "throws"])("accepts Node when the optional SEA check %s", async mode => {
  vi.spyOn(process, "getBuiltinModule").mockImplementation(() => {
    if (mode === "throws") throw new Error("SEA unavailable");
    return (mode === "missing module" ? undefined : {}) as any;
  });
  expect(await resolveEmbedder()).not.toBeNull();
  expect(getEmbedderState()).toMatchObject({ state: "ready" });
});

it("logs repeated watchdog warnings once without entering embedder cooldown", async () => {
  const messages: string[] = [];
  const unsubscribe = onEmbeddingDiagnostic(message => messages.push(message));
  try {
    const worker = await resolveEmbedder();
    fixture.child.emit("message", { type: "watchdog-warning", error: { message: "start failed" } });
    fixture.child.emit("message", { type: "watchdog-warning", error: { message: "start failed again" } });
    expect(messages).toHaveLength(1); expect(messages[0]).toContain("watchdog");
    expect(getEmbedderState()).toMatchObject({ state: "ready" });
    expect(getEmbedderState().retryAt).toBeUndefined();
    expect(await resolveEmbedder()).toBe(worker);
    const pending = worker!.embed(["query"]);
    fixture.child.emit("message", { type: "result", id: 1, vectors: [new Float32Array(384)] });
    expect(await pending).toHaveLength(1);
    expect(kill).not.toHaveBeenCalled();
  } finally { unsubscribe(); }
});

it("IPC send failure rejects the request and terminates the child", async () => {
  const failures: string[] = [];
  const worker = await createWorkerEmbedder(paths.models, f => failures.push(f.error.message));
  fixture.sendError = true;
  await expect(worker!.embed(["query"])).rejects.toThrow("send failed");
  expect(failures).toEqual(["send failed"]); expect(kill).toHaveBeenCalledWith("SIGKILL");
});
