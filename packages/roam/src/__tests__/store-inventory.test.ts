import { createStorePort } from "../stores";
import { readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, openDb } from "@spider/db-core";
import { replicaPath } from "@spider/db-core/roam/catalog";
import { enableMemoryCapture } from "@spider/db-core/roam/seed";
import { openRoamStoreReadOnly } from "@spider/db-core/roam/reads";
import { createReplica } from "@spider/db-core/testutil";
import { handleAgentOperation } from "../agent";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import { openJournal } from "../journal";
import { listStoreKeys, storeInventoryDiagnostic, type UngatheredStore } from "../store-inventory";
import { mapWorkspace } from "@spider/db-core/roam/repo-map";

const BOX = "00000000-0000-4000-8000-000000000002";
const HUB = "00000000-0000-4000-8000-000000000001";
const fixtures: Array<{ close(): void }> = [];
afterEach(() => { for (const fixture of fixtures.splice(0).reverse()) fixture.close(); });
function fixture() {
  const global = createReplica("global", BOX), worktree = createReplica("worktree", BOX);
  fixtures.push(global, worktree);
  global.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('local',?, ?,1,1)").run(worktree.root, worktree.db.raw.name);
  const ports = { config: { enabled: true, role: "box" as const, machineId: BOX, hubMachineId: HUB,
    peers: [], discoveryRoots: [], coreUnit: "core", syncMs: 120_000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() },
    root: join(global.root, "roam", "staging"), journal: openJournal(join(global.root, "journal.db")),
    openStore(key: string) { if (key !== "global") throw new Error("unexpected store"); return { db: global.db,
      effects: { begin() { return { winning() {} }; }, committed() {} }, policy: { encode: (_: unknown, body: import("@spider/db-core/roam/types").JsonObject) => body } }; } };
  return { global, worktree, ports };
}
it.each(["stores", "inventory"])("keyless %s discovers a registered store and an agent-created unmapped store", async kind => {
  const { global, worktree, ports } = fixture();
  const foreign = createReplica("repo", BOX); fixtures.push(foreign);
  const file = replicaPath(global.db, foreign.storeKey);
  mkdirSync(join(global.root, "roam", "stores"), { recursive: true, mode: 0o700 });
  await foreign.db.raw.backup(file);
  chmodSync(file, 0o600);
  const before = global.db.prepare("SELECT count(*) AS n FROM roam_changes").get();
  const operation = { id: "discover", machineId: BOX, expectedEpoch: null, kind, args: {} };
  const result = await handleAgentOperation(operation, ports);
  expect(result).toMatchObject({ code: 0, value: { protocol: 1, schema: 14, machineId: BOX,
    stores: ["global", foreign.storeKey, worktree.storeKey] } });
  expect(JSON.stringify(result)).not.toContain(global.root);
  expect(global.db.prepare("SELECT count(*) AS n FROM roam_changes").get()).toEqual(before);
  expect(await handleAgentOperation(operation, ports)).toEqual(result);
  expect(ports.journal.read(operation.id).filter(row => row.action === "done")).toHaveLength(0);
}, 5000);
it("reads registered, mapped and replica stores from a detached catalog", () => {
  const { global, worktree } = fixture();
  const repo = createReplica("repo", BOX); fixtures.push(repo);
  const replicaKey = "repo:other-repo" as const;
  const directory = join(global.root, "roam", "stores"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const replica = openDb(replicaPath(global.db, replicaKey));
  try { migrate(replica, "repo", { machineId: BOX, globalRoot: global.root }); enableMemoryCapture(replica, replicaKey); }
  finally { replica.close(); }
  const catalog = {
    globalPath: global.db.raw.name, machine: BOX,
    projects: [{ db_path: worktree.db.raw.name, git_common_dir: null }],
    repos: [{ repo_key: "fixture-repo", path: join(global.root, "checkout") }],
    worktrees: [{ repo_key: "fixture-repo", workspace_id: "fixture-workspace", path: join(global.root, "checkout") }],
    redirects: [repo, worktree].map(store => ({ peer_stream: `spider-local:mapping-redirect:${JSON.stringify([store.storeKey, store.db.raw.name])}` })),
  };
  expect(listStoreKeys(catalog)).toEqual(["global", replicaKey, repo.storeKey, worktree.storeKey].sort());
  for (const key of [repo.storeKey, worktree.storeKey, replicaKey]) {
    const db = openRoamStoreReadOnly(catalog, key);
    try { expect(db?.prepare("SELECT store_key FROM roam_meta WHERE id=1").get()).toEqual({ store_key: key }); }
    finally { db?.close(); }
  }
}, 5000);

it("omits deleted registered databases and a mapped worktree awaiting capture", async () => {
  const { global, worktree, ports } = fixture();
  const common = join(global.root, "deleted", ".git");
  global.db.prepare("UPDATE projects SET git_common_dir=?").run(common);
  const path = join(global.root, "planned"); mkdirSync(path);
  await mapWorkspace(global.db, { repoKey: "fixture-repo", workspaceId: "00000000-0000-4000-8000-000000000003", path });
  worktree.db.close(); unlinkSync(worktree.db.raw.name);
  const problems: Array<{ entry: string; error: unknown }> = [], incomplete: string[] = [];
  expect(listStoreKeys(global.db, { onProblem: (entry, error) => problems.push({ entry, error }), onIncomplete: entry => incomplete.push(entry) })).toEqual(["global"]);
  expect(incomplete).toEqual([worktree.db.raw.name, join(common, "spider", "repo.db"), join(path, ".spider", "project.db")]);
  expect(problems).toEqual(expect.arrayContaining([
    { entry: worktree.db.raw.name, error: expect.objectContaining({ code: "store-missing", scope: "worktree" }) },
    { entry: join(common, "spider", "repo.db"), error: expect.objectContaining({ code: "store-missing", scope: "repo" }) },
    { entry: join(path, ".spider", "project.db"), error: expect.objectContaining({ code: "store-missing", scope: "worktree" }) },
  ]));
  const result = await handleAgentOperation({ id: "missing", machineId: BOX, expectedEpoch: null, kind: "stores", args: {} }, ports);
  expect(result).toMatchObject({ code: 0, value: { stores: ["global"] } });
}, 5000);

it.each(["EACCES", "SQLITE_CORRUPT"])("marks registered inspect failure %s ungathered with its path", code => {
  const { global, worktree } = fixture(), incomplete: string[] = [], problems: unknown[] = [];
  expect(listStoreKeys(global.db, { open() { throw Object.assign(new Error("private detail"), { code }); },
    onProblem: (_entry, error) => problems.push(error), onIncomplete: entry => incomplete.push(entry) })).toEqual(["global"]);
  expect(incomplete).toEqual([worktree.db.raw.name]);
  expect(problems).toEqual([expect.objectContaining({ code: "store-uninspectable", check: code.toLowerCase().replaceAll("_", "-"), path: worktree.db.raw.name })]);
});

it("marks an unexpected file type ungathered with its database path", () => {
  const { global } = fixture();
  const file = join(global.root, "wrong-type.db"); mkdirSync(file);
  global.db.prepare("UPDATE projects SET db_path=?").run(file);
  const problems: unknown[] = [], incomplete: string[] = [];
  listStoreKeys(global.db, { onProblem: (_entry, error) => problems.push(error), onIncomplete: entry => incomplete.push(entry) });
  expect(incomplete).toEqual([file]);
  expect(problems).toEqual([expect.objectContaining({ code: "store-uninspectable", check: "store-path-type", path: file })]);
});

it("marks an unexpected mapped database file type ungathered with its path", () => {
  const { global } = fixture(), path = join(global.root, "mapped");
  const file = join(path, ".spider", "project.db"); mkdirSync(file, { recursive: true });
  global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','planned',?)").run(path);
  const problems: unknown[] = [], incomplete: string[] = [];
  listStoreKeys(global.db, { onProblem: (_entry, error) => problems.push(error), onIncomplete: entry => incomplete.push(entry) });
  expect(incomplete).toEqual([file]);
  expect(problems).toEqual([expect.objectContaining({ code: "store-uninspectable", check: "store-path-type", path: file })]);
});

it("rejects malformed or duplicate detached mapping redirects", () => {
  const { global } = fixture();
  const key = "repo:fixture-repo" as const;
  const catalog = { globalPath: global.db.raw.name, machine: BOX, projects: [],
    repos: [{ repo_key: "fixture-repo", path: join(global.root, "missing-checkout") }], worktrees: [],
    redirects: [{ peer_stream: "spider-local:mapping-redirect:not-json" }] };
  expect(() => openRoamStoreReadOnly(catalog, key)).toThrow();
  catalog.redirects = ["a", "b"].map(name => ({ peer_stream: `spider-local:mapping-redirect:${JSON.stringify([key, join(global.root, `${name}.db`)])}` }));
  expect(() => openRoamStoreReadOnly(catalog, key)).toThrow(/duplicate/i);
  catalog.redirects = [{ peer_stream: `spider-local:mapping-redirect:${JSON.stringify([key, null])}` }];
  expect(() => openRoamStoreReadOnly(catalog, key)).toThrow(/invalid mapping redirect/i);
}, 5000);

it("marks a registered store incomplete if it disappears before the read-only open", () => {
  const { global, worktree } = fixture(), incomplete: string[] = [];
  const keys = listStoreKeys(global.db, { open: () => undefined, onIncomplete: entry => incomplete.push(entry) });
  expect(keys).toEqual(["global"]);
  expect(incomplete).toEqual([worktree.db.raw.name]);
}, 5000);

it("marks a registered file ungathered when it vanishes before read-only open", () => {
  const { global, worktree } = fixture(), incomplete: string[] = [], problems: unknown[] = [];
  worktree.db.close();
  expect(listStoreKeys(global.db, { open(file) { unlinkSync(file); return undefined; },
    onProblem: (_entry, error) => problems.push(error), onIncomplete: entry => incomplete.push(entry) })).toEqual(["global"]);
  expect(incomplete).toEqual([worktree.db.raw.name]);
  expect(problems).toEqual([expect.objectContaining({ code: "store-missing", check: "enoent", path: worktree.db.raw.name })]);
});

it("inventory reports an unreadable owned replica as ungathered", async () => {
  const { global, ports } = fixture();
  const directory = join(global.root, "roam", "stores"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, `${"a".repeat(64)}.db`), "not a database", { mode: 0o600 });
  const result = await handleAgentOperation({ id: "unreadable", machineId: BOX, expectedEpoch: null, kind: "stores", args: {} }, ports);
  expect(result.code).toBe(0);
  expect(result.value).toMatchObject({ stores: ["global", expect.any(String)], ungathered: [expect.objectContaining({ scope: "replica", key: null, code: "corrupt" })] });
}, 5000);

