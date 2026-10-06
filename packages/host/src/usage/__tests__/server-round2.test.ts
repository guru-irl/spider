import { afterAll, afterEach, expect, it, vi } from "vitest";
import { readFile, writeFile, rm, utimes, symlink, stat, readdir } from "node:fs/promises";
import * as fs from "node:fs";
import * as cp from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import * as runtime from "../server-runtime.js";
import * as lock from "../server-lock.js";
import { bootUsageServer } from "../server-entry.js";
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>() }));
vi.mock("../server-lock.js", async original => ({ ...await original<typeof import("../server-lock.js")>() }));
let fixtures: any;
async function setup(env = {}) {
  const h = await import(/* @vite-ignore */ new URL("./fixtures/dashboard-process.mjs", import.meta.url).href);
  fixtures ??= await h.processFixtures();
  return { h, f: await fixtures.fixture(env) };
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fixtures?.cleanup(); });
afterAll(async () => { await fixtures?.dispose(); });
async function launched(f: any, options?: any) {
  const r = await f.start("launch", options).exited;
  expect(r.code, r.stderr).toBe(0); const row = JSON.parse(r.stdout); f.pids.add(row.pid); return row;
}

it("alternating builds converge once and report the bundle actually loaded", async () => {
  const { h, f } = await setup();
  const first = await launched(f);
  const bundleUrl = await fixtures.buildBundle(h.NEW_BUILD);
  const next = await launched(f, { bundleUrl, serverBuild: h.NEW_BUILD });
  expect(next.reused).toBe(false); expect(next.pid).not.toBe(first.pid);
  for (const serverBuild of [h.OLD_BUILD, h.NEW_BUILD, undefined, "unknown", "", "sha@bad", "sha@2026-10-06"]) {
    const reused = await launched(f, { serverBuild });
    expect(reused.pid, serverBuild).toBe(next.pid); expect(reused.reused).toBe(true);
  }
  const g = await fixtures.fixture();
  const actual = await launched(g, { bundleUrl, serverBuild: h.OLD_BUILD });
  expect(actual.serverBuild).toBe(h.NEW_BUILD);
}, 20000);

it("two new launchers replace once and mixed reusers wait across replacement", async () => {
  const { h, f } = await setup({ SPIDER_FIXTURE_PARTICIPANT: "1", SPIDER_FIXTURE_HANG_STOP: "1" });
  const first = await launched(f), bundleUrl = await fixtures.buildBundle(h.NEW_BUILD);
  const pending = launched(f, { bundleUrl, serverBuild: h.NEW_BUILD });
  await h.waitFor(async () => readFile(join(f.root, "participant-stopped"), "utf8").catch(() => ""));
  const rows = await Promise.all([pending, launched(f, { bundleUrl, serverBuild: h.NEW_BUILD }), launched(f), launched(f)]);
  expect(new Set(rows.map(r => r.pid)).size).toBe(1);
  expect(rows.filter(r => !r.reused)).toHaveLength(1);
  expect(rows[0].pid).not.toBe(first.pid);
  for (const row of rows) expect((await h.reply(row.port, new URL(row.bootstrapUrl).pathname + new URL(row.bootstrapUrl).search)).status).toBe(303);
}, 15000);

it("unparseable server build is never replaced", async () => {
  const { h, f } = await setup();
  const bundleUrl = await fixtures.buildBundle("synthetic@unknown");
  const first = await launched(f, { bundleUrl, serverBuild: "unknown" });
  const next = await launched(f, { serverBuild: h.NEW_BUILD });
  expect(next.pid).toBe(first.pid); expect(next.reused).toBe(true);
}, 10000);

it("young dead guard recovers in under four seconds", async () => {
  const { f } = await setup();
  await writeFile(`${f.options.lockFile}.guard`, JSON.stringify({ instanceId: "a".repeat(32), pid: 99999999, processIdentity: "dead", createdAt: Date.now() }), { mode: 0o600 });
  const started = Date.now(); await launched(f); expect(Date.now() - started).toBeLessThan(4000);
});

it("identity-mismatched live guards are stale but failed ps waits for grace", async () => {
  const { f } = await setup(), file = join(f.privateDir, "crash.guard");
  for (const identity of ["reused-pid", undefined]) {
    await writeFile(file, JSON.stringify({ pid: process.pid, processIdentity: "old-owner", createdAt: Date.now() }), { mode: 0o600 });
    expect(await lock.reclaimStaleServerRecord(file, async () => identity)).toBe(identity !== undefined);
    if (identity === undefined) {
      const old = new Date(Date.now() - 20000); await utimes(file, old, old);
      expect(await lock.reclaimStaleServerRecord(file, async () => undefined)).toBe(true);
    }
  }
});

