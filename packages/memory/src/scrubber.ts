/**
 * Streaming-safe context scrubber for `@spider/memory`.
 *
 * Faithful 1:1 TypeScript port of the context-fencing helpers in
 * `hermes-agent/agent/memory_manager.py` — `sanitize_context`,
 * `class StreamingContextScrubber`, and `build_memory_context_block`.
 *
 * Purpose: prevent recalled `<memory-context>…</memory-context>` spans from
 * leaking to the UI when they are split across streaming deltas, and strip
 * forged fences / system-note lines from injected or recalled provider output.
 *
 * The one-shot `sanitizeContext` regex cannot survive chunk boundaries: a
 * `<memory-context>` opened in one delta and closed in a later delta leaks its
 * payload because the non-greedy block regex needs both tags in one string.
 * `StreamingContextScrubber` runs a small state machine across deltas, holding
 * back partial-tag tails and discarding everything inside a span (including the
 * system-note line).
 */

const _FENCE_TAG_RE = /<\/?\s*memory-context\s*>/gi;
const _INTERNAL_CONTEXT_RE = /<\s*memory-context\s*>[\s\S]*?<\/\s*memory-context\s*>/gi;
const _INTERNAL_NOTE_RE =
  /\[System note:\s*The following is recalled memory context,\s*NOT new user input\.\s*Treat as (?:informational background data|authoritative reference data[^\]]*)\.\]\s*/gi;

/** Strip fence tags, injected context blocks, and system notes from provider output. */
export function sanitizeContext(text: string): string {
  text = text.replace(_INTERNAL_CONTEXT_RE, "");
  text = text.replace(_INTERNAL_NOTE_RE, "");
  text = text.replace(_FENCE_TAG_RE, "");
  return text;
}

/**
 * Stateful scrubber for streaming text that may contain split memory-context
 * spans.
 *
 * Usage:
 *
 *     const scrubber = new StreamingContextScrubber();
 *     for (const delta of stream) {
 *       const visible = scrubber.feed(delta);
 *       if (visible) emit(visible);
 *     }
 *     const trailing = scrubber.flush(); // at end of stream
 *     if (trailing) emit(trailing);
 *
 * The scrubber is re-entrant per agent instance. Callers building new
 * top-level responses (new turn) should create a fresh scrubber or call
 * `reset()`.
 */
export class StreamingContextScrubber {
  private static readonly _OPEN_TAG = "<memory-context>";
  private static readonly _CLOSE_TAG = "</memory-context>";

  private _in_span = false;
  private _buf = "";
  private _at_block_boundary = true;

  reset(): void {
    this._in_span = false;
    this._buf = "";
    this._at_block_boundary = true;
  }

  /**
   * Return the visible portion of `text` after scrubbing.
   *
   * Any trailing fragment that could be the start of an open/close tag is
   * held back in the internal buffer and surfaced on the next `feed()` call
   * or discarded/emitted by `flush()`.
   */
  feed(text: string): string {
    if (!text) {
      return "";
    }
    let buf = this._buf + text;
    this._buf = "";
    const out: string[] = [];

    while (buf) {
      if (this._in_span) {
        const idx = buf.toLowerCase().indexOf(StreamingContextScrubber._CLOSE_TAG);
        if (idx === -1) {
          // Hold back a potential partial close tag; drop the rest
          const held = this._maxPartialSuffix(buf, StreamingContextScrubber._CLOSE_TAG);
          this._buf = held ? buf.slice(buf.length - held) : "";
          return out.join("");
        }
        // Found close — skip span content + tag, continue
        buf = buf.slice(idx + StreamingContextScrubber._CLOSE_TAG.length);
        this._in_span = false;
      } else {
        const idx = this._findBoundaryOpenTag(buf);
        if (idx === -1) {
          // No open tag — hold back a potential partial open tag
          const held =
            this._maxPendingOpenSuffix(buf) ||
            this._maxPartialSuffix(buf, StreamingContextScrubber._OPEN_TAG);
          if (held) {
            this._appendVisible(out, buf.slice(0, buf.length - held));
            this._buf = buf.slice(buf.length - held);
          } else {
            this._appendVisible(out, buf);
          }
          return out.join("");
        }
        // Emit text before the tag, enter span
        if (idx > 0) {
          this._appendVisible(out, buf.slice(0, idx));
        }
        buf = buf.slice(idx + StreamingContextScrubber._OPEN_TAG.length);
        this._in_span = true;
      }
    }

    return out.join("");
  }