it("inventory ignores mismatched hashes and never follows replica symlinks", async () => {
  const { global, worktree, ports } = fixture();
  const directory = join(global.root, "roam", "stores"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const foreign = createReplica("repo", BOX); fixtures.push(foreign);
  await foreign.db.raw.backup(join(directory, `${"0".repeat(64)}.db`));
  symlinkSync(foreign.db.raw.name, join(directory, `${createHash("sha256").update(foreign.storeKey).digest("hex")}.db`));
  const result = await handleAgentOperation({ id: "unsafe", machineId: BOX, expectedEpoch: null, kind: "stores", args: {} }, ports);
  expect(result).toMatchObject({ code: 0, value: { stores: ["global", worktree.storeKey] } });
  expect(JSON.stringify(result)).not.toContain(foreign.root);
}, 5000);

it.each(["missing", "corrupt"])("reports a %s mapped scope without refusing readable stores", async mode => {
  const { global, worktree, ports } = fixture();
  const path = join(global.root, "unavailable"), file = join(path, ".spider", "project.db");
  if (mode === "corrupt") { mkdirSync(join(path, ".spider"), { recursive: true }); writeFileSync(file, "not sqlite"); }
  global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','hidden',?)").run(path);
  const result = await handleAgentOperation({ id: "ungathered", machineId: BOX, expectedEpoch: null, kind: "stores", args: {} }, ports);
  expect(result).toMatchObject({ code: 0, value: { stores: ["global", worktree.storeKey], ungathered: [
    { key: "worktree:fixture-repo:hidden", scope: "worktree", path: file, code: mode === "missing" ? "missing" : "corrupt" },
  ] } });
}, 5000);

it("reports a mapped identity once when its missing path is also registered", async () => {
  const { global, ports } = fixture(), path = join(global.root, "missing-checkout"), file = join(path, ".spider", "project.db");
  global.db.prepare("UPDATE projects SET db_path=?").run(file);
  global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','hidden',?)").run(path);
  const result = await handleAgentOperation({ id: "known-missing", machineId: BOX, expectedEpoch: null, kind: "stores", args: {} }, ports);
  expect(result.value).toMatchObject({ stores: ["global"], ungathered: [expect.objectContaining({ key: "worktree:fixture-repo:hidden", path: file, code: "missing" })] });
});

it.each([
  ["registered", false], ["mapped", false], ["registered and mapped", false], ["mapped", true],
] as const)("reports a foreign-machine %s worktree as ungathered, assigned=%s", async (source, assigned) => {
  const { global, worktree, ports } = fixture(), key = worktree.storeKey, file = worktree.db.raw.name;
  worktree.db.prepare("UPDATE roam_meta SET machine_id=?,store_key=? WHERE id=1").run(HUB, assigned ? key : null);
  if (source === "mapped") global.db.prepare("DELETE FROM projects").run();
  if (source !== "registered") {
    global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(worktree.root);
    writeLocal(global.db, "mapping-redirect", key, file);
  }
  const problems: unknown[] = [], incomplete: string[] = [], ungathered: UngatheredStore[] = [];
  expect(listStoreKeys(global.db, { onProblem: (_entry, error) => problems.push(error),
    onIncomplete: entry => incomplete.push(entry), onUngathered: store => ungathered.push(store) })).toEqual(["global"]);
  expect(incomplete).toContain(file);
  expect(problems.length).toBeGreaterThan(0);
  for (const error of problems) expect(error).toMatchObject({ code: "store-uninspectable", check: "store-machine-mismatch" });
  expect(ungathered).toEqual([{ key: source === "registered" ? null : key, scope: "worktree", path: file,
    code: "uninspectable", check: "store-machine-mismatch" }]);
  const rows = problems.map(error => storeInventoryDiagnostic(file, error));
  expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("store-uninspectable:worktree:store-machine-mismatch"),
    repairCommand: expect.stringContaining("belongs to another machine identity") })]));
  expect(JSON.stringify(rows)).not.toContain(HUB); expect(JSON.stringify(rows)).not.toContain(BOX);
  const result = await handleAgentOperation({ id: "foreign-store", machineId: BOX, expectedEpoch: null, kind: "stores", args: {} }, ports);
  expect(result).toMatchObject({ code: 0, value: { stores: ["global"], ungathered } });
  expect(worktree.db.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get()).toEqual({ machine_id: HUB, store_key: assigned ? key : null });
});

