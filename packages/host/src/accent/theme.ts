import type { Theme, ThemeBg, ThemeColor, ThemeToken } from "@earendil-works/pi-coding-agent";
import { colorToHex, type Color } from "@earendil-works/pi-tui";
import type { Accent } from "./palette.js";

const BACKGROUNDS = {
  selectedBg: true, searchMatchBg: true, userMessageBg: true, customMessageBg: true,
  toolPendingBg: true, toolSuccessBg: true, toolErrorBg: true,
} satisfies Record<ThemeBg, true>;

const ACCENT_TOKENS: readonly ThemeColor[] = ["accent", "borderAccent", "customMessageLabel"];

export function accentThemeMatches(theme: Theme, accent: Accent): boolean {
  return ACCENT_TOKENS.every(token => colorToHex(theme.colors[token]) === accent.hex);
}

function themeValue(color: Color): number | string {
  if (color.kind === "indexed") return color.index;
  if (color.kind === "oklch") return `oklch(${color.l} ${color.c} ${color.h})`;
  return colorToHex(color);
}

// colors resolves terminal defaults to an RGB guess and composites faint tokens.
// Preserve defaults and recover the original foreground of faint tokens from its
// public opening SGR instead, so the copy doesn't apply dim twice.
function faintForeground(ansi: string, fallback: Color): string | number {
  const rgb = /^\x1b\[38;2;(\d+);(\d+);(\d+)m/u.exec(ansi);
  if (rgb) return `#${rgb.slice(1).map(channel => Number(channel).toString(16).padStart(2, "0")).join("")}`;
  const indexed = /^\x1b\[38;5;(\d+)m/u.exec(ansi);
  return indexed ? Number(indexed[1]) : themeValue(fallback);
}

export function copyAccentTheme(base: Theme, accent?: Accent): Theme {
  const values = {} as Record<ThemeToken, string | number>;
  const dim: ThemeColor[] = [];
  for (const token of Object.keys(base.colors) as ThemeToken[]) {
    const color = base.colors[token];
    if (Object.hasOwn(BACKGROUNDS, token)) {
      values[token] = base.getBgAnsi(token as ThemeBg) === "\x1b[49m" ? "" : themeValue(color);
      continue;
    }
    const foreground = token as ThemeColor;
    const ansi = base.getFgAnsi(foreground);
    const faint = ansi.endsWith("\x1b[2m");
    if (accent && ACCENT_TOKENS.includes(foreground)) values[token] = accent.hex;
    else {
      if (faint) dim.push(foreground);
      values[token] = ansi.startsWith("\x1b[39m") ? "" : faint ? faintForeground(ansi, color) : themeValue(color);
    }
  }
  // In a linked install Pi's Theme class can be different from the one imported
  // by Spider's bundle. Pi checks instanceof when accepting an in-memory theme.
  const HostTheme = base.constructor as typeof Theme;
  return new HostTheme(values, values, base.getColorMode(), { appearance: base.appearance, name: base.name, dim });
}
