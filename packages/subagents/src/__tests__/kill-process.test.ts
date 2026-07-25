import { describe, it, expect, vi } from "vitest";
import { isProcessAlive, killProcessGroup } from "../kill-process";

describe("isProcessAlive", () => {
  it("is true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("is false for an implausible pid", () => {
    expect(isProcessAlive(2_147_483_600)).toBe(false);
  });

  it("treats EPERM as alive (process exists, owned by another user)", () => {
    const kill = vi.fn(() => {
      const e: any = new Error("permission denied");
      e.code = "EPERM";
      throw e;
    });
    expect(isProcessAlive(123, kill)).toBe(true);
  });

  it("treats ESRCH as dead", () => {
    const kill = vi.fn(() => {
      const e: any = new Error("no such process");
      e.code = "ESRCH";
      throw e;
    });
    expect(isProcessAlive(123, kill)).toBe(false);
  });
});

describe("killProcessGroup", () => {
  it("reports already-dead when the first signal throws ESRCH", async () => {
    const kill = vi.fn(() => { const e: any = new Error("no such process"); e.code = "ESRCH"; throw e; });
    const res = await killProcessGroup(123, { kill, platform: "darwin", graceMs: 1 });
    expect(res).toBe("already-dead");
  });

  it("sends SIGTERM to the negative pid on unix", async () => {
    const kill = vi.fn((p: number, sig: NodeJS.Signals | number) => {
      if (p === -123 && sig === "SIGTERM") return;          // group SIGTERM: expected
      if (p === 123 && sig === 0) { const e: any = new Error("gone"); e.code = "ESRCH"; throw e; } // leader probe: correct
      throw new Error(`unexpected kill(${p}, ${String(sig)})`);
    });
    const res = await killProcessGroup(123, { kill, platform: "darwin", graceMs: 5 });
    expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(123, 0); // Must probe LEADER, not group
    expect(res).toBe("terminated");
  });

  it("escalates to SIGKILL when the process survives the grace period", async () => {
    const kill = vi.fn((p: number, sig: NodeJS.Signals | number) => {
      if (p === -123 && (sig === "SIGTERM" || sig === "SIGKILL")) return; // group signals: expected
      if (p === 123 && sig === 0) return; // leader probe: still alive
      throw new Error(`unexpected kill(${p}, ${String(sig)})`);
    });
    const res = await killProcessGroup(123, { kill, platform: "darwin", graceMs: 5 });
    expect(kill).toHaveBeenCalledWith(-123, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(123, 0); // Must probe LEADER, not group
    expect(kill).toHaveBeenCalledWith(-123, "SIGKILL");
    expect(res).toBe("forced");
  });

  it("uses the positive pid on win32 (no process groups)", async () => {
    const kill = vi.fn();
    await killProcessGroup(123, { kill, platform: "win32", graceMs: 5 });
    expect(kill).toHaveBeenCalledWith(123, "SIGTERM");
  });
});
