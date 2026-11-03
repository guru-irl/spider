import { prepareDashboardBuild } from "./fixtures/dashboard-build.js";
import { createFixtureHerdr } from "./fixtures/herdr-assets.js";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { createCandidateHistory } from "./fixtures/candidate-history.js";
import { Worker } from "node:worker_threads";
import type { UsageWorkerEvent } from "../protocol.js";
import { USAGE_WORKER_RESOURCE_LIMITS } from "../runtime.js";
const require = createRequire(import.meta.url);
const { extensionShim } = require("../../../../../scripts/extension-shim.mjs");
const children = new Set<ChildProcess>(), dirs: string[] = [];
const run = promisify(execFile);
let buildRoot: string, built: string;
beforeAll(async () => {
  const scratch = resolve(".spider/scratch");
  mkdirSync(scratch, { recursive: true });
  buildRoot = mkdtempSync(join(scratch, "worker-bundle-build-"));
  const outDir = join(buildRoot, "dist");
  built = join(outDir, "extension.js");
  const options = { timeout: 60_000, killSignal: "SIGKILL" as const, maxBuffer: 10 * 1024 * 1024 };
  // Use the real repo config, but never read or overwrite the checkout's dist.
  await run(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "build", "--outDir", outDir], options);
  await run(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "build", "--config", prepareDashboardBuild(buildRoot)], options);
  createFixtureHerdr(buildRoot);
  // The real post-build gate resolves dist relative to cwd, including its native import.
  await run(process.execPath, [resolve("scripts/assert-bundle.mjs")], { ...options, cwd: buildRoot });
}, 150_000);
afterAll(() => { if (buildRoot) rmSync(buildRoot, { recursive: true, force: true }); });
afterEach(() => { for (const p of children) p.kill("SIGKILL"); children.clear(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });
it("finishes event-history ingestion within the worker heap budget", async () => {
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "event-history-")); dirs.push(root);
  const projectDb = join(root, "events.db"), registryDb = join(root, "registry.db");
  const registry = new Database(registryDb);
  registry.exec("CREATE TABLE projects(project_key TEXT,db_path TEXT)");
  registry.prepare("INSERT INTO projects VALUES (?,?)").run(root, projectDb); registry.close();
  const db = new Database(projectDb);
  // Adding a default after insertion supplies padding at read time, not per row.
  db.exec("CREATE TABLE runs(id TEXT); INSERT INTO runs VALUES ('child'); CREATE TABLE run_events(id INTEGER PRIMARY KEY,run_id TEXT,ts INTEGER,type TEXT)");
  const insert = db.prepare("INSERT INTO run_events VALUES (?,'child',1,'spider_usage')");
  db.transaction(() => { for (let id = 1; id <= 10000; id++) insert.run(id); })();
  const payload = JSON.stringify({ provider: "fixture", model: "fixture-model", padding: "x".repeat(32768) });
  db.exec(`ALTER TABLE run_events ADD COLUMN payload TEXT DEFAULT '${payload}'`);
  db.prepare("INSERT INTO run_events VALUES (10001,'child',1,'spider_usage',?)").run(JSON.stringify({ purpose: "learner", provider: "fixture", model: "fixture-model",
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } })); db.close();
  const worker = new Worker(built, {
    workerData: { spiderUsageWorker: 1, command: { type: "start", owner: `${process.pid}:history`, child: false, poll: false,
      roots: { registryDb, sessionsDir: join(root, "sessions"), ledgerFile: join(root, "usage.db"),
        authPath: join(root, "absent-auth.json"), leaseDir: join(root, "leases") } } },
    resourceLimits: USAGE_WORKER_RESOURCE_LIMITS, execArgv: [],
  });
  try {
    const result = await new Promise<string | { backfill: string; calls: number }>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("event history deadline")), 20000);
      worker.on("error", error => { clearTimeout(deadline); resolve((error as NodeJS.ErrnoException).code ?? "worker-error"); });
      worker.on("message", (event: UsageWorkerEvent) => {
        if (event.type === "error") { clearTimeout(deadline); resolve(event.code); }
        if (event.type === "snapshot" && event.backfill === "complete") { clearTimeout(deadline); resolve({ backfill: event.backfill, calls: event.health.calls }); }
      });
    });
    expect(result).toEqual({ backfill: "complete", calls: 1 });
    expect(statSync(projectDb).size).toBeLessThan(1024 * 1024);
  } finally { worker.postMessage({ type: "stop" }); await worker.terminate(); }
});
it("finishes missing-transcript discovery for two hundred thousand candidates within the worker budget", async () => {
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "candidate-history-")); dirs.push(root);
  const roots = createCandidateHistory(root);
  const worker = new Worker(built, {
    workerData: { spiderUsageWorker: 1, command: { type: "start", owner: `${process.pid}:candidates`, child: false, poll: false, roots } },
    resourceLimits: USAGE_WORKER_RESOURCE_LIMITS, execArgv: [],
  });
  try {
    const result = await new Promise<string | number>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("candidate history deadline")), 20000);
      worker.on("error", error => { clearTimeout(deadline); resolve((error as NodeJS.ErrnoException).code ?? "worker-error"); });
      worker.on("message", (event: UsageWorkerEvent) => {
        if (event.type === "error") { clearTimeout(deadline); resolve(event.code); }
        if (event.type === "snapshot" && event.backfill === "complete") { clearTimeout(deadline); resolve(event.health.sourceErrors); }
      });
    });
    expect(result).toBe(2001);
  } finally { worker.postMessage({ type: "stop" }); await worker.terminate(); }
});
it.each(["direct", "shim", "oom", "contended"])("fresh single-file bundle through %s keeps pi alive and owns its workers", async mode => {
  const root = mkdtempSync(join(process.env.SPIDER_GLOBAL_ROOT!, "worker-bundle-")); dirs.push(root);
  mkdirSync(join(root, "packaged", "dist"), { recursive: true });
  const bundle = join(root, "packaged", "dist", "extension.js"); cpSync(built, bundle);
  for (const name of readdirSync(resolve("packages"))) {
    const poison = join(root, "packaged", "node_modules", "@spider", name);
    mkdirSync(poison, { recursive: true });
    writeFileSync(join(poison, "index.js"), 'throw new Error("fixture-workspace-dependency-forbidden");');
  }
  const shim = join(root, "spider.ts"); writeFileSync(shim, extensionShim(bundle));
  mkdirSync(join(root, "pi-agent"), { recursive: true }); mkdirSync(join(root, "sessions", "fixture"), { recursive: true });
  const registry = new Database(join(root, "registry.db")); registry.exec("CREATE TABLE projects(project_key TEXT, db_path TEXT)"); registry.close();
  const ts = "2026-10-04T12:00:00.000Z";
  writeFileSync(join(root, "sessions", "fixture", "session.jsonl"), [JSON.stringify({ type: "session", id: "fixture", timestamp: ts }), ...Array.from({ length: 40 }, (_, i) => JSON.stringify({ type: "message", id: `m${i}`, timestamp: ts, message: { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } }))].join("\n") + "\n");
  const env: NodeJS.ProcessEnv = { ...process.env, SPIDER_GLOBAL_ROOT: root, PI_CODING_AGENT_DIR: join(root, "pi-agent"), HOME: root };
  for (const name of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_DB_PATH", "PI_SPIDER_SESSION_ID", "NODE_OPTIONS"]) delete env[name];
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((res, rej) => {
    const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("./fixtures/no-network.mjs", import.meta.url)), fileURLToPath(new URL("./fixtures/bundle-smoke.mjs", import.meta.url)), mode, bundle, root, shim], { env, stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
    let stdout = "", stderr = "";
    child.stdout!.on("data", b => { stdout += b; }); child.stderr!.on("data", b => { stderr += b; });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); rej(new Error(`bundle smoke deadline\n${stderr}\n${stdout}`)); }, 25000);
    child.on("error", error => { clearTimeout(timeout); rej(error); });
    child.on("exit", code => { clearTimeout(timeout); children.delete(child); res({ code, stdout, stderr }); });
  });
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject(mode === "oom"
    ? { mode, parentSurvived: true, ledgerSurvived: true, errorCode: "usage-worker-oom" }
    : { mode, workers: 2, calls: 40, liveCalls: 42, ownerBackfills: 1, readOnlyCounter: true, takeover: true, inertImport: true, stopped: true });
});