it("atomic reclaim preserves a fresh file swapped at rename", async () => {
  const { f } = await setup(), file = join(f.privateDir, "crash.guard");
  const old = JSON.stringify({ pid: 99999999, createdAt: Date.now() - 20000 });
  await writeFile(file, old, { mode: 0o600 });
  const fresh = JSON.stringify({ pid: process.pid, processIdentity: await runtime.usageProcessIdentity(process.pid), createdAt: Date.now() });
  const rename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (from === file) { fs.unlinkSync(file); fs.writeFileSync(file, fresh, { mode: 0o600 }); }
    rename(from, to);
  });
  expect(await lock.reclaimStaleServerRecord(file, runtime.usageProcessIdentity)).toBe(false);
  expect(await readFile(file, "utf8")).toBe(fresh);
});

it("guard wait checks at most 100 ms and caches its own ps lookup", async () => {
  const { h, f } = await setup();
  for (const key of ["HOME", "SPIDER_GLOBAL_ROOT", "PI_CODING_AGENT_DIR", "SPIDER_FIXTURE_OBSERVED"]) vi.stubEnv(key, f.env[key]);
  const guard = `${f.options.lockFile}.guard`;
  await writeFile(guard, JSON.stringify({ pid: process.pid, processIdentity: await runtime.usageProcessIdentity(process.pid), createdAt: Date.now() }), { mode: 0o600 });
  let released = 0;
  const timer = setTimeout(() => { fs.unlinkSync(guard); released = Date.now(); }, 250);
  const pending = runtime.ensureUsageServer(f.options);
  void pending.catch(() => {});
  try {
    const observed = await h.waitFor(f.observed), elapsed = Date.now() - released;
    const row = await pending; f.pids.add(row.pid);
    expect(elapsed).toBeLessThan(500); expect(observed.pid).toBe(row.pid);
  } finally { clearTimeout(timer); await pending.catch(() => {}); }
});

it("concurrent crash writers preserve all new rows while crossing the cap", async () => {
  const { f } = await setup();
  await writeFile(join(f.privateDir, "crash.log"), "usage-server-close-failed\n".repeat(340), { mode: 0o600 });
  const results = await Promise.all(Array.from({ length: 6 }, () => f.start("crash-write").exited));
  for (const r of results) expect(r.code, r.stderr).toBe(0);
  const codes = await runtime.readUsageServerCrashCodes(f.privateDir);
  expect(codes.filter(c => c === "usage-server-crashed")).toHaveLength(120);
  expect(codes.filter(c => c === "usage-server-not-ready")).toHaveLength(120);
  expect((await stat(join(f.privateDir, "crash.log"))).size).toBeLessThanOrEqual(8192);
}, 15000);

it("replacement SIGKILLs an identity-matched server ignoring SIGTERM", async () => {
  const { h, f } = await setup({ SPIDER_FIXTURE_IGNORE_TERM: "1" });
  const first = await launched(f), bundleUrl = await fixtures.buildBundle(h.NEW_BUILD);
  const next = await launched(f, { bundleUrl, serverBuild: h.NEW_BUILD });
  expect(next.pid).not.toBe(first.pid); expect(next.reused).toBe(false);
  await h.waitFor(async () => { try { process.kill(first.pid, 0); return false; } catch { return true; } }, 1000);
}, 10000);

it("stale secret temporaries are swept only after grace under the guard", async () => {
  const { f } = await setup();
  const stale = join(f.privateDir, `lock.json.${"a".repeat(32)}`), fresh = join(f.privateDir, `startup.json.${"b".repeat(32)}`);
  await writeFile(stale, "synthetic-secret", { mode: 0o600 }); await writeFile(fresh, JSON.stringify({ pid: 99999999, createdAt: Date.now(), secret: "synthetic-secret" }), { mode: 0o600 });
  const old = new Date(Date.now() - 20000); await utimes(stale, old, old);
  await launched(f); expect(await readdir(f.privateDir)).not.toContain(stale.split("/").pop());
  expect(JSON.parse(await readFile(fresh, "utf8")).secret).toBe("synthetic-secret");
});

