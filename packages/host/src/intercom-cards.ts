import { hostname } from "node:os";
import type { ExtensionAPI, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Message, SessionInfo } from "@spider/intercom/types";
import { cardDetailIndent, fitResultLines, icon, type IconStyle } from "@spider/ui";

export function localMachineLabel(readHostname: () => string = hostname): string {
  return readHostname().split(".")[0] || "(unknown machine)";
}

function previewText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 96 ? `${text.slice(0, 95)}…` : text || undefined;
}

type IntercomCommand = "intercom" | "contact_supervisor";

function callCard(
  command: IntercomCommand, args: Record<string, unknown>, theme: Theme,
  style: IconStyle, supervisor: string | undefined,
): Component {
  const action = command === "intercom"
    ? typeof args.action === "string" ? args.action : "intercom"
    : typeof args.reason === "string" ? args.reason : "contact";
  const target = command === "intercom"
    ? typeof args.to === "string" ? args.to.trim() : undefined
    : supervisor;
  let details = action + (target ? ` ${icon("text", "arrowRight")} ${target}` : "");
  const interview = args.interview && typeof args.interview === "object"
    ? args.interview as { title?: unknown } : undefined;
  if (command === "contact_supervisor" && typeof interview?.title === "string" && interview.title.trim()) {
    details += ` · ${interview.title.trim()}`;
  }
  const count = Array.isArray(args.attachments) ? args.attachments.length : 0;
  if (command === "intercom" && count) details += ` (${count} attachment${count === 1 ? "" : "s"})`;
  const preview = previewText(args.message);
  const logo = icon(style, "spider");
  const rows = [` ${theme.fg("toolTitle", logo)} ${theme.fg("toolTitle", theme.bold(command))} · ${theme.fg("muted", details)}`];
  const indent = cardDetailIndent(style);
  if (preview) rows.push(indent + theme.fg("dim", preview));
  return { render: width => fitResultLines(rows, width, true, indent.length), invalidate() {} };
}

interface ResultDetails {
  delivered?: boolean;
  error?: boolean;
  messageId?: string;
  reason?: string;
  structuredReplyParseError?: string;
}
interface ResultContent { content?: Array<{ type: string; text?: string }>; details?: unknown }

function resultCard(
  command: IntercomCommand, result: ResultContent, partial: boolean, expanded: boolean,
  isError: boolean, action: string | undefined, theme: Theme, style: IconStyle,
): Component {
  if (partial) {
    const text = command === "intercom" ? " Intercom working..." : " Waiting for supervisor...";
    return new Text(theme.fg("warning", text), 0, 0);
  }
  const details = result.details as ResultDetails | undefined;
  const failed = isError || details?.error === true || details?.delivered === false;
  const parseWarning = typeof details?.structuredReplyParseError === "string";
  const role = failed ? "failure" : parseWarning ? "warning" : "success";
  const color = failed ? "error" : parseWarning ? "warning" : "success";
  let content = result.content?.find(item => item.type === "text" && typeof item.text === "string")?.text?.replace(/\*\*/g, "") ?? "";
  if (!expanded) {
    // Change the display copy only; the original result remains model-facing.
    content = content.replace(/(^|[ \t]+)\(ID [^)]+\)([ \t]*)/gm, (_match, before: string, after: string) => before && after ? " " : "");
    if (action === "cancel" && details?.messageId) content = content.replaceAll(details.messageId, "message");
    if (action === "pending") content = content.replace(/^(- .+?) · [^\s·]+ · (\d+s ago · )/gm, "$1 · $2");
    if (action === "list" || action === "list-cwd") {
      // Named rows carry an ID prefix for disambiguation; keep it only if the name is missing.
      const bullet = `${icon("text", "bullet")} `;
      content = content.split("\n").map(line => {
        if (!line.startsWith(bullet)) return line;
        const separator = line.indexOf(" — ", bullet.length);
        if (separator < 0) return line;
        const label = line.slice(bullet.length, separator);
        const name = label.replace(/ \([^()]*\)$/, "");
        if (!name || name === label || name === "Unnamed session") return line;
        return `${icon(style, "bullet")} ${name}${line.slice(separator)}`;
      }).join("\n");
    }
  }
  const marker = icon(style, role);
  const indent = " ".repeat(visibleWidth(` ${marker} `));
  const rows = content.split("\n").map((line, index) => index === 0
    ? ` ${theme.fg(color, `${marker} `)}${theme.fg(failed ? "error" : "text", line)}`
    : `${indent}${theme.fg(failed ? "error" : "text", line)}`);
  if (parseWarning) rows.push(`${indent}${theme.fg("warning", `Structured reply parse issue: ${details.structuredReplyParseError}`)}`);
  if (command === "intercom" && expanded && details?.reason) {
    rows.push(`${indent}${theme.fg("dim", `Reason: ${details.reason}`)}`);
  }
  return { render: width => fitResultLines(rows, width, true, indent.length), invalidate() {} };
}

