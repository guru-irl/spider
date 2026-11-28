import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { icon, type IconStyle } from "@spider/ui";
import type { SessionInfo, Message } from "../types.js";

export class InlineMessageComponent implements Component {
  // Caches assume message/bodyText never mutate after construction; theme styling
  // stays outside the caches so live theme changes apply per render.
  private collapsedPreview?: string;
  private wrappedBody?: { width: number; lines: string[] };

  constructor(
    private from: SessionInfo,
    private message: Message,
    private theme: Theme,
    private replyCommand?: string,
    private bodyText?: string,
    private collapsed = false,
    private iconStyle: IconStyle = "text",
    private localMachineName = "(unknown machine)",
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const logo = icon(this.iconStyle, "spider");
    const prefix = " ".repeat(visibleWidth(` ${logo} `));
    const bodyWidth = Math.max(1, width - prefix.length);
    const sender = this.from.name || this.from.id.slice(0, 8);
    const machine = this.from.remote ? this.from.machineAlias : this.localMachineName;
    const title = ` ${this.theme.fg("accent", logo)} ${this.theme.fg("toolTitle", this.theme.bold("intercom"))} · ${this.theme.fg("muted", `from ${sender} · ${machine}`)}`;
    const lines = [truncateToWidth(title, width, "")];

    if (this.collapsed) {
      this.collapsedPreview ??= (this.bodyText || this.message.content.text).replace(/\s+/g, " ").trim();
      lines.push(truncateToWidth(` ${this.theme.fg("dim", icon(this.iconStyle, "gutter"))} ${this.theme.fg("text", this.collapsedPreview)}`, width, ""));
      return lines;
    }

    if (this.wrappedBody?.width !== bodyWidth) {
      this.wrappedBody = { width: bodyWidth, lines: wrapTextWithAnsi(this.bodyText || this.message.content.text, bodyWidth) };
    }
    for (const line of this.wrappedBody.lines) {
      lines.push(truncateToWidth(prefix + this.theme.fg("text", line), width, ""));
    }

    const details: string[] = [];
    if (this.replyCommand) details.push(`To reply: ${this.replyCommand}`);
    for (const attachment of this.message.content.attachments ?? []) details.push(`Attachment: ${attachment.name}`);
    if (this.message.provenance?.type === "extension_outbox") details.push(`Via extension: ${this.message.provenance.extensionName}`);
    if (this.message.replyTo && !this.message.expectsReply) details.push("In reply to a message");
    for (const detail of details) {
      for (const line of wrapTextWithAnsi(detail, bodyWidth)) {
        lines.push(truncateToWidth(prefix + this.theme.fg("dim", line), width, ""));
      }
    }
    return lines;
  }
}
