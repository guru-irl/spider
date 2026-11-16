import { join } from "node:path";
import { openDb } from "@spider/db-core";
import { sessionHome } from "./homes";
import { resolveControlMachine } from "./commands";
import { createProductionRecoveryPorts } from "./recovery-transport";
import { createMovePorts, forgetMachineWithAdapters, type AdapterMachineRecoveryOutcome } from "./move-ports";
import type { MoveRuntimeFactory, MoveRuntimeInput } from "./move-runtime-contracts";

/** Machine-wide orchestration mounts participant effects only for each exact recovered session. */
export async function forgetMachineForRuntime(input: Omit<MoveRuntimeInput, "sessionId">, factory: MoveRuntimeFactory,
  request: { machine: string; confirmation: string }): Promise<AdapterMachineRecoveryOutcome> {
  const { config, journal } = input;
  const runtime = (sessionId: string, operation?: import("./contracts").Operation) => factory({ ...input, sessionId, operation });
    const machineId = resolveControlMachine(request.machine, config);
    if (!machineId) return { ok: false, code: 2, reason: "machine-not-enrolled", operationId: "", value: null, recovered: [], results: [] };
    const db = openDb(join(input.root, "roam", "journal.db"), { fileMustExist: true, checkpointOnClose: false });
    try {
      const ports = createMovePorts(config, input.transport, journal, { globalDb: input.globalDb, privateDb: db,
        recovery: { ...createProductionRecoveryPorts(input), mirrorRoot: join(input.root, "roam", "mirrors"), restoreWorkspace: async () => null, conflicts: async () => [] } });
      ports.replicateHome = async home => {
        if (!config.enabled) {
          const current = sessionHome(input.globalDb, home.sessionId);
          if (!current || current === "unknown" || current.machineId !== home.machineId || current.epoch !== home.epoch || current.moveId !== home.moveId) throw new Error("recovery-home-changed");
          return;
        }
        const mounted = await runtime(home.sessionId);
        try { await mounted.ports.replicateHome(home); } finally { await mounted.close(); }
      };
      ports.recovery.restore = async (home, mirror, operation) => {
        const mounted = await runtime(home.sessionId, operation);
        try { return await mounted.ports.recovery.restore(home, mirror, operation); } finally { await mounted.close(); }
      };
      ports.recovery.presentReadyTarget = async target => {
        const mounted = await runtime(target.sessionId);
        try { return await mounted.ports.recovery.presentReadyTarget(target); } finally { await mounted.close(); }
      };
      return await forgetMachineWithAdapters({ machineId, confirmation: request.confirmation }, ports);
    } finally { db.close(); }

}
