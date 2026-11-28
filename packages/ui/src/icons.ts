export const ICON_STYLES = ["text", "nerd"] as const;
export type IconStyle = typeof ICON_STYLES[number];

export const REPLY_FRAME = {
  left: "│", right: "│", top: "─", bottom: "─",
  topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯",
} as const;

export const BAND_GLYPHS = { top: "▄", bottom: "▀", bar: "▌", barTop: "▖", barBottom: "▘" } as const;

const NEW_MOON = "\uE3E3";
// Every other Weather Icons phase (new, then U+E3E1 to U+E3C9 in steps of two, full at index 7). Each frame
// makes Pi rescan the whole transcript, so 14 a second halves the cost of all 28 (user, 2026-11-28).
export const ACTIVITY_FRAMES: Readonly<Record<IconStyle, { readonly idle: string; readonly working: readonly string[] }>> = {
  text: { idle: "○", working: ["◐", "◓", "◑", "◒"] },
  nerd: { idle: NEW_MOON, working: [NEW_MOON, ...Array.from({ length: 13 }, (_, i) => String.fromCodePoint(0xE3C9 + 2 * (12 - i)))] },
} as const;

// These four frames exist only in fonts patched by Spider. The pad is for non-Mono Nerd Fonts.
export const ROBOT_FRAMES = {
  center: "\u{F2120} ", left: "\u{F2121} ", right: "\u{F2122} ", closed: "\u{F2123} ",
} as const;

export function isIconStyle(value: unknown): value is IconStyle {
  return ICON_STYLES.some(style => style === value);
}

const ICONS = {
  agent: { text: "◇", nerd: "\u{F167A} " },
  spider: { text: "◆", nerd: "\u{F0BCA} " },
  warning: { text: "▲", nerd: "\u{F002A} " },
  failure: { text: "×", nerd: "\u{F0156} " },
  success: { text: "✓", nerd: "\u{F012C} " },
  question: { text: "?", nerd: "\u{F02D6} " },
  running: { text: "●", nerd: "●" },
  open: { text: "○", nerd: "○" },
  paused: { text: "■", nerd: "■" },
  queued: { text: "○", nerd: "○" },
  active: { text: "◆", nerd: "◆" },
  todoDone: { text: "✓", nerd: "\u{F05E1} " },
  todoFailed: { text: "×", nerd: "\u{F015A} " },
  todoPending: { text: "○", nerd: "\u{F0766} " },
  task: { text: "→", nerd: "\u{F060D} " },
  result: { text: "↑", nerd: "\u{F005C} " },
  message: { text: "→", nerd: "\u{F01F0} " },
  reply: { text: "←", nerd: "\u{F0F20} " },
  broadcast: { text: "»", nerd: "\u{F0B23} " },
  handoff: { text: "→", nerd: "\u{F19B0} " },
  pin: { text: "†", nerd: "\u{F0931} " },
  modelDefault: { text: "←", nerd: "\u{F004D} " },
  copy: { text: "□", nerd: "\u{F018F} " },
  copied: { text: "✓", nerd: "\u{F012C} " },
  content: { text: "□", nerd: "□" },
  todo: { text: "▣", nerd: "▣" },
  bullet: { text: "•", nerd: "•" },
  select: { text: "▸", nerd: "▸" },
  arrowLeft: { text: "←", nerd: "←" },
  prompt: { text: "❯", nerd: "❯" },
  arrowRight: { text: "→", nerd: "→" },
  arrowUp: { text: "↑", nerd: "↑" },
  arrowDown: { text: "↓", nerd: "↓" },
} as const;

export type IconRole = keyof typeof ICONS;

export function icon(style: IconStyle | undefined, role: IconRole): string {
  return ICONS[role][style ?? "text"];
}
