import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { commandEnv, paths } from "@spider/db-core";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      const pid = Number(readFileSync(join(root, "provider.pid"), "utf8"));
      if (Number.isInteger(pid) && pid > 0) try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    } catch { /* provider never started */ }
    rmSync(root, { recursive: true, force: true });
  }
});

// This catches moving ORT back into a thread in the host process. The real addon
// is imported, but no model is loaded or downloaded. A native abort stays inside
// the sacrificial host subprocess instead of taking down Vitest.
it.each(["stop", "exit"])("survives %s while the real ORT addon is importing", async mode => {
  for (let trial = 0; trial < 5; trial++) {
    const root = join(paths.globalRoot, `native-shutdown-${randomUUID()}`);
    roots.push(root);
    const provider = join(root, "node_modules", "fastembed");
    mkdirSync(provider, { recursive: true });
    const ort = import.meta.resolve("onnxruntime-node");
    writeFileSync(join(provider, "index.js"), `
      const { parentPort } = require('node:worker_threads');
      require('node:fs').writeFileSync(${JSON.stringify(join(root, "provider.pid"))}, String(process.pid));
      const dlopen = process.dlopen;
      process.dlopen = function(module, file, ...args) {
        if (file.includes('onnxruntime_binding.node')) {
          const msg = {type: 'native-import-probe'};
          if (parentPort) parentPort.postMessage(msg); else process.send(msg);
        }
        return dlopen.call(this, module, file, ...args);
      };
      require(${JSON.stringify(new URL(ort).pathname)});
      exports.EmbeddingModel = {BGESmallENV15: 'fixture'};
      exports.FlagEmbedding = {async init() {return {async *embed() {yield []}}}};
    `);
    const entry = join(root, "host.mjs");
    writeFileSync(entry, `
      import {Worker} from 'node:worker_threads';
      import {ChildProcess} from 'node:child_process';
      const {createWorkerEmbedder, stopEmbeddingWorkers} = await import(${JSON.stringify(new URL("../embeddings/worker.ts", import.meta.url).href)});
      const hold = setInterval(() => {}, 1000);
      let seen = false;
      for (const Class of [Worker, ChildProcess]) {
        const emit = Class.prototype.emit;
        Class.prototype.emit = function(event, msg, ...rest) {
          if (event === 'message' && msg?.type === 'native-import-probe' && !seen) {
            seen = true;
            if (${JSON.stringify(mode)} === 'stop') {
              void stopEmbeddingWorkers().then(() => {clearInterval(hold); console.log('survived')});
            } else {console.log('survived'); process.exit(0)}
          }
          return emit.call(this, event, msg, ...rest);
        };
      }
      void createWorkerEmbedder(${JSON.stringify(join(root, "models"))}, failure => {console.error(failure); clearInterval(hold); process.exitCode = 2}, ${JSON.stringify(pathToFileURL(join(root, "entry.js")).href)});
    `);
    const result = execFileSync(process.execPath, [entry], { env: commandEnv(), encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
    expect(result.trim()).toBe("survived");
    const pid = Number(readFileSync(join(root, "provider.pid"), "utf8"));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return process.platform === "win32" || !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
      } catch { return false; }
    };
    const deadline = Date.now() + 1500;
    while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(alive(), `orphan provider ${pid} after host ${mode}`).toBe(false);
  }
});
