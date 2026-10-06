import type { UsageRoots } from "./discovery.js";
import type { LedgerHealth } from "./ledger.js";
import type { CounterState } from "./counter.js";
import type { CalibrationResult } from "./dashboard-contract.js";

export type UsageWorkerCommand =
  | { type: "start"; roots: UsageRoots; owner: string; child: boolean; poll: boolean; calibration?: "auto" | "off"; dashboardMode?: boolean }
  | { type: "refresh" }
  | { type: "configure"; poll: boolean; calibration?: "auto" | "off" }
  | { type: "stop" };
export type BackfillState = "pending" | "running" | "complete" | "failed";
export type ReconciliationView = {
  windowStart: number; windowEnd: number; computedAIC: number;
  counterAIC: number | null; gap: number | null; ratio: number | null;
  unpricedCalls: number; estimated: boolean;
};
export type UsageProgress = { sourcesCompleted: number; sourcesTotal: number };
export type UsageWorkerEvent =
  | { type: "snapshot"; calibration?: CalibrationResult; health: LedgerHealth; counter: CounterState; backfill: BackfillState; reconciliation: ReconciliationView; progress?: UsageProgress; ingestRole?: "owner" | "follower" | "standby" }
  | { type: "error"; code: string }
  | { type: "standby" }
  | { type: "stopped"; released?: boolean };
export type UsageRuntimeSnapshot = {
  calibration?: CalibrationResult; health: LedgerHealth | null; counter: CounterState | null; backfill: BackfillState;
  reconciliation: ReconciliationView | null; progress?: UsageProgress; ingestRole?: "owner" | "follower" | "standby"; errorCode: string | null;
};
