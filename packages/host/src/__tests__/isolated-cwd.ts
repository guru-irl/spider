import { beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/** Non-git fixture: stop git walking up to the real checkout. */
export function isolatedCwd(name: string): string {
  const dir = resolve(".spider", "scratch", `host-${name}-${process.pid}`);
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  beforeAll(() => {
    mkdirSync(dir, { recursive: true });
    process.env.GIT_CEILING_DIRECTORIES = join(dir, "..");
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
