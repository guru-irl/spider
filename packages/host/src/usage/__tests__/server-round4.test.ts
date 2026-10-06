import { afterAll, afterEach, expect, it, vi } from "vitest";
import { access, chmod, link, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import * as fs from "node:fs";
import * as http from "node:http";
import { join } from "node:path";
import * as runtime from "../server-runtime.js";
import * as lock from "../server-lock.js";
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));
vi.mock("node:http", async original => ({ ...await original<typeof import("node:http")>() }));
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
async function launched(f: any, overrides?: any) {
  const result = await f.start("launch", overrides).exited;
  expect(result.code, result.stderr).toBe(0);
  const row = JSON.parse(result.stdout); f.pids.add(row.pid); return row;
}
async function marker(f: any, build: string) {
  const file = join(f.privateDir, "replace-intent.json");
  await lock.writeServerRecord(file, { version: 1, instanceId: "a".repeat(32), serverBuild: build,
    pid: process.pid, processIdentity: await runtime.usageProcessIdentity(process.pid), expiresAt: Date.now() + 10000 });
  return file;
}
const NEWEST = "synthetic@2026-10-07T00:00:00Z";
for (const kind of ["cold mixed builds", "two newer builds", "staggered newer builds"]) {
  it(`${kind}: six bounded rounds return zero dead URLs and finish on the newest build`, async () => {
    for (let round = 0; round < 6; round++) {
      const { h, f } = await setup();
      const newUrl = await fixtures.buildBundle(h.NEW_BUILD), newestUrl = await fixtures.buildBundle(NEWEST);
      if (kind !== "cold mixed builds") await launched(f);
      const n1 = { bundleUrl: newUrl, serverBuild: h.NEW_BUILD }, n2 = { bundleUrl: newestUrl, serverBuild: NEWEST };
      let rows: any[];
      if (kind === "staggered newer builds") {
        const a = launched(f, n1);
        await new Promise(resolve => setTimeout(resolve, round * 30));
        rows = await Promise.all([a, launched(f, n2)]);
      } else {
        const order = kind === "cold mixed builds" ? [undefined, n1, undefined, n1, undefined, undefined] : [n1, undefined, n2, undefined, n1, n2, undefined, undefined];
        rows = await Promise.all(order.map(o => launched(f, o)));
      }
      const expected = kind === "cold mixed builds" ? h.NEW_BUILD : NEWEST;
      expect(JSON.parse(await readFile(f.options.lockFile, "utf8")).serverBuild).toBe(expected);
      expect(new Set(rows.map(r => r.pid)).size, `round ${round}`).toBe(1);
      for (const row of rows) {
        const u = new URL(row.bootstrapUrl);
        expect((await h.reply(row.port, u.pathname + u.search)).status, `round ${round}`).toBe(303);
      }
      await fixtures.cleanup();
    }
  }, 90000);
}
it("cold start advertises intent before entering an occupied launch guard", async () => {
  const { h, f } = await setup();
  const guard = `${f.options.lockFile}.guard`;
  await lock.writeServerRecord(guard, { instanceId: "b".repeat(32), pid: process.pid, processIdentity: await runtime.usageProcessIdentity(process.pid), createdAt: Date.now() }, true);
  const launch = launched(f);
  let intent;
  try { intent = await h.waitFor(async () => JSON.parse(await readFile(join(f.privateDir, "replace-intent.json"), "utf8").catch(() => "null")), 1500).catch(() => undefined); }
  finally { unlinkSync(guard); }
  await launch;
  expect(intent?.serverBuild).toBe(h.OLD_BUILD);
}, 10000);
it("a stalled newer marker over the full launch deadline mints zero bootstrap nonces", async () => {
  const { h, f } = await setup(); await launched(f); isolate(f); await marker(f, h.NEW_BUILD);
  const request = vi.spyOn(http, "request");
  const error = await runtime.ensureUsageServer(f.options).catch(error => error);
  expect(request.mock.calls.filter(([options]) => typeof options === "object" && "path" in options && options.path === "/local/bootstrap-nonce")).toHaveLength(0);
  expect(error.message).toBe("usage-server-busy");
}, 10000);
it("an equal-build marker does not stall reuse", async () => {
  const { h, f } = await setup(); const first = await launched(f); await marker(f, h.OLD_BUILD);
  const start = Date.now(), next = await launched(f);
  expect(next.pid).toBe(first.pid); expect(next.reused).toBe(true); expect(Date.now() - start).toBeLessThan(3000);
}, 10000);
it("EPERM for a recorded lock owner permits a fresh server", async () => {
  const { f } = await setup(); isolate(f);
  await lock.writeServerRecord(f.options.lockFile, { version: 1, instanceId: "a".repeat(32), pid: 99999998, port: 12345, secret: "a".repeat(43), processIdentity: "old-birth" });
  const original = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === 99999998 && signal === 0) throw Object.assign(new Error("foreign owner"), { code: "EPERM" });
    return original(pid, signal);
  });
  const row = await runtime.ensureUsageServer(f.options); f.pids.add(row.pid);
  expect(row.reused).toBe(false); expect(row.pid).not.toBe(99999998);
}, 10000);
it.each(["wrong-mode", "hard-linked", "symlink"])("a %s marker is swept under the guard and newer launches succeed", async kind => {
  const { h, f } = await setup(); await launched(f);
  const file = await marker(f, h.NEW_BUILD), outside = join(f.root, "untouched-marker");
  if (kind === "wrong-mode") await chmod(file, 0o644);
  if (kind === "hard-linked") await link(file, outside);
  if (kind === "symlink") { await writeFile(outside, "untouched"); unlinkSync(file); await symlink(outside, file); }
  const bundleUrl = await fixtures.buildBundle(h.NEW_BUILD);
  const row = await launched(f, { bundleUrl, serverBuild: h.NEW_BUILD }); expect(row.serverBuild).toBe(h.NEW_BUILD);
  await expect(access(file)).rejects.toThrow();
  if (kind === "symlink") expect(await readFile(outside, "utf8")).toBe("untouched");
}, 10000);
it.each(["processIdentity", "serverBuild"])("intent compare-and-delete preserves a successor with a changed %s", async key => {
  const { h, f } = await setup(); const file = await marker(f, h.NEW_BUILD);
  const owned = await lock.readServerRecord(file);
  const successor = { ...owned, [key]: "successor" };
  await lock.writeServerRecord(file, successor);
  expect(await lock.removeServerIntent(file, owned)).toBe(false);
  expect(await lock.readServerRecord(file)).toEqual(successor);
});
it("intent cleanup rechecks the moved inode and restores a raced successor", async () => {
  const { h, f } = await setup(); const file = await marker(f, h.NEW_BUILD);
  const owned = await lock.readServerRecord(file), successor = { ...owned, instanceId: "b".repeat(32) };
  const rename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (from === file && String(to).includes(".reclaim-")) {
      fs.unlinkSync(file); fs.writeFileSync(file, JSON.stringify(successor), { mode: 0o600 });
    }
    rename(from, to);
  });
  expect(await lock.removeServerIntent(file, owned)).toBe(false);
  expect(await lock.readServerRecord(file)).toEqual(successor);
});
it("expired marker temp files are swept but fresh marker temps remain", async () => {
  const { f } = await setup(); await launched(f);
  const old = join(f.privateDir, `replace-intent.json.${"a".repeat(32)}`), fresh = join(f.privateDir, `replace-intent.json.${"b".repeat(32)}`);
  for (const file of [old, fresh]) await writeFile(file, JSON.stringify({ instanceId: "a".repeat(32), pid: process.pid, processIdentity: await runtime.usageProcessIdentity(process.pid), serverBuild: f.options.serverBuild }), { mode: 0o600 });
  await utimes(old, new Date(0), new Date(0));
  await launched(f);
  await expect(access(old)).rejects.toThrow(); await access(fresh);
});
