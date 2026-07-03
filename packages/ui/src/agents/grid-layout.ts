import type { GridLayout } from "./types";

export function layoutGrid(count: number, page = 0): GridLayout {
  if (count <= 0) return { rows: 0, cols: 0, perPage: 0, pages: 1, page: 0 };
  let rows: number, cols: number;
  if (count === 1) { rows = 1; cols = 1; }
  else if (count === 2) { rows = 1; cols = 2; }
  else if (count <= 4) { rows = 2; cols = 2; }
  else if (count <= 9) { rows = 3; cols = 3; }
  else { rows = 4; cols = 4; } // 10–16 and paginated beyond
  const perPage = rows * cols;
  const pages = Math.max(1, Math.ceil(count / perPage));
  const clamped = Math.min(Math.max(0, page), pages - 1);
  return { rows, cols, perPage, pages, page: clamped };
}
