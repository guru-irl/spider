export type DetailViewport =
  | { kind: "normal"; width: number; height: number; textWidth: number; conversationTop: 6; conversationRows: number }
  | { kind: "compact"; width: number; height: number }
  | { kind: "unusable"; width: number; height: number };

function cells(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Width requested from the terminal before pi resolves the overlay options. */
export function detailWidth(columns: number): number {
  const width = cells(columns);
  return Math.min(width, Math.max(24, Math.floor(0.8 * width)));
}

/** The width passed to render is already resolved by pi. */
export function detailViewport(width: number, safeHeight: number): DetailViewport {
  width = cells(width);
  const height = cells(safeHeight);
  if (width < 3 || height < 3) return { kind: "unusable", width, height };
  if (width < 24 || height < 9) return { kind: "compact", width, height };
  return {
    kind: "normal", width, height, textWidth: Math.max(1, width - 4),
    conversationTop: 6, conversationRows: height - 8,
  };
}
