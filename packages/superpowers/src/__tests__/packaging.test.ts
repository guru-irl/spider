import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { testScratchPath } from "./testutil.js";

const root = resolve(import.meta.dirname, "../../../..");
const skillDirs = ["packages/superpowers/skills", "packages/pstack/skills"];
function skillFiles(): string[] {
  return skillDirs.flatMap(dir => readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter(file => file === "SKILL.md" || file.endsWith("/SKILL.md"))
    .map(file => `${dir}/${file}`));
}

describe("npm skill packaging", () => {
  it("advertises both bundled skill directories to pi", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest.pi.skills).toEqual(expect.arrayContaining(skillDirs.map(dir => `./${dir}`)));
  });

  it("packs every SKILL.md in both collections and the pstack license", () => {
    const cache = testScratchPath(`npm-pack-${crypto.randomUUID()}`);
    mkdirSync(cache, { recursive: true });
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`, npm_config_cache: cache, npm_config_update_notifier: "false" },
    });
    const files = JSON.parse(output)[0].files.map((file: { path: string }) => file.path) as string[];
    expect(skillFiles().length).toBeGreaterThanOrEqual(46);
    expect([...skillFiles(), "packages/pstack/LICENSE"].filter(file => !files.includes(file))).toEqual([]);
  });
});

describe("release tarball check", () => {
  const base = ["dist/extension.js", "dist/dashboard/index.html", "dist/dashboard/assets/index-abcdefgh.js", "dist/dashboard/assets/index-abcdefgh.css", "README.md", "LICENSE", "NOTICE.md", "packages/context/LICENSE", "packages/pstack/LICENSE"];
  function check(files: string[]) {
    const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
    const code = workflow.match(/npm pack --json --ignore-scripts \| node -e "([\s\S]*?)"\n/)?.[1];
    if (!code) throw new Error("release tarball verifier not found");
    return spawnSync(process.execPath, ["-e", code], {
      cwd: root, encoding: "utf8", input: JSON.stringify([{ files: files.map(path => ({ path })) }]),
    });
  }
  it("accepts extension/dashboard artifacts plus every bundled skill", () => {
    const result = check([...base, ...skillFiles()]);
    expect(result.status, result.stderr).toBe(0);
  });
  it.each(["packages/superpowers/skills/using-superpowers/SKILL.md", "packages/pstack/skills/how/SKILL.md", "packages/pstack/LICENSE", "NOTICE.md", "packages/context/LICENSE", "dist/extension.js", "dist/dashboard/assets/index-abcdefgh.css"])("rejects a tarball missing %s", missing => {
    const result = check([...base, ...skillFiles()].filter(file => file !== missing));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(missing.endsWith(".css") ? "dashboard JS/CSS missing" : missing);
  });
  it.each(["dist/dashboard/assets/index-abcdefgh.js.map", "dist/dashboard/states.html"])("still rejects development artifact %s", extra => {
    const result = check([...base, ...skillFiles(), extra]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("development dashboard files");
  });
});
