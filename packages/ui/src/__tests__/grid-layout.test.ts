import { describe, it, expect } from "vitest";
import { layoutGrid } from "../agents/grid-layout.js";

describe("layoutGrid", () => {
  it("1 → 1x1 full", () => expect(layoutGrid(1)).toMatchObject({ rows: 1, cols: 1, perPage: 1, pages: 1 }));
  it("2 → 1x2", () => expect(layoutGrid(2)).toMatchObject({ rows: 1, cols: 2, perPage: 2, pages: 1 }));
  it("3 → 2x2", () => expect(layoutGrid(3)).toMatchObject({ rows: 2, cols: 2, perPage: 4, pages: 1 }));
  it("4 → 2x2", () => expect(layoutGrid(4)).toMatchObject({ rows: 2, cols: 2, perPage: 4 }));
  it("9 → 3x3", () => expect(layoutGrid(9)).toMatchObject({ rows: 3, cols: 3, perPage: 9, pages: 1 }));
  it("16 → 4x4 single page", () => expect(layoutGrid(16)).toMatchObject({ rows: 4, cols: 4, perPage: 16, pages: 1 }));
  it("17 → 4x4 paginated (2 pages)", () => expect(layoutGrid(17)).toMatchObject({ rows: 4, cols: 4, perPage: 16, pages: 2 }));
  it("clamps page into range", () => expect(layoutGrid(17, 99).page).toBe(1));
  it("0 → empty", () => expect(layoutGrid(0)).toMatchObject({ rows: 0, cols: 0, pages: 1 }));
});
