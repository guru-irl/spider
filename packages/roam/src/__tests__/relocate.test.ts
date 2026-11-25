import { describe, expect, it } from "vitest";
import { relocate } from "../relocate/relocate";
import { deferred, destination, ports, request, running, source, state } from "./relocate-fakes";

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
