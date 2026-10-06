import { afterAll, afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, chmod, utimes } from "node:fs/promises";
import { join, resolve } from "node:path";
const dirs: string[] = [];
let processFixtures: any;
async function cleanup() { await processFixtures?.cleanup(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); }
afterEach(cleanup); afterAll(async () => { await cleanup(); await processFixtures?.dispose(); });
async function fixture() {
  const scratch = resolve(".spider/scratch/usage-ui"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "server-lock-")); dirs.push(root);
  return { root, dir: join(root, "usage-server"), lockFile: join(root, "usage-server", "lock.json") };
}
async function implementation() {
  const mod = await import("../server-lock.js").catch(() => undefined);
  expect(mod, "private server record implementation exists").toBeDefined(); return mod!;
}
it("lock cleanup respects a replacement launcher guard", async () => {
  const m = await implementation(), f = await fixture();
  expect(m.removeOwnedUsageServerLock, "guarded owned-lock cleanup exists").toBeTypeOf("function");
  await m.ensurePrivateServerDir(f.dir);
  const old = { version: 1 as const, instanceId: "a".repeat(32), pid: process.pid, port: null, secret: "s".repeat(43) };
  await m.writeServerRecord(f.lockFile, old);
  await m.writeServerRecord(`${f.lockFile}.guard`, { instanceId: "b".repeat(32), createdAt: Date.now(), pid: process.pid }, true);
  expect(await m.removeOwnedUsageServerLock(f.lockFile, old.instanceId)).toBe(false);
  expect(await m.readUsageServerLock(f.lockFile)).toEqual(old);
  await m.removeServerRecord(`${f.lockFile}.guard`, "b".repeat(32));
  expect(await m.removeOwnedUsageServerLock(f.lockFile, old.instanceId)).toBe(true);
  expect(await m.readServerRecord(`${f.lockFile}.guard`)).toBeUndefined();
});

