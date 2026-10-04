import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Embedder } from "./embedder";

// A string, not a worker file URL: the published extension is a single bundle.
// ORT can throw uncaught Napi::Error exceptions when a thread is terminated
// during native import/load/inference. A process boundary keeps aborts out of pi.
const watchdogSource = String.raw`
      const { workerData } = require('node:worker_threads');
      const { parentPid, childPid } = workerData;
      const realPid = pid => typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
      if (!realPid(parentPid) || !realPid(childPid)) process.exit(1);
      setInterval(() => {
        let gone = process.ppid !== parentPid;
        if (!gone) try { process.kill(parentPid, 0); } catch (error) { gone = error.code === 'ESRCH'; }
        if (gone) process.kill(childPid, 'SIGKILL');
      }, 100);
`;
const source = String.raw`
// Disconnect cancels async work immediately; the poll also covers a missed event
// or a channel already disconnected before the listener was registered.
process.on('disconnect', () => process.exit(0));
setInterval(() => { if (!process.connected) process.exit(0); }, 100).unref();
process.once('message', async workerData => {
  const { createRequire } = require('node:module');
  const { existsSync, mkdirSync } = require('node:fs');
  const { join } = require('node:path');
  const ownRequire = createRequire(workerData.base);
  const failure = error => ({ message: String(error.message || error), name: error.name, code: error.code });
  let modelDir, existed;
  try {
    // The main child event loop can be blocked inside synchronous ORT loading.
    // This JS-only watchdog never imports ORT. It detects parent death even then.
    let warned = false;
    const watchdogFailure = error => {
      if (warned) return;
      warned = true;
      process.send({ type: 'watchdog-warning', error: failure(error) });
    };
    try {
      const { Worker } = require('node:worker_threads');
      const watchdog = new Worker(${JSON.stringify(watchdogSource)}, { eval: true, workerData: { parentPid: workerData.parentPid, childPid: process.pid } });
      watchdog.on('error', watchdogFailure);
      watchdog.unref();
    } catch (error) { watchdogFailure(error); }
    mkdirSync(workerData.modelsDir, { recursive: true });
    const { FlagEmbedding, EmbeddingModel } = ownRequire('fastembed');
    modelDir = join(workerData.modelsDir, EmbeddingModel.BGESmallENV15);
    existed = existsSync(modelDir);
    const model = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15,
      cacheDir: workerData.modelsDir, showDownloadProgress: false });
    let tasks = Promise.resolve();
    process.on('message', msg => {
      tasks = tasks.then(async () => {
        try {
          const vectors = [];
          for await (const batch of model.embed(msg.texts)) {
            for (const vector of batch) vectors.push(Float32Array.from(vector));
          }
          process.send({ type: 'result', id: msg.id, vectors, memory: process.memoryUsage() });
        } catch (error) { process.send({ type: 'failure', id: msg.id, error: failure(error) }); }
      });
    });
    process.send({ type: 'ready', memory: process.memoryUsage() });
  } catch (error) {
    process.send({ type: 'load-failure', error: failure(error), modelDir, existed });
    process.disconnect();
  }
});
`;

const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const unavailable = (error: Error) => Object.assign(new Error(error.message, { cause: error }), { code: "EMBED_WORKER_UNAVAILABLE" });
export function isEmbeddingWorkerUnavailable(error: unknown): boolean {
  return (error as { code?: string })?.code === "EMBED_WORKER_UNAVAILABLE";
}

export interface WorkerMemory { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number }
export interface WorkerFailure { error: Error; modelDir?: string; existed?: boolean }
export interface WorkerEmbedder extends Embedder { stop(): Promise<void>; memory(): WorkerMemory | undefined }
interface WireError { message: string; name?: string; code?: string }
type WorkerMessage =
  | { type: "ready"; memory?: WorkerMemory }
  | { type: "result"; id: number; vectors: Float32Array[]; memory?: WorkerMemory }
  | { type: "failure"; id: number; error: WireError }
  | { type: "watchdog-warning"; error: WireError }
  | { type: "load-failure"; error: WireError; modelDir?: string; existed?: boolean };
const realPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0;

const liveKey = Symbol.for("spider.embedding-workers.v2");
const registry = globalThis as typeof globalThis & { [liveKey]?: Set<() => Promise<void>> };
const live = registry[liveKey] ??= new Set<() => Promise<void>>();
export async function stopEmbeddingWorkers(): Promise<void> { await Promise.all([...live].map(stop => stop())); }

