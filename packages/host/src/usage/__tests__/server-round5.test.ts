import { afterAll, afterEach, expect, it, vi } from "vitest";
import * as cp from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, utimes } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as runtime from "../server-runtime.js";
import * as lock from "../server-lock.js";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>() }));
vi.mock("../server-lock.js", async original => ({ ...await original<typeof import("../server-lock.js")>() }));
let fixtures: any;
async function setup(env = {}) {
  const h = await import(/* @vite-ignore */ new URL("./fixtures/dashboard-process.mjs", import.meta.url).href);
  fixtures ??= await h.processFixtures();
  const f = await fixtures.fixture(env);
  for (const key of ["HOME", "SPIDER_GLOBAL_ROOT", "PI_CODING_AGENT_DIR", "SPIDER_FIXTURE_OBSERVED"]) vi.stubEnv(key, f.env[key]);
  return { h, f };
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fixtures?.cleanup(); });
afterAll(async () => { await fixtures?.dispose(); });

it.skipIf(process.platform === "linux")("replacement keeps one guard owner past grace when a second launcher's birth lookup fails", async () => {
  // Removing replacement refresh lets B reclaim after 10 s and A overwrite B.
  // Model late authentication and slow ps with a clock, not scheduler-dependent sleeps.
  const { h, f } = await setup({ SPIDER_FIXTURE_IGNORE_TERM: "1" });
  const first = await f.start("launch").exited; expect(first.code, first.stderr).toBe(0);
  const old = JSON.parse(await readFile(f.options.lockFile, "utf8")); f.pids.add(old.pid);
  const bundleUrl = await fixtures.buildBundle(h.NEW_BUILD);
  const guard = `${f.options.lockFile}.guard`, realNow = Date.now.bind(Date), realKill = process.kill.bind(process);
  const execFile = cp.execFile as typeof cp.execFile & { [promisify.custom]: (...args: any[]) => Promise<any> };
  const actualExec = execFile[promisify.custom];
  let offset = 0, term = false, killed = false, acquiredAt = 0;
  let attempted = false, reclaimed: boolean | undefined, secondAcquired = false;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const write = lock.writeServerRecord;
  vi.spyOn(lock, "writeServerRecord").mockImplementation(async (file, record, exclusive, ...fence) => {
    await write(file, record, exclusive, ...fence);
    if (file === guard) await utimes(file, new Date(Date.now()), new Date(Date.now()));
  });
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: any) => {
    if (pid === old.pid && signal === "SIGTERM") {
      acquiredAt = JSON.parse(readFileSync(guard, "utf8")).createdAt;
      term = true; offset = 3500;
    }
    if (pid === -old.pid && signal === "SIGKILL") { killed = true; offset = 0; }
    return realKill(pid, signal);
  }) as any);
  const exec = vi.spyOn(cp, "execFile");
  Object.defineProperty(exec, promisify.custom, { value: async (file: string, args: string[], options: any) => {
    if (file === "/bin/ps" && args[1] === String(old.pid) && args[3] === "lstart=" && term) {
      if (killed) return { stdout: "", stderr: "" };
      offset += 2500;
      if (!attempted && Date.now() - acquiredAt > 10050) {
        attempted = true;
        // B runs the real reclamation and exclusive acquisition with unknown birth.
        reclaimed = await lock.reclaimStaleServerRecord(guard, async () => undefined);
        try {
          await lock.writeServerRecord(guard, { version: 1, instanceId: "b".repeat(32), pid: process.pid,
            processIdentity: null, createdAt: Date.now() }, true);
          secondAcquired = true;
        } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("EEXIST"); }
      }
      return { stdout: old.processIdentity.slice("ps-utc:".length), stderr: "" };
    }
    return actualExec(file, args, options);
  } });
  const pending = runtime.ensureUsageServer({ ...f.options, bundleUrl, serverBuild: h.NEW_BUILD });
  await expect(pending).resolves.toMatchObject({ reused: false });
  const row = await pending; f.pids.add(row.pid);
  expect(attempted).toBe(true);
  expect(reclaimed, "B must not reclaim A's refreshed guard after a failed ps lookup").toBe(false);
  expect(secondAcquired).toBe(false);
  expect(row.reused).toBe(false); expect(row.pid).not.toBe(old.pid);
  expect(JSON.parse(await readFile(f.options.lockFile, "utf8")).pid).toBe(row.pid);
  const url = new URL(row.bootstrapUrl);
  expect((await h.reply(row.port, url.pathname + url.search)).status).toBe(303);
});