it.each(["registered", "mapped", "registered and mapped"] as const)("a same-machine unassigned %s store is not reported as foreign", source => {
  const { global, worktree } = fixture(), key = worktree.storeKey, file = worktree.db.raw.name;
  worktree.db.prepare("UPDATE roam_meta SET store_key=NULL WHERE id=1").run();
  if (source === "mapped") global.db.prepare("DELETE FROM projects").run();
  if (source !== "registered") {
    global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(worktree.root);
    writeLocal(global.db, "mapping-redirect", key, file);
  }
  const problems: unknown[] = [], incomplete: string[] = [], ungathered: UngatheredStore[] = [];
  expect(listStoreKeys(global.db, { onProblem: (_entry, error) => problems.push(error),
    onIncomplete: entry => incomplete.push(entry), onUngathered: store => ungathered.push(store) }))
    .toEqual(source === "registered" ? ["global"] : ["global", key]);
  expect({ problems, incomplete, ungathered }).toEqual({ problems: [], incomplete: [], ungathered: [] });
  expect(worktree.db.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get()).toEqual({ machine_id: BOX, store_key: null });
});

it.each(["registered", "mapped", "registered and mapped"] as const)("keeps a malformed machine identity as an inspection failure for a %s store", source => {
  const { global, worktree } = fixture(), key = worktree.storeKey, file = worktree.db.raw.name;
  worktree.db.prepare("UPDATE roam_meta SET machine_id='invalid-machine',store_key=NULL WHERE id=1").run();
  if (source === "mapped") global.db.prepare("DELETE FROM projects").run();
  if (source !== "registered") {
    global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(worktree.root);
    writeLocal(global.db, "mapping-redirect", key, file);
  }
  const ungathered: UngatheredStore[] = [], problems: unknown[] = [], incomplete: string[] = [];
  expect(listStoreKeys(global.db, { onProblem: (_entry, error) => problems.push(error),
    onIncomplete: entry => incomplete.push(entry), onUngathered: store => ungathered.push(store) })).toEqual(["global"]);
  expect(incomplete).toContain(file);
  for (const error of problems) expect(error).toMatchObject({ code: "store-uninspectable", check: "inspect-failed" });
  expect(ungathered).toEqual([{ key: source === "registered" ? null : key, scope: "worktree", path: file, code: "uninspectable", check: "inspect-failed" }]);
  expect(JSON.stringify(problems.map(error => storeInventoryDiagnostic(file, error)))).not.toContain("invalid-machine");
});