interface IncomingDetails { from: SessionInfo; message: Message; replyCommand?: string; bodyText?: string }

class IncomingIntercomCard implements Component {
  private collapsedPreview?: string;
  private wrappedBody?: { width: number; lines: string[] };

  constructor(
    private details: IncomingDetails, private theme: Theme, private collapsed: boolean,
    private style: IconStyle, private localMachineName: string,
  ) {}
  invalidate(): void {}

  render(width: number): string[] {
    const { from, message, replyCommand, bodyText } = this.details;
    const logo = icon(this.style, "spider");
    const prefix = cardDetailIndent(this.style);
    const bodyWidth = Math.max(1, width - prefix.length);
    const sender = from.name || from.id.slice(0, 8);
    const machine = from.remote ? from.machineAlias : this.localMachineName;
    const title = ` ${this.theme.fg("toolTitle", logo)} ${this.theme.fg("toolTitle", this.theme.bold("intercom"))} · ${this.theme.fg("muted", `from ${sender} · ${machine}`)}`;
    const lines = [truncateToWidth(title, width, "")];
    if (this.collapsed) {
      this.collapsedPreview ??= (bodyText || message.content.text).replace(/\s+/g, " ").trim();
      lines.push(truncateToWidth(prefix + this.theme.fg("text", this.collapsedPreview), width, ""));
      return lines;
    }
    if (this.wrappedBody?.width !== bodyWidth) {
      this.wrappedBody = { width: bodyWidth, lines: wrapTextWithAnsi(bodyText || message.content.text, bodyWidth) };
    }
    for (const line of this.wrappedBody.lines) lines.push(truncateToWidth(prefix + this.theme.fg("text", line), width, ""));
    const details: string[] = [];
    if (replyCommand) {
      const hasReplyId = replyCommand.includes(`replyTo: ${JSON.stringify(message.id)}`);
      details.push(hasReplyId ? "To reply: use intercom for this message" : `To reply: ${replyCommand}`);
    }
    for (const attachment of message.content.attachments ?? []) details.push(`Attachment: ${attachment.name}`);
    if (message.provenance?.type === "extension_outbox") details.push(`Via extension: ${message.provenance.extensionName}`);
    if (message.replyTo && !message.expectsReply) details.push("In reply to a message");
    for (const detail of details) {
      for (const line of wrapTextWithAnsi(detail, bodyWidth)) {
        lines.push(truncateToWidth(prefix + this.theme.fg("dim", line), width, ""));
      }
    }
    return lines;
  }
}

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

/** Replace only presentation hooks; the fork keeps its execute and result objects. */
export function withIntercomCards(pi: ExtensionAPI, iconStyle: () => IconStyle, localMachineName: string): ExtensionAPI {
  return new Proxy(pi, { get(target, key) {
    if (key === "registerTool") return (tool: RegisteredTool) => {
      if (tool.name !== "intercom" && tool.name !== "contact_supervisor") return target.registerTool(tool);
      const command = tool.name;
      const supervisor = process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET?.trim();
      const wrapped: RegisteredTool = {
        ...tool,
        renderCall: (args, theme) => {
          const params = args && typeof args === "object" ? args as Record<string, unknown> : {};
          return callCard(command, params, theme, iconStyle(), supervisor);
        },
        renderResult: (result, options, theme, context) => {
          const args = context.args as Record<string, unknown> | undefined;
          const action = typeof args?.action === "string" ? args.action : undefined;
          return resultCard(command, result, options.isPartial, context.expanded ?? options.expanded,
            context.isError, action, theme, iconStyle());
        },
      };
      return target.registerTool(wrapped);
    };
    if (key === "registerMessageRenderer") return (name: string, renderer: MessageRenderer) => {
      if (name !== "intercom_message") return target.registerMessageRenderer(name, renderer);
      return target.registerMessageRenderer(name, (message, options, theme) => {
        const details = message.details as IncomingDetails | undefined;
        return details ? new IncomingIntercomCard(details, theme, !options.expanded, iconStyle(), localMachineName) : undefined;
      });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
