import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { openUsageLedger, type UsageLedger } from "../ledger.js";
import * as leases from "../lease.js";

const root = join(process.env.SPIDER_GLOBAL_ROOT!, "lease");
mkdirSync(root, { recursive: true });
let seq = 0;
const children: ChildProcess[] = [];
const ledgers: UsageLedger[] = [];
const snapshot = { ts: 1000, creditsUsed: 7, raw: {} };
function store(file = join(root, `usage-${++seq}.db`)) {
  const ledger = openUsageLedger(file); ledgers.push(ledger); return { ledger, file };
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.kill("SIGKILL"); await closed;
  }));
  for (const ledger of ledgers.splice(0)) ledger.close();
});

const modulePath = join(root, "lease-fixture.mjs");
buildSync({ stdin: { contents: `export * from ${JSON.stringify(fileURLToPath(new URL("../ledger.ts", import.meta.url)))}; export * from ${JSON.stringify(fileURLToPath(new URL("../lease.ts", import.meta.url)))};`, resolveDir: process.cwd() },
  outfile: modulePath, bundle: true, platform: "node", format: "esm", external: ["better-sqlite3", "sqlite-vec"], logLevel: "silent" });
function child(script: string) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", `import { openUsageLedger, acquireUsageLease } from ${JSON.stringify(modulePath)};\n${script}`], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(proc);
  let buffer = "", stderr = "";
  const lines: string[] = [], waiters: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
  proc.stderr!.on("data", d => { stderr += d; });
  proc.stdout!.on("data", d => {
    buffer += d;
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      const waiter = waiters.shift(); if (waiter) waiter.resolve(line); else lines.push(line);
    }
  });
  const exit = new Promise<void>(resolve => proc.once("close", () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`Fixture exited: ${stderr}`)); resolve();
  }));
  return { proc, exit, line: () => new Promise<string>((resolve, reject) => {
    const line = lines.shift(); if (line !== undefined) resolve(line);
    else if (proc.exitCode !== null || proc.signalCode !== null) reject(new Error(stderr));
    else waiters.push({ resolve, reject });
  }) };
}

