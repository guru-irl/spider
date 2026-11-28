import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { safeError } from "@spider/organism";
import { controlConfig, readLayer } from "../control.js";
import { ACCENT_KEY, ACCENTS, SPIDER_BLUE, storedAccent, type Accent } from "./palette.js";
import { accentPicker } from "./picker.js";
import { accentThemeMatches, copyAccentTheme } from "./theme.js";

function setTheme(ui: ExtensionUIContext, theme: Theme): boolean {
  const result = ui.setTheme(theme);
  if (!result.success) ui.notify(`Could not apply accent: ${result.error ?? "Pi rejected the theme"}`, "error");
  return result.success;
}

export function registerAccentPicker(pi: Pick<ExtensionAPI, "on" | "registerCommand">): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const { config } = readLayer(join(paths.globalRoot, "config.json"));
    const accent = storedAccent(config[ACCENT_KEY]);
    if (accent && !accentThemeMatches(ctx.ui.theme, accent)) {
      setTheme(ctx.ui, copyAccentTheme(ctx.ui.theme, accent));
    }
  });

  pi.registerCommand("color", {
    description: "Preview or save a Dracula accent; /color reset restores Spider blue",
    getArgumentCompletions(prefix) {
      const choices = [...ACCENTS.map(accent => ({ value: accent.id, label: accent.label, description: accent.hex })),
        { value: "reset", label: "Reset", description: "Restore Spider blue" }];
      return choices.filter(choice => choice.value.startsWith(prefix.toLowerCase()));
    },
    async handler(args, ctx) {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        if (ctx.hasUI) ctx.ui.notify("/color needs an interactive Pi terminal.", "warning");
        return;
      }
      const input = args.trim().toLowerCase().replace(/\s+/gu, "-");
      const requested = input === "reset" || input === "blue" ? SPIDER_BLUE : storedAccent(input);
      const { ui } = ctx;
      if (input && !requested) {
        ui.notify("Unknown accent color. Use /color to see the palette.", "warning");
        return;
      }

      // ui.theme is a live proxy. Capture a separate instance before switching it.
      const before = copyAccentTheme(ui.theme);
      const initial = ACCENTS.find(accent => accent.hex === colorToHex(before.colors.accent)) ?? SPIDER_BLUE;
      let previewed: Accent | undefined;
      let saved = false;
      const preview = (accent: Accent) => {
        if (!setTheme(ui, copyAccentTheme(before, accent))) return false;
        previewed = accent;
        return true;
      };
      try {
        let getColumns = () => 80;
        const selected = requested ?? await ui.custom<Accent | undefined>((tui, _theme, keys, done) => {
          getColumns = () => tui.terminal.columns;
          return accentPicker({ initial, theme: () => ui.theme, height: () => tui.terminal.rows,
            keys, preview, done, requestRender: () => tui.requestRender() });
        }, {
          overlay: true,
          overlayOptions: () => ({ anchor: "top-left", width: Math.min(33, Math.max(12, Math.floor(getColumns() * 0.45))), maxHeight: "100%" }),
          blocked: { kind: "question", message: "Choose an accent color" },
        });
        if (!selected || (selected !== previewed && !preview(selected))) return;
        controlConfig("set", ctx.cwd, ACCENT_KEY, selected.id, "global");
        saved = true;
      } catch (error) {
        ui.notify(`Could not save accent: ${safeError(error)}`, "error");
      } finally {
        if (previewed && !saved) setTheme(ui, before);
      }
    },
  });
}