it("concurrent launchers reuse only authenticated owner", async () => {
  // A PID/port-only reuse, missing atomic guard, or cached bootstrap URL breaks this case.
  const fixtureUrl = new URL("./fixtures/dashboard-process.mjs", import.meta.url).href;
  const h = await import(/* @vite-ignore */ fixtureUrl);
  processFixtures ??= await h.processFixtures();
  const f = await processFixtures.fixture();
  const launched = await Promise.all(Array.from({ length: 4 }, async () => {
    const launcher = f.start("launch"); const result = await launcher.exited;
    expect(result.code, result.stderr).toBe(0); return JSON.parse(result.stdout);
  }));
  expect(new Set(launched.map(row => row.pid)).size).toBe(1);
  expect(launched.filter(row => !row.reused)).toHaveLength(1);
  expect(new Set(launched.map(row => row.bootstrapUrl)).size).toBe(4);
  const lock = JSON.parse(await readFile(f.options.lockFile, "utf8")); f.pids.add(lock.pid);
  for (const row of launched) {
    expect(row.bootstrapUrl).not.toContain(lock.secret);
    expect((await h.reply(row.port, new URL(row.bootstrapUrl).pathname + new URL(row.bootstrapUrl).search)).status).toBe(303);
  }
  // Pretend the stored PID has been recycled into this live test runner. An authenticated
  // server with the same instance must not be reused or signalled under the swapped PID.
  await writeFile(f.options.lockFile, JSON.stringify({ ...lock, pid: process.pid }), { mode: 0o600 });
  const replacement = f.start("launch"); const result = await replacement.exited;
  expect(result.code, result.stderr).toBe(0);
  const next = JSON.parse(result.stdout); f.pids.add(next.pid);
  expect(next.reused).toBe(false); expect(next.pid).not.toBe(lock.pid);
  expect((await h.reply(lock.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${lock.secret}` })).status).toBe(200);
}, 30000);

it("startup files are bounded and fenced", async () => {
  // Removing no-follow, size/mode checks or the instance comparison would expose roots or delete another owner's record.
  const m = await implementation(), f = await fixture();
  const first = { version: 1 as const, instanceId: "a".repeat(32), pid: process.pid, port: null, secret: "s".repeat(43) };
  const previousMask = process.umask(0);
  try {
    await m.ensurePrivateServerDir(f.dir);
    expect((await stat(f.dir)).mode & 0o777).toBe(0o700);
    await m.writeServerRecord(f.lockFile, first);
    expect((await stat(f.lockFile)).mode & 0o777).toBe(0o600);
  } finally { process.umask(previousMask); }
  expect(await m.readUsageServerLock(f.lockFile)).toEqual(first);
  expect(await m.removeServerRecord(f.lockFile, "b".repeat(32))).toBe(false);
  expect(await readFile(f.lockFile, "utf8")).toContain(first.instanceId);
  expect(await m.removeServerRecord(f.lockFile, first.instanceId)).toBe(true);
  await writeFile(f.lockFile, "x".repeat(16385), { mode: 0o600 });
  await expect(m.readServerRecord(f.lockFile)).rejects.toThrow("usage-server-record-invalid");
  await rm(f.lockFile); await writeFile(f.lockFile, JSON.stringify(first), { mode: 0o644 });
  await expect(m.readServerRecord(f.lockFile)).rejects.toThrow("usage-server-record-invalid");
  await rm(f.lockFile); const target = join(f.root, "target"); await writeFile(target, JSON.stringify(first), { mode: 0o600 });
  await symlink(target, f.lockFile);
  await expect(m.readServerRecord(f.lockFile)).rejects.toThrow("usage-server-record-invalid");
  await expect(m.writeServerRecord(f.lockFile, first)).rejects.toThrow("usage-server-record-invalid");
  expect(await readFile(target, "utf8")).toBe(JSON.stringify(first));
  await rm(f.lockFile); await writeFile(f.lockFile, '{"instanceId":"broken"}', { mode: 0o600 });
  expect(await m.readUsageServerLock(f.lockFile)).toBeUndefined();
  expect(await m.removeServerRecord(f.lockFile, first.instanceId)).toBe(false);
  const linkedDir = join(f.root, "linked"); await symlink(f.dir, linkedDir);
  await expect(m.ensurePrivateServerDir(linkedDir)).rejects.toThrow("usage-server-record-invalid");
});


it("owned private directory permissions are repaired but symlinks fail closed", async () => {
  const m = await implementation(), f = await fixture();
  await mkdir(f.dir, { mode: 0o755 });
  await m.ensurePrivateServerDir(f.dir);
  expect((await stat(f.dir)).mode & 0o777).toBe(0o700);
  await chmod(f.dir, 0o755);
  expect(() => m.assertPrivateServerDir(f.dir)).toThrow("usage-server-record-invalid");
});

it("crash-mid-start empty corrupt and wrong-mode records recover after grace", async () => {
  const h = await import(/* @vite-ignore */ new URL("./fixtures/dashboard-process.mjs", import.meta.url).href);
  processFixtures ??= await h.processFixtures();
  for (const name of ["lock.json.guard", "lock.json", "startup.json"]) {
    for (const state of ["empty", "corrupt", "wrong-mode", "wrong-shape"]) {
      const f = await processFixtures.fixture(); const file = join(f.privateDir, name);
      const record = { version: 1, instanceId: "d".repeat(32), pid: 99999999, createdAt: Date.now() - 20000, processIdentity: "absent", port: 12345, secret: "s".repeat(43) };
      await writeFile(file, state === "empty" ? "" : state === "corrupt" ? "{" : state === "wrong-shape" ? '{"instanceId":"broken"}' : JSON.stringify(record), { mode: state === "wrong-mode" ? 0o644 : 0o600 });
      const stale = new Date(Date.now() - 20000); await utimes(file, stale, stale);
      const result = await f.start("launch").exited;
      expect(result.code, `${name} ${state}: ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout).reused).toBe(false);
      await expect(readFile(join(f.privateDir, "startup.json"))).rejects.toThrow();
    }
  }
}, 30000);

it("stale guard recovery races produce one owner and zero spurious failures in twelve rounds", async () => {
  const h = await import(/* @vite-ignore */ new URL("./fixtures/dashboard-process.mjs", import.meta.url).href);
  processFixtures ??= await h.processFixtures();
  for (let round = 0; round < 12; round++) {
    const f = await processFixtures.fixture(); const guard = `${f.options.lockFile}.guard`;
    await writeFile(guard, JSON.stringify({ version: 1, instanceId: "e".repeat(32), pid: 99999999, createdAt: Date.now() - 9990 }), { mode: 0o600 });
    const old = new Date(Date.now() - 9990); await utimes(guard, old, old);
    const results = await Promise.all(Array.from({ length: 6 }, () => f.start("launch").exited));
    for (const r of results) expect(r.code, `round ${round}: ${r.stderr}`).toBe(0);
    const rows = results.map(r => JSON.parse(r.stdout));
    expect(new Set(rows.map(row => row.pid)).size).toBe(1);
    expect(rows.filter(row => !row.reused)).toHaveLength(1);
    expect(new Set(rows.map(row => row.bootstrapUrl)).size).toBe(6);
    await processFixtures.cleanup();
  }
}, 60000);

