import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import { openDbAt, openRoamStoreReadOnly } from "../registry";
import { repoRoot } from "../paths";
import { catalogReplica, replicaPath, resolveSessionReplica } from "../roam/catalog";
import { mappingRedirect } from "../roam/reads";
import { applyBatch } from "../roam/apply";
import { validateBatch } from "../roam/codec";
import { createReplicaEffects } from "../roam/effects";
import { createExportPolicy } from "../roam/event-policy";
import { exportBatch } from "../roam/export";
import { seedSession } from "../roam/seed";
import { cancelMapping, discoverRepository, mapRepository, mapWorkspace, resolveRepositoryKey, resolveWorkspace, resumePendingMappings } from "../roam/repo-map";
import { localEntries, readLocal, writeLocal } from "../roam/local-state";

const local = "11111111-1111-4111-8111-111111111111";
const remote = "22222222-2222-4222-8222-222222222222";
const key = "worktree:fixture-repo:fixture-workspace" as const;
const fixtures: ReturnType<typeof createReplica>[] = [];

function gitFixture(root: string, name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const git = (args: string[], input?: string) => execFileSync("git", args, { cwd: dir, env, input, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  const tree = git(["mktree"], "");
  const rootCommit = (ref: string) => {
    const commit = git(["commit-tree", tree], `${ref}\n`);
    git(["update-ref", `refs/heads/${ref}`, commit]);
    return commit;
  };
  return { dir, git, rootCommit };
}

it("fallback roots cache until explicit refresh", async () => {
  const global = createReplica("global", local); fixtures.push(global);
  const repo = gitFixture(global.root, "roots");
  const first = repo.rootCommit("first");
  let walks = 0;
  const readRoots = () => { walks++; return repo.git(["rev-list", "--max-parents=0", "--all"]).split(/\r?\n/); };
  const keyBefore = resolveRepositoryKey(global.db, repo.dir, { readRoots });
  expect(resolveRepositoryKey(global.db, repo.dir, { readRoots })).toBe(keyBefore);
  const second = repo.rootCommit("second");
  expect(resolveRepositoryKey(global.db, repo.dir, { readRoots })).toBe(keyBefore);
  expect(walks).toBe(1);
  await mapRepository(global.db, { repoKey: keyBefore, path: repo.dir });
  const expected = `root:${createHash("sha256").update([first, second].sort().join("\n")).digest("hex")}`;
  expect(global.db.prepare("SELECT root_fingerprint FROM roam_repo_maps WHERE repo_key = ?").get(keyBefore)).toEqual({ root_fingerprint: expected });
  expect(resolveRepositoryKey(global.db, repo.dir, { readRoots })).toBe(keyBefore);
}, 5000);

it("fallback roots cache survives restart until explicit refresh", async () => {
  const global = createReplica("global", local); fixtures.push(global);
  const repo = gitFixture(global.root, "persistent-roots"); repo.rootCommit("first");
  let walks = 0;
  const readRoots = () => { walks++; return repo.git(["rev-list", "--max-parents=0", "--all"]).split(/\r?\n/); };
  const keyBefore = resolveRepositoryKey(global.db, repo.dir, { readRoots });
  repo.rootCommit("second");
  vi.resetModules();
  const restarted = await import("../roam/repo-map");
  expect(restarted.resolveRepositoryKey(global.db, repo.dir, { readRoots })).toBe(keyBefore);
  expect(walks).toBe(1);
}, 5000);

it("mapping uses existing schema 14 without adding tables", async () => {
  const global = createReplica("global", local); fixtures.push(global);
  const workspace = join(global.root, "schema-workspace"); mkdirSync(workspace);
  const tables = () => global.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  const before = tables();
  await mapWorkspace(global.db, { repoKey: "fixture-repo", workspaceId: "fixture-workspace", path: workspace });
  expect(tables()).toEqual(before);
}, 5000);

it("origin change requires explicit map", async () => {
  const global = createReplica("global", local); fixtures.push(global);
  const repo = gitFixture(global.root, "origin"); repo.rootCommit("first");
  repo.git(["config", "remote.origin.url", "https://example.invalid/team/one.git"]);
  const keyBefore = resolveRepositoryKey(global.db, repo.dir);
  repo.git(["config", "remote.origin.url", "https://example.invalid/team/two.git"]);
  expect(() => resolveRepositoryKey(global.db, repo.dir)).toThrow(/explicit map/i);
  await mapRepository(global.db, { repoKey: keyBefore, path: repo.dir });
  expect(resolveRepositoryKey(global.db, repo.dir)).toBe(keyBefore);
}, 5000);

it("repository replacement requires explicit map", async () => {
  const global = createReplica("global", local); fixtures.push(global);
  const repo = gitFixture(global.root, "replacement"); repo.rootCommit("first");
  const keyBefore = resolveRepositoryKey(global.db, repo.dir);
  await mapRepository(global.db, { repoKey: keyBefore, path: repo.dir });
  renameSync(join(repo.dir, ".git"), join(repo.dir, "old-git"));
  repo.git(["init", "-q"]);
  expect(() => resolveRepositoryKey(global.db, repo.dir)).toThrow(/explicit map/i);
  await mapRepository(global.db, { repoKey: keyBefore, path: repo.dir });
  expect(resolveRepositoryKey(global.db, repo.dir)).toBe(keyBefore);
}, 5000);

it("ambiguous discovery refuses transfer", () => {
  const global = createReplica("global", local); fixtures.push(global);
  const a = gitFixture(global.root, "one"), b = gitFixture(global.root, "two");
  for (const repo of [a, b]) { repo.rootCommit("first"); repo.git(["config", "remote.origin.url", "https://example.invalid/team/repo.git"]); }
  const key = resolveRepositoryKey(global.db, a.dir);
  expect(() => discoverRepository(global.db, key, [global.root])).toThrow(/ambiguous/i);
  expect(global.db.prepare("SELECT count(*) AS n FROM roam_repo_maps").get()).toEqual({ n: 0 });
}, 5000);

it("discovery ignores unborn repositories without an automatic key", () => {
  const global = createReplica("global", local); fixtures.push(global);
  const repo = gitFixture(global.root, "identified"); repo.rootCommit("first");
  repo.git(["config", "remote.origin.url", "https://example.invalid/team/repo.git"]);
  gitFixture(global.root, "unborn");
  const key = resolveRepositoryKey(global.db, repo.dir);
  expect(discoverRepository(global.db, key, [global.root])).toBe(repo.dir);
}, 5000);

it("linked worktrees retain distinct workspace IDs and share repo memory", async () => {
  const global = createReplica("global", local); fixtures.push(global);
  const repo = gitFixture(global.root, "main-tree");
  const commit = repo.rootCommit("first");
  const linked = join(global.root, "linked-tree");
  repo.git(["worktree", "add", "--quiet", "--detach", linked, commit]);
  const key = resolveRepositoryKey(global.db, repo.dir);
  expect(resolveRepositoryKey(global.db, linked)).toBe(key);
  await mapRepository(global.db, { repoKey: key, path: repo.dir });
  const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await mapWorkspace(global.db, { repoKey: key, workspaceId: first, path: repo.dir });
  await mapWorkspace(global.db, { repoKey: key, workspaceId: second, path: linked });
  await expect(mapWorkspace(global.db, { repoKey: key, workspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", path: linked })).rejects.toThrow(/already mapped/i);
  await expect(mapRepository(global.db, { repoKey: "different-repo", path: linked })).rejects.toThrow(/already mapped/i);
  await expect(resumePendingMappings(global.db)).resolves.toBeUndefined();
  expect(resolveWorkspace(global.db, key, first)).toBe(repo.dir);
  expect(resolveWorkspace(global.db, key, second)).toBe(linked);
  const repoDb = openDbAt(join(repoRoot(repo.dir)!, "repo.db"), "repo");
  try { repoDb.exec("INSERT INTO memory(uuid,category,content,status,source,created_at) VALUES ('shared','insight','shared note','active','user',1)"); }
  finally { repoDb.close(); }
  const read = openRoamStoreReadOnly(global.db, `repo:${key}`);
  try {
    expect(read?.raw.readonly).toBe(true);
    expect(read?.prepare("SELECT content FROM memory WHERE uuid = 'shared'").get()).toEqual({ content: "shared note" });
  } finally { read?.close(); }
}, 5000);

it("mapped reads refuse a symlink to another store", async () => {
  const global = createReplica("global", local), other = createReplica("repo", remote);
  fixtures.push(global, other);
  const repo = gitFixture(global.root, "mapped"); repo.rootCommit("first");
  await mapRepository(global.db, { repoKey: "fixture-repo", path: repo.dir });
  const directory = repoRoot(repo.dir)!;
  mkdirSync(directory, { recursive: true });
  symlinkSync(other.db.raw.name, join(directory, "repo.db"));
  expect(() => openRoamStoreReadOnly(global.db, "repo:fixture-repo")).toThrow(/unsafe|symlink/i);
}, 5000);

it("repeated map refreshes a changed root fingerprint without merging", async () => {
  const global = createReplica("global", local);
  fixtures.push(global);
  const repo = join(global.root, "repo");
  mkdirSync(repo);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const git = (args: string[], input?: string) => execFileSync("git", args, { cwd: repo, env, input, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  const tree = git(["mktree"], "");
  const root1 = git(["commit-tree", tree], "first root\n");
  git(["update-ref", "refs/heads/first", root1]);
  const input = { repoKey: "fixture-repo", path: repo };
  const rootHash = (roots: string[]) => `root:${createHash("sha256").update(roots.sort().join("\n")).digest("hex")}`;
  await mapRepository(global.db, input);
  expect(global.db.prepare("SELECT root_fingerprint FROM roam_repo_maps WHERE repo_key = ?").get(input.repoKey)).toEqual({ root_fingerprint: rootHash([root1]) });
  const redirect = mappingRedirect(global.db, `repo:${input.repoKey}`);
  const root2 = git(["commit-tree", tree], "second root\n");
  git(["update-ref", "refs/heads/second", root2]);
  await mapRepository(global.db, input);
  expect(global.db.prepare("SELECT root_fingerprint FROM roam_repo_maps WHERE repo_key = ?").get(input.repoKey)).toEqual({ root_fingerprint: rootHash([root1, root2]) });
  expect(mappingRedirect(global.db, `repo:${input.repoKey}`)).toEqual(redirect);
  const changes = global.db.prepare("SELECT total_changes() AS n").get();
  await mapRepository(global.db, input);
  expect(global.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
}, 5000);
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

it("mapping merges versions tombstones and retains redirect", async () => {
  const global = createReplica("global", local);
  fixtures.push(global);
  const replicaFile = replicaPath(global.db, key);
  mkdirSync(join(global.root, "roam", "stores"), { recursive: true, mode: 0o700 });
  const replica = openDbAt(replicaFile, "worktree");
  const workspace = join(global.root, "checkout");
  mkdirSync(workspace);
  try {
    replica.prepare("UPDATE roam_meta SET machine_id = ?, store_key = ?, capture_enabled = 1 WHERE id = 1").run(remote, key);
    replica.exec("INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('remote-session',1,'active')");
    replica.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES ('remote-session',1,?)").run(remote);
    replica.exec("INSERT INTO todos(uuid,session_id,seq,text,created_at) VALUES ('todo-one','remote-session',1,'keep',1)");
    replica.exec("INSERT INTO todos(uuid,session_id,seq,text,created_at) VALUES ('todo-two','remote-session',2,'delete',1)");
    replica.exec("DELETE FROM todos WHERE uuid = 'todo-two'");
    catalogReplica(global.db, key, replica);
    const versions = replica.prepare("SELECT * FROM roam_versions ORDER BY entity,row_key").all();
    await mapWorkspace(global.db, { repoKey: "fixture-repo", workspaceId: "fixture-workspace", path: workspace });
    expect(resolveWorkspace(global.db, "fixture-repo", "fixture-workspace")).toBe(workspace);
    const resolved = resolveSessionReplica(global.db, "remote-session");
    expect(resolved?.db.raw.readonly).toBe(true);
    expect(resolved?.db.prepare("SELECT * FROM roam_versions ORDER BY entity,row_key").all()).toEqual(versions);
    expect(resolved?.db.prepare("SELECT text FROM todos").all()).toEqual([{ text: "keep" }]);
    expect(replica.prepare("SELECT deleted FROM roam_versions WHERE row_key = 'todo-two'").get()).toEqual({ deleted: 1 });
    expect(mappingRedirect(global.db, key)).toEqual(join(workspace, ".spider", "project.db"));
    resolved?.db.close();
  } finally { replica.close(); }
}, 5000);

function interruptedFixture() {
  const global = createReplica("global", local);
  fixtures.push(global);
  mkdirSync(join(global.root, "roam", "stores"), { recursive: true, mode: 0o700 });
  const source = openDbAt(replicaPath(global.db, key), "worktree");
  source.prepare("UPDATE roam_meta SET machine_id = ?, store_key = ?, capture_enabled = 1 WHERE id = 1").run(remote, key);
  source.exec("INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('remote-session',1,'active')");
  source.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES ('remote-session',1,?)").run(remote);
  source.exec("INSERT INTO todos(uuid,session_id,seq,text,created_at) VALUES ('todo-one','remote-session',1,'keep',1)");
  catalogReplica(global.db, key, source);
  const workspace = join(global.root, "checkout");
  mkdirSync(workspace);
  const input = { repoKey: "fixture-repo", workspaceId: "fixture-workspace", path: workspace };
  global.db.exec("CREATE TRIGGER fail_mapping BEFORE INSERT ON roam_workspace_maps BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
  return { global, source, workspace, input };
}

async function incomingBatch() {
  const peer = createReplica("worktree", "33333333-3333-4333-8333-333333333333");
  fixtures.push(peer);
  peer.db.exec("UPDATE roam_meta SET capture_enabled = 1; INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('incoming-session',1,'active')");
  peer.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES ('incoming-session',1,?)").run(peer.machineId);
  const artifact = await exportBatch(peer.db, { after: 0, targetBytes: 1024 * 1024, batchId: "incoming-batch" }, createExportPolicy((_path, origin) => ({ machineId: origin, reference: "unavailable" })));
  const now = Date.now();
  return validateBatch(artifact, { storeKey: key, senderMachine: peer.machineId, senderStream: artifact.header.senderStream, now });
}

it.each(["duplicate diagnosis", "other store key", "import in progress", "foreign machine", "trigger drift"] as const)("rejects %s before recording an intent or fencing", async problem => {
  const f = interruptedFixture();
  f.global.db.exec("DROP TRIGGER fail_mapping");
  mkdirSync(join(f.workspace, ".spider"), { recursive: true });
  const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
  try {
    target.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(local);
    if (problem === "duplicate diagnosis") target.exec("UPDATE roam_meta SET roamable=0, problem='Duplicate todo sequence for row IDs 17,29'");
    if (problem === "other store key") target.exec("UPDATE roam_meta SET store_key='worktree:other:workspace'");
    if (problem === "import in progress") target.exec("UPDATE roam_meta SET importing=1");
    if (problem === "foreign machine") target.prepare("UPDATE roam_meta SET machine_id=?").run(remote);
    if (problem === "trigger drift") target.exec("CREATE TRIGGER foreign_guard BEFORE INSERT ON todos BEGIN SELECT 1; END");
    if (process.platform !== "win32") { chmodSync(join(f.workspace, ".spider"), 0o755); chmodSync(target.raw.name, 0o644); }
    const before = target.prepare("SELECT store_key,roamable,problem,importing FROM roam_meta").get();
    const modes = [statSync(join(f.workspace, ".spider")).mode & 0o777, statSync(target.raw.name).mode & 0o777];
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow(/ready|roamable|duplicate|another store/i);
    expect(target.prepare("SELECT store_key,roamable,problem,importing FROM roam_meta").get()).toEqual(before);
    expect([statSync(join(f.workspace, ".spider")).mode & 0o777, statSync(target.raw.name).mode & 0o777]).toEqual(modes);
    expect(localEntries(f.global.db, "mapping-intent")).toEqual([]);
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined();
    const incoming = await incomingBatch();
    expect(() => applyBatch(f.source, incoming, { hubMachine: local, effects: createReplicaEffects(() => {}), now: Date.now(), sessionHome: () => null })).not.toThrow();
  } finally { target.close(); f.source.close(); }
}, 5000);

it("resumes after the target commit but before the global publication commit", async () => {
  const f = interruptedFixture();
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    try {
      expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: key });
      expect(target.prepare("SELECT text FROM todos").all()).toEqual([{ text: "keep" }]);
    } finally { target.close(); }
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBeNull();
    expect(localEntries(f.global.db, "mapping-intent")).toHaveLength(1);
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeDefined();
    f.global.db.exec("DROP TRIGGER fail_mapping");
    await resumePendingMappings(f.global.db);
    const published = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    try {
      expect(published.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: key });
      expect(published.prepare("SELECT text FROM todos").all()).toEqual([{ text: "keep" }]);
    } finally { published.close(); }
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBe(f.workspace);
  } finally { f.source.close(); }
}, 5000);

it("rolls back the global mapping if redirect publication fails", async () => {
  const f = interruptedFixture();
  try {
    f.global.db.exec("DROP TRIGGER fail_mapping");
    f.global.db.exec("CREATE TRIGGER fail_redirect BEFORE INSERT ON roam_cursors WHEN NEW.peer_stream LIKE 'spider-local:mapping-redirect:%' BEGIN SELECT RAISE(ABORT, 'redirect failed'); END");
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("redirect failed");
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBeNull();
    expect(mappingRedirect(f.global.db, key)).toBeNull();
    expect(localEntries(f.global.db, "mapping-intent")).toHaveLength(1);
    const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    try { expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: key }); }
    finally { target.close(); }
    f.global.db.exec("DROP TRIGGER fail_redirect");
    await resumePendingMappings(f.global.db);
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBe(f.workspace);
    expect(mappingRedirect(f.global.db, key)).toBe(join(f.workspace, ".spider", "project.db"));
    expect(localEntries(f.global.db, "mapping-intent")).toEqual([]);
  } finally { f.source.close(); }
}, 5000);

it("cancels a pending mapping and its fence, allowing imports and a different target", async () => {
  const f = interruptedFixture();
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    expect(localEntries(f.global.db, "mapping-intent")).toHaveLength(1);
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeDefined();
    const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    try {
      expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: key });
      cancelMapping(f.global.db, key);
      expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: null });
    } finally { target.close(); }
    expect(localEntries(f.global.db, "mapping-intent")).toEqual([]);
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined();
    const incoming = await incomingBatch();
    expect(() => applyBatch(f.source, incoming, { hubMachine: local, effects: createReplicaEffects(() => {}), now: Date.now(), sessionHome: () => null })).not.toThrow();
    cancelMapping(f.global.db, key); // Cancellation is idempotent before publication.
    const other = join(f.global.root, "alternate"); mkdirSync(other);
    f.global.db.exec("DROP TRIGGER fail_mapping");
    await mapWorkspace(f.global.db, { ...f.input, path: other });
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBe(other);
    expect(() => cancelMapping(f.global.db, key)).toThrow(/published|redirect/i);
    await resumePendingMappings(f.global.db);
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeDefined();
  } finally { f.source.close(); }
}, 5000);

