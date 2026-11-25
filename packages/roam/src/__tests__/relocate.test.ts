import { describe, expect, it } from "vitest";
import { relocate } from "../relocate/relocate";
import { deferred, destination, ports, request, running, sessionId, source, state, third } from "./relocate-fakes";

const protocol = (effects: string[]) => effects.filter(e => !e.startsWith("save-"));

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
    expect(s.effects).toEqual(["locate-source", "start-source", "confirm-source"]);
    expect(s.snapshots.size).toBe(0); expect(s.pushed.size).toBe(0);
  });

  it("completed same-home call never writes its finished journal", async () => {
    const s = state(); expect((await relocate(request, ports(s))).ok).toBe(true);
    const home = structuredClone(s.home); const journal = structuredClone(s.journal);
    const before = s.effects.length; s.failBefore = "save";
    expect(await relocate(request, ports(s))).toMatchObject({ ok: true, value: { disposition: "already-home" } });
    expect(s.home).toEqual(home); expect(s.journal).toEqual(journal); expect(s.ids).toBe(1);
    expect(s.effects.slice(before)).toEqual(["locate-destination", "start-destination", "confirm-destination"]);
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
    expect(s.effects).not.toContain("pull-source");
    expect(s.effects).not.toContain("push-destination");
    expect(s.effects).not.toContain("install-destination");
    expect(s.effects).not.toContain("start-destination");
    expect(s.processes).toEqual(new Set([source]));
    barrier.resolve();
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
    s.refuse = { effect: "check", code: "repo-unmapped" };
    expect(await relocate(request, ports(s))).toMatchObject({ ok: false, refusal: { code: "repo-unmapped" } });
    expect(s.home).toEqual(running());
    expect(s.effects).toEqual(["initial-source", "initialize"]);
    expect(s.processes).toEqual(new Set([source]));
  });
});