it("live unexpired lease blocks a sequential second owner without a guard collision (I4)", () => {
  const { ledger } = store();
  const a = leases.acquireUsageLease(ledger, "counter", "a", 1000, 100)!;
  expect(a).toBeDefined();
  expect(leases.acquireUsageLease(ledger, "counter", "b", 1050, 100)).toBeUndefined();
  expect(a.isCurrent(1050)).toBe(true);
});
it("a different process cannot steal a live lease without contention (I4)", async () => {
  const { ledger, file } = store();
  const a = leases.acquireUsageLease(ledger, "counter", "a", 1000, 100)!;
  const b = child(`const db = openUsageLedger(${JSON.stringify(file)}); console.log(String(!!acquireUsageLease(db, 'counter', 'b', 1050, 100))); db.close();`);
  expect(await b.line()).toBe("false"); expect(a.isCurrent(1050)).toBe(true);
});
it("one owner wins across processes", async () => {
  const { file } = store();
  const code = (owner: string) => `const db = openUsageLedger(${JSON.stringify(file)}); console.log(String(!!acquireUsageLease(db, 'counter', '${owner}', 1000, 100))); db.close();`;
  const a = child(code("a")), b = child(code("b"));
  expect((await Promise.all([a.line(), b.line()])).filter(x => x === "true")).toHaveLength(1);
});
it("atomic snapshot save fences expired tokens, including identical owner names (C1)", () => {
  const { ledger } = store();
  const old = leases.acquireUsageLease(ledger, "counter", "same", 1000, 100)!;
  expect(old.saveIfCurrent(1000, snapshot)).toBe(true);
  const next = leases.acquireUsageLease(ledger, "counter", "same", 1100, 100)!;
  expect(old.saveIfCurrent(1100, { ...snapshot, ts: 1100, creditsUsed: 99 })).toBe(false);
  expect(old.renew(1100)).toBe(false); old.release();
  expect(next.isCurrent(1100)).toBe(true); expect(ledger.latestCounter()?.creditsUsed).toBe(7);
});
it("expired owners cannot renew before takeover", () => {
  const { ledger } = store(); const a = leases.acquireUsageLease(ledger, "counter", "a", 1000, 100)!;
  expect(a.renew(1100)).toBe(false); expect(a.isCurrent(1100)).toBe(false);
});
it("release is idempotent, transactional and token-fenced (M4)", () => {
  const { ledger } = store(); const a = leases.acquireUsageLease(ledger, "counter", "a", 1000, 100)!;
  expect(a.release()).toBe(true); expect(a.release()).toBe(true);
  const b = leases.acquireUsageLease(ledger, "counter", "b", 1000, 100)!;
  expect(a.release()).toBe(true); expect(b.isCurrent(1000)).toBe(true);
});
it("release reports a bounded SQLite BUSY rather than silently abandoning ownership (M4/I1)", () => {
  const { ledger, file } = store(); const a = leases.acquireUsageLease(ledger, "counter", "a", 1000, 100)!;
  const blocker = new Database(file); blocker.exec("BEGIN IMMEDIATE");
  const start = performance.now();
  try { expect(() => a.release()).toThrow("lease-busy"); expect(performance.now() - start).toBeLessThan(1500); }
  finally { blocker.exec("ROLLBACK"); blocker.close(); }
  expect(a.isCurrent(1000)).toBe(true); expect(a.release()).toBe(true);
});
it("next due survives release and expired takeover; ingest and counter have distinct names", () => {
  const { ledger } = store(); const a = leases.acquireUsageLease(ledger, "counter", "a", 1000, 100)!;
  expect(a.claimPoll(1000, 600000)).toBe(true); a.release();
  const b = leases.acquireUsageLease(ledger, "counter", "b", 1000, 100)!;
  expect(b.nextPollAt()).toBe(601000); expect(b.claimPoll(1000, 600000)).toBe(false);
  const ingest = leases.acquireUsageLease(ledger, "ingest", "a", 1000, 100)!;
  expect(ingest.claimPoll(1000, 1000)).toBe(true);
  const c = leases.acquireUsageLease(ledger, "counter", "c", 601000, 100)!;
  expect(c.claimPoll(601000, 600000)).toBe(true); b.release(); expect(c.isCurrent(601000)).toBe(true);
});
it.each(["not-a-date", -1])("repairs corrupt schedules conservatively with a visible code (I2): %s", due => {
  const { ledger, file } = store(); const a = leases.acquireUsageLease(ledger, "counter", "a", 1000, 1000000)!;
  const db = new Database(file); try { db.prepare("UPDATE leases SET next_due_at=? WHERE name='counter'").run(due); } finally { db.close(); }
  expect(a.claimPoll(1000, 600000)).toBe(false); expect(a.nextPollAt()).toBe(601000);
  expect(leases.inspectUsageLease(ledger, "counter", 1000)).toMatchObject({ lastErrorCode: null, notice: { code: "schedule-corrupt", at: 1000 } });
  expect(a.claimPoll(601000, 600000)).toBe(true);
});
it("corrupt owner rows wait one TTL, then recover instead of blocking forever (I2)", () => {
  const { ledger, file } = store(); leases.acquireUsageLease(ledger, "counter", "a", 1000, 100)!;
  const db = new Database(file); try { db.exec("UPDATE leases SET expires_at='bad', token=NULL WHERE name='counter'"); } finally { db.close(); }
  expect(leases.acquireUsageLease(ledger, "counter", "b", 1050, 100)).toBeUndefined();
  expect(leases.inspectUsageLease(ledger, "counter", 1050)).toMatchObject({ expiresAt: 1150, lastErrorCode: null, notice: { code: "lease-row-corrupt", at: 1050 } });
  expect(leases.acquireUsageLease(ledger, "counter", "b", 1150, 100)).toBeDefined();
});
it("clock jumps clamp next due to two intervals and report the correction (M2)", () => {
  const { ledger, file } = store(); const a = leases.acquireUsageLease(ledger, "counter", "a", 1000, 2000000)!;
  const db = new Database(file); try { db.exec("UPDATE leases SET next_due_at=31536001000 WHERE name='counter'"); } finally { db.close(); }
  expect(a.claimPoll(1000, 600000)).toBe(false); expect(a.nextPollAt()).toBe(1201000);
  expect(leases.inspectUsageLease(ledger, "counter", 1000)).toMatchObject({ lastErrorCode: null, notice: { code: "clock-jump", at: 1000 } });
  expect(a.claimPoll(1201000, 600000)).toBe(true);
});
it("doctor inspection distinguishes free, owner, follower and expired without exposing tokens", () => {
  const { ledger } = store();
  expect(leases.inspectUsageLease(ledger, "counter", 1000)).toMatchObject({ role: "free", owner: null, expiresAt: null, lastErrorCode: null });
  leases.acquireUsageLease(ledger, "counter", "a", 1000, 100)!;
  expect(leases.inspectUsageLease(ledger, "counter", 1050, "a")).toMatchObject({ role: "owner", owner: "a", expiresAt: 1100 });
  expect(leases.inspectUsageLease(ledger, "counter", 1050, "b").role).toBe("follower");
  expect(leases.inspectUsageLease(ledger, "counter", 1100).role).toBe("expired");
  expect(leases.inspectUsageLease(ledger, "counter", 1050)).not.toHaveProperty("token");
});

