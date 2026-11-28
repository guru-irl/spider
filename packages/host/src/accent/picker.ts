import type { Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, parseColor, truncateToWidth, visibleWidth, type Component, type KeybindingsManager, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { ACCENT_GROUPS, ACCENTS, type Accent } from "./palette.js";

const PANEL = parseColor("#161618");
const SELECTED = mixColors(PANEL, parseColor("#ffffff"), 0.08, "srgb");
const ROWS = ACCENT_GROUPS.flatMap<string | Accent>(group => [group.label, ...group.accents]);
const SWATCHES = new Map(ACCENTS.map(accent => [accent, parseColor(accent.hex)]));

// Pi's │ / ┃ scrollbar, limited to the list between the pinned title and hints.
function thumb(top: number, height: number, total: number) {
  const length = Math.max(1, Math.floor(height * height / total));
  const start = Math.round(top * (height - length) / (total - height));
  return (row: number) => row >= start && row < start + length;
}

export function accentPicker(options: {
  initial: Accent;
  theme: () => Theme;
  height: () => number;
  keys: KeybindingsManager;
  preview: (accent: Accent) => boolean;
  done: (accent?: Accent) => void;
  requestRender: () => void;
}): Component {
  let selected = options.initial;
  let top = 0;
  let listStart = 0, listEnd = 0, renderedWidth = 0, renderedHeight = 0;

  const select = (accent: Accent) => {
    if (accent !== selected && options.preview(accent)) {
      selected = accent;
      options.requestRender();
    }
  };
  const step = (direction: number) => {
    const index = Math.max(0, Math.min(ACCENTS.length - 1, ACCENTS.indexOf(selected) + direction));
    select(ACCENTS[index]);
  };

  return {
    invalidate() {},
    handleInput(data) {
      const { keys, done } = options;
      if (keys.matches(data, "tui.select.up")) step(-1);
      else if (keys.matches(data, "tui.select.down")) step(1);
      else if (keys.matches(data, "tui.select.confirm")) done(selected);
      else if (keys.matches(data, "tui.select.cancel")) done();
    },
    handleMouse(event: TuiMouseEvent) {
      if (event.x < 0 || event.x >= renderedWidth || event.y < 0 || event.y >= renderedHeight) return;
      if (event.type === "wheel" && event.wheelDelta) {
        step(Math.sign(event.wheelDelta));
        return { handled: true };
      }
      if (event.button !== "left" || event.y < listStart || event.y >= listEnd || event.x >= renderedWidth - 1) return;
      const row = ROWS[top + event.y - listStart];
      if (!row || typeof row === "string") return;
      // Pi generates a click only after the component claims the matching press.
      if (event.type === "press") return { handled: true, render: false };
      if (event.type === "click") {
        select(row);
        return { handled: true };
      }
    },
    render(width) {
      renderedWidth = width;
      renderedHeight = Math.max(1, options.height());
      const theme = options.theme();
      const railColor = mixColors(PANEL, theme.colors.accent, 0.5, "srgb");
      const rail = theme.style("│", { fg: railColor });
      const innerWidth = Math.max(0, width - 1);
      const line = (content: string, end = rail, bg = PANEL) => {
        const clipped = truncateToWidth(content, innerWidth, "");
        return theme.style(clipped + " ".repeat(innerWidth - visibleWidth(clipped)) + end, { bg });
      };
      const title = renderedHeight > 1 ? 1 : 0;
      const hints = renderedHeight >= 5 ? (renderedHeight >= 8 ? 2 : 1) : 0;
      const height = renderedHeight - title - hints;
      const selectedRow = ROWS.indexOf(selected);
      // Clamp after a resize, then keep the selected option in the viewport.
      top = Math.min(top, Math.max(0, ROWS.length - height));
      top = Math.max(0, Math.min(selectedRow, Math.max(top, selectedRow - height + 1)));
      const scrollbar = height < ROWS.length ? thumb(top, height, ROWS.length) : undefined;
      const lines = title ? [line(` ${theme.style("Accent color", { fg: "accent", bold: true })}`)] : [];
      listStart = lines.length;
      for (let i = 0; i < height; i++) {
        const row = ROWS[top + i];
        const end = scrollbar ? scrollbar(i) ? theme.fg("scrollbarThumb", "┃") : theme.fg("scrollbarTrack", "│") : rail;
        if (row === undefined) lines.push(line("", end));
        else if (typeof row === "string") lines.push(line(` ${theme.fg("muted", row)}`, end));
        else {
          const active = row === selected;
          const marker = active ? theme.fg("accent", "›") : " ";
          const swatch = theme.style("██", { fg: SWATCHES.get(row)! });
          const hex = theme.fg("muted", row.hex);
          const prefix = ` ${marker} ${swatch}`;
          const labelWidth = innerWidth - visibleWidth(prefix) - row.hex.length - 2;
          const label = labelWidth > 0 ? truncateToWidth(row.label, labelWidth, "…") : "";
          const gap = Math.max(1, innerWidth - visibleWidth(prefix) - visibleWidth(label) - row.hex.length - 1);
          const content = label ? `${prefix} ${label}${" ".repeat(gap)}${hex}` : `${swatch} ${hex}`;
          lines.push(line(content, end, active ? SELECTED : PANEL));
        }
      }
      listEnd = lines.length;
      if (hints === 2) lines.push(line(` ${theme.fg("muted", "↑↓ Preview · Click · Scroll")}`));
      if (hints) lines.push(line(` ${theme.fg("text", "Enter")} ${theme.fg("muted", "Save")}   ${theme.fg("text", "Esc")} ${theme.fg("muted", "Cancel")}`));
      return lines;
    },
  };
}