it.each(["instanceId", "createdAt"])("a successor with changed %s fences the final guard write and startup publication", async key => {
  // Checking only instanceId, or checking before an awaited writer, overwrites a successor.
  const { f } = await setup();
  const guard = `${f.options.lockFile}.guard`, write = lock.writeServerRecord;
  let successor: Record<string, unknown> | undefined;
  vi.spyOn(lock, "writeServerRecord").mockImplementation(async (file, record, exclusive, ...fence) => {
    if (file === guard && !exclusive && !successor) {
      const current = await lock.readServerRecord(guard);
      successor = { ...current, [key]: key === "instanceId" ? "b".repeat(32) : Number(current!.createdAt) + 1 };
      await write(guard, successor);
    }
    return write(file, record, exclusive, ...fence);
  });
  await expect(runtime.ensureUsageServer(f.options)).rejects.toThrow("usage-server-busy");
  expect(await lock.readServerRecord(guard)).toEqual(successor);
  await expect(access(join(f.privateDir, "startup.json"))).rejects.toThrow();
  await expect(access(f.options.lockFile)).rejects.toThrow();
});

it.each(["instanceId", "createdAt"])("startup publication preserves a successor with changed %s", async key => {
  // Omitting the startup writer's fence leaves our secret record under a foreign guard.
  const { f } = await setup();
  const guard = `${f.options.lockFile}.guard`, startup = join(f.privateDir, "startup.json"), write = lock.writeServerRecord;
  let successor: Record<string, unknown> | undefined;
  vi.spyOn(lock, "writeServerRecord").mockImplementation(async (file, record, exclusive, ...fence) => {
    if (file === startup) {
      const current = await lock.readServerRecord(guard);
      successor = { ...current, [key]: key === "instanceId" ? "b".repeat(32) : Number(current!.createdAt) + 1 };
      await write(guard, successor);
    }
    return write(file, record, exclusive, ...fence);
  });
  await expect(runtime.ensureUsageServer(f.options)).rejects.toThrow("usage-server-busy");
  expect(await lock.readServerRecord(guard)).toEqual(successor);
  await expect(access(startup)).rejects.toThrow();
  await expect(access(f.options.lockFile)).rejects.toThrow();
});

it.each(["instanceId", "createdAt"])("child lock publication rechecks a changed guard %s inside the writer", async key => {
  // A check before writeServerRecord's await does not fence the actual lock rename.
  const { h, f } = await setup();
  const { bootUsageServer } = await import("../server-entry.js");
  const instanceId = "a".repeat(32), createdAt = Date.now(), guard = `${f.options.lockFile}.guard`;
  await lock.writeServerRecord(guard, { version: 1, instanceId, pid: process.pid, createdAt });
  await lock.writeServerRecord(join(f.privateDir, "startup.json"), { version: 1, instanceId, createdAt, secret: "a".repeat(43) });
  const write = lock.writeServerRecord;
  let successor: Record<string, unknown> | undefined;
  vi.spyOn(lock, "writeServerRecord").mockImplementation(async (file, record, exclusive, ...fence) => {
    if (file === f.options.lockFile) {
      successor = { version: 1, instanceId, pid: process.pid, createdAt,
        [key]: key === "instanceId" ? "b".repeat(32) : createdAt + 1 };
      await write(guard, successor);
    }
    return write(file, record, exclusive, ...fence);
  });
  const listeners = process.listenerCount("SIGTERM");
  try { await expect(bootUsageServer({ ...f.options, instanceId })).rejects.toThrow("usage-server-startup-invalid"); }
  finally {
    if (process.listenerCount("SIGTERM") > listeners) {
      process.emit("SIGTERM", "SIGTERM");
      await h.waitFor(() => process.listenerCount("SIGTERM") === listeners);
    }
  }
  expect(await lock.readServerRecord(guard)).toEqual(successor);
  await expect(access(f.options.lockFile)).rejects.toThrow();
});

it("stale crash.log hex leftovers are swept without deleting fresh or unrelated files", async () => {
  // Omitting crash.log from the temp matcher leaves bounded private files forever.
  const { f } = await setup();
  const { writeFile, utimes } = await import("node:fs/promises");
  const old = join(f.privateDir, `crash.log.${"a".repeat(32)}`);
  const fresh = join(f.privateDir, `crash.log.${"b".repeat(32)}`), unrelated = join(f.privateDir, "crash.log.not-hex");
  for (const file of [old, fresh, unrelated]) await writeFile(file, "usage-server-crashed 1\n", { mode: 0o600 });
  await utimes(old, new Date(0), new Date(0));
  await lock.sweepServerRecordTemps(f.privateDir);
  await expect(access(old)).rejects.toThrow();
  await access(fresh); await access(unrelated);
});
