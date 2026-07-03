// packages/host/src/agents/theme-adapter.ts
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ThemeAdapter } from "@spider/ui";

export function piTheme(theme: Theme): ThemeAdapter {
  return {
    fg: (token, s) => theme.fg(token as never, s),
    bg: (token, s) => theme.bg(token as never, s),
    bold: (s) => theme.bold(s),
    glyph: "🕸",
  };
}
