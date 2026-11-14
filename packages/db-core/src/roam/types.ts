import type { Db } from "../db";

export type Scope = "global" | "repo" | "worktree";
export type MachineId = string;
export type StoreKey = "global" | `repo:${string}` | `worktree:${string}:${string}`;
export type Entity = "global_memory" | "memory" | "sessions" | "todos" | "runs" | "run_events" | "session_homes";
export interface Descriptor {
  scope: Scope;
  table: string;
  key: string;
  columns: readonly string[];
  sessionColumn: string | null;
  immutable: readonly string[];
}
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface Hlc { ms: number; count: number; machine: MachineId; stream: string }
export interface Home { sessionId: string; machineId: MachineId; epoch: number; moveId: string | null; updatedAt: number }
export interface Change {
  changeId: string; entity: Entity; rowKey: string; op: "put" | "delete"; clock: Hlc;
  writerSession: string | null; writerEpoch: number | null; schema: 14; body: JsonObject | null;
}
export interface RecordChange extends Change { seq: number }
export interface BatchHeader {
  protocol: 1; schema: 14; batchId: string; senderMachine: MachineId; senderStream: string;
  storeKey: StoreKey; after: number; through: number; count: number;
}
export interface BatchArtifact { file: string; byteLength: number; sha256: string; header: BatchHeader }
declare const validatedBatchBrand: unique symbol;
export type ValidatedBatch = BatchArtifact & { readonly [validatedBatchBrand]: true };
/** `applyMs` is unavailable when replaying a persisted digest receipt. */
export interface ApplyReceipt { batchId: string; stream: string; through: number; sha256: string; applyMs: number | null }
export interface StoreBarrier { storeKey: StoreKey; stream: string; through: number }
export type LocalState = "active" | "frozen" | "retired";
export interface SessionState { sessionId: string; epoch: number; state: LocalState; moveId: string | null; freezeSeq: number | null }
export interface Locator { machineId: MachineId; repoKey: string; workspaceId: string; relativePath: string }
export interface HistoryRef { machineId: MachineId; reference: string }
export interface Segment {
  version: 1; moveId: string; epoch: number; previousMachine: MachineId; nextMachine: MachineId;
  historyMachine: MachineId; parentRef: HistoryRef | null;
}
export interface Blocker { kind: string; id: string; detail: string }
interface ReadinessOwner { sessionId: string; epoch: number; cwd: string; file: string; core: string; terminal: string }
export interface HubOperationReadiness extends ReadinessOwner { origin: "hub-operation"; opId: string }
export interface BoxLocalReadiness extends ReadinessOwner { origin: "box-local"; machineId: MachineId }
export type Readiness = HubOperationReadiness | BoxLocalReadiness;
export interface ExportPolicy { encode(entity: Entity, body: JsonObject, origin: MachineId): JsonObject }
export interface ReplicaEffects {
  winning(db: Db, before: { rowid: number; body: JsonObject } | null, after: { rowid: number } | null, change: Change): void;
  committed(storeKey: StoreKey): void;
}
export interface ProcessIdentity { bootId: string; pid: number; startTime: string }
export type Probe = { kind: "absent" } | { kind: "uncertain" } | { kind: "live"; identity: ProcessIdentity };
