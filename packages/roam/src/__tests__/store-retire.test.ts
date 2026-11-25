import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "@spider/db-core";
import { createReplica } from "@spider/db-core/testutil";
import { localEntries, readLocal, writeLocal } from "@spider/db-core/roam/local-state";
import { handleAgentOperation } from "../agent";
import { main } from "../cli";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import { openJournal } from "../journal";
import { revokeMachine } from "../revocation";
import { listStoreKeys } from "../store-inventory";
import * as runtime from "../runtime";
import * as productionHub from "../production-hub";
import * as transportModule from "../transport";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const OLD = "00000000-0000-4000-8000-000000000003";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const f of fixtures.splice(0).reverse()) f.close(); });
function replica(scope: "global" | "worktree" | "repo", machine: string) { const f = createReplica(scope, machine); fixtures.push(f); return f; }
function fixture() {
  const hub = replica("global", HUB), box = replica("global", BOX), foreign = replica("worktree", OLD);
  box.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('foreign',?,?,1,1)")
    .run(foreign.root, foreign.db.raw.name);
  mkdirSync(join(hub.root, "roam"), { mode: 0o700 });
  const config = { enabled: false, role: "hub" as const, machineId: HUB, hubMachineId: HUB,
    peers: [{ machineId: BOX, alias: "box.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/spider", core: "/fixture/core", globalRoot: "/fixture/global" }],
    discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  writeFileSync(join(hub.root, "roam", "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  writeFileSync(join(hub.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  vi.stubEnv("SPIDER_GLOBAL_ROOT", hub.root);
  vi.spyOn(runtime, "openLocalCore").mockReturnValue({ root: hub.root, config, db: hub.db, close() {} });
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/core" } } as never);
  const journal = openJournal(join(hub.root, "roam", "journal.db"));
  const revocations = openDb(join(hub.root, "roam", "journal.db"));
  const ports = { config: { ...config, role: "box" as const, machineId: BOX }, root: box.root, journal: openJournal(join(box.root, "journal.db")),
    openStore(key: string) { if (key !== "global") throw new Error("Unexpected store"); return { db: box.db,
      effects: { begin() { return { winning() {} }; }, committed() {} }, policy: { encode: (_: unknown, body: import("@spider/db-core/roam/types").JsonObject) => body } }; } };
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ resolve: async () => ({ machineId: BOX }),
    exec: async (_handle: unknown, argv: string[]) => Buffer.from(JSON.stringify(await handleAgentOperation(JSON.parse(argv[2]), ports))),
  } as never);
  const out: string[] = [], err: string[] = [];
  const invoke = async (confirm = false, target = "box.invalid") => {
    out.length = err.length = 0;
    const code = await main(["roam", "stores", "retire", target, ...(confirm ? ["--confirm"] : []), "--json"],
      { out: text => out.push(text), err: text => err.push(text) });
    return { code, result: JSON.parse(out.join("")) };
  };
  return { hub, box, foreign, ports, revocations, journal, config, invoke };
}

it("previews and retires a foreign registration only with durable destroyed-machine proof", async () => {
  const f = fixture();
  try {
    revokeMachine(f.revocations, OLD);
    const entry = { key: "project:foreign", path: f.foreign.db.raw.name };
    const preview = await f.invoke();
    expect(preview).toMatchObject({ code: 0, result: { reason: "stores-retire-preview", value: { candidates: [entry], removed: [] } } });
    expect(f.box.db.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "foreign" }]);
    expect(localEntries(f.box.db, "store-retire")).toEqual([]);
    expect(await f.invoke(true)).toMatchObject({ code: 0, result: { reason: "stores-retired", value: { removed: [entry] } } });
    expect(f.box.db.prepare("SELECT project_key FROM projects").all()).toEqual([]);
    expect(existsSync(entry.path)).toBe(true);
    expect(f.foreign.db.prepare("SELECT machine_id,store_key FROM roam_meta WHERE id=1").get()).toEqual({ machine_id: OLD, store_key: f.foreign.storeKey });
    expect(listStoreKeys(f.box.db)).toEqual(["global"]);
    const audit = localEntries<{ removed: unknown[] }>(f.box.db, "store-retire");
    expect(audit).toHaveLength(1);
    expect(audit[0].value.removed).toEqual([
      expect.objectContaining({ ...entry, machineId: OLD, table: "projects", row: expect.objectContaining({ project_key: "foreign" }) }),
    ]);
    expect(await f.invoke(true)).toMatchObject({ code: 0, result: { value: { removed: [] } } });
    expect(localEntries(f.box.db, "store-retire")).toHaveLength(1);
  } finally { f.revocations.close(); }
});

