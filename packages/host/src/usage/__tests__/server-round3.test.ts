import { afterAll, afterEach, expect, it, vi } from "vitest";
import { readFile, writeFile, stat, access } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import * as cp from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import * as runtime from "../server-runtime.js";
import * as lock from "../server-lock.js";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>() }));
let fixtures: any;
async function setup(env = {}) {
  const h = await import(/* @vite-ignore */ new URL("./fixtures/dashboard-process.mjs", import.meta.url).href);
  fixtures ??= await h.processFixtures();
  return { h, f: await fixtures.fixture(env) };
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fixtures?.cleanup(); });
afterAll(async () => { await fixtures?.dispose(); });
function isolate(f: any) {
  for (const key of ["HOME", "SPIDER_GLOBAL_ROOT", "PI_CODING_AGENT_DIR", "SPIDER_FIXTURE_OBSERVED"]) vi.stubEnv(key, f.env[key]);
}
async function launched(f: any, overrides?: any) {
  const result = await f.start("launch", overrides).exited;
  expect(result.code, result.stderr).toBe(0);
  const row = JSON.parse(result.stdout); f.pids.add(row.pid); return row;
}

it("a failed capability probe is retried rather than poisoning subsequent launches", async () => {
  vi.resetModules();
  const fresh = await import("../server-runtime.js");
  expect(await fresh.usableUsageNode(Date.now() - 1)).toBe(false);
  expect(await fresh.usableUsageNode(Date.now() + 5000)).toBe(true);
});

it.skipIf(process.getuid?.() === 0).each(["recycled", null])("pid 1 EPERM guards are reclaimed with birth identity %s (requires non-root: root can signal pid 1)", async processIdentity => {
  const { f } = await setup();
  const file = `${f.options.lockFile}.guard`;
  await writeFile(file, JSON.stringify({ pid: 1, processIdentity, instanceId: "a".repeat(32), createdAt: Date.now() }), { mode: 0o600 });
  // This reproduction requires an unprivileged user: pid 1 is owned by root.
  expect(() => process.kill(1, 0)).toThrow(expect.objectContaining({ code: "EPERM" }));
  const start = Date.now(); await launched(f);
  expect(Date.now() - start).toBeLessThan(4000);
}, 10000);

it("reusers yield to a live replacement intent published before guard acquisition", async () => {
  const { h, f } = await setup();
  const first = await launched(f), bundleUrl = await fixtures.buildBundle(h.NEW_BUILD);
  const guard = `${f.options.lockFile}.guard`, intent = join(f.privateDir, "replace-intent.json");
  await lock.writeServerRecord(guard, { instanceId: "a".repeat(32), pid: process.pid, processIdentity: await runtime.usageProcessIdentity(process.pid), createdAt: Date.now() }, true);
  // Start reusers first so they are already waiting when the newer launcher advertises intent.
  const reusers = [launched(f), launched(f)];
  const replacing = launched(f, { bundleUrl, serverBuild: h.NEW_BUILD });
  let marker: any, markerMode: number | undefined;
  try {
    marker = await h.waitFor(async () => { const row = JSON.parse(await readFile(intent, "utf8").catch(() => "null")); return row?.serverBuild === h.NEW_BUILD ? row : undefined; }, 2000).catch(() => undefined);
    if (marker) markerMode = (await stat(intent)).mode & 0o777;
  } finally { unlinkSync(guard); }
  const rows = await Promise.all([...reusers, replacing]);
  expect(marker, "replacement intent exists while waiting for guard").toBeDefined();
  expect(marker.serverBuild).toBe(h.NEW_BUILD);
  expect(marker.pid).toBeGreaterThan(0); expect(marker.processIdentity).toBeTypeOf("string");
  expect(marker.expiresAt - Date.now()).toBeGreaterThan(7000);
  expect(marker.expiresAt - Date.now()).toBeLessThanOrEqual(10000);
  expect(markerMode).toBe(0o600);
  expect(new Set(rows.map(r => r.pid)).size).toBe(1);
  expect(rows[0].pid).not.toBe(first.pid); expect(rows.filter(r => !r.reused)).toHaveLength(1);
  for (const row of rows) { const u = new URL(row.bootstrapUrl); expect((await h.reply(row.port, u.pathname + u.search)).status).toBe(303); }
  await expect(access(intent)).rejects.toThrow();
}, 15000);

it("reusers yield to a live replacement intent even when they win the guard first", async () => {
  const { h, f } = await setup(); const first = await launched(f), bundleUrl = await fixtures.buildBundle(h.NEW_BUILD); isolate(f);
  await lock.writeServerRecord(join(f.privateDir, "replace-intent.json"), { instanceId: "a".repeat(32), serverBuild: h.NEW_BUILD,
    pid: process.pid, processIdentity: await runtime.usageProcessIdentity(process.pid), expiresAt: Date.now() + 10000 });
  let returned = false;
  const reuse = runtime.ensureUsageServer(f.options).then(row => { returned = true; f.pids.add(row.pid); return row; });
  await new Promise(resolve => setTimeout(resolve, 300));
  const returnedBeforeReplacement = returned;
  const rows = await Promise.all([reuse, launched(f, { bundleUrl, serverBuild: h.NEW_BUILD })]);
  expect(returnedBeforeReplacement).toBe(false);
  expect(rows[0].pid).not.toBe(first.pid); expect(rows[0].pid).toBe(rows[1].pid);
  for (const row of rows) { const u = new URL(row.bootstrapUrl); expect((await h.reply(row.port, u.pathname + u.search)).status).toBe(303); }
}, 10000);