export function createWorkerEmbedder(
  modelsDir: string,
  onFailure: (failure: WorkerFailure) => void,
  base: string = import.meta.url,
  onDiagnostic: (message: string) => void = () => {},
): Promise<WorkerEmbedder | null> {
  return new Promise(resolve => {
    let worker: ChildProcess;
    try {
      // A Bun runtime or Node single-executable app cannot evaluate the child
      // script as Node. Binary names and versioned install paths are irrelevant.
      let isSea = false;
      try { isSea = process.getBuiltinModule?.("node:sea")?.isSea?.() ?? false; }
      catch { /* SEA detection is optional on runtimes without the module. */ }
      if (process.versions.bun || isSea) {
        throw new Error("embedding child requires a Node executable");
      }
      modelsDir = resolvePath(modelsDir);
      mkdirSync(modelsDir, { recursive: true });
      const env = { ...process.env };
      delete env.NODE_OPTIONS; // Do not inherit host inspectors or arbitrary preloads.
      worker = spawn(process.execPath, ["--input-type=commonjs", "--eval", source], {
        stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
        detached: true, windowsHide: true, cwd: modelsDir, env,
      });
    }
    catch (error) { onFailure({ error: error instanceof Error ? error : new Error(String(error)) }); resolve(null); return; }
    let exited = false;
    // Node may retain a pid-0 handle until the async spawn error arrives. Never
    // call ChildProcess.kill without a positive real pid, including during exit.
    const killChild = () => { if (!exited && realPid(worker.pid)) worker.kill("SIGKILL"); };
    const killOnExit = killChild;
    process.once("exit", killOnExit);
    let settleExit!: () => void;
    const exit = new Promise<void>(resolve => { settleExit = resolve; });
    const didExit = () => {
      exited = true;
      process.removeListener("exit", killOnExit);
      settleExit();
    };
    const terminate = async () => {
      if (!exited && realPid(worker.pid)) worker.ref();
      killChild();
      await exit;
    };
    let nextId = 0;
    let failed: Error | undefined;
    let stopped = false;
    let stopping: Promise<void> | undefined;
    let memory: WorkerMemory | undefined;
    const pending = new Map<number, { resolve: (vectors: Float32Array[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    // Shutdown cancels, rather than drains, in-flight work. Pending queue rows
    // remain retryable. All stop callers wait for the actual child exit.
    const stop = (): Promise<void> => {
      if (stopping) return stopping;
      stopped = true;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(unavailable(new Error("embedding worker stopped"))); }
      pending.clear(); resolve(null);
      stopping = terminate().finally(() => { live.delete(stop); });
      return stopping;
    };
    live.add(stop);
    const fail = (failure: WorkerFailure) => {
      if (failed || stopped) return;
      failed = unavailable(failure.error); live.delete(stop);
      onFailure(failure);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failed); }
      pending.clear(); resolve(null);
      void terminate().catch(() => {});
    };
    worker.on("error", error => { if (!realPid(worker.pid)) didExit(); fail({ error }); });
    worker.on("exit", (code, signal) => { didExit(); if (!stopped) fail({ error: new Error(`embedding worker exited (${signal ?? code})`) }); });
    let watchdogWarned = false;
    worker.on("message", (msg: WorkerMessage) => {
      if (failed || stopped || !msg || !["ready", "result", "failure", "load-failure", "watchdog-warning"].includes(msg.type)) return;
      if (msg.type === "watchdog-warning") {
        if (!watchdogWarned) {
          watchdogWarned = true;
          try { onDiagnostic("embedding watchdog unavailable; continuing without blocked-loop orphan protection"); }
          catch { /* Diagnostics must not disable embeddings. */ }
        }
        return;
      }
      if ("memory" in msg && msg.memory) memory = msg.memory;
      if (msg.type === "ready") {
        resolve({ model: "BGE-small-en-v1.5", dim: 384,
          embed(texts) {
            if (failed || stopped) return Promise.reject(failed ?? unavailable(new Error("embedding worker stopped")));
            return new Promise((resolve, reject) => {
              const id = ++nextId;
              const timer = setTimeout(() => fail({ error: new Error(`embedding request timed out after ${REQUEST_TIMEOUT_MS} ms`) }), REQUEST_TIMEOUT_MS);
              timer.unref();
              if (pending.size === 0) worker.channel?.ref();
              pending.set(id, { resolve, reject, timer });
              try { worker.send({ id, texts }, error => { if (error) fail({ error }); }); }
              catch (error) { fail({ error: error instanceof Error ? error : new Error(String(error)) }); }
            });
          },
          memory: () => memory,
          stop,
        });
      } else if (msg.type === "load-failure") {
        const error = Object.assign(msg.error.name === "SyntaxError" ? new SyntaxError(msg.error.message) : new Error(msg.error.message), { code: msg.error.code });
        fail({ error, modelDir: msg.modelDir, existed: msg.existed });
      } else {
        const request = pending.get(msg.id); if (!request) return;
        pending.delete(msg.id); clearTimeout(request.timer);
        if (pending.size === 0) worker.channel?.unref();
        if (msg.type === "failure") request.reject(new Error(msg.error.message));
        else request.resolve(msg.vectors);
      }
    });
    if (typeof worker.send !== "function" || !worker.connected) {
      if (!realPid(worker.pid)) didExit();
      // Node reports EMFILE/ENOENT on nextTick. Keep that diagnostic if it
      // arrives, but also settle doubles/broken transports that emit no error.
      setImmediate(() => fail({ error: new Error("embedding child spawn failed: IPC unavailable") }));
    } else {
      try { worker.send({ base, modelsDir, parentPid: process.pid }, error => { if (error) fail({ error }); }); }
      catch (error) { fail({ error: error instanceof Error ? error : new Error(String(error)) }); }
    }
    // Registering message listeners refs IPC, so unref both after all listeners.
    worker.unref();
    if (!failed) worker.channel?.unref();
  });
}
