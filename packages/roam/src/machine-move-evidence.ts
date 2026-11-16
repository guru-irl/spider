import type { Db } from "@spider/db-core";
import { readLocal } from "@spider/db-core/roam/local-state";
import type { SessionEndpoint } from "@spider/intercom/protocol";
import type { FreezeJournal } from "./journal";
import type { Operation, RoamConfig, Transport } from "./contracts";
import { readPushedRollbackEvidence, readRollbackEvidence, type RollbackEvidence } from "./move-ports";
import { probeIntercomProcess, type GenerationProcess } from "./intercom-exclusion";
export function machineMoveEvidence(input: { db: Db; config: RoamConfig; journal: FreezeJournal; transport: Transport }) {
  const { db, config, journal } = input;
  return {
    moveJournal: journal as FreezeJournal,
    async moveOwns(endpoint: SessionEndpoint): Promise<boolean> {
      if (endpoint.machineId !== config.machineId) return false;
      const row = readLocal<GenerationProcess>(db, "intercom-generation", JSON.stringify([endpoint.address.sessionId, endpoint.activationEpoch]));
      if (!row || row.version !== 1 || row.sessionId !== endpoint.address.sessionId || row.generation !== endpoint.activationEpoch) return false;
      const owner = probeIntercomProcess(row.pid);
      return owner.kind === "live" && owner.startIdentity === row.startIdentity;
    },
    async moveRollbackProof(operation: Operation): Promise<RollbackEvidence | null> {
      if (config.role === "hub" && config.machineId === config.hubMachineId) return readRollbackEvidence(db, journal, operation);
      return readPushedRollbackEvidence(db, config, operation);
    },
  };
}
