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
        out = `${INJECTION_NOTE}\n\n${out}`;
      }
    }
  } catch {
    return { content, changed: false, flagged: [...flagged] };
  }
  return { content: out, changed: out !== content, flagged: [...flagged] };
}
