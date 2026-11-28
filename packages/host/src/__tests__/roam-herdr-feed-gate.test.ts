import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { clearActions } from "../dispatch";
import { LOADED_BUILD } from "../build-id";
import { mountedFixture } from "./herdr-wiring-fixture";

type FixtureOptions = NonNullable<Parameters<typeof mountedFixture>[11]>;
type Fixture = Awaited<ReturnType<typeof mountedFixture>>;
let fixtureWork: Promise<void> | undefined;

function runFixture(signal: AbortSignal, options: FixtureOptions, check: (fixture: Fixture) => Promise<void>, requested = true): Promise<void> {
  const work = (async () => {
    const f = await mountedFixture("fake", "tui", true, false, true, false, requested, false, false, true, undefined, options);
    try { signal.throwIfAborted(); await check(f); }
    finally { await f.close(); }
  })();
  fixtureWork = work;
  return work;
}

async function drainFixture(): Promise<void> {}

afterEach(() => { clearActions(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("a refused Herdr session records presence without contacting hc or publishing a feed", async () => {
  const f = await mountedFixture("fake", "tui", true, false, true, false, true, false, false, true, undefined, { admitted: () => false, allowMissingFeed: true });
  try {
    expect(f.owner).toBeNull();
    expect(await f.calls()).toEqual([]);
    expect(existsSync(f.feedPath)).toBe(false);
    expect(await f.presence.list()).toEqual([expect.objectContaining({ sessionId: f.h.owner!.sessionId, build: LOADED_BUILD })]);
  } finally { await f.close(); }
}, 5000);

it("a frozen mounted feed does not publish on rename or shutdown", async () => {
  let admitted = true;
  const f = await mountedFixture("fake", "tui", true, false, true, false, true, false, false, true, undefined, { admitted: () => admitted });
  try {
    const before = await readFile(f.feedPath, "utf8");
    admitted = false;
    Reflect.set(f.pi, "getSessionName", () => "renamed");
    await f.emit("session_info_changed");
    expect(await readFile(f.feedPath, "utf8")).toBe(before);
    await f.emit("session_shutdown", { reason: "quit" });
    expect(await readFile(f.feedPath, "utf8")).toBe(before);
  } finally { await f.close(); }
}, 5000);

it("waits for an aborted fixture to close before restoring the environment", async () => {
  const started = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const abort = new AbortController();
  let bodyRan = false;
  const work = runFixture(abort.signal, {
    fastInactive: true,
    admitted: () => false,
    beforeStart: async h => { started.resolve(h.root); await release.promise; },
  }, async () => { bodyRan = true; }, false);
  void work.catch(() => {});
  const root = await started.promise;
  abort.abort(new Error("fixture timed out"));
  let drained = false;
  const drain = drainFixture().then(() => { drained = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(drained).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([work, drain]);
  }
  expect(bodyRan).toBe(false);
  expect(existsSync(root)).toBe(false);
});