it.each(["registered", "mapped"] as const)("keeps an invalid inspecting identity as an inspection failure for a %s store", source => {
  const { global, worktree } = fixture(), key = worktree.storeKey, file = worktree.db.raw.name;
  global.db.prepare("UPDATE roam_meta SET machine_id='invalid-catalog' WHERE id=1").run();
  if (source === "mapped") {
    global.db.prepare("DELETE FROM projects").run();
    global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(worktree.root);
    writeLocal(global.db, "mapping-redirect", key, file);
  }
  const ungathered: UngatheredStore[] = [], incomplete: string[] = [];
  expect(listStoreKeys(global.db, { onIncomplete: entry => incomplete.push(entry), onUngathered: store => ungathered.push(store) })).toEqual(["global"]);
  expect(incomplete).toContain(file);
  expect(ungathered).toEqual([{ key: source === "registered" ? null : key, scope: "worktree", path: file, code: "uninspectable", check: "inspect-failed" }]);
});

it.each(["same", "foreign"] as const)("retains the generic inspection failure for a mapped store with the wrong key and %s machine", machine => {
  const { global, worktree } = fixture(), file = worktree.db.raw.name, mapped = "worktree:fixture-repo:other-workspace";
  if (machine === "foreign") worktree.db.prepare("UPDATE roam_meta SET machine_id=? WHERE id=1").run(HUB);
  global.db.prepare("DELETE FROM projects").run();
  global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','other-workspace',?)").run(worktree.root);
  writeLocal(global.db, "mapping-redirect", mapped, file);
  const ungathered: UngatheredStore[] = [], incomplete: string[] = [];
  expect(listStoreKeys(global.db, { onUngathered: store => ungathered.push(store), onIncomplete: entry => incomplete.push(entry) })).toEqual(["global"]);
  expect(incomplete).toContain(file);
  expect(ungathered).toEqual([{ key: mapped, scope: "worktree", path: file, code: "uninspectable", check: "inspect-failed" }]);
});

