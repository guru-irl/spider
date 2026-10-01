import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { openDbAt, type Db } from "@spider/db-core";
import { RunStore } from "../run-store";
import { adoptReloadedChildren } from "../actions/run";
import { detachShared, disposeSessionRegistries, getShared, registerShared, resetSharedRegistryForTests, sweepDetachedOnExit } from "../child-registry";
import { detachForReload, getChild, teardownAll } from "../coordinators";
import { createEventGate } from "../rpc-child";

let root: string;
const dbs: Db[] = [];
beforeEach(() => {
  const base = resolve(".spider/scratch/reload-survival/tests-round3");
  mkdirSync(base, { recursive: true });
  root = mkdtempSync(join(base, "case-"));
  resetSharedRegistryForTests();
});
afterEach(() => {
  teardownAll(); resetSharedRegistryForTests(); vi.useRealTimers(); vi.restoreAllMocks();
  for (const db of dbs.splice(0)) db.close();
  rmSync(root, { recursive: true, force: true });
});
function database(name: string) {
  const path = join(root, name, "project.db");
  const db = openDbAt(path, "worktree"); dbs.push(db);
  return { path, db, store: new RunStore(db) };
}
function child(r: ReturnType<typeof database>) {
  const { id } = r.store.create({ sessionId: "s", agent: "worker", task: "t" }); r.store.start(id);
  let exit!: (v: { exitCode: number; result?: string }) => void;
  const done = new Promise<{ exitCode: number; result?: string }>(r => { exit = r; });
  const gate = createEventGate();
  registerShared({ runId: id, sessionId: "s", dbPath: r.path, mode: "rpc", survivable: true,
    handle: { wait: () => done, kill: () => {}, killAsync: async () => {}, bindEvents: gate.bind, unbindEvents: gate.unbind } });
  return { id, exit, gate };
}
const ctx = (r: ReturnType<typeof database>) => ({ db: r.db, runDbPath: r.path, cwd: root, sessionId: "s", ui: { notify: vi.fn() }, pi: { sendMessage: vi.fn() } });
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); };

it("m4: finalizing a removed DB never recreates its file or parent directories", async () => {
  const r = database("removed"); const c = child(r);
  await detachShared("s");
  r.db.close(); dbs.splice(dbs.indexOf(r.db), 1);
  rmSync(dirname(r.path), { recursive: true, force: true });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  sweepDetachedOnExit();
  expect(existsSync(dirname(r.path))).toBe(false);
  expect(existsSync(r.path)).toBe(false);
  expect(warning.mock.calls.flat().join(" ")).toContain(c.id);
});

it("M6: adoption uses the recorded run DB after the session resolves a different DB", async () => {
  const own = database("own"), other = database("new-binding"); const c = child(own);
  await detachShared("s");
  c.gate.report({ type: "warning", message: "gap diagnostic" });
  c.exit({ exitCode: 0, result: "own result" }); await tick();
  const next = ctx(other);
  expect(adoptReloadedChildren(next).adopted).toEqual([c.id]);
  await tick();
  expect(own.store.get(c.id)).toMatchObject({ status: "done", result: "own result" });
  expect(other.db.prepare("SELECT * FROM runs").all()).toEqual([]);
  expect(other.db.prepare("SELECT * FROM run_events").all()).toEqual([]);
  expect(own.db.prepare("SELECT summary FROM run_events WHERE run_id=? AND type='warning'").all(c.id)).toEqual([{ summary: "gap diagnostic" }]);
  expect(next.pi.sendMessage.mock.calls.filter(c => c[0].customType === "spider.subagent_done")).toHaveLength(1);
});

it("M6: the adopted kill handle cancels the recorded DB, not the newly resolved DB", async () => {
  const own = database("own"), other = database("new-binding"); const c = child(own);
  await detachShared("s");
  expect(adoptReloadedChildren(ctx(other)).adopted).toEqual([c.id]);
  await getChild("s", c.id)!.killAsync!(1, "killed after rebind");
  c.exit({ exitCode: 143 }); await tick();
  expect(own.store.get(c.id)).toMatchObject({ status: "cancelled", result: "killed after rebind" });
  expect(other.db.prepare("SELECT * FROM run_events").all()).toEqual([]);
});

it("M6: another reload closes the activation's adopted DB connection after parking its child", async () => {
  const own = database("own"), other = database("new-binding"); const c = child(own);
  await detachShared("s");
  const opened: Db[] = [];
  expect(adoptReloadedChildren(ctx(other), { makeStore: db => { opened.push(db); return new RunStore(db); } }).adopted).toEqual([c.id]);
  const adoptedDb = opened.find(db => db !== other.db)!;
  expect(adoptedDb.raw.open).toBe(true);
  await detachForReload("s");
  expect(getShared(c.id)?.state).toBe("detached");
  expect(adoptedDb.raw.open).toBe(false);
});

