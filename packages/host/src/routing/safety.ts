import { scrubSecrets, scanForThreats, SECRET_PATTERNS, INJECTION_NOTE } from "@spider/memory";

export interface SafetyConfig {
  secretScrub: boolean;
  injectionScan: boolean;
}

export interface SafetyResult {
  content: string;
  changed: boolean;
  flagged: string[];
}

const SECRET_IDS = new Set(SECRET_PATTERNS.map((p) => p.id)); // object shape — NOT tuple destructure

export function processToolContent(content: string, cfg: SafetyConfig): SafetyResult {
  let out = content;
  const flagged = new Set<string>();
  try {
    if (cfg.secretScrub) {
      const s = scrubSecrets(out);
      out = s.text;
      for (const id of s.flagged) flagged.add(id);
    }
    if (cfg.injectionScan) {
      const injectionIds = scanForThreats(out, "context").filter(
        (id) => !SECRET_IDS.has(id) && !id.startsWith("invisible_unicode_"),
      );
      if (injectionIds.length) {
        for (const id of injectionIds) flagged.add(id);
        if (!out.startsWith(INJECTION_NOTE)) out = `${INJECTION_NOTE}\n\n${out}`;
      }
    }
  } catch {
    return { content, changed: false, flagged: [...flagged] };
  }
  return { content: out, changed: out !== content, flagged: [...flagged] };
}

/** Scrub JSON data as well as text, withholding data that cannot be safely copied. */
export function scrubToolData(value: unknown, enabled: boolean): { value: any; changed: boolean } {
  if (!enabled || value === undefined) return { value, changed: false };
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return { value: null, changed: true };
    let changed = false;
    const cleanString = (text: string) => {
      const clean = scrubSecrets(text).text;
      if (clean !== text) changed = true;
      return clean;
    };
    const clean = (data: any, depth: number): any => {
      if (depth > 128) throw new Error("Tool data is too deeply nested");
      if (typeof data === "string") return cleanString(data);
      if (Array.isArray(data)) return data.map(item => clean(item, depth + 1));
      if (data && typeof data === "object") return Object.fromEntries(Object.entries(data)
        .map(([key, item]) => [cleanString(key), clean(item, depth + 1)]));
      return data;
    };
    const scrubbed = clean(JSON.parse(json), 0);
    return { value: scrubbed, changed };
  } catch {
    return { value: null, changed: true };
  }
}

/**
 * Sanitize a tool-call input before it is persisted as an intent payload in the
 * `events` log. Content-bearing fields are replaced with size/count metadata
 * (write `content` -> `contentBytes`, edit `edits` -> `editCount`) and every other
 * string value is secret-scrubbed. The events log therefore stores WHAT/where a
 * tool ran (path, counts, scrubbed args) — never full file contents or command
 * secrets. Never throws.
 */
export function sanitizeIntentPayload(input: unknown): unknown {
  try {
    if (input === null || typeof input !== "object") {
      return typeof input === "string" ? scrubSecrets(input).text : input;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (k === "content" && typeof v === "string") { out.contentBytes = v.length; continue; }
      if (k === "edits" && Array.isArray(v)) { out.editCount = v.length; continue; }
      out[k] = typeof v === "string" ? scrubSecrets(v).text : v;
    }
    return out;
  } catch {
    return {};
  }
}
