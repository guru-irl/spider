import { describe, it, expect } from "vitest";
import { getCoordinators, teardownCoordinators } from "../coordinators";

describe("coordinators registry", () => {
  it("creates once per session and tears down", () => {
    let stopped = 0, disposed = 0;
    const make = () => ({ tailer: { stop: () => stopped++ } as any, pipelines: [{ dispose: () => disposed++ } as any] });
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