it("m3: a failed-adoption warning belongs to the run's own DB, not an orphan in the new DB", async () => {
  const own = database("own"), other = database("new-binding"); const c = child(own);
  await detachShared("s");
  getShared(c.id)!.handle.bindEvents = () => { throw new Error("rebind failed"); };
  const next = ctx(other);
  expect(adoptReloadedChildren(next).refused[0]?.reason).toMatch(/adoption failed/);
  expect(next.ui.notify).toHaveBeenCalled();
  const warnings = own.db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='warning'").all(c.id) as { payload: string }[];
  expect(warnings.map(w => JSON.parse(w.payload))).toEqual([expect.objectContaining({ adoptionFailed: true })]);
  expect(other.db.prepare("SELECT * FROM run_events").all()).toEqual([]);
});

const ownGroup = process.platform === "win32" ? undefined : Number(execFileSync("ps", ["-p", String(process.pid), "-o", "pgid="], { encoding: "utf8" }).trim());
it.each([0, 1, -1, -4242, process.pid, ownGroup, 1.5, Number.NaN, Infinity, "4242"])("n1: the exit sweep never signals unsafe pid %s even when identity matches", async pid => {
  const r = database("own"); const c = child(r);
  Object.assign(getShared(c.id)!, { pid, startTime: "recorded" });
  await detachShared("s");
  const kill = vi.fn();
  sweepDetachedOnExit({ kill, identity: () => true });
  expect(kill).not.toHaveBeenCalled();
  expect(r.store.get(c.id)?.status).toBe("cancelled");
});

it.each(["ttl", "quit", "exit", "finished"])("m2: %s finalization notes counts of undelivered steers and discarded buffered events", async mode => {
  const r = database("own"); const c = child(r);
  if (mode === "ttl") vi.useFakeTimers();
  await detachShared("s", { ttlMs: 100 });
  c.gate.report({ type: "steer_delivery", requestId: "one", delivered: false, steer: "private steer body" });
  c.gate.report({ type: "warning", message: "private diagnostic body" });
  if (mode === "finished") { c.exit({ exitCode: 0, result: "real result" }); await tick(); }
  if (mode === "ttl") await vi.advanceTimersByTimeAsync(200);
  else if (mode === "quit") await disposeSessionRegistries("s", "Session shutdown cancelled this run.");
  else sweepDetachedOnExit();
  const row = r.store.get(c.id)!;
  expect(row.status).toBe(mode === "finished" ? "done" : "cancelled");
  expect(row.result).toContain("1 steer(s) accepted but not confirmed.");
  expect(row.result).toMatch(/2 buffered child event\(s\).*not recorded/);
  expect(row.result).not.toContain("private");
  expect(r.db.prepare("SELECT * FROM run_events WHERE type IN ('steer_delivery','warning')").all()).toEqual([]);
});

it.skipIf(process.platform === "win32")("m6: parking installs the production exit hook, which SIGTERMs a real child and cancels its row on natural node exit", async () => {
  const entry = join(root, "host.mjs"), dbPath = join(root, "exit.db"), marker = join(root, "sigterm"), pidFile = join(root, "pid");
  const source = `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { openDbAt } from '@spider/db-core';
    import { RunStore } from ${JSON.stringify(resolve("packages/subagents/src/run-store.ts"))};
    import { registerShared, parkSession } from ${JSON.stringify(resolve("packages/subagents/src/child-registry.ts"))};
    import { processStartTime } from ${JSON.stringify(resolve("packages/subagents/src/process-identity.ts"))};
    const db = openDbAt(${JSON.stringify(dbPath)}, 'worktree');
    const store = new RunStore(db); const { id } = store.create({ sessionId: 's', agent: 'worker', task: 't' }); store.start(id);
    const program = "const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeFileSync(process.argv[1], 'SIGTERM'); process.exit(0); }); setInterval(() => {}, 1000); process.stdout.write('ready');";
    const child = spawn(process.execPath, ['-e', program, ${JSON.stringify(marker)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    child.stdout.once('data', () => {
      const startTime = processStartTime(child.pid);
      if (!startTime) throw new Error('fixture identity unavailable');
      registerShared({ runId: id, sessionId: 's', dbPath: ${JSON.stringify(dbPath)}, mode: 'print', survivable: true,
        handle: { pid: child.pid, startTime, wait: () => new Promise(() => {}), kill: () => {} } });
      parkSession('s'); db.close();
      console.log(JSON.stringify({ id, pid: child.pid }));
      child.stdout.destroy(); child.unref();
    });`;
  try {
    buildSync({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: "exit-fixture.ts", loader: "ts" }, bundle: true, platform: "node", format: "esm",
      banner: { js: "import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);" }, external: ["better-sqlite3", "sqlite-vec"], outfile: entry });
    const env = { ...process.env, SPIDER_GLOBAL_ROOT: join(root, "global"), TMPDIR: root };
    for (const key of Object.keys(env)) if (key.startsWith("PI_")) delete (env as Record<string, string | undefined>)[key];
    const host = spawnSync(process.execPath, [entry], { env, cwd: root, encoding: "utf8", timeout: 10_000 });
    expect(host.status, host.stderr).toBe(0);
    const { id } = JSON.parse(host.stdout.trim());
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 3000, interval: 25 });
    expect(readFileSync(marker, "utf8")).toBe("SIGTERM");
    const db = openDbAt(dbPath, "worktree"); dbs.push(db);
    expect(new RunStore(db).get(id)).toMatchObject({ status: "cancelled", result: "Session shutdown cancelled this run." });
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }
});
