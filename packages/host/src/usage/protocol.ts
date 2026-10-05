import type { UsageRoots } from "./discovery.js";
import type { LedgerHealth } from "./ledger.js";
import type { CounterState } from "./counter.js";

export type UsageWorkerCommand =
  | { type: "start"; roots: UsageRoots; owner: string; child: boolean; poll: boolean }
  | { type: "refresh" }
  | { type: "configure"; poll: boolean }
  | { type: "stop" };
export type BackfillState = "pending" | "running" | "complete" | "failed";
export type ReconciliationView = {
  windowStart: number; windowEnd: number; computedAIC: number;
  counterAIC: number | null; gap: number | null; ratio: number | null;
  unpricedCalls: number; estimated: boolean;
};
export type UsageProgress = { sourcesCompleted: number; sourcesTotal: number };
export type UsageWorkerEvent =
  | { type: "snapshot"; health: LedgerHealth; counter: CounterState; backfill: BackfillState; reconciliation: ReconciliationView; progress?: UsageProgress; ingestRole?: "owner" | "follower" }
  | { type: "error"; code: string }
  | { type: "stopped" };
export type UsageRuntimeSnapshot = {
  health: LedgerHealth | null; counter: CounterState | null; backfill: BackfillState;
  reconciliation: ReconciliationView | null; progress?: UsageProgress; ingestRole?: "owner" | "follower"; errorCode: string | null;
};
