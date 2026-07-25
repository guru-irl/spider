import { openDbAt, type Db } from "@spider/db-core";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Each test gets an isolated scratch directory under packages/subagents/.spider/scratch/<pid>/
// This prevents cross-test pollution now that projectRoot() resolves to the worktree root.
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROC_SCRATCH = join(pkgRoot, ".spider", "scratch", String(process.pid));

export function testScratchPath(name: string): string {
  mkdirSync(PROC_SCRATCH, { recursive: true });
  return join(PROC_SCRATCH, name);
}

export function freshDb(): Db {
  return openDbAt(testScratchPath(`subagents-${randomUUID()}.db`), "project");
}
