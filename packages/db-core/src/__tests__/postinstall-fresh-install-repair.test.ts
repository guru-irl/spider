import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import DatabaseConstructor from "better-sqlite3";
import { openDbAt, registerProject, setGlobalDbPathForTests } from "../registry";
import { GLOBAL_SCHEMA } from "../schema";
import { SCHEMA_VERSION } from "../migrate";

const POISONED_SCHEMA_VERSION = 9;
import { cleanupScratch, scratchDbPath } from "../testutil";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");
const canonicalSchemaPath = join(repoRoot, "packages/db-core/src/schema.ts");
const codeExtensions = new Set([".cjs", ".js", ".mjs", ".sql", ".ts", ".tsx"]);
const ignoredDirectories = new Set([".git", ".spider", "coverage", "dist", "node_modules", "__tests__"]);

function productionCodeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : productionCodeFiles(path);
    }
    if (!codeExtensions.has(extname(entry.name)) || entry.name.includes(".test.")) return [];
    return [path];
  });
}

function postinstallShapedProjectsDdl(): string {
  const canonicalProjects = GLOBAL_SCHEMA.match(
    /CREATE TABLE IF NOT EXISTS projects\s*\([\s\S]*?\n\);/,
  )?.[0];
  if (!canonicalProjects) throw new Error("GLOBAL_SCHEMA projects DDL not found");

  // Reproduce the shipped postinstall shape without introducing a second copied
  // projects schema into the test suite itself.
  return canonicalProjects.replace(/^\s*repo_key\s+TEXT,\s*$/m, "");
}

function tableColumns(dbPath: string): Map<string, string[]> {
  const raw = new DatabaseConstructor(dbPath, { readonly: true });
  try {
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    return new Map(
      tables.map(({ name }) => [
        name,
        (raw.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>)
          .map((column) => column.name)
          .sort(),
      ]),
    );
  } finally {
    raw.close();
  }
}

afterEach(() => {
  setGlobalDbPathForTests(null);
  cleanupScratch();
});

describe("postinstall global schema ownership and repair", () => {
  it("keeps projects CREATE TABLE DDL exclusively in db-core schema.ts", () => {
    const offenders = productionCodeFiles(repoRoot)
      .filter((path) => path !== canonicalSchemaPath)
      .filter((path) => /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?projects\b/i.test(readFileSync(path, "utf8")))
      .map((path) => relative(repoRoot, path));

    expect(
      offenders,
      "projects has one production DDL owner. Remove duplicate CREATE TABLE statements and let db-core migrate it.",
    ).toEqual([]);
  });

  it("repairs the exact version-0 postinstall shape before a real registerProject INSERT", () => {
    const poisonedPath = scratchDbPath("postinstall-v0-poison");
    const raw = new DatabaseConstructor(poisonedPath);
    raw.pragma("journal_mode = WAL");
    raw.exec(postinstallShapedProjectsDdl());
    expect(raw.pragma("user_version", { simple: true })).toBe(0);
    raw.close();

    // Exercise the same first-load path as production. Before the fix this stamps
    // the malformed table current without traversing the v6 ALTER TABLE step.
    const firstLoad = openDbAt(poisonedPath, "global");
    firstLoad.close();

    setGlobalDbPathForTests(poisonedPath);
    expect(() => registerProject({
      projectKey: "/fixture/worktree",
      realPath: "/fixture/worktree",
      gitCommonDir: "/fixture/repo/.git",
      repoKey: "/fixture/repo/.git",
      dbPath: "/fixture/worktree/.spider/project.db",
      name: "fixture",
    })).not.toThrow();

    // Compare against a separate canonical fresh DB so every table and column in
    // GLOBAL_SCHEMA is checked without maintaining another hand-copied list.
    const canonicalPath = scratchDbPath("canonical-global");
    const canonical = openDbAt(canonicalPath, "global");
    canonical.close();
    expect(tableColumns(poisonedPath)).toEqual(tableColumns(canonicalPath));
  });

  it("repairs a poisoned global DB already stamped at the formerly current version", () => {
    const poisonedPath = scratchDbPath("postinstall-v9-poison");
    const raw = new DatabaseConstructor(poisonedPath);
    raw.pragma("journal_mode = WAL");
    raw.exec(postinstallShapedProjectsDdl());
    expect(SCHEMA_VERSION).toBeGreaterThan(POISONED_SCHEMA_VERSION);
    raw.pragma(`user_version = ${POISONED_SCHEMA_VERSION}`);
    raw.close();

    const repaired = openDbAt(poisonedPath, "global");
    const columns = (repaired.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    repaired.close();

    expect(columns).toContain("repo_key");
  });
});
