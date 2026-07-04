import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the packaged baseline skills dir. Resolves correctly from BOTH
 * layouts: dev/test (`src/skills-dir.ts` → `../skills`) and the shipped esbuild
 * bundle (`dist/extension.js` → `../packages/superpowers/skills`). We probe for
 * `using-superpowers/SKILL.md` to pick the real one; falls back to the dev path.
 */
export function baselineSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "skills"), // dev: packages/superpowers/src → package root
    path.resolve(here, "..", "packages", "superpowers", "skills"), // bundle: <root>/dist → <root>
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(path.join(c, "using-superpowers", "SKILL.md")).isFile()) return c;
    } catch {
      /* try next candidate */
    }
  }
  return candidates[0];
}

export function projectSkillsDir(cwd: string): string {
  return path.join(cwd, ".spider", "skills");
}

export function contributeSkillPaths(cwd: string): string[] {
  const out: string[] = [];
  // Only contribute a tier that actually exists on disk (avoids emitting a bad
  // baseline path from an unexpected bundle layout — pi also loads the baseline
  // via the package `pi.skills` manifest entry regardless).
  const baseline = baselineSkillsDir();
  try {
    if (fs.statSync(baseline).isDirectory()) out.push(baseline);
  } catch {
    /* baseline not resolvable here; manifest still provides it */
  }
  const proj = projectSkillsDir(cwd);
  try {
    if (fs.statSync(proj).isDirectory()) out.push(proj);
  } catch {
    /* no project tier */
  }
  return out;
}
