// packages/ui/src/agents/ansi.ts
// Theme tokens (ThemeColor) are semantic and have no "pink", so to make the spider glyph
// reliably pink across every theme we emit a raw truecolor foreground and reset only the
// fg (\x1b[39m) so surrounding bold/bg attributes are preserved. Colour: Dracula pink #ff79c6.
export function pink(s: string): string {
  return `\x1b[38;2;255;121;198m${s}\x1b[39m`;
}
