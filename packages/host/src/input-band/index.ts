import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createBandEditor } from "./editor.js";

type Pi = typeof import("@earendil-works/pi-coding-agent");
type PiTui = typeof import("@earendil-works/pi-tui");
export type InputBandHost = Pick<Pi, "CustomEditor"> & Partial<Pick<Pi,
  "UserMessageComponent" | "ToolExecutionComponent" | "CustomMessageComponent"> & Pick<PiTui, "Box" | "Text" | "Markdown">>;

export function registerInputBand(pi: Pick<ExtensionAPI, "on">, host: InputBandHost, readConfig: (cwd: string) => Record<string, unknown>): void {
  const BandEditor = createBandEditor(host.CustomEditor);
  let releaseEditor: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    releaseEditor?.();
    releaseEditor = undefined;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    if (readConfig(ctx.cwd)["ui.inputBand"] === false || typeof ctx.ui.getEditorComponent !== "function" || ctx.ui.getEditorComponent() !== undefined) return;
    const factory: NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]> = (tui, theme, keys) =>
      new BandEditor(tui, theme, keys, () => ctx.ui.theme);
    ctx.ui.setEditorComponent(factory);
    releaseEditor = () => {
      if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(undefined);
    };
  });
  pi.on("session_shutdown", () => { releaseEditor?.(); releaseEditor = undefined; });
}
