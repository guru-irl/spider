import { describe, it, expect, vi } from "vitest";
import { isProcessAlive, killProcessGroup } from "../kill-process";

describe("isProcessAlive", () => {
  it("is true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("is false for an implausible pid", () => {
    expect(isProcessAlive(2_147_483_600)).toBe(false);
  });
});

describe("killProcessGroup", () => {
  it("reports already-dead when the first signal throws ESRCH", async () => {
    const kill = vi.fn(() => { const e: any = new Error("no such process"); e.code = "ESRCH"; throw e; });
    const res = await killProcessGroup(123, { kill, platform: "darwin", graceMs: 1 });
    expect(res).toBe("already-dead");
  });

  it("sends SIGTERM to the negative pid on unix", async () => {
    const kill = vi.fn();
    // Dies after the SIGTERM: the liveness probe (signal 0) throws ESRCH.
    kill.mockImplementationOnce(() => {})
        .mockImplementation(() => { const e: any = new Error("gone"); e.code = "ESRCH"; throw e; });
    const res = await killProcessGroup(123, { kill, platform: "darwin", graceMs: 5 });
    expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");
    expect(res).toBe("terminated");
  });

  it("escalates to SIGKILL when the process survives the grace period", async () => {
    const kill = vi.fn(); // never throws => always alive
    const res = await killProcessGroup(123, { kill, platform: "darwin", graceMs: 5 });
    expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(-123, "SIGKILL");
    expect(res).toBe("forced");
  });

  it("uses the positive pid on win32 (no process groups)", async () => {
    const kill = vi.fn();
    await killProcessGroup(123, { kill, platform: "win32", graceMs: 5 });
    expect(kill).toHaveBeenCalledWith(123, "SIGTERM");
  });
});