it("keeps an unsafe mapped layout classified as unsafe even when its machine differs", () => {
  const { global } = fixture(), wrong = createReplica("global", HUB); fixtures.push(wrong);
  wrong.db.prepare("UPDATE roam_meta SET store_key=NULL WHERE id=1").run();
  global.db.prepare("DELETE FROM projects").run();
  global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','unsafe',?)").run(wrong.root);
  writeLocal(global.db, "mapping-redirect", "worktree:fixture-repo:unsafe", wrong.db.raw.name);
  const ungathered: UngatheredStore[] = [];
  expect(listStoreKeys(global.db, { onUngathered: store => ungathered.push(store) })).toEqual(["global"]);
  expect(ungathered).toEqual([{ key: "worktree:fixture-repo:unsafe", scope: "worktree", path: wrong.db.raw.name,
    code: "unsafe", check: "store-layout-unsafe" }]);
});

it("does not mark an assigned foreign replica as an incomplete owned store", async () => {
  const { global, worktree } = fixture(), foreign = createReplica("repo", HUB); fixtures.push(foreign);
  const directory = join(global.root, "roam", "stores"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${createHash("sha256").update(foreign.storeKey).digest("hex")}.db`);
  await foreign.db.raw.backup(file); chmodSync(file, 0o600);
  const ungathered: UngatheredStore[] = [], incomplete: string[] = [];
  expect(listStoreKeys(global.db, { onUngathered: store => ungathered.push(store), onIncomplete: entry => incomplete.push(entry) }))
    .toEqual(["global", worktree.storeKey]);
  expect(incomplete).toEqual([]);
  expect(ungathered).toEqual([{ key: null, scope: "replica", path: file, code: "uninspectable", check: "inspect-failed" }]);
});

it("persists the coded inventory cause in local store problems", () => {
  const { global, ports } = fixture(), file = join(global.root, "corrupt.db"); writeFileSync(file, "not sqlite");
  global.db.prepare("UPDATE projects SET db_path=?").run(file);
  const stores = createStorePort(ports.config, global.db);
  try { expect(stores.list(HUB)).toEqual(["global"]); } finally { stores.close(); }
  expect(readLocal(global.db, "store-problem", file)).toEqual({ reason: "store-uninspectable:worktree:sqlite-notadb" });
});

it("does not assign a mapped identity to an incompatible unassigned store", async () => {
  const { global, ports } = fixture(), wrong = createReplica("global", BOX); fixtures.push(wrong);
  wrong.db.prepare("UPDATE roam_meta SET store_key=NULL").run();
  global.db.prepare("INSERT INTO roam_repo_maps(repo_key,path) VALUES ('wrong-scope',?)").run(wrong.root);
  writeLocal(global.db, "mapping-redirect", "repo:wrong-scope", wrong.db.raw.name);
  const result = await handleAgentOperation({ id: "wrong-scope", machineId: BOX, expectedEpoch: null, kind: "stores", args: {} }, ports);
  expect((result.value as { stores: string[] }).stores).not.toContain("repo:wrong-scope");
  expect((result.value as { ungathered: unknown[] }).ungathered).toContainEqual(expect.objectContaining({ key: "repo:wrong-scope", code: "unsafe", path: wrong.db.raw.name }));
  expect(wrong.db.prepare("SELECT store_key,capture_enabled FROM roam_meta").get()).toEqual({ store_key: null, capture_enabled: 0 });
});
