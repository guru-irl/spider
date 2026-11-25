export const ICON_STYLES = ["text", "nerd"] as const;
export type IconStyle = typeof ICON_STYLES[number];

export function isIconStyle(value: unknown): value is IconStyle {
  return ICON_STYLES.some(style => style === value);
}

const ICONS = {
  // U+FE0F asks for emoji presentation: without it terminals draw the web as a
  // one-cell text symbol, which looks tiny in fullscreen pi. The emoji is two
  // cells wide, so the Nerd Font variants carry a pad cell, like the pin.
  agent: { text: "\u{1F578}\uFE0F", nerd: "\u{F167A} " },
  spider: { text: "\u{1F578}\uFE0F", nerd: "\u{F0BCA} " },
  warning: { text: "⚠", nerd: "\u{F002A}" },
  failure: { text: "✗", nerd: "\u{F0156}" },
  gutter: { text: "⎿", nerd: "\u{F060D}" },
  task: { text: "↳", nerd: "\u{F060D}" },
  result: { text: "⤴", nerd: "\u{F005C}" },
  message: { text: "✉", nerd: "\u{F01F0}" },
  reply: { text: "↩", nerd: "\u{F0F20}" },
  broadcast: { text: "⇉", nerd: "\u{F0B23}" },
  handoff: { text: "⇢", nerd: "\u{F19B0}" },
  pin: { text: "📌", nerd: "\u{F0931} " },
  modelDefault: { text: "⟵", nerd: "\u{F004D}" },
  copy: { text: "⧉", nerd: "\u{F018F}" },
} as const;

export type IconRole = keyof typeof ICONS;

export function icon(style: IconStyle | undefined, role: IconRole): string {
  return ICONS[role][style ?? "text"];
}
