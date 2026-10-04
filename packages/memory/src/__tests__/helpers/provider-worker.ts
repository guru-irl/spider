import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Test-only transport double; provider and init options stay controlled by each test. */
interface FixtureWorker extends EventEmitter {
  pid: number;
  channel: { ref(): void; unref(): void };
  ref(): this;
  unref(): this;
  send(msg: { modelsDir?: string; id?: number; texts?: string[] }, callback?: (error: Error | null) => void): boolean;
  kill(signal?: string): boolean;
}
export function providerWorker(load: () => Promise<any>): new () => FixtureWorker {
  return class extends EventEmitter {
    pid = 1;
    connected = true;
    channel = { ref() {}, unref() {} };
    #model: any;
    #stopped = false;
    ref() { return this; }
    unref() { return this; }
    send(msg: { modelsDir?: string; id?: number; texts?: string[] }, callback?: (error: Error | null) => void) {
      callback?.(null);
      queueMicrotask(async () => {
        if (msg.modelsDir) {
          let modelDir: string | undefined, existed = false;
          try {
            mkdirSync(msg.modelsDir, { recursive: true });
            const { FlagEmbedding, EmbeddingModel } = await load();
            modelDir = join(msg.modelsDir, EmbeddingModel.BGESmallENV15); existed = existsSync(modelDir);
            this.#model = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir: msg.modelsDir, showDownloadProgress: false });
            if (!this.#stopped) this.emit("message", { type: "ready" });
          } catch (error: any) {
            if (!this.#stopped) this.emit("message", { type: "load-failure", modelDir, existed, error: { message: error.message, name: error.name, code: error.code } });
          }
        } else {
          try {
            const vectors: Float32Array[] = [];
            for await (const batch of this.#model.embed(msg.texts)) for (const v of batch) vectors.push(Float32Array.from(v));
            if (!this.#stopped) this.emit("message", { type: "result", id: msg.id, vectors });
          } catch (error: any) { if (!this.#stopped) this.emit("message", { type: "failure", id: msg.id, error: { message: error.message } }); }
        }
      });
      return true;
    }
    kill() { this.#stopped = true; this.emit("exit", null, "SIGKILL"); return true; }
  };
}