it("does not publish an in-flight mapping after cancellation and remapping", async () => {
  const f = interruptedFixture();
  try {
    f.global.db.exec("DROP TRIGGER fail_mapping");
    const old = mapWorkspace(f.global.db, f.input).then(() => null, error => String(error));
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeDefined();
    cancelMapping(f.global.db, key);
    const other = join(f.global.root, "alternate"); mkdirSync(other);
    const next = mapWorkspace(f.global.db, { ...f.input, path: other });
    const oldError = await old;
    await next;
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBe(other);
    const previous = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    try { expect(previous.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: null }); }
    finally { previous.close(); }
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeDefined();
    expect(oldError).toMatch(/pending mapping disappeared or changed/i);
  } finally { f.source.close(); }
}, 5000);

it("does not publish an older attempt after cancellation and a same-path retry", async () => {
  const f = interruptedFixture();
  mkdirSync(join(f.workspace, ".spider"), { recursive: true });
  const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
  const originalPrepare = f.global.db.prepare.bind(f.global.db);
  let replaced = false;
  try {
    target.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(local);
    f.global.db.exec("DROP TRIGGER fail_mapping");
    f.global.db.prepare = sql => {
      const statement = originalPrepare(sql);
      if (!sql.includes("SELECT peer_stream FROM roam_cursors")) return statement;
      return new Proxy(statement, { get(real, property) {
        if (property === "all") return (...args: unknown[]) => {
          const meta = target.prepare("SELECT store_key FROM roam_meta").get() as { store_key: string | null };
          if (!replaced && args[2] === "spider-local:mapping-intent:" && meta.store_key === key) {
            replaced = true;
            const pending = localEntries<Record<string, unknown>>(f.global.db, "mapping-intent")[0];
            writeLocal(f.global.db, "mapping-intent", pending.key, { ...pending.value, attempt_id: "replacement-attempt" });
          }
          return real.all(...args);
        };
        const value = Reflect.get(real, property, real);
        return typeof value === "function" ? value.bind(real) : value;
      } });
    };
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow(/pending mapping.*changed|conflicting pending/i);
    expect(replaced).toBe(true);
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBeNull();
    expect(localEntries(f.global.db, "mapping-intent")).toHaveLength(1);
  } finally { f.global.db.prepare = originalPrepare; target.close(); f.source.close(); }
}, 5000);

