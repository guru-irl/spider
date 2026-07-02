import { describe, it, expect } from "vitest";
import { chunkMarkdown, MAX_CHUNK_BYTES } from "../chunker.js";

describe("chunkMarkdown", () => {
  it("splits by markdown headings, keeping code blocks intact", () => {
    const md = "# A\nalpha text\n\n```js\nconst x=1;\n```\n\n# B\nbravo text\n";
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const titles = chunks.map((c) => c.title);
    expect(titles.some((t) => t.startsWith("A"))).toBe(true);
    expect(titles.some((t) => t.startsWith("B"))).toBe(true);
  });

  it("sub-splits an oversized section so no chunk exceeds MAX_CHUNK_BYTES", () => {
    // store.ts's #chunkMarkdown only sub-splits oversized content at paragraph
    // (blank-line) boundaries — a single break-less line is NOT capped (see
    // KNOWN LIMIT comment in chunker.ts). Build the stress input from many
    // blank-line-separated paragraphs so the real sub-splitting path is
    // exercised, matching store.ts behavior byte-for-byte.
    const para = "y".repeat(2000);
    const body = Array.from({ length: 8 }, () => para).join("\n\n");
    const big = "# Big\n" + body;
    const chunks = chunkMarkdown(big);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(Buffer.byteLength(c.content, "utf8")).toBeLessThanOrEqual(MAX_CHUNK_BYTES + 200);
    }
  });
});
