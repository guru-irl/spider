export const ICON_STYLES = ["text", "nerd"] as const;
export type IconStyle = typeof ICON_STYLES[number];

export const REPLY_FRAME = {
  left: "│", right: "│", top: "─", bottom: "─",
  topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯",
} as const;

export const SPINNER_FRAMES: Record<IconStyle, readonly string[]> = {
  text: ["|", "/", "-", "\\"],
  nerd: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

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
  gutter: { text: "└", nerd: "└ " },
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
  arrowRight: { text: "→", nerd: "→" },
  arrowUp: { text: "↑", nerd: "↑" },
  arrowDown: { text: "↓", nerd: "↓" },
} as const;

export type IconRole = keyof typeof ICONS;

export function icon(style: IconStyle | undefined, role: IconRole): string {
  return ICONS[role][style ?? "text"];
}
