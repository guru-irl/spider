import { createHash } from "node:crypto";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Lexer, type MarkedToken, type Token } from "marked";
import { blocksToPlain } from "./plain.js";

export type CopyTarget = { md: string; text: () => string };
export type BlockLayout = { lines: string[]; blocks: ReadonlyMap<number, CopyTarget>; lastContentRow: number };

type BoundaryKind = "code" | "blockquote" | "hr";
type Boundary = { kind: BoundaryKind; key: string };
type SourceBoundary = Boundary & { target?: CopyTarget };

const MARKER = /\x1b\]7799;(code|blockquote|hr):([\da-f]{32})\x07/g;

function isBoundary(type: string): type is BoundaryKind {
  return type === "code" || type === "blockquote" || type === "hr";
}

function boundaryKey(token: Token): string {
  // Pi normalizes tabs before lexing. The payload below still uses the authored text.
  return createHash("sha256").update(token.raw.replaceAll("\t", "   ").trimEnd()).digest("hex").slice(0, 32);
}

/** A cached line can carry a boundary, but never an occurrence number or an action. */
export function markBlockEnd(token: Token, lines: string[]): string[] {
  if (!isBoundary(token.type)) return lines;
  const last = lines.findLastIndex(line => line !== "");
  if (last >= 0) lines[last] += `\x1b]7799;${token.type}:${boundaryKey(token)}\x07`;
  return lines;
}

export const stripBlockMarkers = (line: string): string => line.replace(MARKER, "");

export function replyTarget(source: string): CopyTarget {
  return { md: source, text: () => blocksToPlain(Lexer.lex(source)) };
}

export function sourceBoundaries(source: string): SourceBoundary[] {
  const tokens = Lexer.lex(source.trim());
  const boundaries: SourceBoundary[] = [];
  let sectionStart: number | undefined;
  for (const [index, token] of tokens.entries()) {
    const t = token as MarkedToken;
    if (!isBoundary(t.type)) continue;
    let target: CopyTarget | undefined;
    if (t.type === "code") target = { md: t.raw.trimEnd(), text: () => t.text };
    if (t.type === "blockquote") target = { md: t.raw.trimEnd(), text: () => blocksToPlain(t.tokens) };
    if (t.type === "hr") {
      if (sectionStart !== undefined) {
        const section = tokens.slice(sectionStart, index);
        const md = section.map(part => part.raw).join("").trim();
        if (md) target = { md, text: () => blocksToPlain(section) };
      }
      sectionStart = index + 1;
    }
    boundaries.push({ kind: t.type, key: `${t.type}:${boundaryKey(t)}`, target });
  }
  return boundaries;
}

function byKey<T extends Boundary>(boundaries: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const boundary of boundaries) {
    const group = groups.get(boundary.key);
    if (group) group.push(boundary);
    else groups.set(boundary.key, [boundary]);
  }
  return groups;
}

/** Read every boundary in the final lines, including occurrences emitted from Pi's cache. */
export function layoutBlocks(raw: string[], source: SourceBoundary[]): BlockLayout {
  const display: (Boundary & { row: number })[] = [];
  const lines = raw.map((line, row) => line.replace(MARKER, (_marker, kind: BoundaryKind, fingerprint: string) => {
    display.push({ row, kind, key: `${kind}:${fingerprint}` });
    return "";
  }));
  const blocks = new Map<number, CopyTarget>();
  const authored = byKey(source);
  const rendered = byKey(display);
  for (const [key, occurrences] of authored) {
    const rows = rendered.get(key);
    if (rows?.length !== occurrences.length) continue;
    // Identical display blocks can still carry different authored payloads.
    occurrences.forEach(({ target }, index) => { if (target) blocks.set(rows[index].row, target); });
    authored.delete(key);
    rendered.delete(key);
  }
  // A transformer can rewrite block content. Without an exact match, use
  // occurrence order only if the remaining boundary kinds still line up.
  const remainingSource = source.filter(block => authored.has(block.key));
  const remainingDisplay = display.filter(block => rendered.has(block.key));
  if (remainingSource.length === remainingDisplay.length && remainingSource.every(({ kind }, i) => kind === remainingDisplay[i].kind)) {
    remainingSource.forEach(({ target }, index) => { if (target) blocks.set(remainingDisplay[index].row, target); });
  }
  return { lines, blocks, lastContentRow: lines.findLastIndex(line => stripTerminalSequences(line).trim() !== "") };
}
