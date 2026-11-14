import { afterAll, afterEach, expect, it, vi } from "vitest";
import { access, utimes, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import * as fs from "node:fs";
import { join } from "node:path";
import * as runtime from "../server-runtime.js";
import * as lock from "../server-lock.js";
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));
let fixtures: any;
async function setup() {
  const h = await import(/* @vite-ignore */ new URL("./fixtures/dashboard-process.mjs", import.meta.url).href);
  fixtures ??= await h.processFixtures();
  return { h, f: await fixtures.fixture() };
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fixtures?.cleanup(); });
afterAll(async () => { await fixtures?.dispose(); });
function isolate(f: any) {
  for (const key of ["HOME", "SPIDER_GLOBAL_ROOT", "PI_CODING_AGENT_DIR", "SPIDER_FIXTURE_OBSERVED"]) vi.stubEnv(key, f.env[key]);
}

it("starts the server when a listed temporary intent disappears", async () => {
  const { h, f } = await setup(); isolate(f);
  const disappearing = join(f.privateDir, `replace-intent.json.${"a".repeat(32)}`);
  const stale = join(f.privateDir, `crash.log.${"b".repeat(32)}`);
  await writeFile(disappearing, "temporary", { mode: 0o600 });
  await writeFile(stale, "temporary", { mode: 0o600 });
  await utimes(stale, new Date(0), new Date(0));
  const lstat = fs.lstatSync as any, readdir = fs.readdirSync as any;
  // List the vanishing record first, so the stale record proves the sweep keeps going.
  vi.spyOn(fs, "readdirSync").mockImplementation(((dir: fs.PathLike, options?: any) => {
    const names = readdir(dir, options);
    if (dir !== f.privateDir || options !== undefined) return names;
    const first = `replace-intent.json.${"a".repeat(32)}`;
    return [...names].sort((a: string, b: string) => Number(b === first) - Number(a === first));
  }) as typeof fs.readdirSync);
  vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: any) => {
    if (file === disappearing) unlinkSync(disappearing);
    return lstat(file, options);
  }) as typeof fs.lstatSync);
  const row = await runtime.ensureUsageServer(f.options, { deadlineMs: h.FIXTURE_LAUNCH_DEADLINE_MS });
  f.pids.add(row.pid);
  await expect(access(stale)).rejects.toThrow();
  const url = new URL(row.bootstrapUrl);
  expect((await h.reply(row.port, url.pathname + url.search)).status).toBe(303);
});

it("sweeps a malformed published intent and starts the server", async () => {
  const { h, f } = await setup(); isolate(f);
  const file = join(f.privateDir, "replace-intent.json");
  await writeFile(file, "{malformed", { mode: 0o600 });
  const row = await runtime.ensureUsageServer(f.options, { deadlineMs: h.FIXTURE_LAUNCH_DEADLINE_MS });
  f.pids.add(row.pid);
  await expect(access(file)).rejects.toThrow();
  const url = new URL(row.bootstrapUrl);
  expect((await h.reply(row.port, url.pathname + url.search)).status).toBe(303);
});

it("does not ignore a server directory removed during the sweep", async () => {
  const { f } = await setup();
  const file = join(f.privateDir, `replace-intent.json.${"a".repeat(32)}`);
  await writeFile(file, "temporary", { mode: 0o600 });
  const lstat = fs.lstatSync as any;
  vi.spyOn(fs, "lstatSync").mockImplementation(((name: fs.PathLike, options?: any) => {
    if (name === file) fs.rmSync(f.privateDir, { recursive: true });
    return lstat(name, options);
  }) as typeof fs.lstatSync);
  await expect(lock.sweepServerRecordTemps(f.privateDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it("propagates non-missing temporary record stat errors", async () => {
  const { f } = await setup();
  const file = join(f.privateDir, `replace-intent.json.${"a".repeat(32)}`);
  await writeFile(file, "temporary", { mode: 0o600 });
  const lstat = fs.lstatSync as any;
  vi.spyOn(fs, "lstatSync").mockImplementation(((name: fs.PathLike, options?: any) => {
    if (name === file) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return lstat(name, options);
  }) as typeof fs.lstatSync);
  await expect(lock.sweepServerRecordTemps(f.privateDir)).rejects.toMatchObject({ code: "EACCES" });
});
