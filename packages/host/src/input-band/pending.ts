import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { BAND_GLYPHS, icon, type IconStyle } from "@spider/ui";
import { foregroundFromBackground, reopenBackground } from "./ansi.js";
import type { InputBandHost } from "./index.js";

const PATCH = Symbol.for("spider.pending.bands");
type Options = { theme: () => Theme; iconStyle: () => IconStyle };
type Slot = { options?: Options };
type PendingMode = {
  updatePendingMessagesDisplay: () => void;
  getAllQueuedMessages: () => { steering: string[]; followUp: string[] };
  pendingMessagesContainer: { children: Component[] };
  pendingBashComponents: Component[];
  [PATCH]?: Slot;
};

// Pi has no extension hook for the queue display. Call its private update first,
// then decorate only the exact known shape. Pi still owns the queue and hint.
export function installPendingBands(host: InputBandHost, theme: () => Theme, iconStyle: () => IconStyle): () => void {
  const prototype = host.InteractiveMode?.prototype as unknown as PendingMode | undefined;
  if (!prototype || typeof prototype.updatePendingMessagesDisplay !== "function" || !host.Spacer || !host.TruncatedText) return () => {};
  if (!Object.hasOwn(prototype, PATCH)) {
    const update = prototype.updatePendingMessagesDisplay;
    const slot: Slot = {};
    Object.defineProperty(prototype, PATCH, { value: slot });
    prototype.updatePendingMessagesDisplay = function (this: PendingMode) {
      update.call(this);
      if (!slot.options || typeof this.getAllQueuedMessages !== "function") return;
      const container = this.pendingMessagesContainer;
      const bash = this.pendingBashComponents;
      const queued = this.getAllQueuedMessages();
      if (!container || !Array.isArray(container.children) || !Array.isArray(bash) ||
          !Array.isArray(queued?.steering) || !Array.isArray(queued?.followUp)) return;
      const messages = [...queued.steering.map(text => ({ label: "Steering: ", text })),
        ...queued.followUp.map(text => ({ label: "Follow-up: ", text }))];
      const children = container.children;
      const start = bash.length;
      if (!messages.length || messages.some(message => typeof message.text !== "string") ||
          children.length !== start + messages.length + 2 || bash.some((child, i) => children[i] !== child) ||
          !(children[start] instanceof host.Spacer!) || (children[start] as unknown as { lines: unknown }).lines !== 1) return;
      const hint = children.at(-1);
      if (!(hint instanceof host.TruncatedText!) || typeof (hint as unknown as { text: unknown }).text !== "string" ||
          !/^↳ .* to edit all queued messages$/u.test(stripTerminalSequences((hint as unknown as { text: string }).text))) return;
      const originals = children.slice(start + 1, -1);
      if (originals.some((child, i) => {
        const row = child as unknown as { text?: unknown; paddingX?: unknown; paddingY?: unknown };
        return !(child instanceof host.TruncatedText!) || row.paddingX !== 1 || row.paddingY !== 0 ||
          typeof row.text !== "string" || stripTerminalSequences(row.text) !== stripTerminalSequences(messages[i].label + messages[i].text);
      })) return;
      originals.forEach((original, i) => {
        const message = messages[i].text;
        children[start + 1 + i] = {
          invalidate: () => original.invalidate?.(),
          render(width) {
            const opts = slot.options;
            const current = opts?.theme();
            const bg = current?.getBgAnsi("userMessageBg");
            const ink = bg && foregroundFromBackground(bg);
            const caret = opts && icon(opts.iconStyle(), "pending");
            if (!current || !bg || !ink || !caret || width < visibleWidth(caret) + 4) {
              return original.render(width).map(row => truncateToWidth(row, width, ""));
            }
            const space = width - 3 - visibleWidth(caret);
            const content = truncateToWidth(message.split("\n", 1)[0], space);
            const pad = " ".repeat(Math.max(0, space - visibleWidth(content)));
            const bar = (glyph: string) => current.fg("dim", glyph);
            return [bar(BAND_GLYPHS.barTop) + ink + BAND_GLYPHS.top.repeat(width - 1) + "\x1b[39m",
              bar(BAND_GLYPHS.bar) + bg + " " + current.fg("dim", caret) + " " +
                current.fg("dim", reopenBackground(content, bg)) + pad + "\x1b[49m",
              bar(BAND_GLYPHS.barBottom) + ink + BAND_GLYPHS.bottom.repeat(width - 1) + "\x1b[39m"];
          },
        };
      });
    };
  }
  const slot = prototype[PATCH]!;
  const options = { theme, iconStyle };
  slot.options = options;
  return () => { if (slot.options === options) slot.options = undefined; };
}
