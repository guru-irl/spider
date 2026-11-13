import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createIntentStore, type IntentState } from "../intent";

let bundleRoot = "", crashRoot = "", crashState: IntentState, crashed: { exit: number | null; stderr: string };
beforeAll(async () => {
  const base = resolve(".spider/scratch/roam-intent");
  await mkdir(base, { recursive: true, mode: 0o700 });
  bundleRoot = await mkdtemp(join(base, "bundle-"));
  await build({ configFile: false, logLevel: "silent", build: { ssr: true, outDir: bundleRoot,
    rollupOptions: { input: resolve("packages/roam/src/intent.ts"), output: { entryFileNames: "intent.mjs" } } } });
  crashRoot = await mkdtemp(join(base, "crash-"));
  crashState = { intent: { sessionId: "session-1", epoch: 1, desired: "running", suspended: null,
    file: join(crashRoot, "session.jsonl"), cwd: crashRoot, moveId: null }, failures: [], supervision: { kind: "idle", nextAttemptAt: null } };
  await createIntentStore(crashRoot).update("session-1", null, crashState);
  const script = `import { createIntentStore } from ${JSON.stringify(pathToFileURL(join(bundleRoot, "intent.mjs")).href)};
    const root = process.env.FIXTURE_ROOT;
    const store = createIntentStore(root, { rename: async () => process.exit(77) });
    const row = await store.get('session-1');
    await store.update('session-1', row.version, { ...row.value, intent: { ...row.value.intent, desired: 'stopped' } });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, SPIDER_GLOBAL_ROOT: crashRoot, FIXTURE_ROOT: crashRoot, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = ""; child.stderr.on("data", bytes => { stderr += String(bytes); });
  const exit = await new Promise<number | null>((ok, fail) => { child.once("error", fail); child.once("close", ok); });
  crashed = { exit, stderr };
}, 30_000);
afterAll(async () => {
  if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true });
  if (crashRoot) await rm(crashRoot, { recursive: true, force: true });
});
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const base = resolve(".spider/scratch/roam-intent");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, "case-")); roots.push(root);
  return root;
}

it("stores intent durably and rejects a stale version without changing it", async () => {
  const moduleName = "../intent";
  const module = await import(moduleName).catch(() => undefined);
  expect(module?.createIntentStore).toBeTypeOf("function");
  if (!module) return;
  const root = await fixture();
  const store = module.createIntentStore(root);
  const state = {
    intent: { sessionId: "session-1", epoch: 1, desired: "running", suspended: null,
      file: join(root, "session.jsonl"), cwd: root, moveId: null },
    failures: [], supervision: { kind: "idle", nextAttemptAt: null },
  };
  expect(await store.list()).toEqual([]);
  expect(await store.update("session-1", null, state)).toEqual({ kind: "updated", version: 1 });
  const reopened = module.createIntentStore(root);
  expect(await reopened.list()).toEqual(["session-1"]);
  expect(await reopened.get("session-1")).toEqual({ version: 1, value: state });
  const stopped = { ...state, intent: { ...state.intent, desired: "stopped" } };
  expect(await reopened.update("session-1", 1, stopped)).toEqual({ kind: "updated", version: 2 });
  expect(await store.update("session-1", 1, state)).toEqual({ kind: "stale", currentVersion: 2 });
  expect(await store.get("session-1")).toEqual({ version: 2, value: stopped });
}, 5000);

it("keeps committed intent when publishing stops between the file write and rename", async () => {
  const moduleName = "../intent";
  const module = await import(moduleName);
  const root = await fixture();
  const store = module.createIntentStore(root);
  const state = {
    intent: { sessionId: "session-1", epoch: 1, desired: "running", suspended: null,
      file: join(root, "session.jsonl"), cwd: root, moveId: null },
    failures: [], supervision: { kind: "idle", nextAttemptAt: null },
  };
  await store.update("session-1", null, state);
  let observed = "";
  const interrupted = module.createIntentStore(root, { rename: async (temporary: string) => {
    expect((await lstat(temporary)).mode & 0o777).toBe(0o600);
    observed = await readFile(temporary, "utf8");
    throw new Error("interrupted before rename");
  } });
  const stopped = { ...state, intent: { ...state.intent, desired: "stopped" } };
  await expect(interrupted.update("session-1", 1, stopped)).rejects.toThrow("interrupted before rename");
  expect(JSON.parse(observed)).toMatchObject({ version: 2, value: stopped });
  expect(await module.createIntentStore(root).get("session-1")).toEqual({ version: 1, value: state });
  expect(await store.update("session-1", 1, stopped)).toEqual({ kind: "updated", version: 2 });
  expect(await store.get("session-1")).toEqual({ version: 2, value: stopped });
}, 5000);

it("recovers after the publishing process dies before rename", async () => {
  expect(crashed).toEqual({ exit: 77, stderr: "" });
  const store = createIntentStore(crashRoot);
  expect(await store.get("session-1")).toEqual({ version: 1, value: crashState });
  const stopped: IntentState = { ...crashState, intent: { ...crashState.intent, desired: "stopped" } };
  expect(await store.update("session-1", 1, stopped)).toEqual({ kind: "updated", version: 2 });
  expect((await store.get("session-1"))?.value.intent.desired).toBe("stopped");
}, 5000);
