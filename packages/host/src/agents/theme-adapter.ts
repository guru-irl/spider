// packages/host/src/agents/theme-adapter.ts
import type { Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, styleText } from "@earendil-works/pi-tui";
import { icon, type IconStyle, type ThemeAdapter } from "@spider/ui";

export function piTheme(theme: Theme, iconStyle: IconStyle = "text", spiderGlyphs = false): ThemeAdapter {
  return {
    fg: (token, s) => theme.fg(token as never, s),
    bg: (token, s) => theme.bg(token as never, s),
    bold: (s) => theme.bold(s),
    italic: (s) => theme.italic(s),
    glyph: icon(iconStyle, "agent"),
    iconStyle,
    spiderGlyphs,
    activityTint(text, strength) {
      const colors = theme.colors;
      if (!colors || typeof theme.getColorMode !== "function" || strength === 0 || strength === 1) {
        return theme.fg(strength < 0.5 ? "dim" : "accent", text);
      }
      return styleText(text, { fg: mixColors(colors.dim, colors.accent, strength) }, theme.getColorMode());
    },
  };
}
