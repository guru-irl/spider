// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { RunViewEvent, TranscriptPage } from '../contracts.js';

/** Controls are never output, even when an OSC/CSI spans two transport pages. */
export class TranscriptSanitizer {
  private state: 'text' | 'escape' | 'csi' | 'string' | 'string-escape' = 'text';
  push(text: string): string {
    let output = '';
    for (const char of text) {
      const code = char.codePointAt(0)!;
      switch (this.state) {
        case 'string':
          if (char === '\x07' || char === '\x9c') this.state = 'text';
          else if (char === '\x1b') this.state = 'string-escape';
          break;
        case 'string-escape':
          this.state = char === '\\' || char === '\x07' || char === '\x9c' ? 'text' : char === '\x1b' ? 'string-escape' : 'string';
          break;
        case 'csi':
          if (code >= 0x40 && code <= 0x7e) this.state = 'text';
          else if (char === '\x1b') this.state = 'escape';
          break;
        case 'escape':
          if (char === '[') this.state = 'csi';
          else if (']PX^_'.includes(char)) this.state = 'string';
          else if (code >= 0x30 && code <= 0x7e) this.state = 'text';
          break;
        case 'text':
          if (char === '\x1b') this.state = 'escape';
          else if (char === '\x9b') this.state = 'csi';
          else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) this.state = 'string';
          else if (char === '\n' || char === '\t' || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f))) output += char;
          break;
      }
    }
    return output;
  }
}
/** Kept for the viewer's lifetime, not the lifetime of a reconnecting stream. */
export class TranscriptMessages {
  private readonly seen = new Set<string>();
  shouldRender(event: RunViewEvent): boolean {
    if (event.type !== 'message' || typeof event.messageId !== 'string' || typeof event.streamed !== 'boolean') return true;
    const identity = JSON.stringify([event.runId, event.messageId]);
    if (this.seen.has(identity)) return false;
    this.seen.add(identity);
    return !event.streamed;
  }
}
export function projectTranscript(events: readonly RunViewEvent[]): TranscriptPage {
  const sanitizer = new TranscriptSanitizer();
  const projected = events.map(event => ({ ...event,
    ...(event.text !== undefined ? { text: sanitizer.push(event.text) } : {}),
    type: new TranscriptSanitizer().push(event.type),
    ...(event.summary !== undefined ? { summary: new TranscriptSanitizer().push(event.summary) } : {}),
    ...(event.tool !== undefined ? { tool: new TranscriptSanitizer().push(event.tool) } : {}),
  }));
  return { text: projected.map(event => event.text ?? '').join(''), events: projected };
}
