import type { Db } from "@spider/db-core";
import type { MemoryCategory, MemoryRecord, MemoryScope } from "./types";
import { listActive } from "./store";
import { buildMemoryContextBlock } from "./scrubber";

export interface SnapshotOpts {
  charCap?: number;
  scopes?: MemoryScope[];
}

const DEFAULT_CHAR_CAP = 8000;
const DEFAULT_SCOPES: MemoryScope[] = ["global", "project"];

/** Assemble a frozen, char-capped memory snapshot from the DB (active records only). */
export function assembleSnapshot(dbs: { global?: Db; project?: Db }, opts?: SnapshotOpts): string {
  const charCap = opts?.charCap ?? DEFAULT_CHAR_CAP;
  const scopes = opts?.scopes ?? DEFAULT_SCOPES;

  const records: MemoryRecord[] = [];
  for (const scope of scopes) {
    const db = dbs[scope];
    if (!db) continue;
    records.push(...listActive(db, scope));
  }

  if (records.length === 0) {
    return "";
  }

  records.sort((a, b) => {
    const aUser = a.source === "user" ? 0 : 1;
    const bUser = b.source === "user" ? 0 : 1;
    if (aUser !== bUser) return aUser - bUser;
    const aTime = a.updatedAt ?? a.createdAt;
    const bTime = b.updatedAt ?? b.createdAt;
    return bTime - aTime;
  });

  const categoryOrder: MemoryCategory[] = [];
  const byCategory = new Map<MemoryCategory, MemoryRecord[]>();
  for (const record of records) {
    if (!byCategory.has(record.category)) {
      byCategory.set(record.category, []);
      categoryOrder.push(record.category);
    }
    byCategory.get(record.category)!.push(record);
  }

  let body = "";
  outer: for (const category of categoryOrder) {
    const header = `## ${category}\n`;
    if (body.length + header.length > charCap) {
      break;
    }
    body += header;
    for (const record of byCategory.get(category)!) {
      const line = `- ${record.content}${record.link ? ` [→ ${record.link}]` : ""}\n`;
      if (body.length + line.length > charCap) {
        break outer;
      }
      body += line;
    }
  }

  if (body.length > charCap) {
    body = body.slice(0, charCap);
  }

  if (!body.trim()) {
    return "";
  }

  return buildMemoryContextBlock(body);
}
