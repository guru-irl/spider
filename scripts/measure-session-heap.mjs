// Run one process at a time, with --expose-gc --max-old-space-size=1536.
// Outputs sampled heap (bytes), process high-water RSS (KiB), and work counts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";

const [moduleFile, rootArg, mode = "drain", repeatsArg = "8"] = process.argv.slice(2);
if (!moduleFile || !rootArg || moduleFile === "--help") {
  console.log(`Usage:
  node --max-old-space-size=1536 scripts/measure-session-heap.mjs build <bundle.mjs> [git-revision]
  node --expose-gc --max-old-space-size=1536 scripts/measure-session-heap.mjs <bundle.mjs> <fixture-dir> <mode> [repeats]

Modes: generate, drain, lifecycle, pipeline, tailer, tail, feed, cleanup.
Generate creates a ~120 MiB pi JSONL and matching synthetic run database.
Every measurement opens only that generated session. No live pi APIs or LLMs.
Build accepts an optional revision for comparisons with the same source layout.
Cleanup removes only the generated fixture and databases, not probe bundles.`);
  process.exit(moduleFile === "--help" ? 0 : 1);
}
assert(getHeapStatistics().heap_size_limit < 2 * 1024 ** 3, "Use --max-old-space-size=1536 to stay below a 2 GiB heap");

