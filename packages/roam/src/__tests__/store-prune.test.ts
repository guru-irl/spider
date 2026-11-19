import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { localEntries, readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { pruneMissingStores } from "../store-prune";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function fixture() { const f = createReplica("global", "00000000-0000-4000-8000-000000000001"); fixtures.push(f); return f; }
it("prunes missing mapped directories and their redirects, retaining planned empty directories", () => {
  const f = fixture(), planned = join(f.root, "planned"); mkdirSync(planned);
  f.db.prepare("INSERT INTO roam_repo_maps(repo_key,path) VALUES ('gone',?)").run(join(f.root, "deleted"));
  f.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('gone','deleted',?),('gone','planned',?)").run(join(f.root, "deleted-worktree"), planned);
  writeLocal(f.db, "mapping-redirect", "repo:gone", join(f.root, "deleted", "repo.db"));
  writeLocal(f.db, "mapping-redirect", "worktree:gone:deleted", join(f.root, "deleted-worktree", "project.db"));
  expect(pruneMissingStores(f.db)).toBe(2);
  expect(f.db.prepare("SELECT * FROM roam_repo_maps").all()).toEqual([]);
  expect(f.db.prepare("SELECT workspace_id FROM roam_workspace_maps").all()).toEqual([{ workspace_id: "planned" }]);
  expect(readLocal(f.db, "mapping-redirect", "repo:gone")).toBeUndefined();
  expect(readLocal(f.db, "mapping-redirect", "worktree:gone:deleted")).toBeUndefined();
  expect(localEntries(f.db, "store-prune")).toHaveLength(1);
  expect(pruneMissingStores(f.db)).toBe(0);
  expect(localEntries(f.db, "store-prune")).toHaveLength(1);
});
it("rolls back earlier deletions and the audit if any registered path is inaccessible", () => {
  const f = fixture(), denied = join(f.root, "denied"); mkdirSync(denied);
  f.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('gone',?,?,1,1),('denied',?,?,1,1)")
    .run(join(f.root, "gone"), join(f.root, "gone", "project.db"), denied, join(denied, "project.db"));
  chmodSync(denied, 0);
  try { expect(() => pruneMissingStores(f.db)).toThrow(); } finally { chmodSync(denied, 0o700); }
  expect(f.db.prepare("SELECT project_key FROM projects ORDER BY project_key").all()).toEqual([{ project_key: "denied" }, { project_key: "gone" }]);
  expect(localEntries(f.db, "store-prune")).toEqual([]);
});
it("does not mistake a dangling final symlink for an absent registration", () => {
  const f = fixture(), file = join(f.root, "linked.db"); symlinkSync(join(f.root, "gone.db"), file);
  f.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('linked',?,?,1,1)").run(f.root, file);
  expect(pruneMissingStores(f.db)).toBe(0);
  expect(f.db.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "linked" }]);
});
