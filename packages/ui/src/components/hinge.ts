import { parseColor, type Color } from "@earendil-works/pi-tui";
import { BAND_GLYPHS } from "../icons.js";

// Round 5 Hinge: each pair of rows is one terminal row. Dots are transparent.
const HINGE = [
  "......LLLLL......",
  ".....LLMMMLL.....",
  "....MMMMMMMMM....",
  "..DDMMMMMMMMMDD..",
  ".D..MM*EMM*EM..D.",
  "D..DMEEEMEEEMD..D",
  ".DDDMMEMMMEMMDDD.",
  ".D.MMMMMMMMMMM.D.",
  "..DDMMMMMMMMMDD..",
  ".D...MMMMMMM...D.",
  "D...D.DDDDD.D...D",
  "...D.........D...",
] as const;
const PALETTE = new Map(Object.entries({ D: "#6f568d", M: "#9d7acb", L: "#bd93f9", E: "#242030", "*": "#f8f8f2" })
  .map(([symbol, hex]) => [symbol, parseColor(hex)]));
const THREAD = parseColor("#9a8ba9"), ANCHOR = parseColor("#c0aad0");
const DOTS = [[1, 8], [2, 16], [4, 32], [64, 128]] as const;

// Columns from the fixed hub and half-pixel rows from the top of the rig.
export const COUNTERWEIGHT = [
  { at: 0, dx: 0, top: 6 },
  { at: 200, dx: 0, top: 8 },
  { at: 460, dx: 0, top: 16 },
  { at: 800, dx: 5, top: 12 },
  { at: 1150, dx: -3, top: 12 },
  { at: 1630, dx: 0, top: 14, blink: true },
  { at: 1780, dx: 0, top: 14 },
] as const satisfies readonly { at: number; dx: number; top: number; blink?: boolean }[];
export const REST_POSE = COUNTERWEIGHT.length - 1;
export const HINGE_WIDTH = HINGE[0].length;
export const HINGE_RIG_HEIGHT = 15;

export type ColorCells = { style(text: string, options: { fg?: Color; bg?: Color }): string };

function dragline(width: number, anchor: number, end: number, top: number): Map<number, number> {
  const line = new Map<number, number>();
  const plot = (x: number, y: number) => {
    const cell = Math.floor(y / 4) * width + Math.floor(x / 2);
    line.set(cell, (line.get(cell) ?? 0) | DOTS[y % 4]![x % 2]!);
  };
  // Rasterize the single line on the braille subcell grid. The sprite wins at its crown.
  let x = anchor * 2, y = 4;
  const tx = end * 2, ty = top * 2;
  const dx = Math.abs(tx - x), sx = x < tx ? 1 : -1;
  const dy = -Math.abs(ty - y);
  let error = dx + dy;
  for (;;) {
    plot(x, y);
    if (x === tx && y === ty) break;
    const step = 2 * error;
    if (step >= dy) { error += dy; x += sx; }
    if (step <= dx) { error += dx; y++; }
  }
  plot(anchor * 2, 3);
  return line;
}

function pixel(x: number, y: number, blink: boolean): Color | undefined {
  if (blink && y >= 4 && y <= 6 && ((x >= 5 && x <= 7) || (x >= 9 && x <= 11))) {
    return PALETTE.get(y === 5 ? "E" : "M");
  }
  return PALETTE.get(HINGE[y]?.[x] ?? "");
}

function draw(theme: ColorCells, width: number, height: number, center: number, top: number,
  blink: boolean, line?: Map<number, number>): string[] {
  const left = center - Math.floor(HINGE_WIDTH / 2);
  return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => {
    const upper = pixel(x - left, 2 * y - top, blink);
    const lower = pixel(x - left, 2 * y + 1 - top, blink);
    if (upper && upper === lower) return theme.style(" ", { bg: upper });
    if (upper) return theme.style(BAND_GLYPHS.bottom, { fg: upper, bg: lower });
    if (lower) return theme.style(BAND_GLYPHS.top, { fg: lower });
    const dots = line?.get(y * width + x);
    return dots ? theme.style(String.fromCodePoint(0x2800 + dots), { fg: y === 0 ? ANCHOR : THREAD }) : " ";
  }).join(""));
}

export function hangingHinge(theme: ColorCells, width: number, index: number): string[] {
  const pose = COUNTERWEIGHT[index]!;
  const anchor = Math.floor((width - 1) / 2);
  const center = anchor + Math.round(pose.dx * (width < 33 ? 0.6 : 1));
  return draw(theme, width, HINGE_RIG_HEIGHT, center, pose.top, "blink" in pose, dragline(width, anchor, center, pose.top));
}

export function dockedHinge(theme: ColorCells): string[] {
  return draw(theme, HINGE_WIDTH, 8, Math.floor(HINGE_WIDTH / 2), 2, false);
}
