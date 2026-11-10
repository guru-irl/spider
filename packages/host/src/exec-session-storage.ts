type Stream = "stdout" | "stderr";
type Span = [number, number, number];
type Refs = Partial<Record<Stream, Span[]>>;

function packEntry(entry: unknown, content: string): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const data = entry as Record<string, unknown>;
  if (!("exitCode" in data) || typeof data.stdout !== "string" || typeof data.stderr !== "string" || "spiderOutputRefs" in data) return entry;
  const result = { ...data };
  const refs: Refs = {};
  // Store the unmatched prefix and suffix for the expanded view. Offsets use UTF-16 indices.
  for (const stream of ["stdout", "stderr"] as const) {
    const value = data[stream] as string;
    if (value.length < 80) continue;
    let position = 0;
    let remainder = "";
    const spans: Span[] = [];
    while (position + 80 <= value.length && spans.length < 128) {
      let found: { prefix: number; start: number; length: number } | undefined;
      for (let prefix = position; prefix <= Math.min(position + 1024, value.length - 80); prefix += 16) {
        const start = content.indexOf(value.slice(prefix, prefix + 64));
        if (start < 0) continue;
        let length = 64;
        while (prefix + length < value.length && start + length < content.length && value[prefix + length] === content[start + length]) length++;
        if (length >= 80) { found = { prefix, start, length }; break; }
      }
      if (!found) break;
      remainder += value.slice(position, found.prefix);
      spans.push([found.start, found.length, remainder.length]);
      position = found.prefix + found.length;
    }
    if (!spans.length) continue;
    remainder += value.slice(position);
    refs[stream] = spans;
    if (!remainder) delete result[stream];
    else result[stream] = remainder;
  }
  if (!Object.keys(refs).length) return entry;
  result.spiderOutputRefs = refs;
  return result;
}

/** Pack only text that can be recovered exactly from the final tool content. */
export function packExecMessage(message: any): any | undefined {
  if (message?.role !== "toolResult" || !["spider", "spider_exec"].includes(message.toolName)) return;
  if (!Array.isArray(message.content) || message.content.length !== 1 || message.content[0]?.type !== "text" || typeof message.content[0].text !== "string") return;
  const content = message.content[0].text;
  const details = Array.isArray(message.details)
    ? message.details.map((entry: unknown) => packEntry(entry, content))
    : packEntry(message.details, content);
  if (Array.isArray(details) ? details.every((entry, i) => entry === message.details[i]) : details === message.details) return;
  return { ...message, details };
}

/** Restore execution streams for presentation, including old entries without references. */
export function restoreExecDetails(details: any, content: unknown): any {
  const text = Array.isArray(content) && content.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string" ? content[0].text : "";
  const restore = (entry: any) => {
    if (!entry?.spiderOutputRefs || typeof entry.spiderOutputRefs !== "object") return entry;
    const result = { ...entry };
    for (const stream of ["stdout", "stderr"] as const) {
      const spans = entry.spiderOutputRefs[stream];
      const remainder = typeof entry[stream] === "string" ? entry[stream] : "";
      if (!Array.isArray(spans)) continue;
      let position = 0;
      let output = "";
      for (const span of spans) {
        if (!Array.isArray(span) || span.length !== 3 || !span.every(Number.isSafeInteger) || span[0] < 0 || span[1] < 0 || span[2] < position || span[0] + span[1] > text.length || span[2] > remainder.length) { output = ""; position = -1; break; }
        output += remainder.slice(position, span[2]) + text.slice(span[0], span[0] + span[1]);
        position = span[2];
      }
      if (position >= 0) result[stream] = output + remainder.slice(position);
    }
    return result;
  };
  return Array.isArray(details) ? details.map(restore) : restore(details);
}
