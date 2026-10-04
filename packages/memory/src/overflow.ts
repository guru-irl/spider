import type { Db } from "@spider/db-core";
import type { MemoryScope, MemoryRecord } from "./types";
import { activeCharTotal, listActive } from "./internal";

export const DEFAULT_MEMORY_CHAR_CAP = 8000;

/** Count code points, matching SQLite LENGTH(content), rather than UTF-16 units. */
export function memoryCharLength(content: string): number {
  return [...content].length;
}

export class MemoryOverflowError extends Error {
  readonly usage: number;
  readonly cap: number;
  readonly entries: MemoryRecord[];

  constructor(cap: number, usage: number, entries: MemoryRecord[], scope: MemoryScope, addingChars: number, stagedUuid?: string, replacingUuids: readonly string[] = []) {
    const number = (n: number) => n.toLocaleString("en-US");
    const chars = (n: number) => `${number(n)} ${n === 1 ? "char" : "chars"}`;
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    const prefix = stagedUuid ? "Not approved" : "Not stored";
    const entry = stagedUuid ? `Staged entry ${stagedUuid}` : "This entry";
    const replacing = new Set(replacingUuids);
    const replacementChars = entries.filter(e => replacing.has(e.uuid)).reduce((total, e) => total + memoryCharLength(e.content), 0);
    const projectedUsage = usage - replacementChars + addingChars;
    const largest = [...entries].sort((a, b) => memoryCharLength(b.content) - memoryCharLength(a.content));
    const entryList = largest.map(e => {
      const preview = [...segmenter.segment(e.content.replace(/\s+/g, " ").trim())].map(part => part.segment);
      // Full UUIDs include the identifying prefix and can be used directly with forget.
      return `- ${e.uuid} · ${chars(memoryCharLength(e.content))}${replacing.has(e.uuid) ? " · [would be replaced]" : ""} · [${e.category}] ${preview.slice(0, 50).join("")}${preview.length > 50 ? "..." : ""}`;
    });
    const oversized = addingChars > cap;
    const shorten = stagedUuid
      ? `Reject it with spider control memory sub=reject uuid=${stagedUuid} scope=${scope}, then remember a shorter version`
      : "Shorten it";
    const headline = oversized
      ? `${prefix}: ${stagedUuid ? `staged entry ${stagedUuid}` : "this entry"} is ${chars(addingChars)}, over the ${number(cap)}-char ${scope} memory cap. ${shorten}; forgetting entries cannot make room.`
      : `${prefix}: ${scope} memory is full (${number(usage)} of ${number(cap)} chars used). ${entry} is ${chars(addingChars)}; free at least ${number(projectedUsage - cap)}${stagedUuid ? ", then approve it again" : ""}.`;
    super([
      headline,
      ...(replacementChars ? [`Replacement credit: ${chars(replacementChars)}; projected usage: ${number(projectedUsage)} of ${number(cap)} chars.`] : []),
      ...(!oversized ? [
        `Free space: forget an entry with spider control memory sub=forget uuid=<uuid> scope=${scope}. To condense an entry, forget it and remember a shorter version.`,
        scope === "global"
          ? "Move repo-specific entries to repo scope: forget the global entry, then remember it with scope=repo in the relevant repository."
          : "Keep repo-specific entries in repo scope; forget or condense entries here rather than moving them to global scope.",
        `Active entries (${entries.length}, largest first; full UUIDs):`,
        ...(entryList.length ? entryList : ["(none)"]),
      ] : []),
    ].join("\n"));
    this.cap = cap;
    this.usage = usage;
    this.entries = entries;
  }
}

/** Replacement callers must hold a write transaction through both this check and the write. */
export function assertWithinCap(db: Db, scope: MemoryScope, addingChars: number, cap: number, stagedUuid?: string, replacingUuids: readonly string[] = []): void {
  const usage = activeCharTotal(db, scope);
  // Resolve credit from this scope's current active rows, never from stale reviewer content.
  const entries = replacingUuids.length ? listActive(db, scope) : undefined;
  const replacing = new Set(replacingUuids);
  const replacementChars = entries?.filter(e => replacing.has(e.uuid)).reduce((total, e) => total + memoryCharLength(e.content), 0) ?? 0;
  if (usage - replacementChars + addingChars > cap) {
    throw new MemoryOverflowError(cap, usage, entries ?? listActive(db, scope), scope, addingChars, stagedUuid, replacingUuids);
  }
}
