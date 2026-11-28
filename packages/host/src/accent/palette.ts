// https://draculatheme.com/contribute and Herdr's dracula-plus-glass.json.
export const ACCENT_GROUPS = [
  { label: "Spider", accents: [
    { id: "spider-blue", label: "Spider Blue", hex: "#82aaff" },
  ] },
  { label: "Dracula", accents: [
    { id: "purple", label: "Purple", hex: "#bd93f9" },
    { id: "pink", label: "Pink", hex: "#ff79c6" },
    { id: "cyan", label: "Cyan", hex: "#8be9fd" },
    { id: "green", label: "Green", hex: "#50fa7b" },
    { id: "orange", label: "Orange", hex: "#ffb86c" },
    { id: "yellow", label: "Yellow", hex: "#f1fa8c" },
    { id: "red", label: "Red", hex: "#ff5555" },
    { id: "comment", label: "Comment", hex: "#6272a4" },
  ] },
  { label: "Dracula+", accents: [
    { id: "plus-purple", label: "Plus Purple", hex: "#c792ea" },
    { id: "bright-purple", label: "Bright Purple", hex: "#d6acff" },
    { id: "plus-pink", label: "Plus Pink", hex: "#ff92df" },
    { id: "plus-yellow", label: "Plus Yellow", hex: "#ffcb6b" },
    { id: "bright-red", label: "Bright Red", hex: "#ff6e6e" },
  ] },
] as const;

export type Accent = (typeof ACCENT_GROUPS)[number]["accents"][number];
export const ACCENTS: readonly Accent[] = ACCENT_GROUPS.flatMap<Accent>(group => group.accents);
export const SPIDER_BLUE: Accent = ACCENT_GROUPS[0].accents[0];
export const ACCENT_KEY = "ui.accent";

export function storedAccent(value: unknown): Accent | undefined {
  return ACCENTS.find(accent => accent.id === value);
}
