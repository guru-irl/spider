import type { RunCostFormatter } from "@spider/ui";

type RunUsageSnapshot = { calibration?: { status?: string; factor?: number | null } };

function credits(value: number): string {
  if (value > 0 && value < 0.05) return "<0.1";
  return value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString("en-US");
}

/** Reads the footer's existing worker snapshot, never the usage ledger. */
export function makeRunCostFormatter(snapshot: () => RunUsageSnapshot | undefined): RunCostFormatter {
  return costs => {
    let copilot = 0, other = 0, hasCopilot = false, hasOther = false;
    for (const item of costs) {
      if (item.provider === "github-copilot") { copilot += item.cost; hasCopilot = true; }
      else { other += item.cost; hasOther = true; }
    }
    if (!hasCopilot) return `$${other.toFixed(2)}`;
    const calibration = snapshot()?.calibration;
    const factor = calibration?.status === "calibrated" && typeof calibration.factor === "number"
      && Number.isFinite(calibration.factor) && calibration.factor > 0 ? calibration.factor : 1;
    const text = `${credits(copilot * 100 * factor)} credits`;
    return hasOther ? `${text} + $${other.toFixed(2)}` : text;
  };
}
