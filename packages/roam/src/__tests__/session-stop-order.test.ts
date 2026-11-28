import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate, openDb } from "@spider/db-core";
import { cleanupScratch, scratchDbPath } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom, type Clock, type RoamConfig } from "../contracts";
import { openJournal } from "../journal";
import { revokeMachine } from "../revocation";
import * as relocation from "../relocate/relocate";
import { createV0Runtime } from "../relocate/runtime";
import * as force from "../relocate/set-home";
import { createStopCommand } from "../relocate/session-stop";
import { createSessionStopStore } from "../relocate/session-stop-store";
import type { StopRequest } from "../relocate/session-stop-types";
import type { MovingHome, RelocateId, RunningHome, SessionId, SessionPlacement, StoppedHome } from "../relocate/types";
import { deferred } from "./relocate-fakes";

const source = "11111111-1111-4111-8111-111111111111";
const movedTo = "22222222-2222-4222-8222-222222222222";
const id = "session-1" as SessionId;
const otherId = "session-2" as SessionId;
const moveId = "v0-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RelocateId;
const forceId = "v0-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as RelocateId;
const running: RunningHome = { sessionId: id, machineId: source, epoch: 7, state: "running", destination: null, moveId: null, updatedAt: 100 };
const movingHome: MovingHome = { ...running, epoch: 8, state: "moving", destination: movedTo, moveId, updatedAt: 200 };
const movedHome: RunningHome = { ...movingHome, machineId: movedTo, epoch: 9, state: "running", destination: null };
const undoneHome: RunningHome = { ...movedHome, machineId: source };
const forcedHome: RunningHome = { ...undoneHome, epoch: 10, moveId: forceId, updatedAt: 300 };
const readyMs = DEFAULT_LIMITS.readyMs;
const input: StopRequest = { operationId: "stop-original", sessionId: id, machineId: source, homeEpoch: 7, mode: "graceful" };

function manualClock() {
  let now = 1_000;
  const deadlines = new Map<() => void, number>();
  const clock: Clock = { now: () => now, later(ms, fn) { deadlines.set(fn, now + ms); return () => { deadlines.delete(fn); }; } };
  return { clock, advance(ms: number) {
    now += ms;
    for (const [fn, at] of deadlines) if (now >= at) { deadlines.delete(fn); fn(); }
  } };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { cleanupScratch(); }
});
function fixture(file = scratchDbPath("stop-order"), seed = true) {
  const root = dirname(file);
  vi.stubEnv("HC_SOCKET", join(root, "herdr.sock"));
  vi.stubEnv("HC_SESSION", "stop-order-fixture");
  const db = openDb(file);
  if (seed) {
    migrate(db, "global", { machineId: source, globalRoot: root });
    db.exec("UPDATE roam_meta SET store_key='global', capture_enabled=1");
    for (const sessionId of [id, otherId]) db.prepare(`INSERT INTO session_homes (session_id, machine_id, epoch, move_id, updated_at, state, destination)
      VALUES (?, ?, 7, NULL, 100, 'running', NULL)`).run(sessionId, source);
  }
  const reader = openDb(file);
  const cache = createSessionStopStore(reader);
  const peer = { machineId: movedTo, alias: "box.invalid", node: "/node", pi: "/pi", cli: "/spider", core: "/core", globalRoot: "/box" };
  const config: RoamConfig = { enabled: true, role: "hub", machineId: source, hubMachineId: source, peers: [peer], discoveryRoots: [],
    coreUnit: "fixture", syncMs: 120_000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  const time = manualClock();
  const unused = async () => { throw new Error("Unexpected transport call"); };
  const runtime = createV0Runtime(root, { clock: time.clock, openCore: () => ({ config, db, root, close: () => db.close() }),
    transport: { resolve: unused, bootstrapProbe: unused, exec: unused, read: unused, write: unused, run: unused } });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    reader.close();
    await runtime.close();
  }
  cleanups.push(close);
  const withSession = runtime.adapters.ports.withSession;
  const store = createSessionStopStore(db);
  const effects: { home: StoppedHome; mode: StopRequest["mode"] }[] = [];
  let contact: (home: StoppedHome) => Promise<void> = async () => {};
  const stop = createStopCommand({ operations: runtime.operations, store, homes: runtime.homes,
    withSession, clock: time.clock, readyMs, enabled: () => runtime.options.config.enabled,
    async reconcile(home) {
      // A reconciler must be able to acquire both locks before saving its evidence.
      await runtime.operations.enqueue(home.sessionId, () => withSession(home.sessionId, async () => {
        expect(await runtime.homes.read(home.sessionId)).toEqual(home);
        const record = cache.current(home.sessionId);
        if (!record || record.action === "start") throw new Error("Stop record must be durable before contact");
        expect(record.committed).toEqual(home);
        effects.push({ home, mode: record.mode });
      }));
      await contact(home);
    },
  });
  return { file, root, config, time, runtime, store, cache, effects, stop, close, withSession,
    onContact(fn: typeof contact) { contact = fn; } };
}

