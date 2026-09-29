import type { Db } from "@spider/db-core";
import type { MemoryRecord, MemoryScope } from "./types";
import { listActive } from "./store";
import { tableFor } from "./internal";
import { buildMemoryContextBlock } from "./scrubber";

export interface SnapshotOpts {
  /** Optional limit on the snapshot body, excluding the surrounding context fence. */
  charCap?: number;
  scopes?: MemoryScope[];
}

export type SnapshotCounts = Record<MemoryScope, { active: number; injected: number }>;
export interface SnapshotResult { text: string; counts: SnapshotCounts }

/** Build a frozen, scope-labelled snapshot; an absent cap includes every active entry. */
export function assembleSnapshotWithStats(
  dbs: { global?: Db; repo?: Db }, opts?: SnapshotOpts,
): SnapshotResult {
  const active: Partial<Record<MemoryScope, MemoryRecord[]>> = {};
  for (const tier of opts?.scopes ?? ["global", "repo"] as const) {
    tableFor(tier);
    const db = dbs[tier];
    if (db) active[tier] = listActive(db, tier);
  }
  return assembleSnapshotFromRecords(active, opts);
}

/** Pack already-read active tiers. The host reads each tier separately so a bad file cannot hide another tier. */
export function assembleSnapshotFromRecords(
  active: Partial<Record<MemoryScope, MemoryRecord[]>>, opts?: SnapshotOpts,
): SnapshotResult {
  const counts: SnapshotCounts = {
    global: { active: 0, injected: 0 },
    repo: { active: 0, injected: 0 },
  };
  const records: Array<MemoryRecord & { tier: MemoryScope }> = [];
  for (const tier of opts?.scopes ?? ["global", "repo"] as const) {
    tableFor(tier);
    const tierRecords = active[tier] ?? [];
    counts[tier].active += tierRecords.length;
    records.push(...tierRecords.map(record => ({ ...record, tier })));
  }
  if (!records.length) return { text: "", counts };

  // User directives precede observations regardless of tier or timestamp.
  const priority = (record: MemoryRecord): number =>
    record.category === "preference" ? 0 : record.category === "correction" ? 1 : 2;
  records.sort((a, b) => priority(a) - priority(b)
    || a.tier.localeCompare(b.tier)
    || a.category.localeCompare(b.category)
    || Number(b.source === "user") - Number(a.source === "user")
    || (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)
    || a.uuid.localeCompare(b.uuid));

  const omittedLine = (n: number) => `Memory snapshot: ${n} ${n === 1 ? "entry" : "entries"} omitted.\n`;
  const cap = opts?.charCap;
  let body = "";
  let lastTier: MemoryScope | undefined;
  let lastCategory: string | undefined;
  let included = 0;
  for (const record of records) {
    const header = (lastTier === record.tier ? "" : `## ${record.tier}\n`)
      + (lastTier === record.tier && lastCategory === record.category ? "" : `### ${record.category}\n`);
    const line = `- ${record.content}${record.link ? ` [→ ${record.link}]` : ""}\n`;
    // Reserve the largest possible omission notice while unprocessed entries remain.
    // A misfit is skipped, not a reason to abandon smaller entries that follow.
    const reserve = included + 1 < records.length ? omittedLine(records.length).length : 0;
    if (cap !== undefined && body.length + header.length + line.length + reserve > cap) continue;
    body += header + line;
    lastTier = record.tier;
    lastCategory = record.category;
    counts[record.tier].injected++;
    included++;
  }
  const omitted = records.length - included;
  if (omitted) body += omittedLine(omitted);
  return { text: buildMemoryContextBlock(body), counts };
}

export function assembleSnapshot(dbs: { global?: Db; repo?: Db }, opts?: SnapshotOpts): string {
  return assembleSnapshotWithStats(dbs, opts).text;
}
