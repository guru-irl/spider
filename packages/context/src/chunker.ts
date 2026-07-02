// ─────────────────────────────────────────────────────────
// Markdown chunker (ported from context-mode's store.ts)
// ─────────────────────────────────────────────────────────

export interface Chunk {
  title: string;
  content: string;
  hasCode: boolean;
}

// Oversized chunks (e.g., a 50KB section between two headings) hurt BM25
// length normalization and produce unwieldy search results. Split at paragraph
// boundaries when a chunk exceeds this cap.
export const MAX_CHUNK_BYTES = 4096;

// Blank-line sectioning is used only for output that is *naturally* sectioned:
// at least a few sections, not an unbounded explosion, and no single section so
// large that the split is clearly not the real structure (those fall back to
// line-grouping). Sections that pass the heuristic but still exceed
// MAX_CHUNK_BYTES are sub-split so no persisted chunk breaks the cap.
const MIN_BLANK_LINE_SECTIONS = 3;
const MAX_BLANK_LINE_SECTIONS = 200;
const BLANK_SECTION_STRATEGY_MAX_BYTES = 5000;

// Number of leading characters of a chunk's first line used as its title.
const CHUNK_TITLE_MAX_CHARS = 80;

// When byte-splitting an oversized single line, prefer to break at a whitespace
// boundary for readability — but only if that boundary is past this fraction of
// the slice, otherwise we'd waste too much of the byte budget.
const WHITESPACE_BREAK_RATIO = 0.5;

function buildTitle(
  headingStack: Array<{ level: number; text: string }>,
  currentHeading: string,
): string {
  if (headingStack.length === 0) {
    return currentHeading || "Untitled";
  }
  return headingStack.map((h) => h.text).join(" > ");
}

/**
 * Return the largest prefix of `str` whose UTF-8 byte length does not exceed
 * `maxBytes`, walking by Unicode code point so multibyte sequences (CJK) and
 * surrogate pairs (emoji) are never cut mid-character. Guarantees forward
 * progress: if even the first code point exceeds `maxBytes`, it is still
 * returned whole (a 1-4 byte overshoot beats an infinite loop).
 */
function byteCappedPrefix(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str) <= maxBytes) return str;
  let prefix = "";
  let bytes = 0;
  for (const char of str) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > maxBytes) break;
    prefix += char;
    bytes += charBytes;
  }
  // Defensive: a single code point wider than the cap (only possible with a
  // pathologically small maxBytes) still advances by one character.
  if (prefix.length === 0) return [...str][0] ?? "";
  return prefix;
}

/**
 * Split a single oversized plain-text chunk into byte-capped sub-chunks
 * by accumulating lines until the byte count would exceed maxChunkBytes.
 * Falls back to byte-accurate splitting for extremely long single lines.
 */
function splitOversizedPlainChunk(
  lines: string[],
  titlePrefix: string,
  maxChunkBytes: number,
): Array<{ title: string; content: string }> {
  const subChunks: Array<{ title: string; content: string }> = [];
  let accumulator: string[] = [];
  let partIndex = 1;

  const flushAccumulator = () => {
    if (accumulator.length === 0) return;
    const content = accumulator.join("\n");
    const partTitle = partIndex === 1 ? titlePrefix : `${titlePrefix} (${partIndex})`;
    subChunks.push({ title: partTitle, content });
    partIndex++;
    accumulator = [];
  };

  for (const line of lines) {
    // If a single line itself exceeds the cap (even as first line),
    // split it by character before accumulating
    if (Buffer.byteLength(line) > maxChunkBytes) {
      flushAccumulator();
      // Split the long line into byte-capped pieces
      let remaining = line;
      let linePart = 1;
      while (remaining.length > 0) {
        // Byte-accurate slice: never exceeds the cap, never cuts a multibyte
        // character (CJK) or surrogate pair (emoji) in half.
        let slice = byteCappedPrefix(remaining, maxChunkBytes);
        // Try to break at a whitespace boundary near the end for readability,
        // but only when text remains after this slice.
        if (slice.length < remaining.length) {
          const lastSpace = slice.lastIndexOf(" ");
          const lastNewline = slice.lastIndexOf("\n");
          const breakPoint = Math.max(lastSpace, lastNewline);
          if (breakPoint > slice.length * WHITESPACE_BREAK_RATIO) {
            slice = slice.slice(0, breakPoint);
          }
        }
        const linePartTitle = partIndex === 1 && linePart === 1
          ? titlePrefix
          : `${titlePrefix} (${partIndex}.${linePart})`;
        subChunks.push({ title: linePartTitle, content: slice });
        remaining = remaining.slice(slice.length);
        linePart++;
        partIndex++;
      }
      continue;
    }

    const candidate = accumulator.length > 0
      ? accumulator.join("\n") + "\n" + line
      : line;

    // If adding this line would exceed the cap, flush accumulator first
    if (Buffer.byteLength(candidate) > maxChunkBytes && accumulator.length > 0) {
      flushAccumulator();
    }
    accumulator.push(line);
  }
  flushAccumulator();
  return subChunks;
}

/**
 * Blank-line-section chunking strategy for naturally-sectioned plain-text
 * output (used as a fallback strategy alongside chunkMarkdown; not called by
 * chunkMarkdown itself, but ported as part of the chunker's transitive
 * dependency surface).
 */
