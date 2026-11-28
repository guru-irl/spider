import type { TUI } from "@earendil-works/pi-tui";

// The selection blue Copilot CLI draws in the same terminal (#264f78).
const BACKGROUND = "\x1b[48;2;38;79;120m";
const PATCH = Symbol.for("spider.selection.highlight");
const SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|_[\s\S]*?(?:\x07|\x1b\\))/gu;
const BLOCKS = /[▀▄▖▗▘▝▌▐█]+/gu;

type Highlight = (text: string) => string;
type Slot = { active: WeakMap<object, object>; highlight: Highlight };
type Prototype = { applySelectionHighlight?: Highlight; [PATCH]?: Slot };

// Pi copies from its painted screen, so replacing a glyph with a literal space
// would change clipboard text. Conceal makes it look like a space instead.
function highlight(text: string): string {
  let result = `\x1b[27m${BACKGROUND}`;
  let offset = 0;
  let concealed = false;
  const appendText = (part: string) => {
    result += concealed ? part : part.replace(BLOCKS, glyph => `\x1b[8m${glyph}\x1b[28m`);
  };
  for (const match of text.matchAll(SEQUENCE)) {
    appendText(text.slice(offset, match.index));
    const sequence = match[0];
    result += sequence;
    if (/^\x1b\[[0-9;:]*m$/u.test(sequence)) {
      const params = sequence.slice(2, -1).split(";");
      for (let i = 0; i < params.length; i++) {
        const field = params[i];
        const code = Number(field.split(":")[0] || 0);
        if (code === 0 || code === 28) concealed = false;
        else if (code === 8) concealed = true;
        else if ((code === 38 || code === 48 || code === 58) && !field.includes(":")) {
          if (params[i + 1] === "2") i += 4;
          else if (params[i + 1] === "5") i += 2;
        }
      }
      // A reset, background or inverse SGR cannot override the selection.
      result += `\x1b[27m${BACKGROUND}`;
    }
    offset = match.index + sequence.length;
  }
  appendText(text.slice(offset));
  return result + "\x1b[49m";
}

export function installSelectionHighlight(tui: TUI): () => void {
  let target = Object.getPrototypeOf(tui) as Prototype | null;
  while (target && !Object.hasOwn(target, "applySelectionHighlight")) target = Object.getPrototypeOf(target) as Prototype | null;
  if (!target || typeof target.applySelectionHighlight !== "function") return () => {};
  if (!Object.hasOwn(target, PATCH)) {
    const original = target.applySelectionHighlight;
    const descriptor = Object.getOwnPropertyDescriptor(target, "applySelectionHighlight");
    if (!descriptor?.writable || !Object.isExtensible(target)) return () => {};
    // Do not patch a future Pi implementation whose method has changed shape.
    try {
      if (original.call(tui, "a\x1b[31mb") !== "\x1b[7ma\x1b[31m\x1b[7mb\x1b[27m") return () => {};
    } catch { return () => {}; }
    const slot: Slot = { active: new WeakMap(), highlight };
    Object.defineProperty(target, PATCH, { value: slot });
    target.applySelectionHighlight = function (this: object, text: string) {
      return slot.active.has(this) && typeof text === "string" ? slot.highlight(text) : original.call(this, text);
    };
  }
  const slot = target[PATCH]!;
  slot.highlight = highlight;
  const binding = {};
  slot.active.set(tui, binding);
  return () => { if (slot.active.get(tui) === binding) slot.active.delete(tui); };
}