if (moduleFile === "build") {
  const { build } = await import("vite");
  const output = resolve(rootArg), checkout = process.cwd();
  const revision = process.argv[4];
  // Read only source objects, never histories or runtime state. Package paths
  // must still exist in this checkout; this is not a general worktree builder.
  const sourceAtRevision = revision ? {
    name: "heap-probe-reference-source",
    enforce: "pre",
    load(id) {
      const path = relative(checkout, id.split("?")[0]).split(sep).join("/");
      if (!path.startsWith("packages/") || !/\.[cm]?[jt]s$/.test(path)) return null;
      return execFileSync("git", ["show", `${revision}:${path}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    },
  } : null;
  await build({
    logLevel: "warn",
    plugins: sourceAtRevision ? [sourceAtRevision] : [],
    build: { ssr: "scripts/session-heap-probe.ts", emptyOutDir: false, outDir: dirname(output),
      rollupOptions: { output: { entryFileNames: basename(output) } } },
  });
  console.log(JSON.stringify({ bundle: output, revision: revision ?? "working-tree" }));
  process.exit(0);
}

const root = resolve(rootArg), marker = join(root, ".session-heap-fixture");
const fixture = join(root, "session.jsonl"), dbPath = join(root, "worktree.db");
const markerValue = "spider-synthetic-session-heap-v1\n";
const modes = new Set(["generate", "drain", "lifecycle", "pipeline", "tailer", "tail", "feed", "cleanup"]);
assert(modes.has(mode), `Unknown mode: ${mode}`);
const repeats = Number(repeatsArg);
assert(Number.isInteger(repeats) && repeats > 0 && repeats <= 10000, "Invalid repeat count");
if (mode === "generate") {
  assert(!existsSync(fixture) && !existsSync(dbPath) && !existsSync(marker), "Refusing to overwrite an existing fixture");
  mkdirSync(root, { recursive: true });
} else {
  assert.equal(readFileSync(marker, "utf8"), markerValue, "Not a generated heap fixture");
}
if (mode === "cleanup") {
  rmSync(fixture);
  const databases = readdirSync(root).filter(name => /^(?:lifecycle|repo|global|pipelines)-\d+\.db$/.test(name));
  for (const name of ["worktree.db", "approval.db", ...databases]) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(root, name + suffix), { force: true });
  }
  rmSync(marker);
  console.log(JSON.stringify({ mode, removed: true }));
  process.exit(0);
}
Object.assign(process.env, {
  SPIDER_GLOBAL_ROOT: join(root, "global"), PI_CODING_AGENT_DIR: join(root, "agent"),
  SPIDER_TEST_FIXTURE_CHECKOUT: process.cwd(),
});
for (const name of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUN_ID", "PI_SPIDER_DB_PATH", "PI_SPIDER_SESSION_ID"]) delete process.env[name];
const moduleSha = createHash("sha256").update(readFileSync(resolve(moduleFile))).digest("hex");
const api = await import(pathToFileURL(resolve(moduleFile)).href);
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const sessionId = "synthetic-heap-session";
// Flatten the string: shared ropes would understate retention per dispatch.
const text = (n, size) => Buffer.from((`synthetic-${n} verified build output and review findings. `).repeat(Math.ceil(size / 40)).slice(0, size)).toString();
const usage = { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, totalTokens: 130,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
if (mode === "generate") {
  const db = api.openDbAt(dbPath, "worktree"), fd = openSync(fixture, "wx");
  let bytes = 0, seq = 0, parentId = null, runs = 0;
  const write = entry => { const line = JSON.stringify(entry) + "\n"; writeSync(fd, line); bytes += Buffer.byteLength(line); };
  const append = entry => {
    const id = (++seq).toString(16).padStart(8, "0");
    write({ ...entry, id, parentId, timestamp: new Date(seq * 1000).toISOString() });
    parentId = id;
    return id;
  };
  write({ type: "session", version: 3, id: sessionId, timestamp: new Date(0).toISOString(), cwd: root });
  db.prepare("INSERT INTO sessions(id,started_at) VALUES (?,?)").run(sessionId, 1);
  const run = db.prepare("INSERT INTO runs(id,session_id,agent,status,task,result,started_at,ended_at,step_count,token_count) VALUES (?,?,'worker','done',?,?,?,?,4,130)");
  const event = db.prepare("INSERT INTO run_events(run_id,session_id,ts,type,summary,payload) VALUES (?,?,?,'message',?,?)");
  const activity = db.prepare("INSERT INTO events(session_id,ts,phase,tool,description,payload) VALUES (?,?,'after','edit',?,?)");
  try {
    db.transaction(() => {
      while (bytes < 120 * 1024 * 1024) {
        const id = `run-${runs}`, result = text(runs, 12288), task = text(runs, 2048), now = Date.now();
        const userId = append({ type: "message", message: { role: "user", content: task, timestamp: seq * 1000 } });
        append({ type: "message", message: { role: "assistant", content: [
          { type: "thinking", thinking: text(runs, 2048) }, { type: "text", text: text(runs, 4096) },
          { type: "toolCall", id: `tool-${runs}`, name: "spider", arguments: { action: "exec", language: "shell", code: "printf synthetic" } },
        ], provider: "synthetic", api: "anthropic-messages", model: "fixture", usage, stopReason: "toolUse", timestamp: seq * 1000 } });
        append({ type: "message", message: { role: "toolResult", toolCallId: `tool-${runs}`, toolName: "spider",
          content: [{ type: "text", text: text(runs, 96 * 1024) }], details: { exitCode: 0 }, isError: false, timestamp: seq * 1000 } });
        append({ type: "custom_message", customType: "spider.subagent_done", content: result,
          details: { runId: id, output: result, status: "done" }, display: true });
        append({ type: "usage", kind: "subagent", provider: "synthetic", model: "fixture", usage, note: id });
        if ((runs + 1) % 100 === 0) append({ type: "compaction", summary: `Synthetic checkpoint ${runs}`, firstKeptEntryId: userId, tokensBefore: 1000 });
        run.run(id, sessionId, task, result, now - 1000, now);
        for (let j = 0; j < 4; j++) event.run(id, sessionId, now + j, result, JSON.stringify({ text: result, stopReason: "stop" }));
        activity.run(sessionId, now, `checked synthetic marker ${runs}`, JSON.stringify({ toolCallId: `tool-${runs}`, note: text(runs, 1024) }));
        runs++;
      }
    })();
  } finally { closeSync(fd); db.close(); }
  writeFileSync(marker, markerValue, { flag: "wx" });
  console.log(JSON.stringify({ mode, bytes, runs, entries: seq, dbBytes: statSync(dbPath).size }));
  process.exit(0);
}
assert.equal(typeof global.gc, "function", "Use --expose-gc");
const gc = () => { global.gc(); global.gc(); };
const manager = SessionManager.open(fixture), entryCount = manager.getEntries().length;
assert(entryCount > 1000);
let peak = 0;
const sample = () => { const heap = process.memoryUsage().heapUsed; peak = Math.max(peak, heap); return heap; };
gc();
const before = sample(), heaps = [];
let work, cleanup = () => {};
if (mode === "drain") {
  const db = api.openDbAt(dbPath, "worktree");
  for (let i = 0; i < repeats; i++) {
    let bundle = api.drainSession(db, sessionId, "before_compact", { transcript: [] });
    sample();
    work = { runs: bundle.runs.length, runEvents: bundle.runEvents.length, events: bundle.events.length,
      todos: bundle.todos.length, lastEvent: bundle.events.at(-1)?.description };
    gc(); work.heldHeap = sample(); bundle = null; gc(); heaps.push(sample());
  }
  db.close();
} else if (mode === "lifecycle") {
  const lifecyclePath = join(root, `lifecycle-${process.pid}.db`), repoPath = join(root, `repo-${process.pid}.db`), globalPath = join(root, `global-${process.pid}.db`);
  copyFileSync(dbPath, lifecyclePath);
  const db = api.openDbAt(lifecyclePath, "worktree"), repoDb = api.openDbAt(repoPath, "repo"), globalDb = api.openDbAt(globalPath, "global");
  let calls = 0;
  const reports = [];
  const worker = new api.OrganismWorker({ db: repoDb, worktreeDb: db, globalDb,
    project: { projectKey: "synthetic", cwd: root }, getEmbedder: async () => null,
    makeModel: () => ({ complete: async () => { calls++; sample(); return '{"memory":[],"skills":[],"todos":[]}'; } }),
    org: { ...api.ORGANISM_DEFAULTS, selfNaming: false, autoWriteBudget: 0,
      passes: { runMemoryTodo: true, todoMemory: false, learning: true, consolidation: true, reflection: false, insights: false } },
    curator: api.CURATOR_DEFAULTS, onDrainReport: report => reports.push(report),
  });
  const hooks = {}, pi = { on: (name, fn) => { hooks[name] = fn; } };
  api.registerOrganism(null, pi, () => worker, (_phase, error) => { throw error; });
  const ctx = { sessionManager: manager };
  hooks.session_start({}, ctx);
  for (let i = 0; i < repeats; i++) {
    hooks.session_before_compact({ branchEntries: manager.getBranch() }, ctx);
    await worker.pause(); worker.resume(); sample(); gc(); heaps.push(sample());
  }
  await hooks.session_shutdown({ reason: "quit" }, ctx);
  await worker.stopSkillReviews();
  assert.equal(reports.length, repeats + 1, "A lifecycle hook failed to drain");
  assert(reports.every(report => report.status === "completed"), JSON.stringify(reports.map(report => report.errors)));
  work = { calls, drains: reports.length, lastInputs: reports.at(-1)?.inputs };
  db.close(); repoDb.close(); globalDb.close();
  for (const file of [lifecyclePath, repoPath, globalPath]) for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
} else if (mode === "pipeline") {
  const path = join(root, `pipelines-${process.pid}.db`), db = api.openDbAt(path, "worktree");
  const store = new api.RunStore(db), tailer = new api.RunEventTailer(db);
  const coords = { tailer, pipelines: [], children: new Map() };
  let current;
  // Replace only execution; dispatch, pipeline advancement, DB state and bus are real.
  const handler = api.makeRunHandler({ getCoordinators: () => coords, makeRunner: () => ({ runAsync(opts) {
    const { id } = store.create({ sessionId, agent: opts.agent, task: opts.task, parentRunId: opts.parentRunId });
    store.start(id); current = id; return store.get(id);
  } }) });
  globalThis.heapProbeOwner = coords; // Model the live session registry, not a local's GC liveness.
  for (let i = 0; i < repeats; i++) {
    await handler({ pipeline: [{ agent: "worker", task: text(i, 64 * 1024) }, { agent: "reviewer", task: "Review {previous}" }] }, { db, sessionId, cwd: root, pi: {} });
    for (let j = 0; j < 2; j++) {
      store.finish(current, { status: "done", result: text(i, 64 * 1024) });
      api.bus.emit({ runId: current, sessionId, ts: Date.now(), type: "status", payload: { status: "done" } });
    }
    if ((i + 1) % 25 === 0) { sample(); gc(); heaps.push(sample()); }
  }
  work = { pipelinesRetained: coords.pipelines.length, runs: db.prepare("SELECT count(*) AS n FROM runs WHERE session_id=?").get(sessionId).n };
  cleanup = () => {
    for (const c of [...coords.pipelines]) c.dispose();
    delete globalThis.heapProbeOwner; db.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  };
} else if (mode === "tailer") {
  const db = api.openDbAt(dbPath, "worktree"), tailer = new api.RunEventTailer(db, { sinceId: 0 });
  const last = db.prepare("SELECT run_id FROM run_events ORDER BY id DESC LIMIT 1").get().run_id;
  const end = db.prepare("SELECT max(id) AS id FROM run_events").get().id;
  tailer.track(last);
  let observed = 0, polls = 0;
  const off = api.bus.on(event => { if (event.runId === last) observed++; });
  while (tailer.cursor < end) { tailer.poll(); polls++; sample(); gc(); heaps.push(sample()); assert(polls < 100); }
  off(); work = { polls, observed, cursor: tailer.cursor }; db.close();
} else if (mode === "tail") {
  const tail = new api.SessionTail(fixture);
  let entries = 0;
  for (let i = 0; i < repeats; i++) { const read = tail.read(); entries += read.entries.length; sample(); gc(); heaps.push(sample()); }
  work = { entries };
} else if (mode === "feed") {
  let now = Date.now();
  const source = api.createHerdrDataSource({
    resolveRunDb: () => ({ db: api.openDbAt(dbPath, "worktree"), dbPath }),
    openApprovalDbs: () => ({ global: api.openDbAt(join(root, "approval.db"), "global"), repo: null }),
    runEvents: { on: () => () => {} }, scheduler: { subscribe: () => () => {}, listTriggers: () => [] },
    readUsage: async () => ({ pace: { used: null, budget: null, projected: null, remaining: null, period: { start: 0, end: Number.MAX_SAFE_INTEGER } }, updatedAt: null }),
    readConfig: () => ({ limits: { completedHours: 24, completedRows: 100 } }), clock: () => now,
  });
  const owner = { sessionId, generation: "synthetic-generation", cwd: root, name: "synthetic", sessionFile: fixture,
    terminal: { address: "synthetic/1", coreId: "synthetic-core", terminalId: "1", socket: "/synthetic", sessionNamespace: "synthetic" } };
  try {
    for (let i = 0; i < repeats; i++) {
      now += 2001;
      let snapshot = await source.snapshot(owner); sample();
      work = { rows: snapshot.runs.rows.length, total: snapshot.runs.total };
      snapshot = null; gc(); heaps.push(sample());
    }
  } finally { source.dispose(); }
}
gc();
const after = sample();
assert.equal(manager.getEntries().length, entryCount);
console.log(JSON.stringify({ mode, repeats, node: process.version, pid: process.pid, moduleSha, sessionBytes: statSync(fixture).size,
  entryCount, before, after, settledDelta: after - before, peak, peakDelta: peak - before,
  heaps, maxRss: process.resourceUsage().maxRSS, work }));
cleanup();
