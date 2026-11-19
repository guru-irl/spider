import { afterEach, expect, it } from "vitest";
import { provisionIntercomEnrollment } from "../intercom-enrollment";
import { createIntercomRegistry } from "../intercom-registry";
import { removePairMachineRoute } from "../intercom-pair-resources";
import { scenario, cleanupPairScenarios } from "./intercom-pair-fixture";
afterEach(cleanupPairScenarios);
const A = "00000000-0000-4000-8000-000000000002", B = "00000000-0000-4000-8000-000000000003";
async function enrolled() {
  const f = await scenario(); expect((await provisionIntercomEnrollment(f.request, f.enrollment)).code).toBe(0);
  const record = (await createIntercomRegistry(f.source.globalRoot).get("pair-1"))!;
  return { f, pair: record.pair as Parameters<typeof removePairMachineRoute>[0], resources: record.resources!, run: f.locals.get(A)!.run };
}
it.each([[false, true], [true, false]])("requires both B closure=%s and key removal=%s before consulting hc", async (hostClosed, keyRemoved) => {
  const { f, pair, resources, run } = await enrolled(), before = f.calls.length;
  expect(await removePairMachineRoute(pair, resources, { run, hostClosed, keyRemoved })).toBe("unknown");
  expect(f.calls).toHaveLength(before); expect(f.machines()).toHaveLength(1);
}, 5000);
it("an empty B-local list allows only its exact reserved route to be removed", async () => {
  const { f, pair, resources, run } = await enrolled();
  expect(await removePairMachineRoute(pair, resources, { run, hostClosed: true, keyRemoved: true, terminalInventory: { machineId: B, targetCoreId: "core-b", status: "empty" } })).toBe("removed");
  expect(f.machines()).toEqual([]);
}, 5000);
it.each(["live", "finished", "starting"])("the fallback route inventory handles %s rows without labels", async state => {
  const { f, pair, resources, run } = await enrolled();
  f.terminals([{ address: "spider-pair-pair-1/ta", state }]);
  expect(await removePairMachineRoute(pair, resources, { run, hostClosed: true, keyRemoved: true })).toBe(
    state === "finished" ? "removed" : state === "live" ? "shared-jobs" : "unknown");
  expect(f.machines()).toHaveLength(state === "finished" ? 0 : 1);
}, 5000);
it.each([
  { machineId: A, targetCoreId: "core-b", status: "empty" as const },
  { machineId: B, targetCoreId: "wrong-core", status: "empty" as const },
  { machineId: B, targetCoreId: "core-b", status: "unknown" as const },
])("an unbound or unknown B inventory never authorizes route removal %#", async terminalInventory => {
  const { f, pair, resources, run } = await enrolled();
  expect(await removePairMachineRoute(pair, resources, { run, hostClosed: true, keyRemoved: true, terminalInventory })).toBe("unknown");
  expect(f.calls.some(call => call.includes("machine rm"))).toBe(false);
}, 5000);
it.each(["missing", "ambiguous", "hidden", "duplicate"])("a %s terminal inventory stays pending", async issue => {
  const { f, pair, resources, run } = await enrolled();
  const guarded = async (argv: readonly string[], options: Parameters<typeof run>[1]) => argv[1] === "ls" ? { code: 0, stdout: JSON.stringify({
    terminals: issue === "duplicate" ? [{ address: "other.invalid/t1" }, { address: "other.invalid/t1" }] : [],
    machines: issue === "missing" ? [] : issue === "ambiguous" ? [...f.machines(), ...f.machines()] : f.machines(), hidden_finished: issue === "hidden" ? 1 : 0,
  }) } : run(argv, options);
  expect(await removePairMachineRoute(pair, resources, { run: guarded, hostClosed: true, keyRemoved: true })).toBe("unknown");
  expect(f.calls.some(call => call.includes("machine rm"))).toBe(false);
}, 5000);
