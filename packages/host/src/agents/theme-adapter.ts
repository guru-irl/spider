// packages/host/src/agents/theme-adapter.ts
import type { Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, parseColor, styleText } from "@earendil-works/pi-tui";
import { icon, type IconStyle, type ThemeAdapter } from "@spider/ui";

export function piTheme(theme: Theme, iconStyle: IconStyle = "text", spiderGlyphs = false): ThemeAdapter {
  const roleColors = new Map<string, ReturnType<typeof parseColor>>();
  return {
    fg: (token, s) => theme.fg(token as never, s),
    bg: (token, s) => theme.bg(token as never, s),
    bold: (s) => theme.bold(s),
    italic: (s) => theme.italic(s),
    glyph: icon(iconStyle, "agent"),
    iconStyle,
    spiderGlyphs,
    roleTint(hex, text, strength) {
      if (!theme.colors || typeof theme.getColorMode !== "function") {
        return theme.fg(strength < 0.5 ? "dim" : "accent", text);
      }
      if (strength === 0) return theme.fg("dim", text);
      let color = roleColors.get(hex);
      if (!color) { color = parseColor(hex); roleColors.set(hex, color); }
      return styleText(text, { fg: strength === 1 ? color : mixColors(theme.colors.dim, color, strength) }, theme.getColorMode());
    },
    activityTint(text, strength) {
      const colors = theme.colors;
      if (!colors || typeof theme.getColorMode !== "function" || strength === 0 || strength === 1) {
        return theme.fg(strength < 0.5 ? "dim" : "accent", text);
      }
      return styleText(text, { fg: mixColors(colors.dim, colors.accent, strength) }, theme.getColorMode());
    },
  };
}