  /**
   * Emit any held-back buffer at end-of-stream.
   *
   * If we're still inside an unterminated span the remaining content is
   * discarded (safer: leaking partial memory context is worse than a
   * truncated answer). Otherwise the held-back partial-tag tail is emitted
   * verbatim (it turned out not to be a real tag).
   */
  flush(): string {
    if (this._in_span) {
      this._buf = "";
      this._in_span = false;
      return "";
    }
    const tail = this._buf;
    this._buf = "";
    return tail;
  }

  /**
   * Return the length of the longest buf-suffix that is a tag-prefix.
   * Case-insensitive. Returns 0 if no suffix could start the tag.
   */
  private _maxPartialSuffix(buf: string, tag: string): number {
    const tagLower = tag.toLowerCase();
    const bufLower = buf.toLowerCase();
    const maxCheck = Math.min(bufLower.length, tagLower.length - 1);
    for (let i = maxCheck; i > 0; i--) {
      if (tagLower.startsWith(bufLower.slice(bufLower.length - i))) {
        return i;
      }
    }
    return 0;
  }

  /** Find an opening fence only when it starts a block-like span. */
  private _findBoundaryOpenTag(buf: string): number {
    const bufLower = buf.toLowerCase();
    let searchStart = 0;
    for (;;) {
      const idx = bufLower.indexOf(StreamingContextScrubber._OPEN_TAG, searchStart);
      if (idx === -1) {
        return -1;
      }
      if (this._isBlockBoundary(buf, idx) && this._hasBlockOpenerSuffix(buf, idx)) {
        return idx;
      }
      searchStart = idx + 1;
    }
  }

  /** Hold a complete boundary tag until the following char confirms it. */
  private _maxPendingOpenSuffix(buf: string): number {
    if (!buf.toLowerCase().endsWith(StreamingContextScrubber._OPEN_TAG)) {
      return 0;
    }
    const idx = buf.length - StreamingContextScrubber._OPEN_TAG.length;
    if (!this._isBlockBoundary(buf, idx)) {
      return 0;
    }
    return StreamingContextScrubber._OPEN_TAG.length;
  }

  private _hasBlockOpenerSuffix(buf: string, idx: number): boolean {
    const afterIdx = idx + StreamingContextScrubber._OPEN_TAG.length;
    if (afterIdx >= buf.length) {
      return false;
    }
    const ch = buf[afterIdx];
    return ch === "\r" || ch === "\n";
  }

  private _isBlockBoundary(buf: string, idx: number): boolean {
    if (idx === 0) {
      return this._at_block_boundary;
    }
    const preceding = buf.slice(0, idx);
    const lastNewline = preceding.lastIndexOf("\n");
    if (lastNewline === -1) {
      return this._at_block_boundary && preceding.trim() === "";
    }
    return preceding.slice(lastNewline + 1).trim() === "";
  }

  private _appendVisible(out: string[], text: string): void {
    if (!text) {
      return;
    }
    out.push(text);
    this._updateBlockBoundary(text);
  }

  private _updateBlockBoundary(text: string): void {
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline !== -1) {
      this._at_block_boundary = text.slice(lastNewline + 1).trim() === "";
    } else {
      this._at_block_boundary = this._at_block_boundary && text.trim() === "";
    }
  }
}

/** Wrap prefetched memory in a fenced block with system note. */
export function buildMemoryContextBlock(rawContext: string): string {
  if (!rawContext || !rawContext.trim()) {
    return "";
  }
  const clean = sanitizeContext(rawContext);
  return (
    "<memory-context>\n" +
    "[System note: The following is recalled memory context, " +
    "NOT new user input. Treat as authoritative reference data — " +
    "this is the agent's persistent memory and should inform all responses.]\n\n" +
    `${clean}\n` +
    "</memory-context>"
  );
}
