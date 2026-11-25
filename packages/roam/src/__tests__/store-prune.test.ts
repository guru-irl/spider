import { afterEach, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { localEntries, readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { pruneMissingStores } from "../store-prune";
import { listStoreKeys, storeInventoryDiagnostic } from "../store-inventory";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function fixture() { const f = createReplica("global", "00000000-0000-4000-8000-000000000001"); fixtures.push(f); return f; }

it.each(["project", "repository"] as const)("lists and prunes a deleted %s store folder only after confirmation", kind => {
  const f = fixture(), container = join(f.root, "container"), folder = join(container, kind === "project" ? ".spider" : "spider");
  const file = join(folder, kind === "project" ? "project.db" : "repo.db"), sentinel = join(container, "keep.txt");
  mkdirSync(folder, { recursive: true }); writeFileSync(sentinel, "keep"); rmSync(folder, { recursive: true });
  f.db.prepare("INSERT INTO projects(project_key,real_path,db_path,git_common_dir,created_at,last_seen_at) VALUES ('fixture',?,?,?,1,1)")
    .run(container, kind === "project" ? file : f.db.raw.name, kind === "repository" ? container : null);
  const problems: Array<{ path: string; error: unknown }> = [];
  listStoreKeys(f.db, { onProblem: (path, error) => problems.push({ path, error }) });
  const problem = problems.find(item => item.path === file);
  expect(problem).toBeDefined();
  expect(storeInventoryDiagnostic(file, problem?.error)).toMatchObject({
    reason: expect.stringContaining(`store-missing:${kind === "project" ? "worktree" : "repo"}:enoent:`),
    repairCommand: expect.stringContaining("spider roam stores prune"),
  });
  const entry = { key: `${kind}:fixture`, path: file };
  expect(pruneMissingStores(f.db)).toMatchObject({ candidates: [entry], unavailable: [], removed: [] });
  expect(f.db.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "fixture" }]);
  expect(localEntries(f.db, "store-prune")).toEqual([]);
  expect(pruneMissingStores(f.db, true)).toMatchObject({ candidates: [entry], unavailable: [], removed: [entry] });
  expect(existsSync(sentinel)).toBe(true);
  expect(existsSync(folder)).toBe(false);
  expect(localEntries<{ removed: unknown[] }>(f.db, "store-prune")[0].value.removed).toEqual([
    expect.objectContaining({ ...entry, table: "projects", row: expect.objectContaining({ project_key: "fixture" }) }),
  ]);
  if (kind === "project") expect(f.db.prepare("SELECT project_key FROM projects").all()).toEqual([]);
  else expect(f.db.prepare("SELECT git_common_dir FROM projects").get()).toEqual({ git_common_dir: null });
});

it.each(["missing-container", "symlink-folder", "dangling-folder", "symlink-container", "symlink-ancestor"] as const)("keeps a project with an unsafe %s", mode => {
  const f = fixture(), real = join(f.root, "real"), alias = join(f.root, "alias");
  const container = mode === "symlink-ancestor" ? join(alias, "container") : join(f.root, "container");
  mkdirSync(real);
  if (mode === "symlink-container") symlinkSync(real, container);
  else if (mode === "symlink-ancestor") { mkdirSync(join(real, "container")); symlinkSync(real, alias); }
  else if (mode !== "missing-container") mkdirSync(container);
  if (mode === "symlink-folder") symlinkSync(real, join(container, ".spider"));
  if (mode === "dangling-folder") symlinkSync(join(f.root, "absent"), join(container, ".spider"));
  const file = join(container, ".spider", "project.db");
  f.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('keep',?,?,1,1)").run(container, file);
  expect(pruneMissingStores(f.db, true)).toMatchObject({ candidates: [], removed: [], unavailable: [
    expect.objectContaining({ path: file, check: "path-unavailable", repair: expect.stringMatching(/mount or restore/i) }),
  ] });
  expect(f.db.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "keep" }]);
  expect(localEntries(f.db, "store-prune")).toEqual([]);
});

it.each(["store-folder", "containing-folder"] as const)("keeps a project when its %s is a file", mode => {
  const f = fixture(), container = join(f.root, "container"), folder = join(container, ".spider");
  if (mode === "store-folder") { mkdirSync(container); writeFileSync(folder, "not a directory"); }
  else writeFileSync(container, "not a directory");
  const file = join(folder, "project.db");
  f.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('keep',?,?,1,1)").run(container, file);
  expect(pruneMissingStores(f.db, true)).toMatchObject({ candidates: [], removed: [], unavailable: [
    expect.objectContaining({ path: file, check: "path-unavailable" }),
  ] });
  expect(f.db.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "keep" }]);
  expect(localEntries(f.db, "store-prune")).toEqual([]);
});

