import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import * as runtime from "@spider/roam/runtime";
import * as config from "@spider/roam/host-config";
import * as recovery from "@spider/roam/machine-forget";
import * as transport from "@spider/roam/transport";
import { runDisabledForget, type DisabledForgetResult } from "../disabled-forget";
import { recoveryFixture, OTHER } from "../../../../roam/src/__tests__/recovery-fixture";
const closes: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const close of closes.splice(0)) close(); });
async function fixture() {
  const f = await recoveryFixture(); closes.push(f.close); f.ports.config.enabled = false;
  mkdirSync(join(f.root, "roam")); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  vi.spyOn(runtime, "readLocalIdentity").mockImplementation(() => f.ports.config);
  vi.spyOn(runtime, "openLocalCore").mockReturnValue({ root: f.root, db: f.global.db, config: f.ports.config, close() {} });
  vi.spyOn(transport, "createTransport").mockReturnValue({ resolve: async () => { throw new Error("disabled recovery cannot contact peers"); } } as never);
  vi.spyOn(config, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  return f;
}
it("disabled forget refuses enabled state before opening recovery or taking effects", async () => {
  const f = await fixture(); f.ports.config.enabled = true;
  expect(await runDisabledForget({ machine: OTHER, confirmed: true })).toEqual({ ok: false, reason: "not-disabled" });
  expect(runtime.openLocalCore).not.toHaveBeenCalled();
}, 5000);
it("disabled forget uses the hub single-instance lock before opening recovery", async () => {
  const f = await fixture();
  expect(await withProcessLock(join(f.root, "roam"), "roam-hub", () => runDisabledForget({ machine: OTHER, confirmed: true }))).toEqual({ ok: false, reason: "hub-running" });
  expect(runtime.openLocalCore).not.toHaveBeenCalled();
}, 5000);
it("disabled forget passes the shared engine's pending presentation result through unchanged", async () => {
  const f = await fixture(), home = { ...f.oldHome!, machineId: f.ports.config.machineId, epoch: 2 };
  const pending: DisabledForgetResult = { ok: true, code: 0, reason: "destroyed-machine-recovered", operationId: "forget-a", presentation: "pending", value: [home],
    results: [{ sessionId: home.sessionId, code: 0, reason: "restored", home, presentation: "pending", repairCommand: null }] };
  await import("../move-runtime");
  const engine = vi.spyOn(recovery, "forgetMachineForRuntime").mockResolvedValue(pending);
  expect(await runDisabledForget({ machine: "box-2.invalid", confirmed: true })).toBe(pending);
  expect(engine).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ enabled: false }) }), expect.any(Function), { machine: "box-2.invalid", confirmation: `destroyed ${OTHER}` });
  expect(f.ports.config.enabled).toBe(false);
}, 5000);
it("disabled forget rechecks configuration under the lock before opening recovery", async () => {
  const f = await fixture(); vi.mocked(runtime.readLocalIdentity).mockReturnValueOnce(f.ports.config).mockReturnValueOnce({ ...f.ports.config, enabled: true });
  expect(await runDisabledForget({ machine: OTHER, confirmed: true })).toEqual({ ok: false, reason: "not-disabled" });
  expect(runtime.openLocalCore).not.toHaveBeenCalled();
}, 5000);
