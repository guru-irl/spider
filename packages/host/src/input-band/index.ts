import { parseSkillBlock, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isIconStyle } from "@spider/ui";
import { createBandEditor } from "./editor.js";
import { installTranscriptBands } from "./transcript.js";
import { installPendingBands } from "./pending.js";
import { installCompactionCard } from "./compaction-card.js";
import { modelName } from "../model-name.js";

type Pi = typeof import("@earendil-works/pi-coding-agent");
type PiTui = typeof import("@earendil-works/pi-tui");
export type InputBandHost = Pick<Pi, "CustomEditor"> & Partial<Pick<Pi,
  "InteractiveMode" | "UserMessageComponent" | "ToolExecutionComponent" | "CustomMessageComponent" |
  "BranchSummaryMessageComponent" | "CompactionSummaryMessageComponent" | "SkillInvocationMessageComponent"> &
  Pick<PiTui, "Box" | "Text" | "Markdown" | "Spacer" | "TruncatedText">>;

export function registerInputBand(pi: Pick<ExtensionAPI, "on">, host: InputBandHost, readConfig: (cwd: string) => Record<string, unknown>): void {
  const BandEditor = createBandEditor(host.CustomEditor);
  let releaseTranscript: (() => void) | undefined;
  let releaseEditor: (() => void) | undefined;
  let releasePending: (() => void) | undefined;
  let releaseCompaction: (() => void) | undefined;
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
    releaseTranscript?.();
    releaseTranscript = undefined;
    releasePending?.();
    releasePending = undefined;
    releaseCompaction?.();
    releaseCompaction = undefined;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const config = readConfig(ctx.cwd);
    const inputBand = config["ui.inputBand"] !== false;
    const style = config["ui.icons"];
    const iconStyle = () => isIconStyle(style) ? style : "text";
    const theme = () => ctx.ui.theme;
    releaseCompaction = installCompactionCard(host, {
      theme, iconStyle,
      model: (id, message) => {
        // Live compaction cards do not have a message ID. Pi just placed the
        // current compaction at the front of the active context.
        const entry = id ? ctx.sessionManager?.getEntry(id) : ctx.sessionManager?.buildContextEntries()[0];
        if (entry?.type !== "compaction" || entry.summary !== message.summary || entry.tokensBefore !== message.tokensBefore) return;
        const ref = (entry.details as { summaryModel?: unknown } | undefined)?.summaryModel;
        return typeof ref === "string" ? modelName(ctx.modelRegistry, ref) : undefined;
      },
    });
    releaseTranscript = installTranscriptBands(host, {
      inputBand, theme, iconStyle, live,
      timestamp: id => {
        const entry = ctx.sessionManager?.getEntry(id);
        return entry?.type === "message" && entry.message.role === "user" ? entry.message.timestamp : undefined;
      },
    });
    if (inputBand) releasePending = installPendingBands(host, theme, iconStyle);
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
    releaseTranscript?.(); releaseTranscript = undefined;
    releasePending?.(); releasePending = undefined;
    releaseCompaction?.(); releaseCompaction = undefined;
  });
}