it("stale live identity-matched records are never reclaimed even with wrong mode", async () => {
  const m = await implementation(), f = await fixture();
  await m.ensurePrivateServerDir(f.dir);
  const runtime = await import("../server-runtime.js");
  for (const file of [f.lockFile, `${f.lockFile}.guard`]) {
    const record = { version: 1, instanceId: "e".repeat(32), pid: process.pid, createdAt: Date.now() - 20000, processIdentity: await runtime.usageProcessIdentity(process.pid) };
    await writeFile(file, JSON.stringify(record), { mode: 0o644 });
    const old = new Date(Date.now() - 20000); await utimes(file, old, old);
    expect(await (m as any).reclaimStaleServerRecord(file, runtime.usageProcessIdentity)).toBe(false);
    expect(await readFile(file, "utf8")).toBe(JSON.stringify(record));
    // An unavailable birth lookup is only protected during the grace period.
    expect(await (m as any).reclaimStaleServerRecord(file, async () => undefined)).toBe(true);
  }
});


it("fresh corrupt guards stay busy until grace and stale startup secrets are swept", async () => {
  const h = await import(/* @vite-ignore */ new URL("./fixtures/dashboard-process.mjs", import.meta.url).href);
  processFixtures ??= await h.processFixtures(); const f = await processFixtures.fixture();
  const guard = `${f.options.lockFile}.guard`; await writeFile(guard, "", { mode: 0o600 });
  const old = new Date(Date.now() - 9000); await utimes(guard, old, old);
  const startup = join(f.privateDir, "startup.json");
  await writeFile(startup, JSON.stringify({ version: 1, instanceId: "e".repeat(32), createdAt: Date.now() - 20000, secret: "s".repeat(43) }), { mode: 0o600 });
  const started = Date.now(), result = await f.start("launch").exited;
  expect(result.code, result.stderr).toBe(0);
  expect(Date.now() - started).toBeGreaterThanOrEqual(850);
  await expect(readFile(startup)).rejects.toThrow();
});

it("a SIGKILL during startup exits the launcher early and the next launch succeeds", async () => {
  const h = await import(/* @vite-ignore */ new URL("./fixtures/dashboard-process.mjs", import.meta.url).href);
  processFixtures ??= await h.processFixtures(); const f = await processFixtures.fixture({ SPIDER_FIXTURE_DELAY: "1500" });
  const launcher = f.start("launch"), observed = await h.waitFor(f.observed);
  const killed = Date.now(); process.kill(-observed.pid, "SIGKILL");
  const result = await launcher.exited;
  expect(result.code).toBe(1); expect(result.stderr).toContain("usage-server-not-ready");
  expect(Date.now() - killed).toBeLessThan(1000);
  await expect(readFile(join(f.privateDir, "startup.json"))).rejects.toThrow();
  const next = await f.start("launch").exited; expect(next.code, next.stderr).toBe(0);
  const owner = JSON.parse(await readFile(f.options.lockFile, "utf8"));
  process.kill(-owner.pid, "SIGKILL");
  await h.waitFor(async () => { try { process.kill(owner.pid, 0); return false; } catch { return true; } }, 1000);
  const restarted = await f.start("launch").exited; expect(restarted.code, restarted.stderr).toBe(0);
  expect(JSON.parse(restarted.stdout).reused).toBe(false);
});


it("exclusive guard publication never exposes partial JSON to a concurrent reader", async () => {
  const h = await import(/* @vite-ignore */ new URL("./fixtures/dashboard-process.mjs", import.meta.url).href);
  processFixtures ??= await h.processFixtures(); const f = await processFixtures.fixture();
  const observer = f.start("observe-publication");
  await h.waitFor(async () => await readFile(join(f.root, "observer-ready"), "utf8").catch(() => ""));
  const writer = await f.start("publish-records").exited; expect(writer.code, writer.stderr).toBe(0);
  const result = await observer.exited; expect(result.code, result.stderr).toBe(0);
  const seen = JSON.parse(result.stdout); expect(seen.seen).toBeGreaterThan(0); expect(seen.partial).toBe(0);
}, 15000);
