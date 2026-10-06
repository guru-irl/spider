import type { AicDisplay, CalibrationResult } from "./dashboard-contract.js";

/** Unpriced evidence remains on the measure/caller; scaling never fills missing prices. */
export function toAicDisplay(publishedAic: number | null, _unpricedCalls: number, calibration: CalibrationResult): AicDisplay {
  const calibrated = calibration.status === "calibrated" && calibration.factor !== null;
  return { publishedAic, primaryAic: publishedAic === null ? null : calibrated ? publishedAic * calibration.factor! : publishedAic,
    basis: calibrated ? "calibrated" : "published" };
}