it("can cancel a post-fence todo collision without assigning the target", async () => {
  const f = interruptedFixture();
  f.global.db.exec("DROP TRIGGER fail_mapping");
  mkdirSync(join(f.workspace, ".spider"), { recursive: true });
  const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
  try {
    target.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(local);
    target.exec("INSERT INTO todos(uuid,session_id,seq,text,created_at) VALUES ('local-conflict','remote-session',1,'local todo',1)");
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow(/todo collision/i);
    expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: null });
    expect(localEntries(f.global.db, "mapping-intent")).toHaveLength(1);
    cancelMapping(f.global.db, key);
    expect(localEntries(f.global.db, "mapping-intent")).toEqual([]);
    const incoming = await incomingBatch();
    expect(() => applyBatch(f.source, incoming, { hubMachine: local, effects: createReplicaEffects(() => {}), now: Date.now(), sessionHome: () => null })).not.toThrow();
    expect(target.prepare("SELECT text FROM todos").all()).toEqual([{ text: "local todo" }]);
  } finally { target.close(); f.source.close(); }
}, 5000);

it("cancels when opening the source failed before fencing", async () => {
  const f = interruptedFixture();
  try {
    f.global.db.exec("DROP TRIGGER fail_mapping");
    f.source.exec("UPDATE roam_meta SET store_key=NULL; PRAGMA user_version=15");
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow(/future core schema/i);
    expect(localEntries(f.global.db, "mapping-intent")).toHaveLength(1);
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined();
    cancelMapping(f.global.db, key);
    expect(localEntries(f.global.db, "mapping-intent")).toEqual([]);
    expect(f.source.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: null });
  } finally { f.source.close(); }
}, 5000);

