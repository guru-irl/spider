import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function baselineSkillsDir(): string {
  // src/ → package root → skills/
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

export function projectSkillsDir(cwd: string): string {
  return path.join(cwd, ".spider", "skills");
}

export function contributeSkillPaths(cwd: string): string[] {
  const out = [baselineSkillsDir()];
  const proj = projectSkillsDir(cwd);
  try {
    if (fs.statSync(proj).isDirectory()) out.push(proj);
  } catch { /* no project tier */ }
  return out;
}
