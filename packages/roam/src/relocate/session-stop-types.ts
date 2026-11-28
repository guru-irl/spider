import type { MachineId } from "@spider/db-core/roam/types";
import type { RelocateHome, RunningHome, SessionId, StoppedHome } from "./types";

export type StopMode = "graceful" | "hard";
export type OwnerGeneration = { pid: number; startIdentity: string; bootId: string };
export type StartRequest = { operationId: string; sessionId: SessionId; machineId: MachineId; homeEpoch: number };
export type StopRequest = StartRequest & { mode: StopMode };
export type StopBlocker = { kind: "job"; id: string; cancelFromOwner: boolean } | { kind: "check"; reason: string };
export type StopObservation = {
  sessionId: SessionId;
  machineId: MachineId;
  home: RelocateHome | null;
  bootId: string | null;
  observedAt: number | null;
  evidence:
    | { kind: "checking" }
    | { kind: "pending"; reason: string; blockers: readonly StopBlocker[] }
    | { kind: "confirmed"; owner: OwnerGeneration | null };
};

export type CoreStatus = "running" | "stopping" | "stopped" | "stop-pending" | "starting" | "moving";
export type SessionStatus = {
  sessionId: SessionId;
  machineId: MachineId | null;
  homeEpoch: number | null;
  homeState: RelocateHome["state"] | null;
  status: CoreStatus | null;
  reason: string | null;
  observedAt: number | null;
};
export type SessionOutcome = SessionStatus & { operationId: string; outcome: "complete" | "pending" | "refused" };

export type SessionTransition = {
  operationId: string;
  expected: RelocateHome;
  // Set by the hub using operator-facing reasons, never a raw transport error.
  contactReason: string | null;
} & (
  | {
    action: "stop" | "relocate" | "force";
    committed: StoppedHome;
    mode: StopMode;
    displaced: readonly MachineId[];
    observations: readonly StopObservation[];
  }
  | { action: "start"; committed: RunningHome; observedAt: number | null }
);

export type OperationBinding =
  | { action: "stop"; request: StopRequest; committed: StoppedHome }
  | { action: "start"; request: StartRequest; committed: RunningHome };

export interface SessionStopStore {
  current(id: SessionId): SessionTransition | null;
  list(): readonly SessionTransition[];
  operation(id: string): OperationBinding | null;
  write(record: SessionTransition, binding?: OperationBinding): undefined;
}
