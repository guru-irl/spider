import { Worker } from "node:worker_threads";
import type { Embedder } from "./embedder";

// A string, not a worker file URL: the published extension is a single bundle.
const source = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
const { existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const ownRequire = createRequire(workerData.base);
const failure = error => ({ message: String(error.message || error), name: error.name, code: error.code });
(async () => {
  let modelDir, existed;
  try {
    mkdirSync(workerData.modelsDir, { recursive: true });
    const { FlagEmbedding, EmbeddingModel } = ownRequire('fastembed');
    modelDir = join(workerData.modelsDir, EmbeddingModel.BGESmallENV15);
    existed = existsSync(modelDir);
    const model = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15,
      cacheDir: workerData.modelsDir, showDownloadProgress: false });
    let tasks = Promise.resolve();
    parentPort.on('message', msg => {
      tasks = tasks.then(async () => {
        try {
          const vectors = [];
          for await (const batch of model.embed(msg.texts)) {
            for (const vector of batch) vectors.push(Float32Array.from(vector));
          }
          parentPort.postMessage({ type: 'result', id: msg.id, vectors, memory: process.memoryUsage() }, vectors.map(v => v.buffer));
        } catch (error) { parentPort.postMessage({ type: 'failure', id: msg.id, error: failure(error) }); }
      });
    });
    parentPort.postMessage({ type: 'ready', memory: process.memoryUsage() });
  } catch (error) {
    parentPort.postMessage({ type: 'load-failure', error: failure(error), modelDir, existed });
    parentPort.close();
  }
})();
`;

const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const unavailable = (error: Error) => Object.assign(new Error(error.message, { cause: error }), { code: "EMBED_WORKER_UNAVAILABLE" });
export function isEmbeddingWorkerUnavailable(error: unknown): boolean {
  return (error as { code?: string })?.code === "EMBED_WORKER_UNAVAILABLE";
}

export interface WorkerMemory { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number }
export interface WorkerFailure { error: Error; modelDir?: string; existed?: boolean }
export interface WorkerEmbedder extends Embedder { stop(): Promise<void>; memory(): WorkerMemory | undefined }

const liveKey = Symbol.for("spider.embedding-workers.v1");
const registry = globalThis as typeof globalThis & { [liveKey]?: Set<() => Promise<void>> };
const live = registry[liveKey] ??= new Set<() => Promise<void>>();
export async function stopEmbeddingWorkers(): Promise<void> { await Promise.all([...live].map(stop => stop())); }

export function createWorkerEmbedder(
  modelsDir: string,
  onFailure: (failure: WorkerFailure) => void,
  base: string = import.meta.url,
): Promise<WorkerEmbedder | null> {
  return new Promise(resolve => {
    let worker: Worker;
    try { worker = new Worker(source, { eval: true, stdout: true, stderr: true, workerData: { base, modelsDir } }); }
    catch (error) { onFailure({ error: error instanceof Error ? error : new Error(String(error)) }); resolve(null); return; }
    // Optional native libraries must not write over the host TUI. Structured failures reach doctor.
    worker.stdout?.resume(); worker.stderr?.resume();
    let nextId = 0;
    let failed: Error | undefined;
    let stopped = false;
    let memory: WorkerMemory | undefined;
    const pending = new Map<number, { resolve: (vectors: Float32Array[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const stop = async () => {
      if (stopped) return;
      stopped = true; live.delete(stop);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(unavailable(new Error("embedding worker stopped"))); }
      pending.clear(); resolve(null);
      await worker.terminate();
    };
    live.add(stop);
    const fail = (failure: WorkerFailure) => {
      if (failed || stopped) return;
      failed = unavailable(failure.error); live.delete(stop);
      onFailure(failure);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failed); }
      pending.clear(); resolve(null);
      void worker.terminate().catch(() => {});
    };
    worker.on("error", error => fail({ error }));
    worker.on("exit", code => { if (!stopped) fail({ error: new Error(`embedding worker exited (${code})`) }); });
    worker.on("message", msg => {
      if (failed || stopped) return;
      if (msg.memory) memory = msg.memory;
      if (msg.type === "ready") {
        resolve({ model: "BGE-small-en-v1.5", dim: 384,
          embed(texts) {
            if (failed || stopped) return Promise.reject(failed ?? unavailable(new Error("embedding worker stopped")));
            return new Promise((resolve, reject) => {
              const id = ++nextId;
              const timer = setTimeout(() => fail({ error: new Error(`embedding request timed out after ${REQUEST_TIMEOUT_MS} ms`) }), REQUEST_TIMEOUT_MS);
              timer.unref();
              pending.set(id, { resolve, reject, timer });
              try { worker.postMessage({ id, texts }); }
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
        if (msg.type === "failure") request.reject(new Error(msg.error.message));
        else request.resolve(msg.vectors);
      }
    });
    // Registering message listeners refs the port, so unref after all listeners.
    worker.unref();
  });
}
