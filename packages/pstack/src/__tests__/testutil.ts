// Test utility for isolated scratch directories.
// Each process gets its own subdir under packages/pstack/.spider/scratch/<pid>/.

import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const pkgRoot: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROC_SCRATCH = join(pkgRoot, ".spider", "scratch", String(process.pid));

export function testScratchPath(name: string): string {
  mkdirSync(PROC_SCRATCH, { recursive: true });
  return join(PROC_SCRATCH, name);
}
