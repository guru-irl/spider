import { afterEach, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { commandEnv, paths } from "@spider/db-core";

const roots: string[] = [];
const processes = new Set<number>();
function kill(pid: number | undefined) {
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}
afterEach(() => {
  for (const pid of processes) kill(pid);
  processes.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    if (process.platform !== "win32") return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
    return true;
  } catch { return false; }
}
async function waitUntil(test: () => boolean, bound: number): Promise<boolean> {
  const deadline = Date.now() + bound;
  while (!test() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  return test();
}
function host(mode: string): { child: ChildProcess; output: () => string } {
  const root = join(paths.globalRoot, `orphan-${randomUUID()}`); roots.push(root);
  const provider = join(root, "node_modules", "fastembed"); mkdirSync(provider, { recursive: true });
  writeFileSync(join(provider, "index.js"), `
    exports.EmbeddingModel = {BGESmallENV15: 'fixture'};
    exports.FlagEmbedding = {async init() {
      process.send({type: 'phase', pid: process.pid});
      if (${JSON.stringify(mode)} === 'disconnected') Object.defineProperty(process, 'connected', {value: false});
      if (${JSON.stringify(mode)} === 'disconnect-event') process.emit('disconnect');
      if (['download', 'disconnected', 'disconnect-event'].includes(${JSON.stringify(mode)})) await new Promise(resolve => setTimeout(resolve, 20000));
      if (${JSON.stringify(mode)} === 'load') { const until = Date.now() + 20000; while (Date.now() < until) {} }
      return {async *embed() {await new Promise(resolve => setTimeout(resolve, 200)); yield [Float32Array.from([42, ...Array(383).fill(0)])]}};
    }};
  `);
  const preload = join(root, "watchdog-failure.cjs");
  writeFileSync(preload, `
    const threads = require('node:worker_threads');
    const Worker = threads.Worker;
    threads.Worker = class extends Worker {
      constructor() {
        if (${JSON.stringify(mode)} === 'watchdog-throw') throw new Error('watchdog fixture start failure');
        super("throw new Error('watchdog fixture async failure')", {eval: true});
      }
    };
  `);
  const entry = join(root, "host.mjs");
  writeFileSync(entry, `
    import * as cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const {ChildProcess} = cp;
    if (${JSON.stringify(mode)}.startsWith('watchdog-')) {
      const spawn = cp.default.spawn;
      cp.default.spawn = (exe, args, options) => spawn(exe, ['--require', ${JSON.stringify(preload)}, ...args], options);
      syncBuiltinESMExports();
    }
    const {createWorkerEmbedder} = await import(${JSON.stringify(new URL("../embeddings/worker.ts", import.meta.url).href)});
    const emit = ChildProcess.prototype.emit;
    ChildProcess.prototype.emit = function(event, msg, ...rest) {
      if (event === 'message' && msg?.type === 'phase') console.log('provider=' + msg.pid);
      return emit.call(this, event, msg, ...rest);
    };
    const hold = setInterval(() => {}, 1000);
    const worker = await createWorkerEmbedder(${JSON.stringify(join(root, "models"))}, f => console.error(f.error), ${JSON.stringify(pathToFileURL(join(root, "entry.js")).href)}, message => console.log('diagnostic=' + message));
    if (!worker) { clearInterval(hold); console.log('unavailable'); }
    if (worker && (${JSON.stringify(mode)} === 'inflight' || ${JSON.stringify(mode)}.startsWith('watchdog-'))) {
      if (${JSON.stringify(mode)} === 'inflight') clearInterval(hold);
      console.log('vector=' + (await worker.embed(['query']))[0][0]);
      if (${JSON.stringify(mode)}.startsWith('watchdog-')) console.log('vector2=' + (await worker.embed(['query']))[0][0]);
      await worker.stop();
      clearInterval(hold);
    }
  `);
  const child = spawn(process.execPath, [entry], { env: commandEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
  if (typeof child.pid === "number" && Number.isInteger(child.pid) && child.pid > 0) processes.add(child.pid);
  let output = ""; child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
  return { child, output: () => output };
}
it.each(["download", "load"])("SIGKILL of the parent during %s leaves no live provider within 2 seconds", async mode => {
  const { child, output } = host(mode);
  expect(await waitUntil(() => /provider=\d+/.test(output()), 5000), output()).toBe(true);
  const pid = Number(output().match(/provider=(\d+)/)![1]); processes.add(pid);
  const exited = new Promise(resolve => child.once("exit", resolve));
  const start = Date.now(); kill(child.pid); await exited;
  expect(await waitUntil(() => !alive(pid), 1900), `orphan pid ${pid} after ${Date.now() - start} ms`).toBe(true);
  expect(Date.now() - start).toBeLessThan(2000);
  console.info(`parent SIGKILL during ${mode}: provider gone in ${Date.now() - start} ms`);
});
it.each([
  ["disconnected", "a false process.connected exits pending downloads without a disconnect event"],
  ["disconnect-event", "a disconnect event exits pending downloads while process.connected is still true"],
])("%s: %s", async mode => {
  const { child, output } = host(mode);
  expect(await waitUntil(() => /provider=\d+/.test(output()), 5000), output()).toBe(true);
  const pid = Number(output().match(/provider=(\d+)/)![1]); processes.add(pid);
  const start = Date.now();
  expect(await waitUntil(() => child.exitCode !== null, 1900), output()).toBe(true);
  expect(child.exitCode, output()).toBe(0); expect(output()).toContain("unavailable");
  expect(await waitUntil(() => !alive(pid), 100)).toBe(true);
  expect(Date.now() - start).toBeLessThan(2000);
});
it.each(["watchdog-throw", "watchdog-error"])("%s keeps the embedder available and logs once", async mode => {
  const { child, output } = host(mode);
  const code = await new Promise(resolve => child.once("exit", resolve));
  const pid = Number(output().match(/provider=(\d+)/)?.[1]); if (pid > 0) processes.add(pid);
  expect(code, output()).toBe(0);
  expect(output()).toContain("vector=42"); expect(output()).toContain("vector2=42");
  expect(output().split('\n')).not.toContain("unavailable");
  expect(output().split('\n').filter(line => line.startsWith('diagnostic=') && line.includes('watchdog'))).toHaveLength(1);
  expect(await waitUntil(() => !alive(pid), 1000)).toBe(true);
});
it("an in-flight embed keeps a host without other handles alive until the reply", async () => {
  const { child, output } = host("inflight");
  const code = await new Promise(resolve => child.once("exit", resolve));
  expect(code, output()).toBe(0); expect(output()).toContain("vector=42");
  const pid = Number(output().match(/provider=(\d+)/)![1]); processes.add(pid);
  expect(await waitUntil(() => !alive(pid), 1000)).toBe(true);
});
