import {
  estimateTokens, getLatestCompactionEntry, type CompactionEntry, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext, type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";
import { FULLSCREEN_READER_OVERLAY, TabbedReader, type ReaderTab } from "@spider/ui";
import { Lexer, type MarkedToken } from "marked";
import { blocksToPlain } from "../copy-buttons/plain.js";
import { modelName } from "../model-name.js";
import { compactionTokenCount, renderCompactionBars, type CompactionBill } from "./compaction-metrics.js";

type CompactionRecord = Pick<CompactionEntry, "summary" | "tokensBefore"> & {
  timestamp: string | number;
  model?: string;
  bill?: CompactionBill;
};
type Section = { label: string; markdown: string; count?: number };

function summarySections(markdown: string): Section[] {
  const tokens = Lexer.lex(markdown) as MarkedToken[];
  const files: Section[] = [];
  let end = tokens.length;
  // Pi and Spider append these blocks after the narrative. Don't pull tags
  // out of code blocks, quotes, or the middle of prose.
  while (end > 0) {
    const token = tokens[end - 1];
    if (token.type === "space") { end--; continue; }
    const match = token.type === "html" && /^<(read|modified)-files>\n([\s\S]*?)\n<\/\1-files>\s*$/u.exec(token.raw);
    if (!match) break;
    const paths = match[2].split("\n").map(path => path.trim()).filter(Boolean);
    files.unshift({ label: match[1] === "read" ? "Read files" : "Modified files", count: paths.length,
      markdown: paths.map(path => `    ${path}`).join("\n") });
    end--;
  }
  const sections: Section[] = [];
  let current: Section | undefined;
  for (const token of tokens.slice(0, end)) {
    if (token.type === "heading" && token.depth === 2 && /^ {0,3}##[ \t]/u.test(token.raw)) {
      const label = stripTerminalSequences(blocksToPlain([token])).replace(/\s+/gu, " ").trim();
      current = { label: label || "Section", markdown: "" };
      sections.push(current);
    } else if (current) {
      current.markdown += token.raw;
      if (token.type === "list") current.count = (current.count ?? 0) + token.items.length;
    }
  }
  return sections.length ? [...sections, ...files, { label: "Full summary", markdown }] : [{ label: "Summary", markdown }];
}

// Pi prefixes level-three and deeper headings with hashes. Use its level-two
// heading rendering for subsections, leaving code and other tokens untouched.
function readerMarkdown(markdown: string): string {
  return (Lexer.lex(markdown) as MarkedToken[]).map(token => token.type === "heading" && token.depth >= 3
    ? token.raw.replace(/^( {0,3})#{3,6}(?=[ \t]|$)/u, "$1##")
    : token.raw).join("");
}

// The native bundle and Pi's extension shim can load separate module instances.
// Bind Markdown to the factory's live Theme rather than the native singleton.
function markdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: text => theme.fg("mdHeading", text),
    link: text => theme.fg("mdLink", text),
    linkUrl: text => theme.fg("mdLinkUrl", text),
    code: text => theme.fg("mdCode", text),
    codeBlock: text => theme.fg("mdCodeBlock", text),
    codeBlockBorder: text => theme.fg("mdCodeBlockBorder", text),
    quote: text => theme.fg("mdQuote", text),
    quoteBorder: text => theme.fg("mdQuoteBorder", text),
    hr: text => theme.fg("mdHr", text),
    listBullet: text => theme.fg("mdListBullet", text),
    bold: text => theme.bold(text),
    italic: text => theme.italic(text),
    strikethrough: text => theme.strikethrough(text),
    underline: text => theme.underline(text),
  };
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset",
});

function overview(record: CompactionRecord, theme: Theme): ReaderTab {
  const { summary, tokensBefore, bill, model } = record;
  const summaryTokens = estimateTokens({ role: "compactionSummary", summary, tokensBefore, timestamp: 0 });
  const date = new Date(record.timestamp);
  const missing = theme.fg("dim", "Not recorded");
  const row = (label: string, value: string) => theme.fg("muted", label.padEnd(7)) + "  " + value;
  return { label: "Overview", content: {
    render(width) {
      return [
        theme.bold(theme.fg("text", "Context size")), "",
        ...renderCompactionBars(tokensBefore, summaryTokens, width, theme), "",
        theme.fg("dim", "The summary estimate does not include the retained conversation."), "",
        theme.bold(theme.fg("text", "Compaction details")), "",
        row("billed", bill ? `${bill.tokens} tokens` : missing),
        row("cost", bill?.cost ?? missing),
        row("model", model ?? missing),
        row("time", Number.isNaN(date.getTime()) ? missing : dateFormat.format(date)),
      ].flatMap(line => wrapTextWithAnsi(line, width));
    },
    invalidate() {},
  } };
}

export function compactionModel(ctx: Pick<ExtensionContext, "modelRegistry">, entry: CompactionEntry | undefined): string | undefined {
  const ref = (entry?.details as { summaryModel?: unknown } | undefined)?.summaryModel;
  return typeof ref === "string" ? modelName(ctx.modelRegistry, ref) : undefined;
}

export function compactionBill(entry: CompactionEntry | undefined): CompactionBill | undefined {
  const usage = entry?.usage;
  if (!usage) return undefined;
  const { input, output, cacheRead, cacheWrite, cost } = usage;
  return { tokens: compactionTokenCount(input + output + cacheRead + cacheWrite),
    cost: cost.total > 0 && cost.total < 0.01 ? "<$0.01" : `~$${cost.total.toFixed(2)}` };
}

export function openCompactionReader(ui: Pick<ExtensionUIContext, "custom">, record: CompactionRecord): Promise<void> {
  return ui.custom<void>((tui, theme, _keys, done) => {
    const mdTheme = markdownTheme(theme);
    const sections = summarySections(stripTerminalSequences(record.summary));
    return new TabbedReader({ title: "Compaction", tabs: [overview(record, theme), ...sections.map(section => ({
      label: section.label, count: section.count,
      content: new Markdown(section.markdown.trim() ? readerMarkdown(section.markdown) : "No text in this section.", 0, 0, mdTheme),
    }))] }, {
      theme, height: () => tui.terminal.rows, requestRender: () => tui.requestRender(), close: () => done(),
    });
  }, FULLSCREEN_READER_OVERLAY);
}

export function registerCompactionReader(pi: Partial<Pick<ExtensionAPI, "registerCommand">>): void {
  pi.registerCommand?.("compaction", {
    description: "Read the latest compaction summary on this branch",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      const entry = getLatestCompactionEntry(ctx.sessionManager.getBranch());
      if (!entry) { ctx.ui.notify("No compaction on this branch yet.", "info"); return; }
      await openCompactionReader(ctx.ui, { ...entry, model: compactionModel(ctx, entry), bill: compactionBill(entry) });
    },
  });
}
