import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
const [mode, bundle, root, shim] = process.argv.slice(2);
const roots = { registryDb: join(root, "registry.db"), sessionsDir: join(root, "sessions"), ledgerFile: join(root, "usage.db"), authPath: join(root, "missing-auth.json"), leaseDir: join(root, "leases") };
// Trap actual main-thread fixture I/O and DB calls, not just file creation.
// The worker has a separate module realm, so its authorized backfill is untracked.
const accesses = [];
const sensitive = path => typeof path === "string" && [roots.sessionsDir, roots.registryDb, roots.ledgerFile, roots.authPath].some(prefix => path.startsWith(prefix));
const restores = [];
for (const [api, names] of [[fs, ["openSync", "readFileSync", "statSync", "existsSync", "mkdirSync"]], [fs.promises, ["open", "readFile", "stat", "readdir", "mkdir"]]]) {
  for (const name of names) {
    const original = api[name];
    api[name] = function(path, ...args) { if (sensitive(path)) accesses.push(`fs:${name}`); return original.call(this, path, ...args); };
    restores.push(() => { api[name] = original; });
  }
}
for (const name of ["prepare", "exec", "pragma"]) {
  const original = Database.prototype[name];
  Database.prototype[name] = function(...args) { accesses.push(`db:${name}`); return original.apply(this, args); };
  restores.push(() => { Database.prototype[name] = original; });
}
syncBuiltinESMExports();
// Positive controls prove both traps fire before the import under test.
fs.existsSync(roots.ledgerFile);
const control = new Database(":memory:");
try { control.prepare("SELECT 1").get(); } finally { control.close(); }
assert(accesses.some(a => a.startsWith("fs:")) && accesses.some(a => a.startsWith("db:")), "inert-import traps must be active");
accesses.length = 0;
const url = pathToFileURL(bundle);
if (mode === "shim") {
  const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");
  const loaded = await discoverAndLoadExtensions([shim], root, process.env.PI_CODING_AGENT_DIR);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const stat = statSync(bundle, { bigint: true });
  url.searchParams.set("build", stat.mtimeNs.toString() + "-" + stat.size.toString());
}
const mod = await import(url.href);
assert.deepEqual(accesses, [], "import/registration touched fixture filesystem or SQLite on the main thread");
for (const restore of restores) restore();
syncBuiltinESMExports();
assert.equal(typeof mod.default, "function");
assert.equal(existsSync(roots.ledgerFile), false, "import/registration must be inert");
assert.equal(typeof mod.UsageRuntime, "function", "packaged usage runtime missing");
assert.equal(fileURLToPath(mod.loadedBundle.url), bundle);
assert.equal(mod.loadedBundle.url, url.href, "use the loaded native bundle, not the shim or source URL");
if (mode === "oom") {
  let worker, exited;
  const runtime = new mod.UsageRuntime({ bundleUrl: mod.loadedBundle.url, roots, child: false, workerFactory: (_entry, options) => {
    worker = new Worker(new URL("./oom-worker.mjs", import.meta.url), { ...options, workerData: { ...options.workerData, fixtureBundle: mod.loadedBundle.url }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 4 } });
    exited = new Promise(resolve => worker.once("exit", resolve));
    return worker;
  } });
  const deadline = setTimeout(() => { throw new Error("OOM fixture deadline"); }, 10000);
  try {
    runtime.start(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    await exited;
    assert.equal(runtime.snapshot().errorCode, "usage-worker-oom");
    assert.equal(existsSync(roots.ledgerFile), true, "OOM happened after the usage worker opened SQLite");
    const recovered = new Database(roots.ledgerFile);
    try { assert.equal(recovered.pragma("integrity_check", { simple: true }), "ok"); }
    finally { recovered.close(); }
    console.log(JSON.stringify({ mode, parentSurvived: true, ledgerSurvived: true, errorCode: runtime.snapshot().errorCode }));
  } finally { clearTimeout(deadline); await runtime.stop(); }
  process.exit(0);
}
const workers = [], runtimes = [], snapshots = [[], []], readers = new Set();
const factory = (entry, options) => {
  assert.equal(entry.href, mod.loadedBundle.url);
  const worker = new Worker(entry, { ...options, execArgv: ["--import", new URL("./worker-probe.mjs", import.meta.url).href] });
  worker.on("message", event => { if (event?.type === "fixture-source-read") readers.add(worker); });
  workers.push(worker);
  return worker;
};
const waiters = new Map();
const wait = (index, predicate) => new Promise((resolve, reject) => {
  const deadline = setTimeout(() => { waiters.delete(index); reject(new Error("live snapshot deadline")); }, 10000);
  waiters.set(index, state => {
    if (state.errorCode) { clearTimeout(deadline); waiters.delete(index); reject(new Error(state.errorCode)); }
    else if (predicate(state)) { clearTimeout(deadline); waiters.delete(index); resolve(state); }
  });
});
try {
  // Both controllers start before either worker gets a chance to claim the lease.
  const ready = [];
  for (let i = 0; i < 2; i++) {
    let notify;
    const readyPromise = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("backfill deadline")), 20000);
      notify = state => {
        snapshots[i].push(state);
        waiters.get(i)?.(state);
        if (state.errorCode) { clearTimeout(deadline); reject(new Error(state.errorCode)); }
        else if (state.backfill === "complete" && state.health?.calls === 40) { clearTimeout(deadline); resolve(state); }
      };
    });
    const runtime = new mod.UsageRuntime({ bundleUrl: mod.loadedBundle.url, roots, child: false, workerFactory: factory, onSnapshot: notify });
    runtimes.push(runtime); ready.push(readyPromise); runtime.start(false);
    assert.equal(workers.length, 0, "startup must defer resource creation");
  }
  const states = await Promise.all(ready);
  assert.equal(states[0].counter.availability, "disabled");
  assert.equal(states[1].counter.availability, "disabled");
  assert.equal(readers.size, 1, "exactly one ingest owner reads/backfills transcripts");
  const db = new Database(roots.ledgerFile, { readonly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calls").get().n, 40);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leases WHERE name='ingest' AND owner IS NOT NULL").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leases WHERE name='counter'").get().n, 0);
  } finally { db.close(); }
  const owner = workers.findIndex(w => readers.has(w)), follower = 1 - owner;
  const writer = new Database(roots.ledgerFile);
  try { writer.prepare("INSERT INTO counter_snapshots(ts,account_login,credits_used,raw) VALUES (?,?,?,?)").run(Date.now(), "fixture-account", 4, JSON.stringify({ secret: "fixture-private" })); }
  finally { writer.close(); }
  const counterReady = wait(follower, s => s.counter?.availability === "available" && s.counter?.latest?.creditsUsed === 4);
  runtimes[follower].configure(true);
  const counterState = await counterReady;
  assert.equal(counterState.counter.role, "follower");
  assert.deepEqual(counterState.counter.latest.raw, {});
  assert.equal(counterState.counter.latest.accountLogin, undefined);
  const check = new Database(roots.ledgerFile, { readonly: true });
  try { assert.equal(check.prepare("SELECT COUNT(*) AS n FROM leases WHERE name='counter'").get().n, 0); }
  finally { check.close(); }
  const disabled = wait(follower, s => s.counter?.availability === "disabled");
  runtimes[follower].configure(false); await disabled;
  const source = join(root, "sessions", "fixture", "session.jsonl");
  const append = id => appendFileSync(source, JSON.stringify({ type: "message", id, timestamp: "2026-10-04T12:01:00Z", message: { role: "assistant", provider: "github-copilot", model: "gpt-6.1-sol", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } }) + "\n");
  append("live");
  let readyLive = wait(follower, s => s.health?.calls === 40);
  runtimes[follower].refresh(); await readyLive;
  assert.equal(readers.size, 1, "follower must not scan live sources");
  readyLive = wait(owner, s => s.health?.calls === 41);
  for (let i = 0; i < 100; i++) runtimes[owner].refresh();
  await readyLive;
  readyLive = wait(follower, s => s.health?.calls === 41);
  runtimes[follower].refresh(); await readyLive;
  await runtimes[owner].stop();
  append("takeover");
  readyLive = wait(follower, s => s.health?.calls === 42);
  runtimes[follower].refresh(); await readyLive;
  assert.equal(readers.size, 2, "follower takes over after ingest owner stops");
  await Promise.all(runtimes.map(r => r.stop()));
  assert(workers.every(w => w.threadId === -1), "no live fixture workers after shutdown");
  console.log(JSON.stringify({ mode, workers: workers.length, calls: 40, liveCalls: 42, ownerBackfills: 1, readOnlyCounter: true, takeover: true, inertImport: true, stopped: true }));
} finally {
  await Promise.all(runtimes.map(r => r.stop()));
  await Promise.all(workers.map(w => w.terminate()));
}
