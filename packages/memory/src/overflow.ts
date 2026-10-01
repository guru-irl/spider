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

  constructor(cap: number, usage: number, entries: MemoryRecord[], scope: MemoryScope, addingChars: number, stagedUuid?: string) {
    const number = (n: number) => n.toLocaleString("en-US");
    const chars = (n: number) => `${number(n)} ${n === 1 ? "char" : "chars"}`;
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    const prefix = stagedUuid ? "Not approved" : "Not stored";
    const entry = stagedUuid ? `Staged entry ${stagedUuid}` : "This entry";
    const largest = [...entries].sort((a, b) => memoryCharLength(b.content) - memoryCharLength(a.content)).slice(0, 20);
    const entryList = largest.map(e => {
      const preview = [...segmenter.segment(e.content.replace(/\s+/g, " ").trim())].map(part => part.segment);
      // Full UUIDs include the identifying prefix and can be used directly with forget.
      return `- ${e.uuid} · ${chars(memoryCharLength(e.content))} · [${e.category}] ${preview.slice(0, 50).join("")}${preview.length > 50 ? "..." : ""}`;
    });
    const oversized = addingChars > cap;
    const shorten = stagedUuid
      ? `Reject it with spider control memory sub=reject uuid=${stagedUuid} scope=${scope}, then remember a shorter version`
      : "Shorten it";
    const headline = oversized
      ? `${prefix}: ${stagedUuid ? `staged entry ${stagedUuid}` : "this entry"} is ${chars(addingChars)}, over the ${number(cap)}-char ${scope} memory cap. ${shorten}; forgetting entries cannot make room.`
      : `${prefix}: ${scope} memory is full (${number(usage)} of ${number(cap)} chars used). ${entry} is ${chars(addingChars)}; free at least ${number(usage + addingChars - cap)}${stagedUuid ? ", then approve it again" : ""}.`;
    super([
      headline,
      ...(!oversized ? [
        `Free space: forget an entry with spider control memory sub=forget uuid=<uuid> scope=${scope}. To condense an entry, forget it and remember a shorter version.`,
        scope === "global"
          ? "Move repo-specific entries to repo scope: forget the global entry, then remember it with scope=repo in the relevant repository."
          : "Keep repo-specific entries in repo scope; forget or condense entries here rather than moving them to global scope.",
        `Active entries (${largest.length} of ${entries.length}, largest first; full UUIDs):`,
        ...(entryList.length ? entryList : ["(none)"]),
        ...(entries.length > largest.length ? [`${entries.length - largest.length} more entries; list all with spider control memory sub=status scope=${scope}.`] : []),
      ] : []),
    ].join("\n"));
    this.cap = cap;
    this.usage = usage;
    this.entries = entries;
  }
}

export function assertWithinCap(db: Db, scope: MemoryScope, addingChars: number, cap: number, stagedUuid?: string): void {
  const usage = activeCharTotal(db, scope);
  if (usage + addingChars > cap) {
    const entries = listActive(db, scope);
    throw new MemoryOverflowError(cap, usage, entries, scope, addingChars, stagedUuid);
  }
}
