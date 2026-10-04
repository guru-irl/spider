import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Test-only transport double; provider and init options stay controlled by each test. */
interface FixtureWorker extends EventEmitter {
  unref(): this;
  postMessage(msg: { id: number; texts: string[] }): void;
  terminate(): Promise<number>;
}
export function providerWorker(load: () => Promise<any>): new (source: string, options: { workerData: { modelsDir: string } }) => FixtureWorker {
  return class extends EventEmitter {
    #model: any;
    #stopped = false;
    constructor(_source: string, options: { workerData: { modelsDir: string } }) {
      super();
      const modelsDir = options.workerData.modelsDir;
      queueMicrotask(async () => {
        let modelDir: string | undefined, existed = false;
        try {
          mkdirSync(modelsDir, { recursive: true });
          const { FlagEmbedding, EmbeddingModel } = await load();
          modelDir = join(modelsDir, EmbeddingModel.BGESmallENV15); existed = existsSync(modelDir);
          this.#model = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir: modelsDir, showDownloadProgress: false });
          if (!this.#stopped) this.emit("message", { type: "ready" });
        } catch (error: any) {
          if (!this.#stopped) this.emit("message", { type: "load-failure", modelDir, existed, error: { message: error.message, name: error.name, code: error.code } });
        }
      });
    }
    unref() { return this; }
    postMessage(msg: { id: number; texts: string[] }) {
      queueMicrotask(async () => {
        try {
          const vectors: Float32Array[] = [];
          for await (const batch of this.#model.embed(msg.texts)) for (const v of batch) vectors.push(Float32Array.from(v));
          if (!this.#stopped) this.emit("message", { type: "result", id: msg.id, vectors });
        } catch (error: any) { if (!this.#stopped) this.emit("message", { type: "failure", id: msg.id, error: { message: error.message } }); }
      });
    }
    async terminate() { this.#stopped = true; this.emit("exit", 0); return 0; }
  };
}
