// packages/host/src/agents/theme-adapter.ts
import type { Theme } from "@earendil-works/pi-coding-agent";
import { icon, type IconStyle, type ThemeAdapter } from "@spider/ui";

export function piTheme(theme: Theme, iconStyle: IconStyle = "text"): ThemeAdapter {
  return {
    fg: (token, s) => theme.fg(token as never, s),
    bg: (token, s) => theme.bg(token as never, s),
    bold: (s) => theme.bold(s),
    italic: (s) => theme.italic(s),
    glyph: icon(iconStyle, "agent"),
    iconStyle,
  };
}
