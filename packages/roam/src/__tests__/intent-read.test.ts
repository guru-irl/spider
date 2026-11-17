import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { hash } from "@spider/herdr/sessions/registry";
import { createIntentStore, inspectIntentReservations, inspectSuspendedIntents, type IntentState } from "../intent";

vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const base = resolve(".spider/scratch/intent-read");
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(join(base, "case-")); roots.push(root);
  const state: IntentState = { intent: { sessionId: "session-1", epoch: 2, desired: "running", suspended: null,
    file: join(root, "session.jsonl"), cwd: root, moveId: "move-1" }, failures: [],
    supervision: { kind: "launching", operationId: "launch-1", phase: "reserved" } };
  const store = createIntentStore(root), file = join(root, "roam", "intents", `${hash("session-1")}.json`);
  await store.update("session-1", null, state);
  return { root, state, store, file };
}

it.each(["get", "list", "reservations", "suspensions"] as const)("%s reopens an inode replaced between lookup and metadata inspection", async reader => {
  const f = await fixture(), originalLstat = fs.lstat, originalOpen = fs.open;
  const next: IntentState = { ...f.state, intent: { ...f.state.intent, suspended: "operator stop" },
    supervision: { kind: "launching", operationId: "launch-2", phase: "reserved" } };
  let armed = true, retiredLinks: number | undefined;
  // Model lookup retaining the old inode while the real writer publishes its replacement.
  const replace = async () => {
    armed = false;
    const handle = await originalOpen(f.file, "r");
    await f.store.update("session-1", 1, next);
    retiredLinks = (await handle.stat()).nlink;
    return handle;
  };
  vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === f.file && armed) {
      const handle = await replace();
      try { return await handle.stat(); } finally { await handle.close(); }
    }
    return originalLstat(...args);
  }) as typeof fs.lstat);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => String(args[0]) === f.file && armed ? replace() : originalOpen(...args));
  if (reader === "get") expect(await f.store.get("session-1")).toEqual({ version: 2, value: next });
  else if (reader === "list") expect(await f.store.list()).toEqual(["session-1"]);
  else if (reader === "reservations") expect(await inspectIntentReservations(f.root)).toEqual([
    { sessionId: "session-1", file: f.state.intent.file, operationId: "launch-2", phase: "reserved" },
  ]);
  else expect(await inspectSuspendedIntents(f.root)).toEqual([{ sessionId: "session-1", reason: "operator stop" }]);
  expect(retiredLinks).toBe(0);
});

it("validates the inode it reads when an unsafe replacement follows the pathname check", async () => {
  const f = await fixture(), originalOpen = fs.open, replacement = join(f.root, "replacement.json");
  await fs.writeFile(replacement, JSON.stringify({ version: 2, value: f.state }), { mode: 0o600 });
  let armed = true;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]) === f.file && armed) {
      armed = false;
      await fs.unlink(f.file); await fs.link(replacement, f.file);
    }
    return originalOpen(...args);
  });
  await expect(f.store.get("session-1")).rejects.toThrow("Unsafe hosting state file");
  expect((await fs.lstat(replacement)).nlink).toBe(2);
});

it.each(["get", "list", "reservations", "suspensions"] as const)("%s refuses a linked state file without repairing it", async reader => {
  const f = await fixture(), alias = join(f.root, "alias.json");
  await fs.chmod(f.file, 0o640);
  await fs.link(f.file, alias);
  const read = () => reader === "get" ? f.store.get("session-1") : reader === "list" ? f.store.list()
    : reader === "reservations" ? inspectIntentReservations(f.root) : inspectSuspendedIntents(f.root);
  await expect(read()).rejects.toThrow("Unsafe hosting state file");
  expect((await fs.lstat(alias)).nlink).toBe(2);
  expect((await fs.lstat(alias)).mode & 0o7777).toBe(0o640);
  expect(JSON.parse(await fs.readFile(alias, "utf8"))).toEqual({ version: 1, value: f.state });
});

it.skipIf(process.platform === "win32").each(["get", "list", "reservations", "suspensions"] as const)("%s refuses an intent inode owned by another user", async reader => {
  const f = await fixture(), originalLstat = fs.lstat, originalOpen = fs.open;
  vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    const info = await originalLstat(...args);
    if (String(args[0]) === f.file) Object.assign(info, { uid: Number(info.uid) + 1 });
    return info;
  }) as typeof fs.lstat);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === f.file) {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation((async () => {
        const info = await stat(); return Object.assign(info, { uid: info.uid + 1 });
      }) as typeof handle.stat);
    }
    return handle;
  });
  const read = () => reader === "get" ? f.store.get("session-1") : reader === "list" ? f.store.list()
    : reader === "reservations" ? inspectIntentReservations(f.root) : inspectSuspendedIntents(f.root);
  await expect(read()).rejects.toThrow("Unsafe hosting state file");
});

it.skipIf(process.platform === "win32")("repairs modes only through a mutable intent read", async () => {
  const f = await fixture();
  await fs.chmod(f.file, 0o640);
  await expect(inspectIntentReservations(f.root)).rejects.toThrow();
  expect((await fs.lstat(f.file)).mode & 0o7777).toBe(0o640);
  expect(await f.store.get("session-1")).toEqual({ version: 1, value: f.state });
  expect((await fs.lstat(f.file)).mode & 0o7777).toBe(0o600);
});

it.each(["symlink", "directory"] as const)("refuses a %s in place of an intent file", async replacement => {
  const f = await fixture(), target = join(f.root, "target.json");
  await fs.rename(f.file, target);
  if (replacement === "symlink") await fs.symlink(target, f.file);
  else await fs.mkdir(f.file, { mode: 0o700 });
  if (replacement === "symlink") await expect(f.store.get("session-1")).rejects.toMatchObject({ code: "ELOOP" });
  else await expect(f.store.get("session-1")).rejects.toThrow("Unsafe hosting state file");
  expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ version: 1, value: f.state });
});


it("refuses a retired inode after exactly three opens without reading it", async () => {
  const f = await fixture(), originalOpen = fs.open;
  let opens = 0, reads = 0;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === f.file) {
      if (++opens > 3) { await handle.close(); throw new Error("Retry exceeded three opens"); }
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation((async () => Object.assign(await stat(), { nlink: 0 })) as typeof handle.stat);
      const read = handle.readFile.bind(handle);
      vi.spyOn(handle, "readFile").mockImplementation((async (...args: Parameters<typeof handle.readFile>) => { reads++; return read(...args); }) as typeof handle.readFile);
    }
    return handle;
  });
  await expect(f.store.get("session-1")).rejects.toThrow("Hosting state file replaced during read");
  expect(opens).toBe(3);
  expect(reads).toBe(0);
});

it.skipIf(process.platform === "win32")("refuses a real FIFO intent without waiting for a writer", async () => {
  const f = await fixture(), originalOpen = fs.open;
  await fs.unlink(f.file); execFileSync("mkfifo", [f.file]);
  let blocking = false;
  // Refuse the unsafe syscall in the negative control so a regression cannot hang the test worker.
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]) === f.file && (Number(args[1]) & constants.O_NONBLOCK) === 0) {
      blocking = true; throw new Error("Blocking FIFO open refused by test");
    }
    return originalOpen(...args);
  });
  await expect(f.store.get("session-1")).rejects.toThrow("Unsafe hosting state file");
  expect(blocking).toBe(false);
  expect((await fs.lstat(f.file)).isFIFO()).toBe(true);
});