it("refuses an unknown foreign owner even with confirmation", async () => {
  const f = fixture();
  try {
    expect(await f.invoke(true)).toMatchObject({ code: 1, result: { reason: "stores-retire-refused", value: {
      removed: [], unavailable: [expect.objectContaining({ check: "machine-not-retired" })],
    } } });
    expect(f.box.db.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "foreign" }]);
    expect(localEntries(f.box.db, "store-retire")).toEqual([]);
  } finally { f.revocations.close(); }
});

it("retires proven foreign stores while retaining unrelated missing registrations", async () => {
  const f = fixture();
  try {
    revokeMachine(f.revocations, OLD);
    f.box.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('missing',?,?,1,1)")
      .run(f.box.root, join(f.box.root, "missing.db"));
    expect(await f.invoke(true)).toMatchObject({ code: 1, result: { reason: "stores-retire-refused", value: {
      removed: [{ key: "project:foreign", path: f.foreign.db.raw.name }], unavailable: [expect.objectContaining({ check: "path-unavailable" })],
    } } });
    expect(f.box.db.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "missing" }]);
    expect(existsSync(f.foreign.db.raw.name)).toBe(true);
  } finally { f.revocations.close(); }
});

it("retires a foreign repository reference without deleting its local worktree registration", async () => {
  const f = fixture(), repository = replica("repo", OLD), local = replica("worktree", BOX);
  try {
    revokeMachine(f.revocations, OLD);
    mkdirSync(join(repository.root, "spider"), { mode: 0o700 });
    await repository.db.raw.backup(join(repository.root, "spider", "repo.db"));
    f.box.db.prepare("UPDATE projects SET db_path=?,git_common_dir=? WHERE project_key='foreign'").run(local.db.raw.name, repository.root);
    expect(await f.invoke(true)).toMatchObject({ code: 0, result: { value: { removed: [
      { key: "repository:foreign", path: join(repository.root, "spider", "repo.db") },
    ] } } });
    expect(f.box.db.prepare("SELECT project_key,db_path,git_common_dir FROM projects").get()).toEqual({ project_key: "foreign", db_path: local.db.raw.name, git_common_dir: null });
    expect(existsSync(join(repository.root, "spider", "repo.db"))).toBe(true);
  } finally { f.revocations.close(); }
});

it("retires a mapped foreign worktree and retains the full mapping and redirect in its audit", async () => {
  const f = fixture(), key = f.foreign.storeKey;
  try {
    revokeMachine(f.revocations, OLD);
    f.box.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','fixture-workspace',?)").run(f.foreign.root);
    writeLocal(f.box.db, "mapping-redirect", key, f.foreign.db.raw.name);
    expect(await f.invoke(true)).toMatchObject({ code: 0, result: { value: { removed: [
      { key: "project:foreign", path: f.foreign.db.raw.name }, { key, path: f.foreign.db.raw.name },
    ] } } });
    expect(f.box.db.prepare("SELECT * FROM roam_workspace_maps").all()).toEqual([]);
    expect(readLocal(f.box.db, "mapping-redirect", key)).toBeUndefined();
    expect(localEntries<{ removed: unknown[] }>(f.box.db, "store-retire")[0].value.removed).toContainEqual(expect.objectContaining({
      table: "roam_workspace_maps", redirect: f.foreign.db.raw.name, row: expect.objectContaining({ path: f.foreign.root }),
    }));
  } finally { f.revocations.close(); }
});

