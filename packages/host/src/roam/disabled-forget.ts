import { join } from "node:path";
import { paths } from "@spider/db-core";
import { withProcessLock } from "@spider/herdr/sessions/registry";
import { readLocalIdentity } from "@spider/roam/runtime";
import type { DisabledForgetResult } from "@spider/roam/disabled-forget-contract";
export type { DisabledForgetResult } from "@spider/roam/disabled-forget-contract";

/** Explicit repair takes the hub lock without importing or starting its service. */
export async function runDisabledForget(input: { machine: string; confirmed: true }): Promise<DisabledForgetResult> {
  const root = process.env.SPIDER_GLOBAL_ROOT || paths.globalRoot;
  if (readLocalIdentity(root).enabled) return { ok: false, reason: "not-disabled" };
  try {
    return await withProcessLock(join(root, "roam"), "roam-hub", async () => {
      const config = readLocalIdentity(root);
      if (config.enabled) return { ok: false as const, reason: "not-disabled" as const };
      if (input.confirmed !== true) return { ok: false as const, code: 2 as const, reason: "destroyed-machine-confirmation-required", operationId: "", value: null, recovered: [], results: [] };
      const [{ openLocalCore }, { loadHerdrConfig }, { createTransport }, { openFreezeJournal }, { forgetMachineForRuntime }, { createHostMoveBindings }] = await Promise.all([
        import("@spider/roam/runtime"), import("@spider/roam/host-config"), import("@spider/roam/transport"), import("@spider/roam/journal"),
        import("@spider/roam/machine-forget"), import("./move-runtime"),
      ]);
      const core = openLocalCore(root);
      try {
        const machineId = config.peers.find(peer => peer.machineId === input.machine || peer.alias === input.machine)?.machineId ?? input.machine;
        const transport = createTransport({ binary: loadHerdrConfig(root).core.binary, env: process.env, enrolled: config.peers });
        return await forgetMachineForRuntime({ root, config, globalDb: core.db, journal: openFreezeJournal(join(root, "roam", "journal.db")), transport },
          createHostMoveBindings, { machine: input.machine, confirmation: `destroyed ${machineId}` });
      } finally { core.close(); }
    }, { timeoutMs: 100 });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "lock-occupied") return { ok: false, reason: "hub-running" };
    return { ok: false, code: 3, reason: "recovery-unavailable", operationId: "", value: null, recovered: [], results: [] };
  }
}
