import { Box, stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { BAND_GLYPHS } from "@spider/ui";
import { foregroundFromBackground, reopenBackground } from "./ansi.js";

const BG_RESET = "\x1b[49m";
const HALF_BOX = Symbol.for("spider.transcript.half-box");
type Binding = { enabled: () => boolean };

export function edgeInk(padding: string, width: number): { bg: string; ink: string } | undefined {
  const bg = /^\x1b\[[0-9;]+m/u.exec(padding)?.[0];
  const ink = bg && foregroundFromBackground(bg);
  return ink && padding === bg + " ".repeat(width) + BG_RESET ? { bg, ink } : undefined;
}

export function halfEdge(ink: string, width: number, edge: "top" | "bottom"): string {
  return ink + BAND_GLYPHS[edge].repeat(width) + "\x1b[39m";
}

export function stripRow(row: string, bg: string, width: number, prefix = ""): string {
  if (row.startsWith(bg)) row = row.slice(bg.length);
  if (row.endsWith(BG_RESET)) row = row.slice(0, -BG_RESET.length);
  return bg + prefix + reopenBackground(truncateToWidth(row, width, "", true), bg) + BG_RESET;
}

export function isImageRow(row: string): boolean {
  return row.includes("\x1b_G") || row.includes("\x1b]1337;File=");
}

interface MouseLayout { width: number; height: number; originalHeight: number; skipped: number }

export function bindHalfBox(component: Component, enabled: () => boolean): void {
  const shell = component as Component & { [HALF_BOX]?: Binding };
  if (shell[HALF_BOX]) { shell[HALF_BOX].enabled = enabled; return; }
  const binding: Binding = { enabled };
  Object.defineProperty(shell, HALF_BOX, { value: binding });
  const render = shell.render;
  const mouse = shell.handleMouse;
  let layout: MouseLayout | undefined;
  shell.render = function (width) {
    const rows = render.call(this, width);
    layout = undefined;
    if (!binding.enabled()) return rows;
    const colors = rows.length >= 3 && edgeInk(rows[0], width);
    if (!colors || rows.at(-1) !== rows[0] || rows.some(isImageRow)) return rows;
    const blank = (row: string) => stripTerminalSequences(row).trim() === "";
    let first = 1, end = rows.length - 1;
    while (first < end && blank(rows[first])) first++;
    while (first < end && blank(rows[end - 1])) end--;
    const next = [halfEdge(colors.ink, width, "top"), ...rows.slice(first, end).map(row => stripRow(row, colors.bg, width)),
      halfEdge(colors.ink, width, "bottom")];
    layout = { width, height: next.length, originalHeight: rows.length, skipped: first - 1 };
    return next;
  };
  if (mouse) shell.handleMouse = function (event) {
    if (!layout || !binding.enabled() || layout.width !== event.width || layout.height !== event.height) return mouse.call(this, event);
    const y = event.y === 0 ? 0 : event.y === layout.height - 1 ? layout.originalHeight - 1 : event.y + layout.skipped;
    return mouse.call(this, { ...event, y, height: layout.originalHeight });
  };
}

export function createHalfBox(paddingX: number, bg: (text: string) => string): Box {
  const box = new Box(paddingX, 1, bg);
  bindHalfBox(box, () => true);
  const render = box.render;
  box.render = width => render.call(box, width).map(row => isImageRow(row) ? row : truncateToWidth(row, width, ""));
  return box;
}
