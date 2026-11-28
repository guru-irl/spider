import { stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { BAND_GLYPHS } from "./icons.js";
import { foregroundFromBackground, hasOtherBackground, reopenBackground } from "./ansi.js";

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

export function isHalfEdge(row: string, edge: "top" | "bottom", width: number): boolean {
  return stripTerminalSequences(row) === BAND_GLYPHS[edge].repeat(width);
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

// Pi owns the tool shells. Only decorate known padded shells, including the
// native edit renderer's header, and leave other self-rendered tools alone.
export function bindToolCardShell(component: Component & { children: Component[] },
  padded: (value: unknown) => value is Component, enabled: () => boolean): void {
  const box = field(component, "contentBox");
  const text = field(component, "contentText");
  const child = component.children?.[1];
  let shell: unknown;
  if (child === box) shell = box;
  else if (child === field(component, "contentTextRegion") && field(child, "child") === text) shell = text;
  else if (field(component, "toolName") === "edit" && field(field(component, "toolDefinition"), "renderShell") === "self"
    && child === field(component, "selfRenderContainer")) {
    const call = field(component, "callRendererComponent");
    const shellChildren = field(child, "children");
    if (Array.isArray(shellChildren) && shellChildren.some(region => field(region, "child") === call)) shell = call;
  }
  if (padded(shell)) bindHalfBox(shell, () => enabled() && field(shell, "paddingY") === 1);
}

interface MouseLayout { width: number; height: number; originalHeight: number; skipped: number }

export function bindHalfBox(component: Component, enabled: () => boolean): boolean {
  const shell = component as Component & { [HALF_BOX]?: Binding };
  if (shell[HALF_BOX]) { shell[HALF_BOX].enabled = enabled; return false; }
  const binding: Binding = { enabled };
  Object.defineProperty(shell, HALF_BOX, { value: binding });
  const render = shell.render;
  const mouse = shell.handleMouse;
  let cache: { rows: string[]; output: string[]; layout: MouseLayout } | undefined;
  shell.render = function (width) {
    const rows = render.call(this, width);
    const enabled = binding.enabled();
    if (enabled && cache?.rows === rows && cache.layout.width === width) return cache.output;
    cache = undefined;
    if (!enabled) return rows;
    const colors = rows.length >= 3 && edgeInk(rows[0], width);
    if (!colors || rows.at(-1) !== rows[0] || rows.some(isImageRow)) return rows;
    const blank = (row: string) => row === rows[0] ||
      (stripTerminalSequences(row).trim() === "" && !hasOtherBackground(row, colors.bg));
    let first = 1, end = rows.length - 1;
    while (first < end && blank(rows[first])) first++;
    while (first < end && blank(rows[end - 1])) end--;
    const next = [halfEdge(colors.ink, width, "top"), ...rows.slice(first, end).map(row => stripRow(row, colors.bg, width)),
      halfEdge(colors.ink, width, "bottom")];
    cache = { rows, output: next, layout: { width, height: next.length, originalHeight: rows.length, skipped: first - 1 } };
    return next;
  };
  if (mouse) shell.handleMouse = function (event) {
    const layout = cache?.layout;
    if (!layout || !binding.enabled() || layout.width !== event.width || layout.height !== event.height) return mouse.call(this, event);
    const y = event.y === 0 ? 0 : event.y === layout.height - 1 ? layout.originalHeight - 1 : event.y + layout.skipped;
    return mouse.call(this, { ...event, y, height: layout.originalHeight });
  };
  return true;
}
