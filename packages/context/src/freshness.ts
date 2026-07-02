import { createHash } from "node:crypto";
import { openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { ContentStore } from "./content-store.js";

export function refreshStaleContent(store: ContentStore, opts?: { maxSources?: number }): number {
  const stale = store.listStaleSources();
  let refreshed = 0;
  for (const s of stale.slice(0, opts?.maxSources ?? 50)) {
    try {
      const fd = openSync(s.path, "r");
      let text: string;
      try {
        if (!fstatSync(fd).isFile()) continue;
        text = readFileSync(fd, "utf-8");
      } finally {
        closeSync(fd);
      }
      const h = createHash("sha256").update(text).digest("hex");
      if (h !== s.hash) {
        store.indexContent({ content: text, path: s.path, source: s.source });
        refreshed++;
      }
    } catch {
      /* file gone/unreadable → leave stale chunks, skip */
    }
  }
  return refreshed;
}
