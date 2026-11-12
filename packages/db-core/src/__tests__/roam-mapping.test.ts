import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, symlinkSync } from "node:fs";
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
import { discoverRepository, mapRepository, mapWorkspace, resolveRepositoryKey, resolveWorkspace, resumePendingMappings } from "../roam/repo-map";

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