it.each([0, 0o111])("reports an inspect error for a containing folder with mode %i", mode => {
  const f = fixture(), container = join(f.root, "denied"), file = join(container, ".spider", "project.db");
  mkdirSync(container);
  f.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('keep',?,?,1,1)").run(container, file);
  chmodSync(container, mode);
  try { expect(() => pruneMissingStores(f.db, true)).toThrow(expect.objectContaining({ path: file, check: "eacces" })); }
  finally { chmodSync(container, 0o700); }
  expect(f.db.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "keep" }]);
  expect(localEntries(f.db, "store-prune")).toEqual([]);
});
it("prunes missing mapped directories and their redirects, retaining planned empty directories", () => {
  const f = fixture(), planned = join(f.root, "planned"); mkdirSync(planned);
  f.db.prepare("INSERT INTO roam_repo_maps(repo_key,path) VALUES ('gone',?)").run(join(f.root, "deleted"));
  f.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('gone','deleted',?),('gone','planned',?)").run(join(f.root, "deleted-worktree"), planned);
  writeLocal(f.db, "mapping-redirect", "repo:gone", join(f.root, "deleted", "repo.db"));
  writeLocal(f.db, "mapping-redirect", "worktree:gone:deleted", join(f.root, "deleted-worktree", "project.db"));
  expect(pruneMissingStores(f.db, true).removed).toHaveLength(2);
  expect(f.db.prepare("SELECT * FROM roam_repo_maps").all()).toEqual([]);
  expect(f.db.prepare("SELECT workspace_id FROM roam_workspace_maps").all()).toEqual([{ workspace_id: "planned" }]);
  expect(readLocal(f.db, "mapping-redirect", "repo:gone")).toBeUndefined();
  expect(readLocal(f.db, "mapping-redirect", "worktree:gone:deleted")).toBeUndefined();
  expect(localEntries(f.db, "store-prune")).toHaveLength(1);
  expect(pruneMissingStores(f.db, true).removed).toEqual([]);
  expect(localEntries(f.db, "store-prune")).toHaveLength(1);
});
it("rolls back earlier deletions and the audit if any registered path is inaccessible", () => {
  const f = fixture(), denied = join(f.root, "denied"); mkdirSync(denied); mkdirSync(join(f.root, "gone"));
  f.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('gone',?,?,1,1),('denied',?,?,1,1)")
    .run(join(f.root, "gone"), join(f.root, "gone", "project.db"), denied, join(denied, "project.db"));
  chmodSync(denied, 0);
  try { expect(() => pruneMissingStores(f.db, true)).toThrow(); } finally { chmodSync(denied, 0o700); }
  expect(f.db.prepare("SELECT project_key FROM projects ORDER BY project_key").all()).toEqual([{ project_key: "denied" }, { project_key: "gone" }]);
  expect(localEntries(f.db, "store-prune")).toEqual([]);
});
it("does not mistake a dangling final symlink for an absent registration", () => {
  const f = fixture(), file = join(f.root, "linked.db"); symlinkSync(join(f.root, "gone.db"), file);
  f.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('linked',?,?,1,1)").run(f.root, file);
  expect(pruneMissingStores(f.db, true).removed).toEqual([]);
  expect(f.db.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "linked" }]);
});

it.each(["missing-parent", "broken-parent"])("does not prune an unavailable %s", mode => {
  const f = fixture(), parent = join(f.root, "unavailable"), file = join(parent, "project.db");
  if (mode === "broken-parent") symlinkSync(join(f.root, "unmounted"), parent);
  f.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('keep',?,?,1,1)").run(parent, file);
  const result = pruneMissingStores(f.db, true);
  expect(result).toMatchObject({ candidates: [], removed: [], unavailable: [expect.objectContaining({ path: file, repair: expect.stringMatching(/mount or restore/i) })] });
  expect(f.db.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "keep" }]);
  expect(localEntries(f.db, "store-prune")).toEqual([]);
});
it("lists a dry run and preserves full rows and redirects when confirmed", () => {
  const f = fixture(), path = join(f.root, "deleted");
  f.db.prepare("INSERT INTO roam_repo_maps(repo_key,path,origin_fingerprint,root_fingerprint,worktree_command_json) VALUES ('gone',?,'origin-digest','root-digest','[]')").run(path);
  f.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path,snapshot_json) VALUES ('gone','deleted',?,?)").run(join(f.root, "deleted-worktree"), JSON.stringify({ branch: "fixture" }));
  const rows = { repo: f.db.prepare("SELECT * FROM roam_repo_maps").get(), workspace: f.db.prepare("SELECT * FROM roam_workspace_maps").get() };
  writeLocal(f.db, "mapping-redirect", "repo:gone", join(path, "repo.db"));
  expect(pruneMissingStores(f.db)).toMatchObject({ candidates: [expect.objectContaining({ key: "repo:gone", path }), expect.objectContaining({ key: "worktree:gone:deleted" })], removed: [] });
  expect(f.db.prepare("SELECT * FROM roam_repo_maps").get()).toEqual(rows.repo);
  expect(localEntries(f.db, "store-prune")).toEqual([]);
  expect(pruneMissingStores(f.db, true).removed).toHaveLength(2);
  const audit = localEntries<{ removed: unknown[] }>(f.db, "store-prune");
  expect(audit).toHaveLength(1);
  expect(audit[0].value.removed).toEqual(expect.arrayContaining([
    expect.objectContaining({ table: "roam_repo_maps", row: rows.repo, redirect: join(path, "repo.db") }),
    expect.objectContaining({ table: "roam_workspace_maps", row: rows.workspace }),
  ]));
  expect(pruneMissingStores(f.db, true).removed).toEqual([]);
  expect(localEntries(f.db, "store-prune")).toEqual(audit);
});

it.each(["home", "action"])("keeps a missing workspace required by a live %s", mode => {
  const f = fixture(), path = join(f.root, "deleted-workspace");
  f.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','active',?)").run(path);
  f.db.prepare("INSERT INTO roam_locations(session_id,stores_json) VALUES ('session-active',?)").run(JSON.stringify(["worktree:fixture-repo:active"]));
  if (mode === "home") f.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at) VALUES ('session-active','00000000-0000-4000-8000-000000000001',1,1)").run();
  else f.db.prepare("INSERT INTO roam_home_actions(move_id,session_id,expected_epoch,args_digest) VALUES ('move-active','session-active',1,'fixture-digest')").run();
  expect(pruneMissingStores(f.db, true)).toMatchObject({ candidates: [], removed: [], unavailable: [expect.objectContaining({ check: "session-in-use", path })] });
  expect(f.db.prepare("SELECT path FROM roam_workspace_maps").all()).toEqual([{ path }]);
  expect(localEntries(f.db, "store-prune")).toEqual([]);
});
