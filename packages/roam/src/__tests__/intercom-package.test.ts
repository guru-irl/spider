import { paths } from "@spider/db-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildRoamEntries } from "../../../../scripts/build-roam.mjs";
import { assertRoamBundle } from "../../../../scripts/check-roam-bundle.mjs";

let root: string, helper: string, original: string;
beforeAll(async () => {
  root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "ip-"));
  await buildRoamEntries(join(root, "dist/roam"));
  helper = join(root, "dist/roam/intercom-helper.mjs"); original = readFileSync(helper, "utf8");
}, 5000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); }, 5000);
const strict = () => (assertRoamBundle as (root: string, options: { requireHelper: boolean }) => void)(root, { requireHelper: true });
it("the actual helper and dispatcher are present, separate, and free of private heavyweight paths", () => {
  expect(strict).not.toThrow();
  expect(original).not.toMatch(/better-sqlite3|sqlite-vec|node:sqlite|@earendil-works\/pi-|transcript|terminal/i);
  const dispatcher = readFileSync(join(root, "dist/roam/cli.mjs"), "utf8");
  expect(dispatcher).toContain('import("./intercom-helper.mjs")');
  expect(dispatcher).toContain('import("./cli-main.mjs")');
  expect(dispatcher).not.toMatch(/better-sqlite3|sqlite-vec/i);
}, 5000);
it("strict package validation refuses a missing helper", () => {
  rmSync(helper);
  try { expect(strict).toThrow(/roaming|helper/i); } finally { writeFileSync(helper, original, { mode: 0o700 }); }
}, 5000);
it.each([
  ['native SQLite', 'import Database from "better-sqlite3";'],
  ['transcript access', 'const transcript = "fixture";'],
  ['terminal attach', 'const terminal = "fixture";'],
  ['external package', 'import x from "untrusted-external";'],
])("strict package validation refuses %s in the helper", (_name, injected) => {
  writeFileSync(helper, `${original}\n${injected}\n`);
  try { expect(strict).toThrow(/helper/i); } finally { writeFileSync(helper, original, { mode: 0o700 }); }
}, 5000);


it("the release file-list gate rejects either missing helper entry", () => {
  const skills = ["packages/superpowers/skills", "packages/pstack/skills", "packages/intercom/skills"].flatMap(dir =>
    readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(file => file === "SKILL.md" || file.endsWith("/SKILL.md")).map(file => `${dir}/${file}`));
  const files = ["dist/extension.js", "dist/intercom/broker.mjs", "dist/dashboard/index.html", "dist/dashboard/assets/app-aaaaaaaa.js", "dist/dashboard/assets/app-aaaaaaaa.css",
    "README.md", "LICENSE", "NOTICE.md", "packages/context/LICENSE", "packages/pstack/LICENSE", "packages/intercom/LICENSE", "packages/intercom/ORIGIN.md", ...skills,
    "dist/roam/cli.mjs", "dist/roam/cli-main.mjs", "dist/roam/intercom-helper.mjs", "dist/roam/supervisor.mjs", "scripts/link.mjs", "scripts/dev-link.mjs",
    "scripts/intercom-switchover.mjs", "scripts/link-roam.mjs", "scripts/extension-shim.mjs", "scripts/pi-agent-dir.mjs"];
  for (const missing of ["dist/roam/cli-main.mjs", "dist/roam/intercom-helper.mjs"]) {
    const result = spawnSync(process.execPath, ["scripts/check-package-files.cjs"], { input: JSON.stringify([{ files: files.filter(file => file !== missing).map(path => ({ path })) }]), encoding: "utf8", timeout: 2000 });
    expect(result.status).toBe(1); expect(result.stderr).toContain(missing);
  }
}, 5000);
