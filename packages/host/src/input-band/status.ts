import type { Theme } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_FRAMES, MOON_CYCLE_MS, type IconStyle } from "@spider/ui";
import type { InputBandHost } from "./index.js";

const PATCH = Symbol.for("spider.status.moon");
type Options = { theme: () => Theme; iconStyle: () => IconStyle };
type Slot = { options?: Options };
type Indicator = { kind?: unknown; setIndicator?: (options: { frames: string[]; intervalMs: number }) => void };
type Mode = { showStatusIndicator: (indicator: Indicator) => void; [PATCH]?: Slot };

export function installMoonStatus(host: InputBandHost, theme: () => Theme, iconStyle: () => IconStyle): () => void {
  const prototype = host.InteractiveMode?.prototype as unknown as Mode | undefined;
  if (!prototype || typeof prototype.showStatusIndicator !== "function") return () => {};
  if (!Object.hasOwn(prototype, PATCH)) {
    const show = prototype.showStatusIndicator;
    const slot: Slot = {};
    Object.defineProperty(prototype, PATCH, { value: slot });
    prototype.showStatusIndicator = function (indicator) {
      show.call(this, indicator);
      if (!slot.options || !indicator || typeof indicator.setIndicator !== "function" ||
          (indicator.kind !== "compaction" && indicator.kind !== "branchSummary" && indicator.kind !== "retry")) return;
      try {
        const current = slot.options.theme();
        const frames = ACTIVITY_FRAMES[slot.options.iconStyle()].working;
        const color = indicator.kind === "retry" ? "warning" : "accent";
        indicator.setIndicator({ frames: frames.map(frame => current.fg(color, frame)), intervalMs: MOON_CYCLE_MS / frames.length });
      } catch { /* An unsupported host keeps Pi's own indicator. */ }
    };
  }
  const slot = prototype[PATCH]!;
  const options = { theme, iconStyle };
  slot.options = options;
  return () => { if (slot.options === options) slot.options = undefined; };
}
