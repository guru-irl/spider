import { describe, it, expect } from "vitest";
import { getCoordinators, teardownCoordinators, registerChild, unregisterChild, getChild, teardownAll, teardownAllAsync } from "../coordinators";
import type { ChildHandle } from "../runner";

describe("coordinators registry", () => {
  it("creates once per session and tears down", () => {
    let stopped = 0, disposed = 0;
    const make = () => ({ tailer: { stop: () => stopped++ } as any, pipelines: [{ dispose: () => disposed++ } as any], children: new Map() });
    const a = getCoordinators("reg-s1", make);
    const b = getCoordinators("reg-s1", make);
    expect(a).toBe(b); // same instance, make() called once
    teardownCoordinators("reg-s1");
    expect(stopped).toBe(1);
    expect(disposed).toBe(1);
    const c = getCoordinators("reg-s1", make); // recreated after teardown
    expect(c).not.toBe(a);
    teardownCoordinators("reg-s1");
  });
});

describe("child handle registry", () => {
  const fakeHandle = (): ChildHandle & { killed: boolean } => {
    const h = { pid: 111, killed: false, wait: async () => ({ exitCode: 0 }), kill() { h.killed = true; }, detach() {} };
    return h as ChildHandle & { killed: boolean };
  };

  it("registers and retrieves a child handle by session + run", () => {
    const h = fakeHandle();
    registerChild("sess-a", "run-1", h);
    expect(getChild("sess-a", "run-1")).toBe(h);
  });

  it("unregisters a child handle", () => {
    registerChild("sess-b", "run-2", fakeHandle());
    unregisterChild("sess-b", "run-2");
    expect(getChild("sess-b", "run-2")).toBeUndefined();
  });

  it("does not leak handles across sessions", () => {
    registerChild("sess-c", "run-3", fakeHandle());
    expect(getChild("sess-d", "run-3")).toBeUndefined();
  });

  it("teardownAll kills every registered child", () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    registerChild("sess-e", "run-4", h1);
    registerChild("sess-e", "run-5", h2);
    teardownAll();
    expect(h1.killed).toBe(true);
    expect(h2.killed).toBe(true);
  });
});

describe("async teardown with SIGKILL escalation", () => {
  const fakeHandle = (opts?: { dieDuringGrace?: boolean }) => {
    let sigkillCalled = false;
    const h = {
      pid: Math.floor(Math.random() * 100000),
      killed: false,
      async wait() { return { exitCode: 0 }; },
      kill() { this.killed = true; },
      async killAsync(graceMs: number) {
        // Simulate the SIGTERM -> wait -> SIGKILL escalation
        if (opts?.dieDuringGrace) {
          // Process dies quickly, before SIGKILL
          await new Promise<void>((r) => setTimeout(r, graceMs / 2));
          return "terminated";
        } else {
          // Process survives grace period, needs SIGKILL
          await new Promise<void>((r) => setTimeout(r, graceMs));
          sigkillCalled = true;
          return "forced";
        }
      },
      detach() {},
      get sigkillCalled() { return sigkillCalled; },
    };
    return h;
  };

  it("child still alive after grace receives SIGKILL escalation", async () => {
    const h = fakeHandle();
    registerChild("async-sess-1", "run-1", h as any);
    
    await teardownAllAsync({ graceMs: 50 });
    
    expect(h.sigkillCalled).toBe(true);
  });

  it("child that dies during grace does NOT receive SIGKILL", async () => {
    const h = fakeHandle({ dieDuringGrace: true });
    registerChild("async-sess-2", "run-2", h as any);
    
    await teardownAllAsync({ graceMs: 50 });
    
    expect(h.sigkillCalled).toBe(false);
  });

  it("total wait is bounded with multiple children (parallel escalation)", async () => {
    const handles: any[] = [];
    for (let i = 0; i < 3; i++) {
      const h = fakeHandle();
      handles.push(h);
      registerChild("async-sess-3", `run-${i}`, h as any);
    }
    
    const startTime = Date.now();
    await teardownAllAsync({ graceMs: 50 });
    const elapsed = Date.now() - startTime;
    
    // Should take ~50ms (parallel), not 150ms (3 * 50ms serial)
    expect(elapsed).toBeLessThan(100); // Allow some overhead
  });
});