it.each(["home", "action"])("keeps a retired-owner store required by a current %s", async mode => {
  const f = fixture();
  try {
    revokeMachine(f.revocations, OLD);
    f.box.db.prepare("INSERT INTO roam_locations(session_id,stores_json) VALUES ('session-current',?)").run(JSON.stringify([f.foreign.storeKey]));
    if (mode === "home") f.box.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at) VALUES ('session-current',?,2,1)").run(BOX);
    else f.box.db.prepare("INSERT INTO roam_home_actions(move_id,session_id,expected_epoch,args_digest) VALUES ('move-current','session-current',1,'fixture')").run();
    expect(await f.invoke(true)).toMatchObject({ code: 1, result: { value: { removed: [], unavailable: [expect.objectContaining({ check: "session-in-use" })] } } });
    expect(f.box.db.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "foreign" }]);
    expect(localEntries(f.box.db, "store-retire")).toEqual([]);
  } finally { f.revocations.close(); }
});

it("refuses a live enrolled owner even if its store is on a different machine", async () => {
  const f = fixture();
  try {
    f.config.peers.push({ ...f.config.peers[0], machineId: OLD, alias: "live.invalid" });
    writeFileSync(join(f.hub.root, "roam", "config.json"), JSON.stringify(f.config), { mode: 0o600 });
    expect(await f.invoke(true)).toMatchObject({ code: 1, result: { value: { removed: [], unavailable: [expect.objectContaining({ check: "machine-not-retired" })] } } });
    expect(f.box.db.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "foreign" }]);
  } finally { f.revocations.close(); }
});

it("refuses a retirement attestation from anyone other than the enrolled hub", async () => {
  const f = fixture();
  try {
    const result = await handleAgentOperation({ id: "forged-retirement", kind: "stores-retire", machineId: BOX, expectedEpoch: null,
      args: { sourceMachine: OLD, retiredMachines: [OLD], confirm: true } }, f.ports);
    expect(result.code).toBe(2);
    expect(f.box.db.prepare("SELECT project_key FROM projects").all()).toEqual([{ project_key: "foreign" }]);
    expect(localEntries(f.box.db, "store-retire")).toEqual([]);
  } finally { f.revocations.close(); }
});

it("supports hub-local repair while roaming is disabled", async () => {
  const f = fixture();
  try {
    revokeMachine(f.revocations, OLD);
    f.hub.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('foreign',?,?,1,1)").run(f.foreign.root, f.foreign.db.raw.name);
    expect(await f.invoke(true, HUB)).toMatchObject({ code: 0, result: { reason: "stores-retired", value: { removed: [{ key: "project:foreign", path: f.foreign.db.raw.name }] } } });
    expect(f.hub.db.prepare("SELECT project_key FROM projects").all()).toEqual([]);
    expect(localEntries(f.hub.db, "store-retire")).toHaveLength(1);
  } finally { f.revocations.close(); }
});

it("retains a foreign project when deleting it would drop a repository required by a current home", async () => {
  const f = fixture(), repository = replica("repo", BOX);
  try {
    revokeMachine(f.revocations, OLD);
    mkdirSync(join(repository.root, "spider"), { mode: 0o700 });
    await repository.db.raw.backup(join(repository.root, "spider", "repo.db"));
    f.box.db.prepare("UPDATE projects SET git_common_dir=? WHERE project_key='foreign'").run(repository.root);
    f.box.db.prepare("INSERT INTO roam_locations(session_id,stores_json) VALUES ('session-current',?)").run(JSON.stringify([repository.storeKey]));
    f.box.db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,updated_at) VALUES ('session-current',?,2,1)").run(BOX);
    expect(await f.invoke(true)).toMatchObject({ code: 1, result: { value: { removed: [], unavailable: [expect.objectContaining({ key: "project:foreign", check: "session-in-use" })] } } });
    expect(f.box.db.prepare("SELECT project_key,git_common_dir FROM projects").get()).toEqual({ project_key: "foreign", git_common_dir: repository.root });
    expect(localEntries(f.box.db, "store-retire")).toEqual([]);
  } finally { f.revocations.close(); }
});

it("plain doctor names the exact hub retirement command", async () => {
  const f = fixture();
  try {
    f.hub.db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('foreign',?,?,1,1)").run(f.foreign.root, f.foreign.db.raw.name);
    await f.hub.db.raw.backup(join(f.hub.root, "spider.db"));
    const out: string[] = [];
    await main(["roam", "doctor"], { out: text => out.push(text), err: text => out.push(text) });
    const text = out.join("");
    expect(text).toContain("store-uninspectable:worktree:store-machine-mismatch");
    expect(text).toContain(`spider roam stores retire ${HUB}`);
  } finally { f.revocations.close(); }
});