export function chunkPlainText(
  text: string,
  linesPerChunk: number,
  maxChunkBytes: number = MAX_CHUNK_BYTES,
): Array<{ title: string; content: string }> {
  // Try blank-line splitting first for naturally-sectioned output
  const sections = text.split(/\n\s*\n/);
  if (
    sections.length >= MIN_BLANK_LINE_SECTIONS &&
    sections.length <= MAX_BLANK_LINE_SECTIONS &&
    sections.every((s) => Buffer.byteLength(s) < BLANK_SECTION_STRATEGY_MAX_BYTES)
  ) {
    return sections.flatMap((section, i) => {
      const trimmed = section.trim();
      if (trimmed.length === 0) return [];
      const title = trimmed.split("\n")[0].slice(0, CHUNK_TITLE_MAX_CHARS) || `Section ${i + 1}`;
      // A section may pass the strategy guard yet still exceed the byte cap
      // (4097–4999B band): sub-split it so no stored chunk breaks the cap.
      if (Buffer.byteLength(trimmed) <= maxChunkBytes) {
        return [{ title, content: trimmed }];
      }
      return splitOversizedPlainChunk(trimmed.split("\n"), title, maxChunkBytes);
    });
  }

  const lines = text.split("\n");

  // Small enough for a single chunk — but still enforce byte cap
  if (lines.length <= linesPerChunk) {
    if (Buffer.byteLength(text) <= maxChunkBytes) {
      return [{ title: "Output", content: text }];
    }
    return splitOversizedPlainChunk(lines, "Output", maxChunkBytes);
  }

  // Fixed-size line groups with 2-line overlap
  const chunks: Array<{ title: string; content: string }> = [];
  const overlap = 2;
  const step = Math.max(linesPerChunk - overlap, 1);

  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + linesPerChunk);
    if (slice.length === 0) break;
    const startLine = i + 1;
    const endLine = Math.min(i + slice.length, lines.length);
    const firstLine = slice[0]?.trim().slice(0, CHUNK_TITLE_MAX_CHARS);
    const joined = slice.join("\n");

    // Enforce byte cap: sub-split oversized line-group chunks
    if (Buffer.byteLength(joined) <= maxChunkBytes) {
      chunks.push({
        title: firstLine || `Lines ${startLine}-${endLine}`,
        content: joined,
      });
    } else {
      const subChunks = splitOversizedPlainChunk(
        slice,
        firstLine || `Lines ${startLine}-${endLine}`,
        maxChunkBytes,
      );
      chunks.push(...subChunks);
    }
  }

  return chunks;
}

export function chunkMarkdown(text: string, maxChunkBytes: number = MAX_CHUNK_BYTES): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = text.split("\n");
  const headingStack: Array<{ level: number; text: string }> = [];
  let currentContent: string[] = [];
  let currentHeading = "";

  const flush = () => {
    const joined = currentContent.join("\n").trim();
    if (joined.length === 0) return;

    const title = buildTitle(headingStack, currentHeading);
    const hasCode = currentContent.some((l) => /^`{3,}/.test(l));

    // If under the cap, emit as-is (fast path — most chunks hit this)
    if (Buffer.byteLength(joined) <= maxChunkBytes) {
      chunks.push({ title, content: joined, hasCode });
      currentContent = [];
      return;
    }

    // Split oversized chunk at paragraph boundaries (double newlines).
    // KNOWN LIMIT (matches store.ts): a single break-less oversized paragraph
    // is not byte-capped — it is emitted whole even if it exceeds maxChunkBytes.
    const paragraphs = joined.split(/\n\n+/);
    let accumulator: string[] = [];
    let partIndex = 1;

    const flushAccumulator = () => {
      if (accumulator.length === 0) return;
      const part = accumulator.join("\n\n").trim();
      if (part.length === 0) return;
      const partTitle = paragraphs.length > 1 ? `${title} (${partIndex})` : title;
      partIndex++;
      chunks.push({
        title: partTitle,
        content: part,
        hasCode: part.includes("```"),
      });
      accumulator = [];
    };

    for (const para of paragraphs) {
      accumulator.push(para);
      const candidate = accumulator.join("\n\n");
      if (Buffer.byteLength(candidate) > maxChunkBytes && accumulator.length > 1) {
        accumulator.pop();
        flushAccumulator();
        accumulator = [para];
      }
    }
    flushAccumulator();

    currentContent = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Horizontal rule separator (Context7 uses long dashes)
    if (/^[-_*]{3,}\s*$/.test(line)) {
      flush();
      i++;
      continue;
    }

    // Heading (H1-H4)
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flush();

      const level = headingMatch[1].length;
      const heading = headingMatch[2].trim();

      // Pop deeper levels from stack
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level, text: heading });
      currentHeading = heading;

      currentContent.push(line);
      i++;
      continue;
    }

    // Code block — collect entire block as a unit
    const codeMatch = line.match(/^(`{3,})(.*)?$/);
    if (codeMatch) {
      const fence = codeMatch[1];
      const codeLines: string[] = [line];
      i++;

      while (i < lines.length) {
        codeLines.push(lines[i]);
        if (lines[i].startsWith(fence) && lines[i].trim() === fence) {
          i++;
          break;
        }
        i++;
      }

      currentContent.push(...codeLines);
      continue;
    }

    // Regular line
    currentContent.push(line);
    i++;
  }

  // Flush remaining content
  flush();

  return chunks;
}

export function detectContentType(chunk: Chunk): "code" | "prose" {
  return chunk.hasCode ? "code" : "prose";
}