it("cleans an orphan fence at startup after target cleanup committed", async () => {
  const f = interruptedFixture();
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    try {
      f.source.exec("CREATE TRIGGER fail_unfence BEFORE DELETE ON roam_cursors WHEN OLD.peer_machine='' AND OLD.peer_stream='mapping-fence' BEGIN SELECT RAISE(ABORT, 'unfence failed'); END");
      expect(() => cancelMapping(f.global.db, key)).toThrow("unfence failed");
      expect(localEntries(f.global.db, "mapping-intent")).toEqual([]);
      expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: null });
      expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeDefined();
      f.source.exec("DROP TRIGGER fail_unfence");
      const startup = openDbAt(f.global.db.raw.name, "global");
      try {
        await resumePendingMappings(startup);
        expect(localEntries(startup, "mapping-intent")).toEqual([]);
        expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined();
        await resumePendingMappings(startup);
      } finally { startup.close(); }
      const incoming = await incomingBatch();
      expect(() => applyBatch(f.source, incoming, { hubMachine: local, effects: createReplicaEffects(() => {}), now: Date.now(), sessionHome: () => null })).not.toThrow();
    } finally { target.close(); }
  } finally { f.source.close(); }
}, 5000);

it("cleans an orphan target identity and fence at startup after the cancellation commit", async () => {
  const f = interruptedFixture();
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    try {
      target.exec("CREATE TRIGGER fail_unstamp BEFORE UPDATE OF store_key ON roam_meta WHEN NEW.store_key IS NULL BEGIN SELECT RAISE(ABORT, 'unstamp failed'); END");
      expect(() => cancelMapping(f.global.db, key)).toThrow("unstamp failed");
      expect(localEntries(f.global.db, "mapping-intent")).toEqual([]);
      expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBeNull();
      expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: key });
      expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeDefined();
      target.exec("DROP TRIGGER fail_unstamp");
      const startup = openDbAt(f.global.db.raw.name, "global");
      try {
        await resumePendingMappings(startup);
        expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: null });
        expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined();
      } finally { startup.close(); }
    } finally { target.close(); }
  } finally { f.source.close(); }
}, 5000);

