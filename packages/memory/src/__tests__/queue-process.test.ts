import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";
import { openDbAt, paths, commandEnv, type Db } from "@spider/db-core";
import { addMemory } from "../store";
import { drainEmbedQueue } from "../embeddings/queue";

let root: string, db: Db;
const children: ChildProcess[] = [];
const exits = new Map<ChildProcess, Promise<void>>();
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exits.get(child); }
  exits.clear(); db?.close(); if (root) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = join(paths.globalRoot, `queue-process-${randomUUID()}`); mkdirSync(root);
  db = openDbAt(join(root, "fixture.db"), "repo");
  addMemory(db, "repo", { category: "insight", content: "fixture" });
}
function child(script: string) {
  const env = commandEnv();
  for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_DB_PATH", "PI_SPIDER_SESSION_ID"]) delete env[key];
  const process = spawn(globalThis.process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe", "ipc"] });
  children.push(process); exits.set(process, new Promise(resolve => process.once("exit", () => resolve())));
  return process;
}
function message(process: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: unknown) => { cleanup(); resolve(String(value)); };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`fixture exited before reply (${code})`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("fixture reply timed out")); }, 3000);
    const cleanup = () => { clearTimeout(timer); process.off("message", onMessage); process.off("exit", onExit); };
    process.once("message", onMessage); process.once("exit", onExit);
  });
}
async function runner(pauseReclaim = false): Promise<string> {
  const entry = join(root, "race.ts"), bundle = join(root, "race.mjs");
  writeFileSync(entry, `
    import { openDbAt } from ${JSON.stringify(new URL("../../../db-core/src/index.ts", import.meta.url).pathname)};
    import { drainEmbedQueue } from ${JSON.stringify(new URL("../embeddings/queue.ts", import.meta.url).pathname)};
    const db = openDbAt(${JSON.stringify(db.raw.name)}, 'repo');
    const next = () => new Promise(resolve => process.once('message', resolve));
    process.send('ready'); await next();
    const drained = await drainEmbedQueue(db, {model:'fixture', dim:384, async embed(texts) {
      process.send('inference'); await next(); return texts.map(() => new Float32Array(384));
    }});
    process.send('drained:' + drained); db.close(); process.disconnect();
  `);
  const shim = join(root, "reclaim-fs.ts");
  if (pauseReclaim) writeFileSync(shim, `
    import * as fs from 'fs'; export * from 'fs';
    export function unlinkSync(path) {
      if (String(path).endsWith('.embed-lock') && Date.now() - fs.statSync(path).mtimeMs > 120000) {
        process.send('reclaiming'); fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      }
      fs.unlinkSync(path);
    }
  `);
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external",
    alias: { "@spider/db-core": new URL("../../../db-core/src/index.ts", import.meta.url).pathname, ...(pauseReclaim ? { "node:fs": shim } : {}) } });
  return bundle;
}
it("allows only one inference when two processes race to reclaim an expired live-pid lease", async () => {
  fixture();
  const lock = `${db.raw.name}.embed-lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "expired" })); utimesSync(lock, new Date(1), new Date(1));
  const bundle = await runner();
  const a = child(bundle), b = child(bundle);
  expect(await Promise.all([message(a), message(b)])).toEqual(["ready", "ready"]);
  const replies = [message(a), message(b)]; a.send("go"); b.send("go");
  const first = await Promise.all(replies);
  expect(first.sort()).toEqual(["drained:0", "inference"]);
  // The pid in the lease identifies the one process still doing inference.
  const { readFileSync } = await import("node:fs");
  const pid = JSON.parse(readFileSync(lock, "utf8")).pid;
  const holder = a.pid === pid ? a : b;
  const done = message(holder); holder.send("finish"); expect(await done).toBe("drained:1");
  await Promise.all([exits.get(a), exits.get(b)]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM vector_map").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM embed_queue").get()).toEqual({ n: 0 });
  expect(existsSync(lock)).toBe(false);
});
it("excludes a second process while the first pauses at stale-file reclamation", async () => {
  fixture(); const lock = `${db.raw.name}.embed-lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "expired" })); utimesSync(lock, new Date(1), new Date(1));
  const bundle = await runner(true); const a = child(bundle), b = child(bundle);
  expect(await Promise.all([message(a), message(b)])).toEqual(["ready", "ready"]);
  const reclaim = message(a); a.send("go"); expect(await reclaim).toBe("reclaiming");
  const blocked = message(b); b.send("go"); expect(await blocked).toBe("drained:0");
  const inference = message(a); a.stdin!.write("x"); expect(await inference).toBe("inference");
  const done = message(a); a.send("finish"); expect(await done).toBe("drained:1");
  await Promise.all([exits.get(a), exits.get(b)]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM vector_map").get()).toEqual({ n: 1 });
  expect(existsSync(lock)).toBe(false);
});
it("skips a three-second foreign write lock within 800ms and does not charge a retry", async () => {
  fixture(); const script = join(root, "busy.cjs");
  writeFileSync(script, `
    const {createRequire} = require('node:module');
    const Database = createRequire(${JSON.stringify(import.meta.url)})('better-sqlite3');
    const db = new Database(${JSON.stringify(db.raw.name)}); db.exec('BEGIN IMMEDIATE');
    process.send('locked'); setTimeout(() => { db.exec('ROLLBACK'); db.close(); process.disconnect(); }, 3000);
  `);
  const holder = child(script); expect(await message(holder)).toBe("locked");
  const before = performance.now();
  expect(await drainEmbedQueue(db, { model: "fixture", dim: 384, async embed(texts) { return texts.map(() => new Float32Array(384)); } })).toBe(0);
  expect(performance.now() - before).toBeLessThan(800);
  expect(db.prepare("SELECT tries FROM embed_queue").get()).toEqual({ tries: 0 });
  expect(existsSync(`${db.raw.name}.embed-lock`)).toBe(false);
});