type Fixture = ReturnType<typeof fixture>;

async function checkSwap(f: Fixture, from: RunningHome | StoppedHome | MovingHome, to: RunningHome | StoppedHome | MovingHome) {
  expect(await f.runtime.homes.compareAndSwap(from, to)).toEqual({ kind: "applied", home: to });
}

function pausedMove(f: Fixture, result: "commit" | "undo" | "unsettled") {
  const marked = deferred(), release = deferred();
  // Drive the real hub entry, process lock and home CAS; replace only the relocation's external work.
  vi.spyOn(relocation, "relocate").mockImplementation((request, ports) => ports.withSession(request.sessionId, async () => {
    const current = await ports.homes.read(request.sessionId);
    if (current?.state === "running") {
      expect(await ports.homes.compareAndSwap(current, movingHome)).toEqual({ kind: "applied", home: movingHome });
    } else {
      expect(current).toEqual(movingHome);
    }
    marked.resolve();
    await release.promise;
    if (result === "unsettled") return { ok: false, step: "stop-source", home: movingHome, moveId,
      refusal: { code: "stop-timeout", message: "fixture stopped mid-move", nextStep: "retry" } };
    const home = result === "undo" ? undoneHome : movedHome;
    expect(await ports.homes.compareAndSwap(movingHome, home)).toEqual({ kind: "applied", home });
    const placement: SessionPlacement = { sessionId: id, machineId: home.machineId, repoKey: "repo", workspaceId: "fixture",
      repository: "/repo", cwd: "/repo", file: "/session.jsonl", stores: [], historyMachine: source };
    return { ok: true, value: { home, moveId, placement, terminal: "fixture", disposition: result === "undo" ? "undone" : "relocated" } };
  }));
  const done = f.runtime.services.relocate({ sessionId: id, destinationMachine: result === "undo" ? source : movedTo });
  return { done, marked: marked.promise, release: release.resolve };
}