it("cleans an orphan fence without a target locator on startup", async () => {
  const f = interruptedFixture();
  try {
    f.source.exec("INSERT INTO roam_cursors(peer_machine,peer_stream,last_seq) VALUES ('','mapping-fence',0)");
    expect(localEntries(f.global.db, "mapping-intent")).toEqual([]);
    await resumePendingMappings(f.global.db);
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined();
    await resumePendingMappings(f.global.db);
    const incoming = await incomingBatch();
    expect(() => applyBatch(f.source, incoming, { hubMachine: local, effects: createReplicaEffects(() => {}), now: Date.now(), sessionHome: () => null })).not.toThrow();
  } finally { f.source.close(); }
}, 5000);

it("records one failed orphan cleanup and continues cleaning another", async () => {
  const f = interruptedFixture();
  const secondKey = "worktree:fixture-repo:second" as const;
  const secondSource = openDbAt(replicaPath(f.global.db, secondKey), "worktree");
  try {
    secondSource.prepare("UPDATE roam_meta SET machine_id=?,store_key=? WHERE id=1").run(remote, secondKey);
    const second = join(f.global.root, "second-checkout"); mkdirSync(second);
    const other = { repoKey: "fixture-repo", workspaceId: "second", path: second };
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    await expect(mapWorkspace(f.global.db, other)).rejects.toThrow("interrupted");
    const firstTarget = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    const secondTarget = openDbAt(join(second, ".spider", "project.db"), "worktree");
    try {
      firstTarget.exec("CREATE TRIGGER fail_unstamp BEFORE UPDATE OF store_key ON roam_meta WHEN NEW.store_key IS NULL BEGIN SELECT RAISE(ABORT, 'unstamp failed'); END");
      secondTarget.exec("CREATE TRIGGER fail_unstamp BEFORE UPDATE OF store_key ON roam_meta WHEN NEW.store_key IS NULL BEGIN SELECT RAISE(ABORT, 'unstamp failed'); END");
      expect(() => cancelMapping(f.global.db, key)).toThrow("unstamp failed");
      expect(() => cancelMapping(f.global.db, secondKey)).toThrow("unstamp failed");
      secondTarget.exec("DROP TRIGGER fail_unstamp");
      await expect(resumePendingMappings(f.global.db)).resolves.toBeUndefined();
      expect(firstTarget.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: key });
      expect(secondTarget.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: null });
      expect(secondSource.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined();
      const failures = localEntries<{ storeKey: string; error: string }>(f.global.db, "mapping-failure");
      expect(failures).toHaveLength(1);
      expect(failures[0].value).toMatchObject({ storeKey: key, error: "unstamp failed" });
      firstTarget.exec("DROP TRIGGER fail_unstamp");
      await resumePendingMappings(f.global.db);
      expect(firstTarget.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: null });
      expect(localEntries(f.global.db, "mapping-failure")).toEqual([]);
    } finally { firstTarget.close(); secondTarget.close(); }
  } finally { secondSource.close(); f.source.close(); }
}, 5000);