it("boot rejects old startup before consuming it or starting a participant", async () => {
  const { f } = await setup(), instanceId = "a".repeat(32), createdAt = Date.now() - 6000;
  const record = { version: 1, instanceId, pid: process.pid, createdAt, secret: "x".repeat(43) };
  await writeFile(`${f.options.lockFile}.guard`, JSON.stringify(record), { mode: 0o600 });
  const startup = join(f.privateDir, "startup.json"); await writeFile(startup, JSON.stringify(record), { mode: 0o600 });
  let starts = 0;
  await expect(bootUsageServer({ ...f.options, instanceId, startParticipant: () => { starts++; throw new Error("unexpected participant"); } })).rejects.toThrow("usage-server-startup-invalid");
  expect(starts).toBe(0); expect(await readFile(startup, "utf8")).toBe(JSON.stringify(record));
});

it("calibration reload follows pi's config reader for symlink large and unreadable files", async () => {
  const { h, f } = await setup();
  const { openUsageLedger } = await import("../ledger.js"); openUsageLedger(f.options.roots.ledgerFile).close();
  const config = join(f.root, "config.json"), target = join(f.root, "target.json");
  await writeFile(target, JSON.stringify({ "usage.calibration": "off", padding: "x".repeat(70000) })); await symlink(target, config);
  const row = await launched(f, { calibrationConfigFile: config, calibrationMode: "off" });
  const boot = await h.reply(row.port, new URL(row.bootstrapUrl).pathname + new URL(row.bootstrapUrl).search);
  const headers = { Cookie: boot.headers["set-cookie"][0].split(";")[0] };
  const mode = async () => JSON.parse((await h.reply(row.port, "/api/overview", headers)).body).data.calibration.status;
  expect(await mode()).toBe("off");
  await writeFile(target, JSON.stringify({ "usage.calibration": "auto", padding: "x".repeat(70000) })); expect(await mode()).toBe("uncalibrated");
  await rm(config); await fs.promises.mkdir(config); expect(await mode()).toBe("uncalibrated");
});


it("replacement rechecks birth identity immediately before signalling", async () => {
  const { h, f } = await setup();
  const first = await launched(f), bundleUrl = await fixtures.buildBundle(h.NEW_BUILD);
  for (const key of ["HOME", "SPIDER_GLOBAL_ROOT", "PI_CODING_AGENT_DIR", "SPIDER_FIXTURE_OBSERVED"]) vi.stubEnv(key, f.env[key]);
  const read = lock.readUsageServerLock; let reads = 0;
  vi.spyOn(lock, "readUsageServerLock").mockImplementation(async file => {
    const record = await read(file);
    if (record?.pid === first.pid && ++reads === 2) {
      process.kill(-first.pid, "SIGKILL");
      await h.waitFor(async () => { try { process.kill(first.pid, 0); return false; } catch { return true; } }, 1000);
    }
    return record;
  });
  const kill = vi.spyOn(process, "kill");
  const next = await runtime.ensureUsageServer({ ...f.options, bundleUrl, serverBuild: h.NEW_BUILD }); f.pids.add(next.pid);
  expect(kill.mock.calls.filter(([pid, signal]) => pid === first.pid && signal === "SIGTERM")).toHaveLength(0);
  expect(next.pid).not.toBe(first.pid);
}, 10000);

it("all guards carry owner birth identity and own lookup is cached across a wait", async () => {
  const { h, f } = await setup();
  for (const key of ["HOME", "SPIDER_GLOBAL_ROOT", "PI_CODING_AGENT_DIR", "SPIDER_FIXTURE_OBSERVED"]) vi.stubEnv(key, f.env[key]);
  const guard = `${f.options.lockFile}.guard`; await writeFile(guard, "", { mode: 0o600 });
  const originalExec = cp.execFile as any;
  const custom = originalExec[promisify.custom]; let ownLookups = 0;
  const exec = vi.spyOn(cp, "execFile");
  Object.defineProperty(exec, promisify.custom, { value: (file: string, args: string[], options: object) => {
    if (args[1] === String(process.pid)) ownLookups++;
    return custom(file, args, options);
  } });
  const owners: any[] = [], link = fs.linkSync;
  vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
    if (String(to).endsWith(".guard")) owners.push(JSON.parse(fs.readFileSync(from, "utf8")));
    return link(from, to);
  });
  const timer = setTimeout(() => fs.unlinkSync(guard), 450);
  let row;
  try { row = await runtime.ensureUsageServer(f.options); f.pids.add(row.pid); } finally { clearTimeout(timer); }
  if (process.platform !== "linux") expect(ownLookups).toBe(1);
  await runtime.writeUsageServerCrashCode(f.privateDir, "usage-server-crashed");
  const extra = join(f.privateDir, "owned.json"); await lock.writeServerRecord(extra, { instanceId: "a".repeat(32) });
  await lock.removeOwnedUsageServerLock(extra, "a".repeat(32));
  expect(new Set(owners.map(owner => owner.instanceId)).size).toBe(3);
  for (const owner of owners) { expect(owner.pid).toBe(process.pid); expect(owner.processIdentity).toBeTypeOf("string"); }
  const spawns = vi.spyOn(cp, "spawn");
  expect(await runtime.usableUsageNode(Date.now() + 5000)).toBe(true);
  expect(await runtime.usableUsageNode(Date.now() + 5000)).toBe(true);
  expect(spawns.mock.calls.filter(([, args]) => args?.includes("--eval")).length).toBeLessThanOrEqual(1);
});


