/** Adapted from pi-copy-button by Jonas Silva, MIT. See NOTICE.md. */
/** Plain text from Markdown: marked's tokens without their syntax. */
import type { MarkedToken, Token } from "marked";

/** Plain text from Markdown tokens: the source without its syntax, so nothing is soft-wrapped. Each block keeps the line breaks that followed it in the source. */
export function blocksToPlain(tokens: Token[]): string {
	return tokens
		.map((token) => blockToPlain(token) + breaksAfter(token.raw))
		.join("")
		.replace(/^\n+|\n+$/g, "");
}

/** The line breaks in a token's trailing whitespace (a blank line may hold spaces). */
const breaksAfter = (raw: string) => (/\s*$/.exec(raw)?.[0] ?? "").replaceAll(/[^\n]/g, "");

function blockToPlain(token: Token): string {
	const t = token as MarkedToken;
	switch (t.type) {
		case "space":
		case "def":
			return "";
		case "checkbox": // a task item's box, before its text (tight lists; loose ones have it inline)
			return t.checked ? "[x] " : "[ ] ";
		case "paragraph":
		case "heading":
			return inlineToPlain(t.tokens);
		case "text":
			return t.tokens ? inlineToPlain(t.tokens) : t.text;
		case "code": // indented code keeps its closing newline in `text`; a fenced block's blank lines are content
			return t.codeBlockStyle === "indented" ? t.text.replace(/\n+$/, "") : t.text;
		case "blockquote":
			return blocksToPlain(t.tokens);
		case "hr":
			return "---";
		case "list":
			return t.items
				.map((item, i) => {
					const bullet = t.ordered ? `${(t.start === "" ? 1 : t.start) + i}. ` : "- ";
					const body = blocksToPlain(item.tokens);
					const gap = i < t.items.length - 1 ? breaksAfter(item.raw) || "\n" : ""; // the last item's is blocksToPlain's
					return bullet + body.replaceAll("\n", `\n${" ".repeat(bullet.length)}`).replaceAll(/^ +$/gm, "") + gap;
				})
				.join("");
		case "table":
			return [t.header, ...t.rows].map((row) => row.map((cell) => inlineToPlain(cell.tokens)).join(" | ")).join("\n");
		case "html":
			return t.text.trim();
		default:
			return token.raw.replace(/\n+$/, ""); // e.g. Pi's display math, whose raw ends in a newline
	}
}

function inlineToPlain(tokens: Token[]): string {
	return tokens
		.map((token) => {
			const t = token as MarkedToken;
			switch (t.type) {
				case "strong":
				case "em":
				case "del":
				case "image": // its alt text, which can have formatting too
					return inlineToPlain(t.tokens);
				case "link": {
					const text = inlineToPlain(t.tokens);
					if (!text) return t.href;
					return [text, `mailto:${text}`, `http://${text}`].includes(t.href) ? text : `${text} (${t.href})`;
				}
				case "text":
					return t.tokens ? inlineToPlain(t.tokens) : t.text;
				case "codespan":
				case "escape":
				case "html":
					return t.text;
				case "br":
					return "\n";
				case "checkbox":
					return t.checked ? "[x] " : "[ ] ";
				default:
					return token.raw;
			}
		})
		.join("");
}