it.each(["expired", "dead", "recycled"])("%s replacement intent is ignored and swept under the guard", async kind => {
  const { h, f } = await setup(); const first = await launched(f);
  const file = join(f.privateDir, "replace-intent.json");
  await lock.writeServerRecord(file, { instanceId: "a".repeat(32), serverBuild: h.NEW_BUILD,
    pid: kind === "dead" ? 99999999 : process.pid, processIdentity: kind === "recycled" ? "old-birth" : await runtime.usageProcessIdentity(process.pid),
    expiresAt: Date.now() + (kind === "expired" ? -1 : 10000) });
  const next = await launched(f); expect(next.pid).toBe(first.pid); expect(next.reused).toBe(true);
  await expect(access(file)).rejects.toThrow();
}, 10000);

it("a stalled identity-matched owner fails busy without starting a second server", async () => {
  const { f } = await setup(); const first = await launched(f);
  process.kill(first.pid, "SIGSTOP");
  try {
    const start = Date.now(), result = await f.start("launch").exited;
    expect(result.code).toBe(1); expect(result.stderr).toContain("usage-server-busy");
    expect(Date.now() - start).toBeGreaterThanOrEqual(4500); expect(Date.now() - start).toBeLessThan(5500);
    expect(JSON.parse(await readFile(f.options.lockFile, "utf8")).pid).toBe(first.pid);
    expect(await runtime.readUsageServerCrashCodes(f.privateDir)).toEqual(["usage-server-busy"]);
  } finally { process.kill(first.pid, "SIGCONT"); }
}, 10000);

it.skipIf(process.platform === "linux")("unavailable final birth probe never permits a second live server", async () => {
  const { h, f } = await setup(); const first = await launched(f), bundleUrl = await fixtures.buildBundle(h.NEW_BUILD); isolate(f);
  const original = cp.execFile as any, custom = original[promisify.custom]; let probes = 0;
  const exec = vi.spyOn(cp, "execFile");
  Object.defineProperty(exec, promisify.custom, { value: (file: string, args: string[], options: object) => {
    if (args[1] === String(first.pid) && ++probes >= 2) return Promise.resolve({ stdout: "", stderr: "" });
    return custom(file, args, options);
  } });
  await expect(runtime.ensureUsageServer({ ...f.options, bundleUrl, serverBuild: h.NEW_BUILD })).rejects.toThrow("usage-server-busy");
  expect(JSON.parse(await readFile(f.options.lockFile, "utf8")).pid).toBe(first.pid);
}, 10000);

it("replacement must observe owner exit even when a kill attempt has no effect", async () => {
  const { h, f } = await setup({ SPIDER_FIXTURE_IGNORE_TERM: "1" });
  const first = await launched(f), bundleUrl = await fixtures.buildBundle(h.NEW_BUILD); isolate(f);
  const kill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => pid === -first.pid && signal === "SIGKILL" ? true : kill(pid, signal));
  await expect(runtime.ensureUsageServer({ ...f.options, bundleUrl, serverBuild: h.NEW_BUILD })).rejects.toThrow("usage-server-busy");
  expect(JSON.parse(await readFile(f.options.lockFile, "utf8")).pid).toBe(first.pid);
  await expect(access(join(f.privateDir, "replace-intent.json"))).rejects.toThrow();
}, 10000);

it("health retry reuses the live owner once its main thread resumes", async () => {
  const { f } = await setup(); const first = await launched(f);
  process.kill(first.pid, "SIGSTOP");
  const resume = setTimeout(() => process.kill(first.pid, "SIGCONT"), 1200);
  try { const next = await launched(f); expect(next.pid).toBe(first.pid); expect(next.reused).toBe(true); }
  finally { clearTimeout(resume); try { process.kill(first.pid, "SIGCONT"); } catch {} }
}, 10000);

it("lock build must match the authenticated self-reported build", async () => {
  const { h, f } = await setup(); const first = await launched(f);
  const record = JSON.parse(await readFile(f.options.lockFile, "utf8"));
  await writeFile(f.options.lockFile, JSON.stringify({ ...record, serverBuild: h.NEW_BUILD }), { mode: 0o600 });
  const result = await f.start("launch").exited;
  expect(result.code).toBe(1); expect(result.stderr).toContain("usage-server-busy");
  expect(JSON.parse(await readFile(f.options.lockFile, "utf8")).pid).toBe(first.pid);
}, 10000);

it("UTC offsets representing an older instant cannot trigger replacement", async () => {
  const { h, f } = await setup(), bundleUrl = await fixtures.buildBundle(h.NEW_BUILD);
  const first = await launched(f, { bundleUrl, serverBuild: h.NEW_BUILD });
  const next = await launched(f, { serverBuild: "synthetic@2026-10-06T00:30:00+01:00" });
  expect(next.pid).toBe(first.pid); expect(next.reused).toBe(true);
}, 10000);

it("unparseable launcher build emits one fixed crash code and disables upgrades", async () => {
  const { f } = await setup(); const first = await launched(f); isolate(f);
  for (let i = 0; i < 2; i++) {
    const row = await runtime.ensureUsageServer({ ...f.options, serverBuild: "bad-label" });
    expect(row.pid).toBe(first.pid); expect(row.reused).toBe(true);
  }
  expect(await runtime.readUsageServerCrashCodes(f.privateDir)).toEqual(["usage-server-build-invalid"]);
});