it("reusing launchers cannot return a live old URL while replacement owns the guard", async () => {
  const { h, f } = await setup();
  const first = await launched(f), bundleUrl = await fixtures.buildBundle(h.NEW_BUILD);
  for (const key of ["HOME", "SPIDER_GLOBAL_ROOT", "PI_CODING_AGENT_DIR", "SPIDER_FIXTURE_OBSERVED"]) vi.stubEnv(key, f.env[key]);
  const read = lock.readUsageServerLock; let reads = 0, enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(lock, "readUsageServerLock").mockImplementation(async file => {
    const record = await read(file);
    if (record?.pid === first.pid && ++reads === 2) { enter(); await resume; }
    return record;
  });
  const replacing = runtime.ensureUsageServer({ ...f.options, bundleUrl, serverBuild: h.NEW_BUILD });
  await entered;
  let reusedEarly = false;
  const reusing = runtime.ensureUsageServer(f.options).then(row => { reusedEarly = true; f.pids.add(row.pid); return row; });
  try {
    // Intent prevents early reuse too, but replacement must still own the guard across stop/start.
    const guardOwner = JSON.parse(await readFile(`${f.options.lockFile}.guard`, "utf8"));
    expect(guardOwner.pid).toBe(process.pid);
    expect(guardOwner.processIdentity).toBe(await runtime.usageProcessIdentity(process.pid));
    expect((await h.reply(first.port, "/api/status")).status).toBe(401);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(reusedEarly).toBe(false);
  } finally { release(); }
  const rows = await Promise.all([replacing, reusing]); for (const row of rows) f.pids.add(row.pid);
  expect(rows[0].pid).not.toBe(first.pid); expect(rows[1].pid).toBe(rows[0].pid);
}, 10000);


it("ISO timestamps with seconds or offsets order builds by time", async () => {
  const { h, f } = await setup(); const first = await launched(f), bundleUrl = await fixtures.buildBundle(h.NEW_BUILD);
  const next = await launched(f, { bundleUrl, serverBuild: "synthetic@2026-10-06T01:00:00+01:00" });
  expect(next.pid).not.toBe(first.pid); expect(next.reused).toBe(false);
  const equal = await launched(f, { serverBuild: "another@2026-10-06T00:00:00Z" });
  expect(equal.pid).toBe(next.pid); expect(equal.reused).toBe(true);
}, 10000);


it("unparseable fresh guard is not reclaimed before the ten-second grace", async () => {
  const { f } = await setup(), file = `${f.options.lockFile}.guard`;
  await writeFile(file, "", { mode: 0o600 });
  const young = new Date(Date.now() - 9000); await utimes(file, young, young);
  expect(await lock.reclaimStaleServerRecord(file, runtime.usageProcessIdentity)).toBe(false);
  expect(await readFile(file, "utf8")).toBe("");
  const old = new Date(Date.now() - 11000); await utimes(file, old, old);
  expect(await lock.reclaimStaleServerRecord(file, runtime.usageProcessIdentity)).toBe(true);
});


it("a stale observation cannot displace an owner refreshed during identity lookup", async () => {
  const { f } = await setup(), file = `${f.options.lockFile}.guard`;
  await writeFile(file, JSON.stringify({ pid: process.pid, processIdentity: "old", createdAt: Date.now() - 20000 }), { mode: 0o600 });
  const fresh = JSON.stringify({ pid: process.pid, processIdentity: "fresh", createdAt: Date.now() });
  const rename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    rename(from, to);
    // A third launcher can claim a name vacated by an erroneous stale rename.
    if (from === file) fs.writeFileSync(file, JSON.stringify({ pid: process.pid, processIdentity: "third", createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
  });
  expect(await lock.reclaimStaleServerRecord(file, async () => {
    fs.unlinkSync(file); fs.writeFileSync(file, fresh, { flag: "wx", mode: 0o600 }); return "fresh";
  })).toBe(false);
  expect(await readFile(file, "utf8")).toBe(fresh);
});
