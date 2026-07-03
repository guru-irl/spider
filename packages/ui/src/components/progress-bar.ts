// packages/ui/src/components/progress-bar.ts
import type { ThemeAdapter } from "../agents/types.js";

export function renderProgressBar(
  theme: ThemeAdapter,
  opts: { value: number; max: number; width: number; filled?: string; empty?: string },
): string {
  const { value, max, width } = opts;
  if (width < 1) return "";
  const filled = opts.filled ?? "█";
  const empty = opts.empty ?? "░";
  const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const n = Math.round(ratio * width);
  return theme.fg("accent", filled.repeat(n)) + theme.fg("muted", empty.repeat(width - n));
}
