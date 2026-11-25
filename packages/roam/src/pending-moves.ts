import { existsSync } from "node:fs";
import { openDiagnosticSnapshot } from "./diagnostic-snapshot";
import { safeMoveFailureStep } from "./cause-codes";
import { parseMoveFailure } from "./move-failure";
import type { JsonObject } from "@spider/db-core/roam/types";
import { MOVE_REFUSAL_MESSAGES } from './contracts';
import { validateBlockerId } from './move';
import { ownershipFailureCode, ownershipRepair } from './ownership-failure';

export interface PendingMove { operationId: string; step: string; repairCommand: string | null; detail?: string }

/** Read-only evidence. An unreadable journal is not proof that moves are absent. */
export function readPendingMoves(file: string): PendingMove[] | null {
  if (!existsSync(file)) return [];
  try {
    const db = openDiagnosticSnapshot(file);
    if (!db) return null;
    try {
      const moves = db.prepare("SELECT operation_id FROM roam_operations WHERE kind='move' AND result_json IS NULL ORDER BY operation_id").all() as { operation_id: string }[];
      return moves.map(({ operation_id: operationId }) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) throw new Error("Invalid pending move ID");
        const rows = (db.prepare("SELECT action,result_json FROM roam_operation_actions WHERE operation_id=? ORDER BY seq").all(operationId) as { action: string; result_json: string }[])
          .map(row => ({ action: row.action, result: JSON.parse(row.result_json) as JsonObject }));
        const aborting = rows.some(row => row.action === "move-abort-start");
        const frozen = rows.some(row => row.action === "move-action-complete" && row.result.action === "freeze" || row.action === "move-state" && row.result.state === "frozen");
        const transferring = rows.some(row => row.action === "move-action-start" && row.result.action === "transfer" || row.action === "move-action-complete" && row.result.action === "home-commit");
        const failure = parseMoveFailure(rows.filter(row => row.action === "move-failure").at(-1)?.result);
        const action = rows.filter(row => row.action === "move-action-start").at(-1)?.result.action;
        const step = aborting ? "cancel" : failure?.step ?? safeMoveFailureStep(action) ?? "preflight";
        const repair = aborting || !frozen && !transferring ? "cancel" : "recover";
        const refused = rows.filter(row => row.action === 'move-recovery-refused').at(-1)?.result;
        if (refused?.reason === 'move-ownership-unavailable' && Array.isArray(refused.blockers)) {
          const blockers = refused.blockers.map(validateBlockerId);
          return { operationId, step, repairCommand: null, detail: `Blockers: ${blockers.join(', ')}. ${MOVE_REFUSAL_MESSAGES['move-ownership-unavailable']} ${ownershipRepair(ownershipFailureCode(refused.causeCode) ?? 'ownership-unavailable')}` };
        }
        return { operationId, step, repairCommand: `spider roam ${repair} ${operationId}` };
      });
    } finally { db.close(); }
  } catch { return null; }
}