describe("hub Stop order", () => {
  it.each([
    ["commit", 7, movedTo],
    ["commit", 8, movedTo],
    ["undo", 8, source],
  ] as const)("follows a pinned %s from epoch %i", async (result, homeEpoch, machineId) => {
    const f = fixture();
    if (result === "undo") await checkSwap(f, running, movingHome);
    const move = pausedMove(f, result);
    await move.marked;
    const request = { ...input, homeEpoch };
    const waiting = await f.stop(request);
    const homeWhileWaiting = await f.runtime.homes.read(id);
    expect(waiting).toMatchObject({ outcome: "pending", reason: "waiting-for-move" });
    expect(homeWhileWaiting?.state).toBe("moving");
    expect(f.cache.operation(request.operationId)).toBeNull();
    expect(f.effects).toEqual([]);
    move.release();
    await move.done;
    // The first caller already got its reply. Replay observes the accepted work.
    expect(await f.stop(request)).toMatchObject({ outcome: "pending", homeEpoch: 10, machineId });
    const afterStop = await f.runtime.homes.read(id);
    expect(afterStop).toMatchObject({ machineId, state: "stopped", epoch: 10, moveId });
    expect(f.cache.operation(request.operationId)).toEqual({ action: "stop", request, committed: afterStop });
    expect(f.effects).toEqual([{ home: afterStop, mode: "graceful" }]);
  });

  it("upgrades the Stop that was queued ahead of Kill now on the same move", async () => {
    const f = fixture(), move = pausedMove(f, "commit");
    await move.marked;
    const stop = { ...input, homeEpoch: 8 };
    const kill = { ...stop, operationId: "kill-behind-move", mode: "hard" } as const;
    for (const waiting of await Promise.all([f.stop(stop), f.stop(kill)])) {
      expect(waiting).toMatchObject({ outcome: "pending", reason: "waiting-for-move", homeEpoch: 8 });
    }

    move.release();
    await move.done;
    for (const accepted of await Promise.all([f.stop(stop), f.stop(kill)])) {
      expect(accepted).toMatchObject({ outcome: "pending", status: "stop-pending", machineId: movedTo, homeEpoch: 10 });
    }
    const stopped = await f.runtime.homes.read(id);
    expect(stopped).toMatchObject({ machineId: movedTo, state: "stopped", epoch: 10, moveId });
    expect(f.cache.current(id)).toMatchObject({ action: "stop", mode: "hard", expected: movedHome, committed: stopped });
    expect(f.cache.operation(stop.operationId)).toEqual({ action: "stop", request: stop, committed: stopped });
    expect(f.cache.operation(kill.operationId)).toEqual({ action: "stop", request: kill, committed: stopped });
  });

  it("does not follow a force after the pinned move", async () => {
    const f = fixture(), move = pausedMove(f, "commit");
    await move.marked;
    vi.spyOn(force, "setHome").mockImplementation((request, ports) => ports.withSession(request.sessionId, async () => {
      const current = await ports.homes.read(id);
      if (!current) throw new Error("no home to force");
      expect(await ports.homes.compareAndSwap(current, forcedHome)).toEqual({ kind: "applied", home: forcedHome });
      return { ok: true, value: forcedHome };
    }));
    const forceRequest = f.runtime.services.setHome({ sessionId: id, destinationMachine: source, force: true, confirmation: "fixture" });
    expect(await f.stop(input)).toMatchObject({ outcome: "pending", reason: "waiting-for-move" });
    move.release();
    await move.done;
    await forceRequest;
    const behindForce = await f.stop(input);
    const afterForce = await f.runtime.homes.read(id);
    expect(behindForce).toMatchObject({ outcome: "refused", reason: "home-changed" });
    expect(afterForce).toEqual(forcedHome);
    expect(f.cache.operation(input.operationId)).toBeNull();
    expect(f.effects).toEqual([]);
  });

  it("does not pin a move that has not taken its turn", async () => {
    const f = fixture(), release = deferred();
    const earlier = f.runtime.operations.enqueue(id, () => release.promise);
    const move = pausedMove(f, "commit");
    const stop = f.stop(input);
    release.resolve();
    await earlier;
    await move.marked;
    move.release();
    await move.done;
    expect(await stop).toMatchObject({ outcome: "refused", reason: "home-changed" });
    expect(await f.runtime.homes.read(id)).toEqual(movedHome);
    expect(f.effects).toEqual([]);
  });

  it("leaves an unsettled move unchanged and explains how to repair it", async () => {
    const f = fixture(), move = pausedMove(f, "unsettled");
    await move.marked;
    expect(await f.stop(input)).toMatchObject({ outcome: "pending", reason: "waiting-for-move" });
    move.release();
    await move.done;
    const unsettled = await f.stop(input);
    const afterUnsettled = await f.runtime.homes.read(id);
    expect(unsettled.reason).toBe("Finish or undo the move with `spider roam relocate`, then stop.");
    expect(afterUnsettled).toEqual(movingHome);
    expect(f.effects).toEqual([]);
  });

  it("checks the live enabled flag when Stop reaches its turn", async () => {
    const f = fixture(), release = deferred();
    const earlier = f.runtime.operations.enqueue(id, () => release.promise);
    const stop = f.stop(input);
    f.config.enabled = false;
    release.resolve();
    await earlier;
    expect(await stop).toMatchObject({ outcome: "refused", reason: "roaming-disabled" });
    expect(await f.runtime.homes.read(id)).toEqual(running);
    expect(f.cache.operation(input.operationId)).toBeNull();
    expect(f.effects).toEqual([]);
  });
});

