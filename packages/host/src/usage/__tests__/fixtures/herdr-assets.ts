import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Minimal inert runtimes for tests of the extension and dashboard artifacts. */
export function createFixtureHerdr(checkout: string): void {
  const entries = join(checkout, "dist/herdr");
  mkdirSync(entries, { recursive: true });
  for (const entry of ["cli", "viewer", "viewer-pi", "feed-reader", "remote-runtime", "subagent-supervisor"]) {
    const remote = entry === "remote-runtime", supervisor = entry === "subagent-supervisor";
    writeFileSync(join(entries, `${entry}.mjs`), `// SPIDER_HERDR_RUNTIME_ENTRY=${remote}\n${remote ? "// A runtime request file is required\n" : ""}${supervisor ? "// A subagent supervisor request file is required.\n" : ""}export {};\n`);
  }
  for (const file of ["LICENSE", "NOTICE.md", "licenses/herdr-apache-2.0.txt", "packages/herdr/LICENSE"]) {
    const destination = join(checkout, file);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolve(file), destination);
  }
  cpSync(resolve("packages/herdr/assets"), join(checkout, "packages/herdr/assets"), { recursive: true });
}

export const fixtureHerdrBoundary = "// SPIDER_HERDR_RUNTIME_ENTRY=false\n";
