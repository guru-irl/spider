import { expect, it, vi } from "vitest";
import { registerUsage } from "../usage/mount";
import { UsageRuntime } from "../usage/runtime";
import { calibrationFallback } from "../usage/calibration";
vi.mock("../control", () => ({ controlConfig: () => ({}) }));
vi.mock("../usage/ledger", () => ({ openUsageLedger: () => { throw new Error("ledger reads forbidden"); } }));
// Break: the controller omits access, freezes a startup factor, or exposes a stopped runtime.
it("exposes only the current footer runtime snapshot and clears it on shutdown", async () => {
  const callbacks = new Map<string, Function>();
  const start = vi.spyOn(UsageRuntime.prototype, "start").mockImplementation(() => {});
  let factor = 2;
  const snapshot = vi.spyOn(UsageRuntime.prototype, "snapshot").mockImplementation(() => ({
    health: null, counter: null, backfill: "pending", reconciliation: null, errorCode: null,
    calibration: { ...calibrationFallback(), status: "calibrated", factor },
  }));
  const pi = { on: (name: string, callback: Function) => { callbacks.set(name, callback); } };
  const controller = registerUsage(pi as never, "file:///fixture/worker.mjs");
  const ctx = { mode: "print", cwd: "fixture", sessionManager: { getSessionId: () => "fixture" } };
  try {
    expect(controller.snapshot?.()).toBeUndefined();
    await callbacks.get("session_start")!({}, ctx);
    expect(controller.snapshot?.()?.calibration?.factor).toBe(2);
    factor = 3;
    expect(controller.snapshot?.()?.calibration?.factor).toBe(3);
    await callbacks.get("session_shutdown")!();
    expect(controller.snapshot?.()).toBeUndefined();
  } finally { await callbacks.get("session_shutdown")!(); start.mockRestore(); snapshot.mockRestore(); }
});
