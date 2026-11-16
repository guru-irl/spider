import type { Db } from "@spider/db-core";
import type { MoveAdapterBindings } from "./move-ports";
import type { FreezeJournal } from "./journal";
import type { MovePorts, MoveSessionOutcome, Operation, Outcome, RoamConfig, Transport } from "./contracts";
import type { JsonObject } from "@spider/db-core/roam/types";
import type { MoveControlHandler } from "./move-control";
export interface MoveRuntimeInput {
  root: string; globalDb: Db; config: RoamConfig; journal: FreezeJournal; sessionId: string; transport: Transport;
  sync?: NonNullable<MoveAdapterBindings["sync"]>; operation?: Operation;
}
export interface MoveRuntime {
  bindings: MoveAdapterBindings; ports: MovePorts; control: MoveControlHandler;
  recover(): Promise<readonly MoveSessionOutcome[]>;
  dispatch?(operation: Operation): Promise<Outcome<JsonObject>>;
  close(): Promise<void>;
}
export type MoveRuntimeFactory = (input: MoveRuntimeInput) => Promise<MoveRuntime>;
