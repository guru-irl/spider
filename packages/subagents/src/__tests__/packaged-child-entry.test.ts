import { afterAll, beforeAll, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildViteFixture as build } from "../../../../scripts/test-bundle.js";
import type { buildChildSpawnSpec as buildChildSpawnSpecType } from "../pi-args";

let root: string;
let buildChildSpawnSpec: typeof buildChildSpawnSpecType;

beforeAll(async () => {
  const scratch = join(process.env.SPIDER_TEST_FIXTURE_CHECKOUT!, ".spider", "scratch");
  mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "child-package-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(process.cwd(), "scripts", "package-extension.ts"), join(root, "scripts", "package-extension.ts"));
  await build({ root: process.cwd(), configFile: join(process.cwd(), "vite.config.mjs"), logLevel: "silent",
    build: { ssr: join(process.cwd(), "packages/subagents/src/pi-args.ts"), outDir: join(root, "dist") } });
  ({ buildChildSpawnSpec } = await import(/* @vite-ignore */ pathToFileURL(join(root, "dist", "extension.js")).href));
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it.each([
  ["rpc", "fresh"], ["rpc", "fork"], ["print", "fresh"], ["print", "fork"],
] as const)("launches a %s %s child through the package entry", (childMode, context) => {
  const spec = buildChildSpawnSpec({ runId: "r1", sessionId: "s1", agent: "worker", task: "test", context,
    parentSessionId: "s1", parentSessionFile: join(root, "parent.jsonl"), childIndex: 0, dbPath: "", scratchRoot: root, childMode });
  const index = spec.argv.indexOf("--extension");
  expect(index).toBeGreaterThan(-1);
  expect(spec.argv[index + 1]).toBe(join(root, "scripts", "package-extension.ts"));
});
