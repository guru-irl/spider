// packages/db-core/src/testutil.ts
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Scratch DBs live under packages/db-core/.spider/scratch — NEVER /tmp.
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = join(pkgRoot, ".spider", "scratch");

export function scratchDbPath(name: string): string {
  mkdirSync(SCRATCH, { recursive: true });
  return join(SCRATCH, `${name}-${process.pid}-${Date.now()}.db`);
}

export function cleanupScratch(): void {
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
}
