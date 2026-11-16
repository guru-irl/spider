import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LIMITS, disabledIntercom, type RoamConfig } from "@spider/roam/contracts";
import * as runtime from "@spider/roam/runtime";
import * as productionHub from "@spider/roam/production-hub";
import type { DisabledForgetResult } from "@spider/roam/disabled-forget-contract";
import * as disabledForget from "../disabled-forget";
import { main, startProductionHub } from "../cli-main";
import { createHostMoveBindings } from "../move-runtime";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const config: RoamConfig = {
  enabled: false, role: "hub", machineId: HUB, hubMachineId: HUB,
  peers: [{ machineId: BOX, alias: "box.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/spider", core: "fixture-core", globalRoot: "/fixture/global" }],
  discoveryRoots: [], coreUnit: "fixture-core", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom(),
};
afterEach(() => { vi.restoreAllMocks(); });

function command() {
  vi.spyOn(runtime, "readLocalIdentity").mockReturnValue(config);
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) } };
}
const pending: DisabledForgetResult = {
  ok: true, code: 0, operationId: "forget-box", reason: "destroyed-machine-recovered", presentation: "pending", value: [], results: [],
};
it("the installed CLI binds disabled forget to recovery and preserves pending presentation", async () => {
  const f = command(), recover = vi.spyOn(disabledForget, "runDisabledForget").mockResolvedValue(pending);
  expect(await main(["roam", "forget", "box.invalid", "--confirm", "destroyed box.invalid", "--json"], f.io)).toBe(0);
  expect(recover).toHaveBeenCalledExactlyOnceWith({ machine: BOX, confirmed: true });
  expect(JSON.parse(f.out.join(""))).toEqual(pending);
  expect(f.err).toEqual([]);
});
it.each(["hub-running", "not-disabled"] as const)("disabled forget preserves the production %s refusal", async reason => {
  const f = command();
  vi.spyOn(disabledForget, "runDisabledForget").mockResolvedValue({ ok: false, reason });
  expect(await main(["roam", "forget", BOX, "--confirm", `destroyed ${BOX}`, "--json"], f.io)).toBe(1);
  expect(JSON.parse(f.out.join(""))).toEqual({ ok: false, reason });
});
it("disabled forget requires confirmation before calling recovery", async () => {
  const f = command(), recover = vi.spyOn(disabledForget, "runDisabledForget").mockResolvedValue(pending);
  expect(await main(["roam", "forget", "box.invalid", "--json"], f.io)).toBe(2);
  expect(recover).not.toHaveBeenCalled();
  expect(f.err.join("")).toContain("two copies can run");
});
it("explicit CLI recovery dependencies override production defaults", async () => {
  const f = command(), recover = vi.spyOn(disabledForget, "runDisabledForget").mockRejectedValue(new Error("must not use default"));
  const custom = vi.fn(async () => pending);
  expect(await main(["roam", "forget", BOX, "--confirm", `destroyed ${BOX}`, "--json"], f.io, { runDisabledForget: custom })).toBe(0);
  expect(custom).toHaveBeenCalledExactlyOnceWith({ machine: BOX, confirmed: true });
  expect(recover).not.toHaveBeenCalled();
});
it("the CLI passes its production move factory to hub startup", async () => {
  const f = command(), start = vi.spyOn(productionHub, "startProductionHub").mockRejectedValue(new Error("service not started in this test"));
  expect(await main(["roam", "hub"], f.io)).toBe(1);
  expect(start).toHaveBeenCalledWith(expect.any(String), { moveFactory: createHostMoveBindings });
});
it("the packaged hub export supplies host recovery bindings by default", async () => {
  const stop = vi.fn(async () => {}), start = vi.spyOn(productionHub, "startProductionHub").mockResolvedValue({ stop });
  expect(await startProductionHub("/fixture/global")).toEqual({ stop });
  expect(start).toHaveBeenCalledExactlyOnceWith("/fixture/global", { moveFactory: createHostMoveBindings });
});
it("the packaged hub export retains an explicit move factory", async () => {
  const factory: typeof createHostMoveBindings = async () => { throw new Error("must not mount a runtime"); };
  const stop = vi.fn(async () => {}), start = vi.spyOn(productionHub, "startProductionHub").mockResolvedValue({ stop });
  expect(await startProductionHub("/fixture/global", { moveFactory: factory })).toEqual({ stop });
  expect(start).toHaveBeenCalledExactlyOnceWith("/fixture/global", { moveFactory: factory });
});