describe("hub Stop replay", () => {
  it("reports confirmed stopped status when refusing a stale Stop", async () => {
    const f = fixture();
    const stopped: StoppedHome = { ...running, state: "stopped", epoch: 8, updatedAt: 200 };
    await f.runtime.homes.compareAndSwap(running, stopped, undefined, () => f.store.write({
      action: "stop", operationId: "previous-stop", expected: running, committed: stopped, mode: "graceful",
      displaced: [], contactReason: null, observations: [{ sessionId: id, machineId: source, home: stopped,
        bootId: "fixture-boot", observedAt: 900, evidence: { kind: "confirmed", owner: null } }],
    }));

    expect(await f.stop(input)).toEqual({ sessionId: id, machineId: source, homeEpoch: 8, homeState: "stopped",
      operationId: input.operationId, outcome: "refused", reason: "home-changed", status: "stopped", observedAt: 900 });
    expect(f.cache.operation(input.operationId)).toBeNull();
    expect(f.effects).toEqual([]);
  });

  it("reports verified running status when refusing a new Stop with roaming disabled", async () => {
    const f = fixture();
    const stopped: StoppedHome = { ...running, state: "stopped", epoch: 8, updatedAt: 200 };
    const started: RunningHome = { ...running, epoch: 9, updatedAt: 300 };
    await checkSwap(f, running, stopped);
    expect(await f.runtime.homes.compareAndSwap(stopped, started, undefined, () => f.store.write({
      action: "start", operationId: "previous-start", expected: stopped, committed: started, observedAt: 900, contactReason: null,
    }))).toEqual({ kind: "applied", home: started });
    f.config.enabled = false;

    expect(await f.stop({ ...input, homeEpoch: 9 })).toEqual({ sessionId: id, machineId: source, homeEpoch: 9,
      homeState: "running", operationId: input.operationId, outcome: "refused", reason: "roaming-disabled",
      status: "running", observedAt: 900 });
    expect(f.cache.operation(input.operationId)).toBeNull();
    expect(f.effects).toEqual([]);
  });

  it("reports verified running status when a saved Stop is superseded", async () => {
    const f = fixture();
    await f.stop(input);
    const stopped = await f.runtime.homes.read(id);
    if (stopped?.state !== "stopped") throw new Error("expected a stopped home");
    const started: RunningHome = { ...running, epoch: 9, updatedAt: 300 };
    expect(await f.runtime.homes.compareAndSwap(stopped, started, undefined, () => f.store.write({
      action: "start", operationId: "later-start", expected: stopped, committed: started, observedAt: 900, contactReason: null,
    }))).toEqual({ kind: "applied", home: started });
    f.effects.length = 0;

    expect(await f.stop(input)).toEqual({ sessionId: id, machineId: source, homeEpoch: 9, homeState: "running",
      operationId: input.operationId, outcome: "refused", reason: "home-superseded", status: "running", observedAt: 900 });
    expect(await f.runtime.homes.read(id)).toEqual(started);
    expect(f.effects).toEqual([]);
  });

  it("replays the original stop without rewriting the epoch", async () => {
    const f = fixture();
    const release = deferred(), contacting = deferred(), finishContact = deferred();
    const earlier = f.runtime.operations.enqueue(id, () => release.promise);
    f.onContact(async () => { contacting.resolve(); await finishContact.promise; });
    const lostBeforeCommit = f.stop(input);
    const duplicate = f.stop({ ...input });
    expect(await f.stop({ ...input, sessionId: otherId })).toMatchObject({ outcome: "refused", reason: "operation-reused" });
    expect(await f.stop({ ...input, mode: "hard" })).toMatchObject({ outcome: "refused", reason: "operation-reused" });
    f.time.advance(readyMs);
    expect(await lostBeforeCommit).toMatchObject({ outcome: "pending", homeEpoch: null });
    expect(await duplicate).toEqual(await lostBeforeCommit);
    expect(f.cache.operation(input.operationId)).toBeNull();
    release.resolve();
    await earlier;
    await contacting.promise;
    const lostAfterCommit = f.stop(input);
    f.time.advance(readyMs);
    expect(await lostAfterCommit).toMatchObject({ outcome: "pending", status: "stop-pending", homeEpoch: 8 });
    const committed = await f.runtime.homes.read(id);
    expect(committed).toMatchObject({ state: "stopped", epoch: 8 });
    expect(f.effects).toEqual([{ home: committed, mode: "graceful" }]);
    const drained = f.stop(input);
    finishContact.resolve();
    await drained;
    await f.close();

    const restarted = fixture(f.file, false);
    expect(await restarted.stop(input)).toMatchObject({ outcome: "pending", homeEpoch: 8 });
    expect(await restarted.runtime.homes.read(id)).toEqual(committed);
    expect(restarted.effects).toEqual([{ home: committed, mode: "graceful" }]);
    for (const changed of [{ mode: "hard" } as const, { homeEpoch: 8 }, { machineId: movedTo }, { sessionId: otherId }]) {
      const reused = await restarted.stop({ ...input, ...changed });
      expect(reused.reason).toBe("operation-reused");
    }
    expect(restarted.cache.operation(input.operationId)).toEqual({ action: "stop", request: input, committed });
    expect(await restarted.runtime.homes.read(otherId)).toEqual({ ...running, sessionId: otherId });

    if (committed?.state !== "stopped") throw new Error("expected a stopped home");
    const laterRunningHome: RunningHome = { ...committed, epoch: 9, state: "running", updatedAt: 900 };
    await checkSwap(restarted, committed, laterRunningHome);
    restarted.effects.length = 0;
    expect(await restarted.stop(input)).toMatchObject({ outcome: "refused", reason: "home-superseded" });
    const afterHistoricReplay = await restarted.runtime.homes.read(id);
    const unrelatedEffects = restarted.effects;
    expect(afterHistoricReplay).toEqual(laterRunningHome);
    expect(unrelatedEffects).toEqual([]);
  });

  it("upgrades Kill now without rewriting the epoch or downgrading later", async () => {
    const f = fixture();
    expect(await f.stop(input)).toMatchObject({ outcome: "pending", homeEpoch: 8 });
    const kill = { ...input, operationId: "kill-now", homeEpoch: 8, mode: "hard" } as const;
    expect(await f.stop(kill)).toMatchObject({ outcome: "pending", homeEpoch: 8 });
    const upgrade = f.cache.current(id);
    expect(upgrade).toMatchObject({ mode: "hard", committed: { epoch: 8 } });
    expect(await f.stop({ ...input, operationId: "graceful-later", homeEpoch: 8 })).toMatchObject({ outcome: "pending", homeEpoch: 8 });
    const current = f.cache.current(id);
    const modeAfterGracefulRetry = current && "mode" in current ? current.mode : null;
    expect(modeAfterGracefulRetry).toBe("hard");
    expect(f.effects.map(effect => effect.mode)).toEqual(["graceful", "hard", "hard"]);
    if (!current || current.action === "start") throw new Error("expected a Stop record");
    await f.runtime.operations.enqueue(id, () => f.withSession(id, async () => f.store.write({ ...current,
      observations: [{ sessionId: id, machineId: source, home: current.committed, bootId: "fixture-boot", observedAt: 1_001,
        evidence: { kind: "confirmed", owner: null } }],
    })));
    f.effects.length = 0;
    expect(await f.stop(kill)).toMatchObject({ outcome: "complete", status: "stopped", homeEpoch: 8, observedAt: 1_001 });
    expect(await f.stop({ ...kill, operationId: "kill-confirmed" })).toMatchObject({ outcome: "complete", status: "stopped", homeEpoch: 8 });
    const confirmedKillNowEffects = f.effects;
    expect(confirmedKillNowEffects).toEqual([]);
    expect(await f.runtime.homes.read(id)).toEqual(current.committed);
  });

  it("reports a saved Stop when the deadline fires just after the CAS commits", async () => {
    const f = fixture();
    const compareAndSwap = f.runtime.homes.compareAndSwap;
    vi.spyOn(f.runtime.homes, "compareAndSwap").mockImplementation(async (...args) => {
      const swap = await compareAndSwap(...args);
      // A separate connection sees the binding before admission releases its locks.
      expect(f.cache.operation(input.operationId)?.committed).toEqual(swap.home);
      f.time.advance(readyMs);
      return swap;
    });

    const atDeadline = await f.stop(input);
    await f.stop(input); // Let the accepted operation finish before fixture teardown.
    expect(atDeadline).toEqual({ sessionId: id, operationId: input.operationId, machineId: source, homeEpoch: 8,
      homeState: "stopped", outcome: "pending", status: "stop-pending", reason: "Exit has not been confirmed.", observedAt: null });
    expect(f.cache.current(id)).toMatchObject({ action: "stop", committed: { epoch: 8 } });
  });

  it("returns saved exit proof at the deadline even while contact is unfinished", async () => {
    const f = fixture(), confirmed = deferred(), release = deferred();
    f.onContact(async home => {
      await f.runtime.operations.enqueue(id, () => f.withSession(id, async () => {
        const record = f.store.current(id);
        if (!record || record.action === "start") throw new Error("expected a Stop record");
        f.store.write({ ...record, observations: [{ sessionId: id, machineId: source, home,
          bootId: "fixture-boot", observedAt: 1_001, evidence: { kind: "confirmed", owner: null } }] });
      }));
      confirmed.resolve();
      await release.promise;
    });
    const first = f.stop(input);
    await confirmed.promise;
    f.time.advance(readyMs);
    const atDeadline = await first;
    const draining = f.stop(input);
    release.resolve();
    await draining;
    expect(atDeadline).toMatchObject({ outcome: "complete", status: "stopped", homeEpoch: 8, observedAt: 1_001 });

    const kill = { ...input, operationId: "kill-after-proof", mode: "hard", homeEpoch: 8 } as const;
    expect(await f.stop(kill)).toMatchObject({ outcome: "complete", status: "stopped", homeEpoch: 8 });
    expect(f.cache.current(id)).toMatchObject({ mode: "graceful" });
    expect(f.effects.map(effect => effect.mode)).toEqual(["graceful"]);
  });

  it("records a pending Stop on a stopped epoch without a record", async () => {
    const f = fixture();
    const stopped: StoppedHome = { ...running, state: "stopped", epoch: 8, updatedAt: 200 };
    await checkSwap(f, running, stopped);
    expect(f.cache.current(id)).toBeNull();
    const request = { ...input, homeEpoch: 8 };
    expect(await f.stop(request)).toMatchObject({ outcome: "pending", status: "stop-pending", homeEpoch: 8 });
    expect(await f.runtime.homes.read(id)).toEqual(stopped);
    expect(f.cache.operation(request.operationId)).toEqual({ action: "stop", request, committed: stopped });
    expect(f.effects).toEqual([{ home: stopped, mode: "graceful" }]);
  });

  it("cannot save a Stop through the runtime CAS on a revoked peer", async () => {
    const f = fixture();
    await checkSwap(f, running, movingHome);
    await checkSwap(f, movingHome, movedHome);
    const journal = join(f.root, "roam", "journal.db");
    openJournal(journal);
    const revocations = openDb(journal);
    try { revokeMachine(revocations, movedTo); }
    finally { revocations.close(); }
    expect(await f.stop({ ...input, machineId: movedTo, homeEpoch: 9 })).toMatchObject({ outcome: "refused", reason: "session-commit-failed" });
    expect(await f.runtime.homes.read(id)).toEqual(movedHome);
    expect(f.cache.operation(input.operationId)).toBeNull();
    expect(f.effects).toEqual([]);
  });
});
