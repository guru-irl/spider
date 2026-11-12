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
  const storeKey = scope === "global" ? "global" : scope === "repo" ? "repo:fixture" : "worktree:fixture:workspace";
  let originalTrigger: unknown;
  try {
    db.prepare("UPDATE roam_meta SET store_key = ?, capture_enabled = 1").run(storeKey);
    db.exec(`CREATE TRIGGER roam_unexpected AFTER INSERT ON ${table} BEGIN SELECT 1; END;`);
    originalTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'roam_unexpected'").get();
  } finally { db.close(); }
  const reopened = open();
  try {
    expect(reopened.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
    expect(reopened.prepare("SELECT sql FROM sqlite_master WHERE name = 'roam_unexpected'").get()).toEqual(originalTrigger);
    expect(() => reopened.exec(scope === "worktree"
      ? "INSERT INTO todos(session_id, seq, text, created_at) VALUES ('ordinary', 1, 'usable', 1)"
      : `INSERT INTO ${table}(uuid, category, content, created_at) VALUES ('ordinary', 'insight', 'usable', 1)`)).not.toThrow();
    expect(reopened.prepare("SELECT * FROM roam_changes").all()).toEqual([]);
  } finally { reopened.close(); }
  const report = controlDoctor(root);
  expect(report.ok).toBe(false);
  expect(report.lines.join("\n")).toMatch(new RegExp(`roaming \\(${scope}\\).*trigger`, "i"));
  expect(report.lines.join("\n")).toContain("roam_unexpected");
}, 5000);

it.each(["roam_unexpected", "foreign_guard"])("doctor reports a raising unexpected trigger %s without changing it", name => {
  const info = project();
  const db = openProject(info.projectKey);
  let originalTrigger: unknown;
  try {
    db.prepare("UPDATE roam_meta SET store_key = ?, capture_enabled = 1").run("worktree:fixture:workspace");
    db.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON todos BEGIN SELECT RAISE(ABORT, 'foreign trigger refused'); END`);
    originalTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name);
  } finally { db.close(); }
  const reopened = openProject(info.projectKey);
  try {
    expect(reopened.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
    expect(reopened.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name)).toEqual(originalTrigger);
    expect(() => reopened.exec("INSERT INTO todos(session_id, seq, text, created_at) VALUES ('ordinary', 1, 'blocked', 1)")).toThrow("foreign trigger refused");
  } finally { reopened.close(); }
  const report = controlDoctor(root);
  expect(report.ok).toBe(false);
  expect(report.lines.join("\n")).toContain(name);
}, 5000);

it("doctor reports new trigger drift after capture is already disabled", () => {
  const info = project();
  const db = openProject(info.projectKey);
  try {
    db.prepare("UPDATE roam_meta SET store_key = ?, capture_enabled = 1").run("worktree:fixture:workspace");
    db.exec("CREATE TRIGGER roam_first AFTER INSERT ON todos BEGIN SELECT 1; END");
  } finally { db.close(); }
  const first = openProject(info.projectKey);
  try {
    expect(first.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
    first.exec("CREATE TRIGGER roam_second AFTER INSERT ON todos BEGIN SELECT 1; END");
  } finally { first.close(); }
  const second = openProject(info.projectKey);
  try {
    expect(second.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
    expect(second.prepare("SELECT name FROM sqlite_master WHERE name IN ('roam_first', 'roam_second') ORDER BY name").all())
      .toEqual([{ name: "roam_first" }, { name: "roam_second" }]);
  } finally { second.close(); }
  const report = controlDoctor(root);
  expect(report.ok).toBe(false);
  expect(report.lines.join("\n")).toContain("roam_first");
  expect(report.lines.join("\n")).toContain("roam_second");
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
  expect(report.ok).toBe(true);
  expect(report.lines.filter(line => line.includes("roaming (worktree)"))).toEqual([
    "- roaming (worktree): disabled; Duplicate todo sequence for row IDs 17,29",
  ]);
  const after = openDbReadOnlyAt(info.dbPath)!;
  try {
    expect(after.prepare("SELECT roamable, problem FROM roam_meta").get()).toEqual({
      roamable: 0, problem: "Duplicate todo sequence for row IDs 17,29",
    });
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_todos_session_seq'").get()).toBeUndefined();
  } finally { after.close(); }
}, 5000);

it("doctor fails if roaming capture is enabled despite a missing store key", () => {
  const info = project();
  const db = openProject(info.projectKey);
  try { db.exec("UPDATE roam_meta SET store_key=NULL, capture_enabled=1, roamable=0, problem='Corrupt roaming metadata'"); }
  finally { db.close(); }
  const report = controlDoctor(root);
  expect(report.ok).toBe(false);
  expect(report.lines).toContain("- roaming (worktree): Corrupt roaming metadata");
}, 5000);

it("doctor fails for a configured roaming store with the same duplicate diagnosis", () => {
  const info = project();
  const db = openProject(info.projectKey);
  try {
    db.prepare("UPDATE roam_meta SET store_key=?, capture_enabled=0, roamable=0, problem=? WHERE id=1")
      .run("worktree:fixture:workspace", "Duplicate todo sequence for row IDs 17,29");
  } finally { db.close(); }
  const report = controlDoctor(root);
  expect(report.ok).toBe(false);
  expect(report.lines.filter(line => line.includes("roaming (worktree)"))).toEqual([
    "- roaming (worktree): Duplicate todo sequence for row IDs 17,29",
  ]);
}, 5000);
