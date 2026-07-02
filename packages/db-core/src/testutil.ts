// packages/db-core/src/testutil.ts
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Scratch DBs live under packages/db-core/.spider/scratch — NEVER /tmp.
// Each process (vitest runs test files in parallel forks) gets its OWN subdir so
// one fork's cleanupScratch() cannot delete another fork's live DB (disk I/O error).
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = join(pkgRoot, ".spider", "scratch");
const PROC_SCRATCH = join(SCRATCH, String(process.pid));

export function scratchDbPath(name: string): string {
  mkdirSync(PROC_SCRATCH, { recursive: true });
  return join(PROC_SCRATCH, `${name}-${Date.now()}.db`);
}

export function cleanupScratch(): void {
  // Only remove THIS process's scratch subdir — never the shared root.
  try { rmSync(PROC_SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
}
