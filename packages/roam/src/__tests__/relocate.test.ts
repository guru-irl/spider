import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelocateCheckpoint, RelocateId } from "../relocate/types";
import { relocate } from "../relocate/relocate";
import { assertSafeHistories, deferred, destination, ports, refusal, request, running, sessionId, source, state, third } from "./relocate-fakes";

const readyClock = { now: Date.now, later(ms: number, fn: () => void) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };

const protocol = (effects: string[]) => effects.filter(e => !e.startsWith("save-"));

afterEach(assertSafeHistories);

describe("relocate", () => {
  // Missing awaits, wrong CAS epochs, or start-before-commit violate these public port effects.
  it("relocates through all nine steps", async () => {
    const s = state();
    const result = await relocate(request, ports(s));
    expect(result).toMatchObject({ ok: true, value: {
      moveId: "v0-move-1", disposition: "relocated", terminal: "terminal-destination",
      placement: { file: "/destination/session.jsonl", cwd: "/destination/repo/sub" },
      home: { sessionId: "session-1", machineId: destination, epoch: 3, state: "running", destination: null, moveId: "v0-move-1" },
    } });
    expect(protocol(s.effects)).toEqual([
      "check", "cas-moving", "publish-source-moving", "lock-free", "stop-source",
      "pull-source", "push-destination", "install-destination", "cas-running",
      "publish-destination-running", "start-destination", "confirm-destination",
    ]);
    expect(s.homesWritten[0]).toMatchObject({ machineId: source, epoch: 2, state: "moving", destination, moveId: "v0-move-1" });
    expect(s.homesWritten[1]).toMatchObject({ machineId: destination, epoch: 3, state: "running", moveId: "v0-move-1" });
    expect(s.effects.indexOf("save-check")).toBeLessThan(s.effects.indexOf("cas-moving"));
    expect(s.processes).toEqual(new Set([destination]));
  });

  it("same target reuses the pending move ID", async () => {
    const s = state(); s.failAfter = "push-destination";
    expect(await relocate(request, ports(s))).toMatchObject({ ok: false, step: "push-destination" });
    expect(s.home).toMatchObject({ state: "moving", moveId: "v0-move-1" });
    expect((await relocate(request, ports(s))).ok).toBe(true);
    expect(s.ids).toBe(1);
    expect(s.effects.filter(e => e === "pull-source")).toHaveLength(1);
    expect(s.snapshots.size).toBe(1); expect(s.segments.size).toBe(1);
    expect(s.installed.size).toBe(1); expect(s.pushed.size).toBe(1);
    expect(s.processes).toEqual(new Set([destination]));
  });

  it.each(["mark-moving", "stop-source", "pull-source", "push-destination", "install-destination"] as const)("source target undoes an incomplete move after %s", async step => {
    const s = state(); s.failAfter = `save-${step}`;
    expect((await relocate(request, ports(s))).ok).toBe(false);
    const before = s.effects.length;
    expect(await relocate({ sessionId, destinationMachine: source }, ports(s))).toMatchObject({
      ok: true, value: { disposition: "undone", moveId: "v0-move-1", terminal: "terminal-source",
        home: { machineId: source, state: "running", epoch: 3, moveId: "v0-move-1" } },
    });
    expect(protocol(s.effects.slice(before))).toEqual([
      "lock-free", "stop-source", "activate-source", "cas-running",
      "publish-source-running", "start-source", "confirm-source",
    ]);
    expect(s.processes).toEqual(new Set([source]));
    expect(s.backups.has(source)).toBe(true);
  });

  it("third destination refuses during moving", async () => {
    const s = state(); s.failAfter = "save-stop-source";
    expect((await relocate(request, ports(s))).ok).toBe(false);
    const home = structuredClone(s.home); const journal = structuredClone(s.journal);
    const effects = [...s.effects];
    expect(await relocate({ sessionId, destinationMachine: third }, ports(s))).toMatchObject({
      ok: false, refusal: { code: "move-in-progress", nextStep: expect.stringMatching(/source|destination/) },
    });
    expect(s.home).toEqual(home); expect(s.journal).toEqual(journal);
    expect(s.effects).toEqual(effects); expect(s.ids).toBe(1);
  });

  it.each(["start-destination", "confirm-destination"])("committed retry never recaptures the source after %s", async boundary => {
    const s = state(); s.failAfter = boundary;
    expect((await relocate(request, ports(s))).ok).toBe(false);
    const committed = structuredClone(s.home); const before = s.effects.length;
    const installed = structuredClone(s.installed);
    expect(await relocate(request, ports(s))).toMatchObject({ ok: true, value: { disposition: "relocated", moveId: "v0-move-1" } });
    expect(protocol(s.effects.slice(before))).toEqual([
      "publish-destination-running", "activate-destination", "start-destination", "confirm-destination",
    ]);
    expect(s.home).toEqual(committed); expect(s.ids).toBe(1);
    expect(s.installed).toEqual(installed); expect(s.snapshots.size).toBe(1);
    expect(s.segments.size).toBe(1); expect(s.processes).toEqual(new Set([destination]));
  });

  it("already running here creates no move", async () => {
    const s = state(); const home = structuredClone(s.home);
    expect(await relocate({ sessionId, destinationMachine: source }, ports(s))).toMatchObject({
      ok: true, value: { disposition: "already-home", moveId: null, terminal: "terminal-source" },
    });
    expect(s.home).toEqual(home); expect(s.ids).toBe(0);
    expect(s.effects).toEqual(["locate-source", "publish-source-running", "activate-source", "start-source", "confirm-source"]);
    expect(s.snapshots.size).toBe(0); expect(s.pushed.size).toBe(0);
  });

  it("completed same-home call never writes its finished journal", async () => {
    const s = state(); expect((await relocate(request, ports(s))).ok).toBe(true);
    const home = structuredClone(s.home); const journal = structuredClone(s.journal);
    const before = s.effects.length; s.failBefore = "save";
    expect(await relocate(request, ports(s))).toMatchObject({ ok: true, value: { disposition: "already-home" } });
    expect(s.home).toEqual(home); expect(s.journal).toEqual(journal); expect(s.ids).toBe(1);
    expect(s.effects.slice(before)).toEqual(["locate-destination", "publish-destination-running", "activate-destination", "start-destination", "confirm-destination"]);
  });

  it("stopped source can move and stopped local copy can resume", async () => {
    const remote = state(); remote.home = { ...running(), state: "stopped" }; remote.processes.clear();
    expect(await relocate(request, ports(remote))).toMatchObject({ ok: true, value: {
      disposition: "relocated", home: { machineId: destination, epoch: 3, state: "running" },
    } });
    expect(remote.snapshots.size).toBe(1); expect(remote.segments.size).toBe(1);
    const local = state(); local.home = { ...running(), state: "stopped" }; local.processes.clear();
    expect(await relocate({ sessionId, destinationMachine: source }, ports(local))).toMatchObject({ ok: true, value: {
      disposition: "already-home", moveId: null, home: { machineId: source, epoch: 2, state: "running" },
    } });
    expect(local.effects).toEqual(["locate-source", "activate-source", "cas-running", "publish-source-running", "start-source", "confirm-source"]);
    expect(local.ids).toBe(0); expect(local.snapshots.size).toBe(0); expect(local.segments.size).toBe(0);
    expect(local.processes).toEqual(new Set([source]));
  });

  it("missing stopped local copy leaves home stopped", async () => {
    const s = state(); s.home = { ...running(), state: "stopped" }; s.processes.clear();
    const home = structuredClone(s.home); s.refuse = { effect: "locate-source", code: "destination-copy-missing" };
    expect(await relocate({ sessionId, destinationMachine: source }, ports(s))).toMatchObject({ ok: false, refusal: { code: "destination-copy-missing" } });
    expect(s.home).toEqual(home); expect(s.effects).toEqual([]); expect(s.ids).toBe(0);
  });

  it.each(["missing", "unreadable", "malformed", "wrong-source", "wrong-destination", "wrong-id", "wrong-epoch", "missing-capture", "missing-install"])("missing journal never guesses a source: %s", async mode => {
    const s = state(); s.failAfter = "save-stop-source";
    expect((await relocate(request, ports(s))).ok).toBe(false);
    const id = s.home!.moveId!; const cp = s.journal.get(id)!;
    if (mode === "missing") s.journal.delete(id);
    if (mode === "unreadable") s.failBefore = "load";
    if (mode === "malformed") s.journal.set(id, {} as RelocateCheckpoint);
    if (mode === "wrong-source") cp.plan.sourcePlacement.machineId = third;
    if (mode === "wrong-destination") cp.plan.destinationPlacement.machineId = third;
    if (mode === "wrong-id") cp.plan.moveId = "v0-other" as typeof id;
    if (mode === "wrong-epoch") cp.plan.source.epoch = 99;
    if (mode === "missing-capture") cp.completed = [...cp.completed, "pull-source"];
    if (mode === "missing-install") cp.completed = [...cp.completed, "install-destination"];
    const home = structuredClone(s.home); const journal = structuredClone(s.journal); const before = s.effects.length;
    expect(await relocate(request, ports(s))).toMatchObject({
      ok: false, refusal: { code: "journal-unavailable", nextStep: expect.stringMatching(/set-home.*--force.*lost/i) },
    });
    expect(s.home).toEqual(home); expect(s.journal).toEqual(journal);
    expect(s.effects.slice(before)).toEqual([]); expect(s.ids).toBe(1);
  });

  it.each([
    ["check", "save-check"], ["mark-moving", "cas-moving"], ["stop-source", "save-stop-source"],
    ["pull-source", "pull-source"], ["push-destination", "push-destination"],
    ["install-destination", "install-destination"], ["commit-home", "cas-running"],
    ["start-destination", "start-destination"], ["confirm", "save-confirm"],
  ])("fault after %s resumes without two copies", async (step, boundary) => {
    const s = state(); s.failAfter = boundary;
    expect((await relocate(request, ports(s))).ok).toBe(false);
    const pendingId = s.home!.moveId;
    expect((await relocate(request, ports(s))).ok).toBe(true);
    expect(s.home).toMatchObject({ sessionId, machineId: destination, state: "running", epoch: 3,
      moveId: step === "check" ? "v0-move-2" : pendingId });
    expect(s.ids).toBe(step === "check" ? 2 : 1);
    expect(s.snapshots.size).toBe(1); expect(s.segments.size).toBe(1);
    expect(s.installed.size).toBe(1); expect(s.processes).toEqual(new Set([destination]));
    expect(s.backups.has(source)).toBe(true);
  });

  it("pre-CAS orphan is inert and a new move ID completes", async () => {
    const s = state(); s.failAfter = "save-check";
    expect((await relocate(request, ports(s))).ok).toBe(false);
    const orphan = structuredClone(s.journal.get("v0-move-1" as RelocateId));
    expect(s.home).toEqual(running()); expect(s.homesWritten).toEqual([]);
    expect(await relocate(request, ports(s))).toMatchObject({ ok: true, value: { moveId: "v0-move-2" } });
    expect(s.journal.get("v0-move-1" as RelocateId)).toEqual(orphan);
    expect(s.homesWritten.filter(h => h.state === "moving")).toHaveLength(1);
    expect(s.seeds).toEqual(new Set([sessionId])); expect(s.ids).toBe(2);
    expect([...s.captures.keys()]).toEqual(["v0-move-2"]);
    expect([...s.segments]).toEqual(["v0-move-2"]);
  });

  it.each(["before", "after"])("failed source publication restores only the source: %s delivery", async when => {
    const s = state();
    if (when === "before") s.failBefore = "publish-source-moving";
    else s.failAfter = "publish-source-moving";
    const result = await relocate(request, ports(s));
    expect(result).toMatchObject({ ok: false, step: "mark-moving", refusal: { code: "sync-failed" },
      home: { machineId: source, state: "running", epoch: 3, moveId: "v0-move-1" } });
    expect(s.home).toMatchObject({ machineId: source, state: "running", epoch: 3 });
    expect(s.effects).not.toContain("install-destination"); expect(s.effects).not.toContain("start-destination");
    expect(s.processes).toEqual(new Set([source]));
    expect(s.homesWritten).toHaveLength(2);
  });

  it.each(["mark-moving", "commit-home"])("CAS conflict has no losing effects: %s", async boundary => {
    const s = state();
    if (boundary === "commit-home") {
      s.failAfter = "save-install-destination";
      expect((await relocate(request, ports(s))).ok).toBe(false);
    }
    const winner = { ...running(), epoch: 20, machineId: third };
    s.casWinner = winner;
    const before = s.effects.length;
    expect(await relocate(request, ports(s))).toMatchObject({ ok: false, refusal: { code: "home-conflict" }, home: winner });
    expect(s.home).toEqual(winner);
    const losing = s.effects.slice(before);
    expect(losing.some(e => e.startsWith("activate-") || e.startsWith("start-") || e.startsWith("publish-"))).toBe(false);
  });

  it.each(["cas-running", "publish-source-running", "start-source", "confirm-source"])("interrupted undo resumes only the source after %s", async boundary => {
    const s = state(); s.failAfter = "save-install-destination";
    expect((await relocate(request, ports(s))).ok).toBe(false);
    s.failAfter = boundary;
    const undo = { sessionId, destinationMachine: source };
    expect((await relocate(undo, ports(s))).ok).toBe(false);
    const before = s.effects.length;
    expect(await relocate(undo, ports(s))).toMatchObject({ ok: true, value: { disposition: "undone", moveId: "v0-move-1" } });
    expect(protocol(s.effects.slice(before))).toEqual(["publish-source-running", "activate-source", "start-source", "confirm-source"]);
    expect(s.home).toMatchObject({ machineId: source, state: "running", epoch: 3 });
    expect(s.processes).toEqual(new Set([source])); expect(s.snapshots.size).toBe(1);
  });

  it("stopped-home resume recovers after the CAS reply is lost", async () => {
    const s = state(); s.home = { ...running(), state: "stopped" }; s.processes.clear();
    s.failAfter = "cas-running";
    const resume = { sessionId, destinationMachine: source };
    expect((await relocate(resume, ports(s))).ok).toBe(false);
    expect(await relocate(resume, ports(s))).toMatchObject({ ok: true, value: { disposition: "already-home", home: { epoch: 2 } } });
    expect(s.replicaHomes.get(source)).toEqual(s.home);
    expect(s.ids).toBe(0); expect(s.snapshots.size).toBe(0);
  });

  it.each(["cas-moving", "cas-running"])("lost %s reply reports the durable home", async boundary => {
    const s = state(); s.failAfter = boundary;
    const result = await relocate(request, ports(s));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.home).toEqual(s.home);
  });

  it("capture waits for source lock freedom", async () => {
    const s = state();
    const barrier = deferred();
    const entered = deferred();
    s.stopBarrier = barrier.promise;
    const p = ports(s);
    const stop = p.stopSource;
    p.stopSource = async (...args) => { entered.resolve(); return stop(...args); };
    const pending = relocate(request, p);
    await entered.promise;
    try {
      // Let the immediate journal promises settle without releasing the only
      // real barrier. A missing await must expose an attempted capture here.
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(s.attempts).not.toContain("pull-source");
      expect(s.attempts).not.toContain("push-destination");
      expect(s.attempts).not.toContain("install-destination");
      expect(s.attempts).not.toContain("start-destination");
      expect(s.processes).toEqual(new Set([source]));
    } finally { barrier.resolve(); }
    expect((await pending).ok).toBe(true);
    expect(s.effects.indexOf("lock-free")).toBeLessThan(s.effects.indexOf("pull-source"));
  });

  it.each(["destination-not-provisioned", "repo-unmapped", "unsupported-workspace", "destination-unreachable"] as const)("check refusal changes no home: %s", async code => {
    const s = state();
    s.refuse = { effect: "check", code };
    const result = await relocate(request, ports(s));
    expect(result).toMatchObject({ ok: false, step: "check", refusal: { code, message: expect.any(String), nextStep: expect.any(String) } });
    if (!result.ok) expect(Object.keys(result.refusal).sort()).toEqual(["code", "message", "nextStep"]);
    expect(s.home).toEqual(running());
    expect(s.homesWritten).toEqual([]);
    expect(s.effects).toEqual([]);
    expect(s.processes).toEqual(new Set([source]));
  });

  it("source readiness precedes initialization without starting or stopping it", async () => {
    const s = state(); s.home = null;
    s.refuse = { effect: "initial-source", code: "session-not-found" };
    expect(await relocate(request, ports(s))).toMatchObject({ ok: false, refusal: { code: "session-not-found" } });
    expect(s.home).toBeNull(); expect(s.effects).toEqual([]);
  });

  it("a first move refused at check leaves the source ordinary", async () => {
    const s = state(); s.home = null;
    s.refuse = { effect: "check", code: "destination-unreachable" };
    expect(await relocate(request, ports(s))).toMatchObject({ ok: false, home: null, step: "check", refusal: { code: "destination-unreachable" } });
    expect(s.home).toBeNull();
    expect(s.journal.size).toBe(0);
    expect(s.effects).toEqual(["initial-source"]);
    expect(s.processes).toEqual(new Set([source]));
  });

  it("a failed first checkpoint leaves the source ordinary", async () => {
    const s = state(); s.home = null; s.failAfter = "save-check";
    expect(await relocate(request, ports(s))).toMatchObject({ ok: false, home: null, refusal: { code: "journal-unavailable" } });
    expect(s.home).toBeNull();
    expect(s.effects).toEqual(["initial-source", "check", "save-check"]);
    expect(s.processes).toEqual(new Set([source]));
  });

  it("waits for a cold destination to confirm without starting twice", async () => {
    vi.useFakeTimers();
    try {
      const s = state(), p = ports(s);
      const confirm = p.confirm;
      let ready = false;
      p.confirm = async (...args) => ready ? confirm(...args) : { ok: false, refusal: refusal("start-pending") };
      const moving = relocate(request, p, { clock: readyClock, timeoutMs: 2_000 });
      await vi.advanceTimersByTimeAsync(500);
      expect(s.home).toMatchObject({ machineId: destination, state: "running" });
      ready = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(await moving).toMatchObject({ ok: true, value: { terminal: "terminal-destination" } });
      expect(s.effects.filter(e => e === "start-destination")).toHaveLength(1);
      expect(s.processes).toEqual(new Set([destination]));
    } finally { vi.useRealTimers(); }
  });

  it("returns a committed start-pending result at the deadline even if a probe stalls", async () => {
    vi.useFakeTimers();
    try {
      const s = state(), p = ports(s), stalled = deferred();
      p.confirm = async () => { await stalled.promise; return { ok: true, value: { terminal: "terminal-destination" } }; };
      const moving = relocate(request, p, { clock: readyClock, timeoutMs: 1_000 });
      let result: Awaited<typeof moving> | undefined;
      void moving.then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(999);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      stalled.resolve();
      expect(result).toMatchObject({ ok: false, step: "confirm", home: { machineId: destination, state: "running" }, refusal: {
        code: "start-pending", message: expect.stringContaining("committed"), nextStep: expect.stringContaining("spider roam relocate"),
      } });
      expect(s.processes).toEqual(new Set([destination]));
    } finally { vi.useRealTimers(); }
  });

  it("first move adopts the legacy epoch only after validating it", async () => {
    const s = state(); s.home = null;
    const p = ports(s);
    p.initialEpoch = () => 7;
    const check = p.check;
    p.check = async (req, candidate, moveId) => {
      expect(candidate.epoch).toBe(7);
      return check(req, candidate, moveId);
    };
    p.homes.initialize = async () => {
      s.home = { ...running(), epoch: 7, updatedAt: 137 };
      return s.home;
    };
    expect(await relocate(request, p)).toMatchObject({ ok: true, value: { home: { machineId: destination, epoch: 9 } } });
    expect(s.homesWritten[0]).toMatchObject({ machineId: source, state: "moving", epoch: 8 });
    expect(s.processes).toEqual(new Set([destination]));
  });
});
