import type { UsageRoots } from "./discovery.js";
import type { LedgerHealth } from "./ledger.js";
import type { CounterState } from "./counter.js";
import type { CalibrationResult, SourceErrorRow, Period } from "./dashboard-contract.js";

export type UsageWorkerCommand =
  | { type: "start"; roots: UsageRoots; owner: string; child: boolean; poll: boolean; calibration?: "auto" | "off"; metadataBackfillBytesPerPass?: number; dashboardMode?: boolean; sessionId?: string | null }
  | { type: "refresh" }
  | { type: "configure"; poll: boolean; calibration?: "auto" | "off" }
  | { type: "stop" };
export type BackfillState = "pending" | "running" | "complete" | "failed";
export type ReconciliationView = {
  windowStart: number; windowEnd: number; computedAIC: number;
  counterAIC: number | null; gap: number | null; ratio: number | null;
  unpricedCalls: number; estimated: boolean;
};
export type UsageCollector = { kind: "pi" | "dashboard"; sessionId: string | null; owner: string };
export type UsageProgress = { sourcesCompleted: number; sourcesTotal: number };
/** At most 20 redacted D9 rows. Older workers may omit this field. */
export type SourceErrorDiagnostics = { rows: readonly SourceErrorRow[]; truncated: boolean };
export type UsageWorkerEvent =
  | { type: "snapshot"; metadataBackfill?: BackfillState; metadataProgress?: UsageProgress; monthUsed?: number | null; monthPeriod?: Period; collector?: UsageCollector; sourceErrorDiagnostics?: SourceErrorDiagnostics; calibration?: CalibrationResult; health: LedgerHealth; counter: CounterState; backfill: BackfillState; reconciliation: ReconciliationView; progress?: UsageProgress; ingestRole?: "owner" | "follower" | "standby" }
  | { type: "error"; code: string }
  | { type: "standby" }
  | { type: "stopped"; released?: boolean };
export type UsageRuntimeSnapshot = {
  metadataBackfill?: BackfillState; metadataProgress?: UsageProgress;
  monthUsed?: number | null; monthPeriod?: Period;
  collector?: UsageCollector;
  sourceErrorDiagnostics?: SourceErrorDiagnostics;
  calibration?: CalibrationResult; health: LedgerHealth | null; counter: CounterState | null; backfill: BackfillState;
  reconciliation: ReconciliationView | null; progress?: UsageProgress; ingestRole?: "owner" | "follower" | "standby"; errorCode: string | null;
};
