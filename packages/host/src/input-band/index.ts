import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isIconStyle } from "@spider/ui";
import { createBandEditor } from "./editor.js";
import { installTranscriptBands } from "./transcript.js";

type Pi = typeof import("@earendil-works/pi-coding-agent");
type PiTui = typeof import("@earendil-works/pi-tui");
export type InputBandHost = Pick<Pi, "CustomEditor"> & Partial<Pick<Pi,
  "UserMessageComponent" | "ToolExecutionComponent" | "CustomMessageComponent" |
  "BranchSummaryMessageComponent" | "CompactionSummaryMessageComponent" | "SkillInvocationMessageComponent"> &
  Pick<PiTui, "Box" | "Text" | "Markdown">>;

export function registerInputBand(pi: Pick<ExtensionAPI, "on">, host: InputBandHost, readConfig: (cwd: string) => Record<string, unknown>): void {
  const BandEditor = createBandEditor(host.CustomEditor);
  let releaseTranscript: (() => void) | undefined;
  let releaseEditor: (() => void) | undefined;
  pi.on("session_start", (event, ctx) => {
    releaseEditor?.();
    releaseEditor = undefined;
    releaseTranscript?.();
    releaseTranscript = undefined;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const config = readConfig(ctx.cwd);
    const inputBand = config["ui.inputBand"] !== false;
    const style = config["ui.icons"];
    releaseTranscript = installTranscriptBands(host, {
      inputBand, theme: () => ctx.ui.theme, iconStyle: () => isIconStyle(style) ? style : "text",
    });
    if (!inputBand || typeof ctx.ui.getEditorComponent !== "function" || ctx.ui.getEditorComponent() !== undefined) return;
    const factory: NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]> = (tui, theme, keys) => {
      const editor = new BandEditor(tui, theme, keys, () => ctx.ui.theme);
      // On session switches Pi seeds its default editor before extensions bind.
      // At first startup Pi instead seeds the band itself after binding.
      if (event.reason === "resume" || event.reason === "fork") {
        for (const entry of ctx.sessionManager.buildContextEntries()) {
          if (entry.type !== "message" || entry.message.role !== "user") continue;
          const { content } = entry.message;
          const text = typeof content === "string" ? content
            : content?.flatMap(block => block.type === "text" ? [block.text] : []).join("");
          if (text) editor.addToHistory(text);
        }
      }
      return editor;
    };
    ctx.ui.setEditorComponent(factory);
    releaseEditor = () => {
      if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(undefined);
    };
  });
  pi.on("session_shutdown", () => {
    releaseEditor?.(); releaseEditor = undefined;
    releaseTranscript?.(); releaseTranscript = undefined;
  });
}