it("recovers an interrupted target identity when no replica existed before mapping", async () => {
  const global = createReplica("global", local); fixtures.push(global);
  const workspace = join(global.root, "checkout"); mkdirSync(join(workspace, ".spider"), { recursive: true });
  const target = openDbAt(join(workspace, ".spider", "project.db"), "worktree");
  const input = { repoKey: "fixture-repo", workspaceId: "fixture-workspace", path: workspace };
  try {
    target.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(local);
    expect(existsSync(replicaPath(global.db, key))).toBe(false);
    global.db.exec("CREATE TRIGGER fail_mapping BEFORE INSERT ON roam_workspace_maps BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
    await expect(mapWorkspace(global.db, input)).rejects.toThrow("interrupted");
    expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: key });
    expect(resolveWorkspace(global.db, input.repoKey, input.workspaceId)).toBeNull();
    target.exec("CREATE TRIGGER fail_unstamp BEFORE UPDATE OF store_key ON roam_meta WHEN NEW.store_key IS NULL BEGIN SELECT RAISE(ABORT, 'unstamp failed'); END");
    expect(() => cancelMapping(global.db, key)).toThrow("unstamp failed");
    expect(localEntries(global.db, "mapping-intent")).toEqual([]);
    target.exec("DROP TRIGGER fail_unstamp");
    await resumePendingMappings(global.db);
    expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: null });
    const source = openDbAt(replicaPath(global.db, key), "worktree");
    try { expect(source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined(); }
    finally { source.close(); }
  } finally { target.close(); }
}, 5000);

it.each(["outside the workspace layout", "to a different workspace database"] as const)("refuses an orphan locator %s", async variant => {
  const f = interruptedFixture();
  const otherFile = variant === "outside the workspace layout" ? join(f.global.root, "unrelated.db") : join(f.global.root, "other", ".spider", "project.db");
  const unrelated = openDbAt(otherFile, "worktree");
  try {
    unrelated.prepare("UPDATE roam_meta SET machine_id=?,store_key=? WHERE id=1").run(local, key);
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    const original = readLocal<{ file: string; clearOnCancel: boolean }>(f.source, "mapping-fence-target", key)!;
    writeLocal(f.source, "mapping-fence-target", key, { ...original, file: unrelated.raw.name });
    expect(() => cancelMapping(f.global.db, key)).toThrow(/invalid|changed mapping fence target/i);
    expect(unrelated.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: key });
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeDefined();
    writeLocal(f.source, "mapping-fence-target", key, original);
    await resumePendingMappings(f.global.db);
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined();
  } finally { unrelated.close(); f.source.close(); }
}, 5000);

it("retains an orphan fence when its target locator is malformed", async () => {
  const f = interruptedFixture();
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    const original = readLocal(f.source, "mapping-fence-target", key);
    writeLocal(f.source, "mapping-fence-target", key, null);
    expect(() => cancelMapping(f.global.db, key)).toThrow(/invalid mapping fence target/i);
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeDefined();
    writeLocal(f.source, "mapping-fence-target", key, original);
    await resumePendingMappings(f.global.db);
    const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    try { expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: null }); }
    finally { target.close(); }
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined();
  } finally { f.source.close(); }
}, 5000);

it("keeps the fence when the target database is replaced before recovery", async () => {
  const f = interruptedFixture();
  const file = join(f.workspace, ".spider", "project.db"), original = `${file}.original`, replacement = `${file}.replacement`;
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    renameSync(file, original);
    const other = openDbAt(file, "worktree");
    try {
      other.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(local);
      f.global.db.exec("DROP TRIGGER fail_mapping");
      await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow(/mapping fence target/i);
      expect(() => cancelMapping(f.global.db, key)).toThrow(/changed mapping fence target/i);
      expect(other.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: null });
      expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeDefined();
    } finally { other.close(); }
    renameSync(file, replacement); renameSync(original, file);
    await resumePendingMappings(f.global.db);
    const restored = openDbAt(file, "worktree");
    try { expect(restored.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: null }); }
    finally { restored.close(); }
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined();
  } finally { f.source.close(); }
}, 5000);

it("does not remove a target identity that already existed before mapping", async () => {
  const f = interruptedFixture();
  mkdirSync(join(f.workspace, ".spider"), { recursive: true });
  const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
  try {
    target.prepare("UPDATE roam_meta SET machine_id=?,store_key=? WHERE id=1").run(local, key);
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    cancelMapping(f.global.db, key);
    expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: key });
    expect(localEntries(f.global.db, "mapping-intent")).toEqual([]);
    expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined();
  } finally { target.close(); f.source.close(); }
}, 5000);

it("preserves a target identity claimed by a local session before cancellation", async () => {
  const f = interruptedFixture();
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    try {
      target.exec("INSERT INTO sessions(id,started_at) VALUES ('local-session',1)");
      expect(seedSession(target, "local-session", 1, key, 1024 * 1024).complete).toBe(true);
      cancelMapping(f.global.db, key);
      expect(target.prepare("SELECT store_key,capture_enabled FROM roam_meta").get()).toEqual({ store_key: key, capture_enabled: 1 });
      expect(target.prepare("SELECT id FROM sessions WHERE id='local-session'").get()).toEqual({ id: "local-session" });
      expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined();
    } finally { target.close(); }
  } finally { f.source.close(); }
}, 5000);

it("keeps the target and fence intact when the global cancellation commit fails", async () => {
  const f = interruptedFixture();
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    try {
      f.global.db.exec("CREATE TRIGGER fail_cancel BEFORE DELETE ON roam_cursors WHEN OLD.peer_stream LIKE 'spider-local:mapping-intent:%' BEGIN SELECT RAISE(ABORT, 'cancel commit failed'); END");
      expect(() => cancelMapping(f.global.db, key)).toThrow("cancel commit failed");
      expect(localEntries(f.global.db, "mapping-intent")).toHaveLength(1);
      expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: key });
      expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeDefined();
      f.global.db.exec("DROP TRIGGER fail_cancel");
      cancelMapping(f.global.db, key);
      expect(target.prepare("SELECT store_key FROM roam_meta").get()).toEqual({ store_key: null });
      expect(f.source.prepare("SELECT 1 FROM roam_cursors WHERE peer_machine='' AND peer_stream='mapping-fence'").get()).toBeUndefined();
    } finally { target.close(); }
  } finally { f.source.close(); }
}, 5000);

