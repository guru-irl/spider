import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { ACTIVITY_FRAMES, type IconStyle } from "@spider/ui";
import { FOOTER_SNAPSHOT, type FooterSnapshot } from "../usage/footer-snapshot.js";
import { renderInputBand } from "./editor.js";
import type { InputBandHost } from "./index.js";

const PATCH = Symbol.for("spider.reload.band");
type Options = { theme: () => Theme; iconStyle: () => IconStyle };
type Slot = { options?: Options };
type Container = { addChild(child: Component): void };
type Mode = {
  handleReloadCommand: () => Promise<void>;
  session: { isStreaming: boolean; isCompacting: boolean };
  editorContainer: Container;
  customFooter?: Component & Partial<FooterSnapshot>;
  setExtensionFooter: (factory?: () => Component) => void;
  [PATCH]?: Slot;
};

// Check rendered content and layout, not class names, which change in bundled Pi.
function reloadMessage(child: Component): string | undefined {
  const children = (child as Component & { children?: unknown }).children;
  if (!Array.isArray(children) || children.length !== 5) return;
  const rows = child.render(200).map(row => stripTerminalSequences(row).trim());
  if (rows.length !== 5 || !/^─+$/u.test(rows[0]) || rows[1] !== "" ||
      !rows[2].startsWith("Reloading keybindings") || rows[3] !== "" || !/^─+$/u.test(rows[4])) return;
  return rows[2];
}

export function installReloadBand(host: InputBandHost, theme: () => Theme, iconStyle: () => IconStyle): () => void {
  const prototype = host.InteractiveMode?.prototype as unknown as Mode | undefined;
  if (!prototype || typeof prototype.handleReloadCommand !== "function") return () => {};
  if (!Object.hasOwn(prototype, PATCH)) {
    const reload = prototype.handleReloadCommand;
    const slot: Slot = {};
    Object.defineProperty(prototype, PATCH, { value: slot });
    prototype.handleReloadCommand = function () {
      const opts = slot.options;
      if (!opts || this.session?.isStreaming || this.session?.isCompacting ||
          !this.editorContainer || typeof this.editorContainer.addChild !== "function") return reload.call(this);
      let current: Theme, style: IconStyle, snapshot: string[] | undefined;
      try {
        current = opts.theme(); style = opts.iconStyle();
        if (!renderInputBand(current, 80, ["probe"])) return reload.call(this);
        snapshot = this.customFooter?.[FOOTER_SNAPSHOT]?.();
      } catch { return reload.call(this); }
      const container = this.editorContainer;
      const add = container.addChild;
      const hadOwnAdd = Object.hasOwn(container, "addChild");
      let frozen: Component | undefined;
      container.addChild = (child: Component) => {
        add.call(container, child);
        try {
          const message = reloadMessage(child);
          if (!message) return;
          const original = child.render;
          const glyph = ACTIVITY_FRAMES[style].idle;
          child.render = width => {
            const text = current.fg("dim", `${glyph} ${message}`);
            const rows = wrapTextWithAnsi(text, Math.max(1, width - 2));
            return renderInputBand(current, width, rows) ?? original.call(child, width).map(row => truncateToWidth(row, width, ""));
          };
          if (snapshot && typeof this.setExtensionFooter === "function") {
            const lines = snapshot;
            frozen = { render: width => lines.map(line => truncateToWidth(line, width, "")), invalidate() {} };
            this.setExtensionFooter(() => frozen!);
          }
        } catch { /* An unfamiliar Pi shape keeps the stock view. */ }
      };
      let result: Promise<void>;
      try { result = reload.call(this); }
      finally {
        if (hadOwnAdd) container.addChild = add;
        else delete (container as Partial<Container>).addChild;
      }
      return result.finally(() => {
        if (frozen && this.customFooter === frozen) this.setExtensionFooter(undefined);
      });
    };
  }
  const slot = prototype[PATCH]!;
  const options = { theme, iconStyle };
  slot.options = options;
  return () => { if (slot.options === options) slot.options = undefined; };
}
