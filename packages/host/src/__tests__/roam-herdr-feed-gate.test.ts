import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { clearActions } from "../dispatch";
import { LOADED_BUILD } from "../build-id";
import { mountedFixture } from "./herdr-wiring-fixture";
// Load the mount graph at collection, before either case starts its timer.
import "../herdr/mount.js";

type FixtureOptions = NonNullable<Parameters<typeof mountedFixture>[11]>;
type Fixture = Awaited<ReturnType<typeof mountedFixture>>;
let fixtureWork: { work: Promise<void>; signal: AbortSignal } | undefined;

function runFixture(signal: AbortSignal, options: FixtureOptions, check: (fixture: Fixture) => Promise<void>, requested = true): Promise<void> {
  const work = (async () => {
    const f = await mountedFixture("fake", "tui", true, false, true, false, requested, false, false, true, undefined, options);
    try { signal.throwIfAborted(); await check(f); }
    finally { await f.close(); }
  })();
  fixtureWork = { work, signal };
  return work;
}

async function drainFixture(): Promise<void> {
  const pending = fixtureWork;
  fixtureWork = undefined;
  if (!pending) return;
  try { await pending.work; }
  catch (error) { if (!pending.signal.aborted || error !== pending.signal.reason) throw error; }
}

afterEach(async () => {
  try { await drainFixture(); }
  finally { clearActions(); vi.unstubAllEnvs(); vi.restoreAllMocks(); }
});

it("a refused Herdr session records presence without contacting hc or publishing a feed", async ({ signal }) => {
  await runFixture(signal, { admitted: () => false, allowMissingFeed: true, fastInactive: true }, async f => {
    expect(f.owner).toBeNull();
    expect(await f.calls()).toEqual([]);
    expect(existsSync(f.feedPath)).toBe(false);
    expect(await f.presence.list()).toEqual([expect.objectContaining({ sessionId: f.h.owner!.sessionId, build: LOADED_BUILD })]);
  });
}, 5000);

it("a frozen mounted feed does not publish on rename or shutdown", async ({ signal }) => {
  let admitted = true;
  await runFixture(signal, { admitted: () => admitted }, async f => {
    const before = await readFile(f.feedPath, "utf8");
    admitted = false;
    Reflect.set(f.pi, "getSessionName", () => "renamed");
    await f.emit("session_info_changed");
    expect(await readFile(f.feedPath, "utf8")).toBe(before);
    await f.emit("session_shutdown", { reason: "quit" });
    expect(await readFile(f.feedPath, "utf8")).toBe(before);
  });
}, 5000);

it("waits for an aborted fixture to close before restoring the environment", async () => {
  let markStarted!: (root: string) => void;
  let release!: () => void;
  const started = new Promise<string>(resolve => { markStarted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const abort = new AbortController();
  let bodyRan = false;
  const work = runFixture(abort.signal, {
    fastInactive: true,
    admitted: () => false,
    beforeStart: async h => { markStarted(h.root); await gate; },
  }, async () => { bodyRan = true; }, false);
  void work.catch(() => {});
  const root = await started;
  abort.abort(new Error("fixture timed out"));
  let drained = false;
  const drain = drainFixture().then(() => { drained = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(drained).toBe(false);
  } finally {
    release();
    const outcomes = await Promise.allSettled([work, drain]);
    expect(outcomes[0]).toEqual({ status: "rejected", reason: abort.signal.reason });
    expect(outcomes[1]).toEqual({ status: "fulfilled", value: undefined });
  }
  expect(bodyRan).toBe(false);
  expect(existsSync(root)).toBe(false);
});
