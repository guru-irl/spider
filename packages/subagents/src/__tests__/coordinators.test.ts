import { describe, it, expect } from "vitest";
import { getCoordinators, teardownCoordinators, registerChild, unregisterChild, getChild, teardownAll } from "../coordinators";
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
