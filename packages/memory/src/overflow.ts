import type { Db } from "@spider/db-core";
import type { MemoryScope, MemoryRecord } from "./types";
import { activeCharTotal, listActive } from "./internal";

export const DEFAULT_MEMORY_CHAR_CAP = 8000;

export class MemoryOverflowError extends Error {
  readonly usage: number;
  readonly cap: number;
  readonly entries: MemoryRecord[];

  constructor(cap: number, usage: number, entries: MemoryRecord[]) {
    const entryList = entries.length > 0
      ? entries.map(e => `[${e.category}] ${e.content.substring(0, 50)}${e.content.length > 50 ? "..." : ""}`).join("; ")
      : "(none)";
    super(`Memory cap exceeded: ${usage} + new content would exceed ${cap} chars. Active entries: ${entryList}`);
    this.cap = cap;
    this.usage = usage;
    this.entries = entries;
  }
}

export function assertWithinCap(db: Db, scope: MemoryScope, addingChars: number, cap: number): void {
  const usage = activeCharTotal(db, scope);
  if (usage + addingChars > cap) {
    const entries = listActive(db, scope);
    throw new MemoryOverflowError(cap, usage, entries);
  }
}