it("records a failed resume and continues resuming other pending mappings", async () => {
  const f = interruptedFixture();
  const secondKey = "worktree:fixture-repo:second" as const;
  const secondSource = openDbAt(replicaPath(f.global.db, secondKey), "worktree");
  try {
    secondSource.prepare("UPDATE roam_meta SET machine_id=?, store_key=?, capture_enabled=1").run(remote, secondKey);
    secondSource.exec("INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('second-session',1,'active')");
    secondSource.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES ('second-session',1,?)").run(remote);
    const second = join(f.global.root, "second-checkout"); mkdirSync(second);
    const other = { repoKey: "fixture-repo", workspaceId: "second", path: second };
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    await expect(mapWorkspace(f.global.db, other)).rejects.toThrow("interrupted");
    renameSync(f.workspace, join(f.global.root, "missing-checkout"));
    f.global.db.exec("DROP TRIGGER fail_mapping");
    await expect(resumePendingMappings(f.global.db)).resolves.toBeUndefined();
    expect(resolveWorkspace(f.global.db, other.repoKey, other.workspaceId)).toBe(second);
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBeNull();
    const failures = localEntries<{ storeKey: string; error: string }>(f.global.db, "mapping-failure");
    expect(failures).toHaveLength(1);
    expect(failures[0].value.storeKey).toBe(key);
    expect(failures[0].value.error).toMatch(/ENOENT|no such file/i);
    expect(localEntries(f.global.db, "mapping-intent")).toHaveLength(1);
    renameSync(join(f.global.root, "missing-checkout"), f.workspace);
    await resumePendingMappings(f.global.db);
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBe(f.workspace);
    expect(localEntries(f.global.db, "mapping-failure")).toEqual([]);
    expect(localEntries(f.global.db, "mapping-intent")).toEqual([]);
  } finally { secondSource.close(); f.source.close(); }
}, 5000);

it("skips a malformed pending intent while resuming a healthy one", async () => {
  const f = interruptedFixture();
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    writeLocal(f.global.db, "mapping-intent", "invalid", null);
    f.global.db.exec("DROP TRIGGER fail_mapping");
    await expect(resumePendingMappings(f.global.db)).resolves.toBeUndefined();
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBe(f.workspace);
    const failures = localEntries<{ error: string }>(f.global.db, "mapping-failure");
    expect(failures).toHaveLength(1);
    expect(failures[0].value.error).toMatch(/invalid pending mapping/i);
  } finally { f.source.close(); }
}, 5000);

it("import after verification is refused by the mapping fence", async () => {
  const f = interruptedFixture();
  try {
    f.global.db.exec("DROP TRIGGER fail_mapping");
    const batch = await incomingBatch();
    let attempted = false;
    let refusal: unknown;
    f.global.db.raw.function("attempt_incoming", () => {
      attempted = true;
      try { applyBatch(f.source, batch, { hubMachine: local, effects: createReplicaEffects(() => {}), now: Date.now(), sessionHome: () => null }); }
      catch (error) { refusal = error; }
      return 0;
    });
    f.global.db.exec("CREATE TRIGGER inject_import BEFORE INSERT ON roam_workspace_maps BEGIN SELECT attempt_incoming(); END");
    await mapWorkspace(f.global.db, f.input);
    expect(attempted).toBe(true);
    expect(refusal).toMatchObject({ retryable: true, storeKey: key });
    expect(f.source.prepare("SELECT id FROM sessions WHERE id = 'incoming-session'").get()).toBeUndefined();
  } finally { f.source.close(); }
}, 5000);

it("fenced replica refusal is retryable and names the store", async () => {
  const f = interruptedFixture();
  try {
    f.global.db.exec("DROP TRIGGER fail_mapping");
    await mapWorkspace(f.global.db, f.input);
    const batch = await incomingBatch();
    let refusal: unknown;
    try { applyBatch(f.source, batch, { hubMachine: local, effects: createReplicaEffects(() => {}), now: Date.now(), sessionHome: () => null }); }
    catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: "ROAM_MAPPING_FENCED", retryable: true, storeKey: key });
    expect(String(refusal)).toContain(key);
  } finally { f.source.close(); }
}, 5000);

it("local writes during mapping keep verification valid", async () => {
  const f = interruptedFixture();
  try {
    f.global.db.exec("DROP TRIGGER fail_mapping");
    mkdirSync(join(f.workspace, ".spider"), { recursive: true });
    const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    try {
      target.prepare("UPDATE roam_meta SET machine_id = ?, store_key = ? WHERE id = 1").run(local, key);
      const artifact = await exportBatch(f.source, { after: 0, targetBytes: 1024 * 1024, batchId: "initial-copy" }, createExportPolicy((_path, origin) => ({ machineId: origin, reference: "unavailable" })));
      const now = Date.now();
      const batch = await validateBatch(artifact, { storeKey: key, senderMachine: remote, senderStream: artifact.header.senderStream, now });
      applyBatch(target, batch, { hubMachine: local, effects: createReplicaEffects(() => {}), now, sessionHome: () => null });
      target.exec("UPDATE roam_sessions SET state = 'active' WHERE session_id = 'remote-session'; UPDATE roam_meta SET capture_enabled = 1");
      const pending = mapWorkspace(f.global.db, f.input);
      target.exec("UPDATE sessions SET summary = 'local update' WHERE id = 'remote-session'");
      target.exec("INSERT INTO roam_sessions(session_id,epoch,state) VALUES ('local-session',1,'active'); INSERT INTO sessions(id,started_at) VALUES ('local-session',2)");
      await pending;
      expect(target.prepare("SELECT summary FROM sessions WHERE id = 'remote-session'").get()).toEqual({ summary: "local update" });
      expect(target.prepare("SELECT id FROM sessions WHERE id = 'local-session'").get()).toEqual({ id: "local-session" });
      const replicaVersion = f.source.prepare("SELECT change_id FROM roam_versions WHERE entity = 'sessions' AND row_key = 'remote-session'").get();
      expect(target.prepare("SELECT change_id FROM roam_versions WHERE entity = 'sessions' AND row_key = 'remote-session'").get()).not.toEqual(replicaVersion);
      expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBe(f.workspace);
    } finally { target.close(); }
  } finally { f.source.close(); }
}, 5000);

