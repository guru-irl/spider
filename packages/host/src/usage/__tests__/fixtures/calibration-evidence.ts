import { openUsageLedger } from "../../ledger.js";
import { dashboardBatch, dashboardCall } from "./dashboard-ledger.js";

/** Fixture-only evidence with an independently known factor of one half. */
export function seedCalibrationEvidence(file: string, now: number = Date.now()): void {
  const day = 86400000, ledger = openUsageLedger(file);
  try {
    ledger.apply(dashboardBatch([dashboardCall("reload-evidence", { ts: now - 1.5 * day,
      price: { status: "priced", aic: 1000, components: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 0 }, rateVersion: "fixture", tier: "base", confidence: "estimated" } })]));
    for (const [ts, creditsUsed] of [[now - 2 * day, 0], [now - day, 500]]) {
      ledger.insertCounter({ ts: ts!, creditsUsed: creditsUsed!, accountLogin: "synthetic", resetDate: "synthetic-reset", raw: {} });
    }
  } finally { ledger.close(); }
}