// Reuses review-t5/stranded.test.ts's real-process death modes. The synchronous
// raw getter pauses AFTER the fence check and BEGIN IMMEDIATE, mid-save.
it.each(["SIGKILL", "SIGTERM", "SIGHUP", "process.exit", "worker.terminate"])("a fresh process acquires after TTL following %s mid-save (C1)", async mode => {
  const { file } = store();
  const pause = mode === "process.exit" ? "process.exit(0)" : "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)";
  const body = `const db = openUsageLedger(${JSON.stringify(file)}); const lease = acquireUsageLease(db, 'counter', 'a', 1000, 100); lease.saveIfCurrent(1000, { ts: 1000, creditsUsed: 7, get raw() { NOTIFY; ${pause}; return {}; } });`;
  const script = mode === "worker.terminate" ? `
    import { Worker } from 'node:worker_threads';
    const w = new Worker(${JSON.stringify(`import { openUsageLedger, acquireUsageLease } from ${JSON.stringify(modulePath)}; import { parentPort } from 'node:worker_threads'; ${body.replace("NOTIFY", "parentPort.postMessage('saving')")}`)}, { eval: true });
    setInterval(() => {}, 1000);
    w.on('message', async () => { await w.terminate(); console.log('terminated'); });
    w.on('error', e => { console.error(e); process.exit(1); });
  ` : `import { writeSync } from 'node:fs'; ${body.replace("NOTIFY", "writeSync(1, 'saving\\n')")}`;
  const a = child(script);
  expect(await a.line()).toBe(mode === "worker.terminate" ? "terminated" : "saving");
  if (mode.startsWith("SIG")) a.proc.kill(mode as NodeJS.Signals);
  if (mode !== "worker.terminate") await a.exit;
  else { expect(a.proc.exitCode).toBeNull(); expect(a.proc.signalCode).toBeNull(); }
  const b = child(`const db = openUsageLedger(${JSON.stringify(file)}); console.log(JSON.stringify({ before: !!acquireUsageLease(db, 'counter', 'b', 1099, 100), after: !!acquireUsageLease(db, 'counter', 'b', 1100, 100), snapshot: db.latestCounter() ?? null })); db.close();`);
  expect(JSON.parse(await b.line())).toEqual({ before: false, after: true, snapshot: null });
  if (mode === "worker.terminate") { expect(a.proc.exitCode).toBeNull(); a.proc.kill("SIGKILL"); await a.exit; }
});

