import { USAGE_HTTP_DRAIN_MS, USAGE_PARTICIPANT_STOP_MS, USAGE_REPLACEMENT_GRACE_MS } from "../server-lifecycle.js";
import { afterAll, afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
let processFixtures: any;
const workers = new Set<Worker>();
const dirs: string[] = [];
async function cleanup() { for (const worker of workers) await worker.terminate(); workers.clear(); await processFixtures?.cleanup(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); }
afterEach(cleanup); afterAll(async () => { await cleanup(); await processFixtures?.dispose(); });
it("publication cannot outlive its startup fence", async () => {
  const fixtureUrl = new URL("./fixtures/dashboard-process.mjs", import.meta.url).href;
  const h = await import(/* @vite-ignore */ fixtureUrl); processFixtures ??= await h.processFixtures();
  const f = await processFixtures.fixture({ SPIDER_FIXTURE_PARTICIPANT: "1", SPIDER_FIXTURE_REPLACE_GUARD: "1" });
  const instanceId = "a".repeat(32), createdAt = Date.now();
  await writeFile(`${f.options.lockFile}.guard`, JSON.stringify({ version: 1, instanceId, pid: process.pid, createdAt }), { mode: 0o600 });
  await writeFile(join(f.privateDir, "startup.json"), JSON.stringify({ version: 1, instanceId, createdAt, secret: "s".repeat(43), options: f.options }), { mode: 0o600 });
  const server = f.startServer();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([server.exited, new Promise(resolve => { timer = setTimeout(() => resolve("still-running"), 1500); })]); clearTimeout(timer);
  expect(code).toBe(1);
  await expect(readFile(f.options.lockFile)).rejects.toThrow();
  expect(await readFile(join(f.root, "participant-stopped"), "utf8")).toBe("1");
  expect(JSON.parse(await readFile(`${f.options.lockFile}.guard`, "utf8")).instanceId).toBe("b".repeat(32));
});

it("startup rejects stale guards and corrupt root records", async () => {
  const fixtureUrl = new URL("./fixtures/dashboard-process.mjs", import.meta.url).href;
  const h = await import(/* @vite-ignore */ fixtureUrl); processFixtures ??= await h.processFixtures();
  for (const corrupt of ["stale-guard", "foreign-guard", "stale-startup", "relative-root", "oversized"]) {
    const f = await processFixtures.fixture(); const instanceId = "a".repeat(32), now = Date.now();
    const guard = { version: 1, instanceId: corrupt === "foreign-guard" ? "b".repeat(32) : instanceId,
      pid: process.pid, createdAt: corrupt === "stale-guard" ? now - 10000 : now };
    const record = { version: 1, instanceId, secret: "s".repeat(43), createdAt: corrupt === "stale-startup" ? now - 10000 : now,
      options: { ...f.options, roots: { ...f.options.roots, ...(corrupt === "relative-root" ? { ledgerFile: "relative.db" } : {}) } } };
    await writeFile(`${f.options.lockFile}.guard`, JSON.stringify(guard), { mode: 0o600 });
    await writeFile(join(f.privateDir, "startup.json"), corrupt === "oversized" ? "x".repeat(16385) : JSON.stringify(record), { mode: 0o600 });
    const server = f.startServer();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([server.exited, new Promise(resolve => { timer = setTimeout(() => resolve("still-running"), 1500); })]); clearTimeout(timer);
    expect(code, corrupt).toBe(1);
    await expect(readFile(f.options.lockFile)).rejects.toThrow();
    expect(JSON.parse(await readFile(`${f.options.lockFile}.guard`, "utf8"))).toEqual(guard);
    expect(await readFile(join(f.privateDir, "crash.log"), "utf8")).toMatch(/^usage-server-startup-invalid \d+\n$/);
  }
});

it("idle and signals stop optional participant", async () => {
  // Losing the idle close callback, idempotent close or bounded participant stop leaves a lease/process behind.
  const fixtureUrl = new URL("./fixtures/dashboard-process.mjs", import.meta.url).href;
  const h = await import(/* @vite-ignore */ fixtureUrl); processFixtures ??= await h.processFixtures();
  for (const mode of ["idle", "SIGTERM", "SIGINT", "hung"]) {
    const f = await processFixtures.fixture({ SPIDER_FIXTURE_PARTICIPANT: "1", SPIDER_FIXTURE_IDLE: mode === "idle" ? "1" : "",
      SPIDER_FIXTURE_HANG_STOP: mode === "hung" ? "1" : "" });
    const launched = await f.start("launch").exited; expect(launched.code, launched.stderr).toBe(0);
    const lock = JSON.parse(await readFile(f.options.lockFile, "utf8")); f.pids.add(lock.pid);
    const stoppingAt = Date.now();
    if (mode !== "idle") { process.kill(lock.pid, mode === "hung" ? "SIGTERM" : mode as NodeJS.Signals); }
    await h.waitFor(async () => { try { return await readFile(join(f.root, "participant-stopped"), "utf8"); } catch { return undefined; } }, USAGE_REPLACEMENT_GRACE_MS + 3000);
    expect(await readFile(join(f.root, "participant-stopped"), "utf8")).toBe("1");
    await h.waitFor(async () => { try { await readFile(join(f.root, "fixture-lease")); return false; } catch { return true; } }, USAGE_REPLACEMENT_GRACE_MS + 3000);
    await expect(readFile(join(f.root, "fixture-lease"))).rejects.toThrow();
    await h.waitFor(async () => { try { await readFile(f.options.lockFile); return false; } catch { return true; } }, USAGE_REPLACEMENT_GRACE_MS + 3000);
    await h.waitFor(async () => { try { await h.reply(lock.port, "/api/status"); return false; } catch { return true; } }, USAGE_REPLACEMENT_GRACE_MS + 3000);
    await h.waitFor(async () => { try { process.kill(lock.pid, 0); return false; } catch { return true; } }, USAGE_REPLACEMENT_GRACE_MS + 3000);
    expect(Date.now() - stoppingAt).toBeLessThan(USAGE_HTTP_DRAIN_MS + USAGE_PARTICIPANT_STOP_MS + 3000);
  }
});

it("import and worker entry are inert", async () => {
  // Losing the direct-main or main-thread check would let a shim import or ingest worker bind HTTP.
  const m = await import("../server-entry.js").catch(() => undefined);
  expect(m, "server entry implementation exists").toBeDefined();
  const scratch = resolve(".spider/scratch/usage-ui"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "server-entry-")); dirs.push(root);
  const url = pathToFileURL(join(root, "bundle.mjs")).href;
  expect(m!.isUsageServerMain(url, ["node", join(root, "bundle.mjs")], true)).toBe(false);
  expect(m!.isUsageServerMain(url, ["node", join(root, "other.mjs"), "--spider-usage-server", join(root, "startup.json")], true)).toBe(false);
  expect(m!.isUsageServerMain(url, ["node", join(root, "bundle.mjs"), "--spider-usage-server", join(root, "startup.json")], false)).toBe(false);
  expect(m!.isUsageServerMain(url, ["node", join(root, "bundle.mjs"), "--spider-usage-server", join(root, "startup.json")], true)).toBe(true);
  expect(m!.isUsageServerMain(join(root, "bundle.mjs"), ["node", join(root, "bundle.mjs"), "--spider-usage-server", join(root, "startup.json")], true)).toBe(true);
  const spaced = join(root, "bundle with spaces.mjs");
  for (const moduleUrl of [spaced, pathToFileURL(spaced), pathToFileURL(spaced).href]) {
    expect(m!.isUsageServerMain(moduleUrl, ["node", spaced, "--spider-usage-server", join(root, "startup.json")], true)).toBe(true);
  }
  expect(m!.isUsageServerMain("https://example.test/bundle.mjs", ["node", resolve("https://example.test/bundle.mjs"), "--spider-usage-server", join(root, "startup.json")], true)).toBe(false);
  await m!.runUsageServerEntry(url, { dashboardDir: join(root, "dashboard") }); // Vitest's argv is not direct-main.
  expect(await readdir(root)).toEqual([]);
  const fixtureUrl = new URL("./fixtures/dashboard-process.mjs", import.meta.url).href;
  const h = await import(/* @vite-ignore */ fixtureUrl); processFixtures ??= await h.processFixtures();
  const f = await processFixtures.fixture();
  expect((await f.start("import").exited).code).toBe(0);
  const worker = new Worker(processFixtures.built, { argv: ["--spider-usage-server", join(f.privateDir, "startup.json")], env: f.env });
  workers.add(worker);
  expect(await new Promise((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); })).toBe(0);
  expect(await readdir(f.privateDir)).toEqual([]);
});


it("startup record cannot override idle policy or pass arbitrary boot options", async () => {
  const h = await import(/* @vite-ignore */ new URL("./fixtures/dashboard-process.mjs", import.meta.url).href);
  processFixtures ??= await h.processFixtures(); const f = await processFixtures.fixture();
  const instanceId = "a".repeat(32), createdAt = Date.now();
  await writeFile(`${f.options.lockFile}.guard`, JSON.stringify({ version: 1, instanceId, pid: process.pid, createdAt }), { mode: 0o600 });
  await writeFile(join(f.privateDir, "startup.json"), JSON.stringify({ version: 1, instanceId, createdAt, secret: "s".repeat(43), options: { ...f.options, idleMs: 50 } }), { mode: 0o600 });
  const child = f.startServer();
  const lock = await h.waitFor(async () => { try { return JSON.parse(await readFile(f.options.lockFile, "utf8")); } catch { return undefined; } });
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(child.child.exitCode).toBeNull(); expect(child.child.signalCode).toBeNull();
  expect((await h.reply(lock.port, "/local/bootstrap-nonce", { Authorization: `Bearer ${lock.secret}` })).status).toBe(200);
  await expect(readFile(join(f.privateDir, "startup.json"))).rejects.toThrow();
});
