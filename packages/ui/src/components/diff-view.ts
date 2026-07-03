// packages/ui/src/components/diff-view.ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types.js";

interface Hunk { kind: "add" | "remove" | "context"; text: string }
const PREFIX = { add: "+", remove: "-", context: " " } as const;
const TOKEN = { add: "toolDiffAdded", remove: "toolDiffRemoved", context: "toolDiffContext" } as const;

export function renderDiffView(
  theme: ThemeAdapter,
  opts: { hunks: Hunk[]; width: number; maxLines?: number },
): string[] {
  const { hunks, width } = opts;
  const max = opts.maxLines ?? hunks.length;
  const shown = hunks.slice(0, max);
  const lines = shown.map((h) => {
    const raw = truncateToWidth(PREFIX[h.kind] + h.text, width, "");
    return theme.fg(TOKEN[h.kind], raw);
  });
  const rest = hunks.length - shown.length;
  if (rest > 0) lines.push(theme.fg("muted", truncateToWidth(`… ${rest} more`, width, "")));
  return lines;
}