it("M3 expiry more than one TTL ahead allows takeover with a clock-jump notice (P4)", () => {
  const { ledger } = store();
  const old = leases.acquireUsageLease(ledger, "counter", "skewed", 86401000, 120000)!;
  const next = leases.acquireUsageLease(ledger, "counter", "fresh", 1000, 120000);
  expect(next).toBeDefined();
  expect(old.isCurrent(1000)).toBe(false);
  expect(leases.inspectUsageLease(ledger, "counter", 1000)).toMatchObject({ owner: "fresh", lastErrorCode: null, notice: { code: "clock-jump", at: 1000 } });
});
it("M3 expiry exactly one TTL ahead remains live and cannot be stolen", () => {
  const { ledger } = store(); leases.acquireUsageLease(ledger, "counter", "a", 1000, 120000);
  expect(leases.acquireUsageLease(ledger, "counter", "b", 1000, 120000)).toBeUndefined();
});
it("M2 corrupt-row repair clears its notice on recovery but preserves the poll error", () => {
  const { ledger, file } = store(); const a = leases.acquireUsageLease(ledger, "counter", "a", 1000, 100)!;
  a.recordError(1000, "http-401");
  const db = new Database(file); db.exec("UPDATE leases SET expires_at='bad', token=NULL"); db.close();
  expect(leases.acquireUsageLease(ledger, "counter", "b", 1050, 100)).toBeUndefined();
  expect(leases.inspectUsageLease(ledger, "counter", 1050)).toMatchObject({ lastErrorCode: "http-401", notice: { code: "lease-row-corrupt", at: 1050 } });
  expect(leases.acquireUsageLease(ledger, "counter", "b", 1150, 100)).toBeDefined();
  expect(leases.inspectUsageLease(ledger, "counter", 1150)).toMatchObject({ lastErrorCode: "http-401", notice: null });
});

it("I1 a renewal 1 ms ahead is not a clock jump or false takeover", () => {
  const { ledger } = store(); const a = leases.acquireUsageLease(ledger, "counter", "A", 1000, 120000)!;
  a.renew(1501);
  expect(leases.acquireUsageLease(ledger, "counter", "B", 1500, 120000)).toBeUndefined();
  expect(a.isCurrent(1502)).toBe(true); expect(leases.inspectUsageLease(ledger, "counter", 1502).notice).toBeNull();
});
it("I1 clock-jump takeover is strict beyond TTL plus 30 seconds", () => {
  const { ledger } = store(); leases.acquireUsageLease(ledger, "counter", "A", 31000, 120000);
  expect(leases.acquireUsageLease(ledger, "counter", "B", 1000, 120000)).toBeUndefined();
  expect(leases.acquireUsageLease(ledger, "counter", "B", 999, 120000)).toBeDefined();
});
it("I1 samples the clock inside BEGIN IMMEDIATE for every write fence", () => {
  const { ledger, file } = store(); const probe = new Database(file, { timeout: 0 });
  let samples = 0;
  const clock = (() => {
    samples++;
    expect(() => probe.exec("BEGIN IMMEDIATE")).toThrow();
    return 1000;
  });
  try {
    const a = leases.acquireUsageLease(ledger, "counter", "A", clock, 120000)!;
    expect(a).toBeDefined(); expect(samples).toBe(1);
    expect(a.renew(clock)).toBe(true); expect(samples).toBe(2);
    expect(a.claimPoll(clock, 600000)).toBe(true); expect(samples).toBe(3);
    expect(a.recordError(clock, "http-500")).toBe(true); expect(samples).toBe(4);
    expect(a.saveIfCurrent(clock, snapshot)).toBe(true); expect(samples).toBe(5);
  } finally { if (probe.inTransaction) probe.exec("ROLLBACK"); probe.close(); }
});
