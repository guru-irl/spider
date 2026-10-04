import { afterEach, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { paths, commandEnv } from "@spider/db-core";
import { createWorkerEmbedder, stopEmbeddingWorkers } from "../embeddings/worker";
import { makeMemDb } from "./helpers/tmpdb";
import { addMemory } from "../store";
import { drainEmbedQueue } from "../embeddings/queue";

let root: string;
let dbFixture: ReturnType<typeof makeMemDb> | undefined;
afterEach(async () => { await stopEmbeddingWorkers(); dbFixture?.cleanup(); dbFixture = undefined; if (root) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  root = join(paths.globalRoot, `worker-${randomUUID()}`);
  const dir = join(root, "node_modules", "fastembed"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), `
    const { isMainThread, threadId } = require('node:worker_threads');
    const block = () => { const end = Date.now() + 120; while (Date.now() < end) {} };
    exports.EmbeddingModel = { BGESmallENV15: 'fixture' };
    exports.FlagEmbedding = { async init(options) {
      if (isMainThread) throw new Error('provider on main thread');
      if (options.showDownloadProgress !== false) throw new Error('progress enabled');
      block();
      return { async *embed(texts) { if (texts.includes('EXIT')) process.exit(9); block(); yield texts.map(() => Float32Array.from([threadId, ...Array(383).fill(0)])); } };
    } };
  `);
  return pathToFileURL(join(root, "entry.js")).href;
}
async function timerWins<T>(task: Promise<T>): Promise<T> {
  let completed = false; task.then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(completed).toBe(false);
  return task;
}
it("keeps main-thread timers responsive during synchronous provider load and inference", async () => {
  const errors: Error[] = [];
  const base = fixture();
  const worker = await timerWins(createWorkerEmbedder(join(root, "models"), f => errors.push(f.error), base));
  expect(worker).not.toBeNull();
  const vectors = await timerWins(worker!.embed(["query", "content"]));
  expect(vectors).toHaveLength(2); expect(vectors[0]).toBeInstanceOf(Float32Array);
  expect(vectors[0][0]).toBeGreaterThan(0);
  expect(worker!.memory()?.heapUsed).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  await worker!.stop();
  await expect(worker!.embed(["late"])).rejects.toThrow("stopped");
});

it("settles a real worker exit mid-batch and leaves all rows retryable", async () => {
  const base = fixture(); const errors: Error[] = [];
  const worker = await createWorkerEmbedder(join(root, "models"), f => errors.push(f.error), base);
  dbFixture = makeMemDb();
  for (const content of ["EXIT", ...Array.from({ length: 7 }, (_, i) => `good ${i}`)]) addMemory(dbFixture.db, "repo", { category: "insight", content });
  expect(await drainEmbedQueue(dbFixture.db, worker)).toBe(0);
  expect(errors.map(error => error.message)).toEqual(["embedding worker exited (9)"]);
  expect(dbFixture.db.prepare("SELECT DISTINCT tries FROM embed_queue").all()).toEqual([{ tries: 0 }]);
  await expect(worker!.embed(["late"])).rejects.toThrow("exited (9)");
});

it("terminates and settles a worker that is still loading on shutdown", async () => {
  const base = fixture();
  const pending = createWorkerEmbedder(join(root, "models"), () => {}, base);
  await stopEmbeddingWorkers();
  expect(await pending).toBeNull();
});

it("an unused model worker does not keep a short-lived process alive", () => {
  const base = fixture(); const moduleUrl = new URL("../embeddings/worker.ts", import.meta.url).href;
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    const { createWorkerEmbedder } = await import(${JSON.stringify(moduleUrl)});
    void createWorkerEmbedder(${JSON.stringify(join(root, "models"))}, () => {}, ${JSON.stringify(base)});
    setTimeout(() => process.stdout.write('exiting'), 30);
  `], { env: commandEnv(), encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" });
  expect(result).toBe("exiting");
});
