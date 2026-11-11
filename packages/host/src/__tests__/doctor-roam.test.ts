import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { openDbReadOnlyAt, openGlobal, openProject, openRepo, resolveProject, setGlobalDbPathForTests } from "@spider/db-core";
import { controlDoctor } from "../control";

let root = "";
afterEach(() => {
  setGlobalDbPathForTests(null);
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function project() {
  root = resolve(".spider/scratch", `doctor-roam-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  setGlobalDbPathForTests(join(root, "global.db"));
  return resolveProject(root);
}

it.each(["global", "repo", "worktree"] as const)("doctor reports trigger drift in the %s store", scope => {
  const info = project();
  const open = scope === "global" ? () => openGlobal()
    : scope === "repo" ? () => openRepo(info.repoKey!) : () => openProject(info.projectKey);
  const table = scope === "global" ? "global_memory" : scope === "repo" ? "memory" : "todos";
  const db = open();
  try {
    db.exec(`UPDATE roam_meta SET capture_enabled = 1;
      CREATE TRIGGER roam_unexpected AFTER INSERT ON ${table} BEGIN SELECT 1; END;`);
  } finally { db.close(); }
  const reopened = open();
  try { expect(reopened.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 }); }
  finally { reopened.close(); }
  const report = controlDoctor(root);
  expect(report.ok).toBe(false);
  expect(report.lines.join("\n")).toMatch(new RegExp(`roaming \\(${scope}\\).*trigger`, "i"));
}, 5000);

it("doctor reports a duplicate diagnosis without repairing its index", () => {
  const info = project();
  const db = openProject(info.projectKey);
  try {
    db.exec(`DROP INDEX idx_todos_session_seq;
      INSERT INTO todos (id, session_id, seq, text, created_at) VALUES (17, 's', 1, 'one', 1), (29, 's', 1, 'two', 1);
      UPDATE roam_meta SET roamable = 0, problem = 'Duplicate todo sequence for row IDs 17,29';
      DELETE FROM todos WHERE id = 29;`);
  } finally { db.close(); }
  const report = controlDoctor(root);
  expect(report.ok).toBe(false);
  expect(report.lines.join("\n")).toMatch(/roaming \(worktree\).*17,29/i);
  const after = openDbReadOnlyAt(info.dbPath)!;
  try {
    expect(after.prepare("SELECT roamable, problem FROM roam_meta").get()).toEqual({
      roamable: 0, problem: "Duplicate todo sequence for row IDs 17,29",
    });
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_todos_session_seq'").get()).toBeUndefined();
  } finally { after.close(); }
}, 5000);