it("mapping refuses publication if target no longer contains a replica version", async () => {
  const f = interruptedFixture();
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    try { target.prepare("DELETE FROM roam_versions WHERE entity = 'todos' AND row_key = 'todo-one'").run(); }
    finally { target.close(); }
    f.global.db.exec("DROP TRIGGER fail_mapping");
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow(/not contained/i);
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBeNull();
  } finally { f.source.close(); }
}, 5000);

it("pending mappings resume after reopening the global store", async () => {
  const f = interruptedFixture();
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    f.global.db.exec("DROP TRIGGER fail_mapping");
    const reopened = openDbAt(f.global.db.raw.name, "global");
    try {
      await resumePendingMappings(reopened);
      expect(resolveWorkspace(reopened, f.input.repoKey, f.input.workspaceId)).toBe(f.workspace);
      const resolved = resolveSessionReplica(reopened, "remote-session")!;
      try { expect(resolved.db.prepare("SELECT text FROM todos").all()).toEqual([{ text: "keep" }]); }
      finally { resolved.db.close(); }
    } finally { reopened.close(); }
  } finally { f.source.close(); }
}, 5000);

it("concurrent retries of the same mapping converge without duplicate changes", async () => {
  const f = interruptedFixture();
  try {
    f.global.db.exec("DROP TRIGGER fail_mapping");
    const outcomes = await Promise.allSettled([mapWorkspace(f.global.db, f.input), mapWorkspace(f.global.db, f.input)]);
    expect(outcomes.flatMap(outcome => outcome.status === "rejected" ? [String(outcome.reason)] : [])).toEqual([]);
    const resolved = resolveSessionReplica(f.global.db, "remote-session")!;
    try {
      expect(resolved.db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual(f.source.prepare("SELECT count(*) AS n FROM roam_changes").get());
      expect(resolved.db.prepare("SELECT text FROM todos").all()).toEqual([{ text: "keep" }]);
    } finally { resolved.db.close(); }
  } finally { f.source.close(); }
}, 5000);

it("interrupted mapping resumes without duplicate changes", async () => {
  const f = interruptedFixture();
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    const target = openDbAt(join(f.workspace, ".spider", "project.db"), "worktree");
    target.prepare("INSERT INTO sessions(id, started_at, origin_machine) VALUES ('target-session', 1, ?)").run(local);
    const before = target.prepare("SELECT change_id FROM roam_changes ORDER BY change_id").all();
    target.close();
    f.global.db.exec("DROP TRIGGER fail_mapping");
    await mapWorkspace(f.global.db, f.input);
    const targetSession = resolveSessionReplica(f.global.db, "target-session");
    expect(targetSession?.db.raw.name).toBe(join(f.workspace, ".spider", "project.db"));
    targetSession?.db.close();
    const resolved = resolveSessionReplica(f.global.db, "remote-session")!;
    try {
      expect(statSync(join(f.workspace, ".spider")).mode & 0o777).toBe(0o700);
      expect(statSync(resolved.db.raw.name).mode & 0o777).toBe(0o600);
      expect(resolved.db.prepare("SELECT change_id FROM roam_changes ORDER BY change_id").all()).toEqual(before);
      expect(resolved.db.prepare("SELECT count(*) AS n FROM todos").get()).toEqual({ n: 1 });
    } finally { resolved.db.close(); }
  } finally { f.source.close(); }
}, 5000);

it("mapping is invisible until verification commits", async () => {
  const f = interruptedFixture();
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBeNull();
    const resolved = resolveSessionReplica(f.global.db, "remote-session")!;
    try { expect(resolved.db.raw.name).toBe(replicaPath(f.global.db, key)); }
    finally { resolved.db.close(); }
  } finally { f.source.close(); }
}, 5000);

it("conflicting pending mapping is refused", async () => {
  const f = interruptedFixture();
  try {
    await expect(mapWorkspace(f.global.db, f.input)).rejects.toThrow("interrupted");
    const other = join(f.global.root, "other");
    mkdirSync(other);
    await expect(mapWorkspace(f.global.db, { ...f.input, path: other })).rejects.toThrow(/pending/i);
    expect(existsSync(join(other, ".spider", "project.db"))).toBe(false);
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBeNull();
  } finally { f.source.close(); }
}, 5000);

it("repeated completed mapping is a no-op", async () => {
  const f = interruptedFixture();
  try {
    f.global.db.exec("DROP TRIGGER fail_mapping");
    await mapWorkspace(f.global.db, f.input);
    const changes = f.global.db.prepare("SELECT total_changes() AS n").get();
    await mapWorkspace(f.global.db, f.input);
    expect(f.global.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(resolveWorkspace(f.global.db, f.input.repoKey, f.input.workspaceId)).toBe(f.workspace);
  } finally { f.source.close(); }
}, 5000);
