import { parseSkillBlock, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isIconStyle } from "@spider/ui";
import { createBandEditor } from "./editor.js";
import { installSelectionHighlight } from "./selection.js";
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
  let releaseSelection: (() => void) | undefined;
  const live: { pending?: { text: string; timestamp: number } } = {};
  pi.on("message_start", event => {
    live.pending = undefined;
    if (event.message.role !== "user") return;
    const { content, timestamp } = event.message;
    const text = typeof content === "string" ? content : content.flatMap(block => block.type === "text" ? [block.text] : []).join("");
    const skill = parseSkillBlock(text);
    const displayed = skill ? skill.userMessage : text;
    if (displayed && Number.isFinite(timestamp)) live.pending = { text: displayed, timestamp };
  });
  pi.on("message_end", () => { live.pending = undefined; });
  pi.on("session_start", (event, ctx) => {
    releaseEditor?.();
    releaseEditor = undefined;
    releaseSelection?.();
    releaseSelection = undefined;
    releaseTranscript?.();
    releaseTranscript = undefined;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    if (typeof ctx.ui.setWidget === "function") {
      ctx.ui.setWidget("spider-selection-highlight", tui => {
        releaseSelection?.();
        const release = installSelectionHighlight(tui);
        releaseSelection = release;
        return { render: () => [], invalidate: () => {}, dispose: () => {
          release();
          if (releaseSelection === release) releaseSelection = undefined;
        } };
      });
    }
    const config = readConfig(ctx.cwd);
    const inputBand = config["ui.inputBand"] !== false;
    const style = config["ui.icons"];
    releaseTranscript = installTranscriptBands(host, {
      inputBand, theme: () => ctx.ui.theme, iconStyle: () => isIconStyle(style) ? style : "text", live,
      timestamp: id => {
        const entry = ctx.sessionManager?.getEntry(id);
        return entry?.type === "message" && entry.message.role === "user" ? entry.message.timestamp : undefined;
      },
    });
    if (!inputBand || typeof ctx.ui.getEditorComponent !== "function" || ctx.ui.getEditorComponent() !== undefined) return;
    const factory: NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]> = (tui, theme, keys) => {
      const editor = new BandEditor(tui, theme, keys, () => ctx.ui.theme);
      // On session switches (new, resume, fork) Pi seeds its default editor before extensions bind.
      // At first startup Pi instead seeds the band itself after binding, and a reload keeps the shared history.
      if (event.reason !== "startup" && event.reason !== "reload") {
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
    live.pending = undefined;
    releaseEditor?.(); releaseEditor = undefined;
    releaseSelection?.(); releaseSelection = undefined;
    releaseTranscript?.(); releaseTranscript = undefined;
  });
}
