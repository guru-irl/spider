// packages/ui/src/components/table.ts
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeAdapter } from "../agents/types";

interface Col { header: string; align?: "left" | "right"; token?: string }

export function renderTable(
  theme: ThemeAdapter,
  opts: { columns: Col[]; rows: string[][]; width: number },
): string[] {
  const { columns, rows, width } = opts;
  const nCols = columns.length;
  const raw = [columns.map((c) => c.header), ...rows];
  const colW = new Array(nCols).fill(0);
  for (const r of raw) for (let i = 0; i < nCols; i++) colW[i] = Math.max(colW[i], visibleWidth(r[i] ?? ""));

  // Shrink columns right-to-left to fit width (gap = 1 space between columns).
  const gap = 1;
  let total = colW.reduce((s, w) => s + w, 0) + gap * (nCols - 1);
  for (let i = nCols - 1; i >= 0 && total > width; i--) {
    const over = total - width;
    const shrink = Math.min(over, colW[i]);
    colW[i] -= shrink; total -= shrink;
  }

  const pad = (s: string, w: number, align?: "left" | "right"): string => {
    const t = truncateToWidth(s, w, "");
    const fill = " ".repeat(Math.max(0, w - visibleWidth(t)));
    return align === "right" ? fill + t : t + fill;
  };

  return raw.map((r, ri) =>
    truncateToWidth(
      columns.map((c, i) => {
        const cell = pad(r[i] ?? "", colW[i], c.align);
        if (ri === 0) return theme.fg("muted", cell);
        return c.token ? theme.fg(c.token, cell) : cell;
      }).join(" ".repeat(gap)),
      width,
    ),
  );
}
