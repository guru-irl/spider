import { network } from "./sync-fixture";
import { createSync } from "../sync";
import * as staging from "../staging";
import { migrate, openDb } from "@spider/db-core";
import { localEntries, writeLocal } from "@spider/db-core/roam/local-state";
import { HerdrError, selectedSocket } from "@spider/herdr/client/parse";
import { disabledIntercom } from "../contracts";
import * as remoteObservations from "../remote-observations";
import * as diagnostics from "../diagnostics";
import * as launchd from "../launchd";
import { peerEnabledDiagnostics, setEnrolledPeerEnabled } from "../peer-enabled";
import { openJournal } from "../journal";
import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { main } from "../cli";
import { startHubControl, type HubControlReply, type HubControlRequest } from "../control-socket";
import * as productionHub from "../production-hub";
import * as localRuntime from "../runtime";
import * as agent from "../agent";
import * as transportModule from "../transport";
import * as hosting from "../production-supervisor";
import * as hubRuntime from "../hub";
import * as intercomRuntime from "../intercom-runtime";
import * as localDiagnostics from "../local-diagnostics";
import * as appModule from "@spider/herdr/client/app";
import * as hcModule from "@spider/herdr/client/hc";
import { createClientFixture } from "../../../herdr/src/__tests__/testutil";

const unavailableMove = async (): Promise<never> => { throw new Error("intercom-move-unavailable"); };
const movePort = { broker: unavailableMove, bridge: unavailableMove, settlement: unavailableMove, endpoint: unavailableMove, releaseRollbackFence: unavailableMove,
  intake: { close: unavailableMove, drain: unavailableMove, inspect: unavailableMove, checkGeneration: unavailableMove, abort: unavailableMove, ready: unavailableMove } };
const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
const sockets: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) await socket.close();
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(identity = HUB, reply?: HubControlReply, withSocket = true) {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "r26-")); roots.push(root);
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId: identity }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({ enabled: true, role: "hub", machineId: HUB,
    hubMachineId: HUB, peers: [{ machineId: BOX, alias: "-box-1.invalid", node: "/fixture/node", pi: "/fixture/pi",
      cli: "/fixture/spider", core: "/fixture/core", globalRoot: "/fixture/global" }], discoveryRoots: [], coreUnit: "fixture" }), { mode: 0o600 });
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  const calls: HubControlRequest[] = [];
  if (withSocket) {
    const socket = await startHubControl(join(root, "roam", "hub.sock"), async request => {
      calls.push(request);
      return reply ?? { code: 0, reason: "Synchronization complete", value: { outcomes: [] } };
    });
    sockets.push(socket);
  }
  const out: string[] = [], err: string[] = [];
  return { root, calls, out, err, invoke: (args: string[]) => main(args, { out: text => out.push(text), err: text => err.push(text) }) };
}

it.each([true, false])("public doctor reports installed core drift when enabled=%s", async enabled => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = enabled; config.peers = [];
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const plistDir = join(f.root, "Library/LaunchAgents"), ports = { plistDir, async launchctl() {} };
  vi.stubEnv("HC_SOCKET", join(f.root, "selected.sock")); vi.stubEnv("HC_SESSION", "team");
  await launchd.installHubService({ node: process.execPath, cli: process.execPath, globalRoot: f.root, pi: process.execPath }, ports);
  vi.stubEnv("HC_SOCKET", join(f.root, "changed.sock"));
  await f.invoke(["roam", "doctor", "--json"]);
  const first = JSON.parse(f.out.join(""));
  expect(first.value.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("hub-core-selection-mismatch"), repairCommand: "spider roam enable" })]));
  await launchd.installHubService({ node: process.execPath, cli: process.execPath, globalRoot: f.root, pi: process.execPath }, ports);
  f.out.length = 0; await f.invoke(["roam", "doctor", "--json"]);
  expect(JSON.parse(f.out.join("")).value.diagnostics.filter((row: { reason: string }) => row.reason.includes("hub-core-selection"))).toEqual([]);
});

it("rejects an invalid core selection before enable contacts peers or changes state", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json"), before = readFileSync(file, "utf8");
  vi.stubEnv("HC_SOCKET", "relative.sock");
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  const transport = vi.spyOn(transportModule, "createTransport").mockImplementation(() => { throw new Error("unexpected peer work"); });
  expect(await f.invoke(["roam", "enable", "--json"])).toBe(1);
  expect(transport).not.toHaveBeenCalled();
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ reason: "enable-unavailable" });
  expect(await f.invoke(["roam", "enable"])).toBe(1);
  expect(f.err.join("")).toContain("Invalid hc socket selection: an absolute path");
});

it.each(["missing", "invalid"] as const)("remote doctor reports %s local configuration without inventing a peer failure", async mode => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  if (mode === "missing") unlinkSync(file);
  else writeFileSync(file, "not JSON", { mode: 0o600 });
  expect(await f.invoke(["roam", "doctor", "box-1.invalid"])).toBe(1);
  expect(f.err.join("")).toMatch(/remote doctor.*unavailable/i);
  expect(f.err.join("")).toContain("roaming-config-unavailable");
  expect(f.err.join("")).not.toContain("peer-");
  expect(await f.invoke(["roam", "doctor", "box-1.invalid", "--json"])).toBe(1);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ reason: "roaming-config-unavailable", repairCommand: "spider roam doctor" });
}, 5000);

it("remote doctor reports an unenrolled machine without inventing a peer failure", async () => {
  const f = await fixture(HUB, undefined, false);
  expect(await f.invoke(["roam", "doctor", "other.invalid"])).toBe(2);
  expect(f.err.join("")).toMatch(/remote doctor.*unavailable/i);
  expect(f.err.join("")).toContain("machine-not-enrolled");
  expect(f.err.join("")).not.toContain("peer-");
  expect(await f.invoke(["roam", "doctor", "other.invalid", "--json"])).toBe(2);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ reason: "machine-not-enrolled" });
}, 5000);

it("doctor warns with missing store paths and prune removes only missing registrations once", async () => {
  const f = await fixture(HUB, undefined, false), db = openDb(join(f.root, "spider.db"));
  migrate(db, "global", { machineId: HUB, globalRoot: f.root });
  const gone = join(f.root, "gone", ".spider", "project.db"), common = join(f.root, "gone", ".git");
  mkdirSync(join(f.root, "gone", ".spider"), { recursive: true }); mkdirSync(join(common, "spider"), { recursive: true });
  mkdirSync(join(f.root, "missing-common", "spider"), { recursive: true });
  db.prepare("INSERT INTO projects(project_key,real_path,db_path,git_common_dir,created_at,last_seen_at) VALUES ('gone',?,?,?,1,1)")
    .run(join(f.root, "gone"), gone, common);
  db.prepare("INSERT INTO projects(project_key,real_path,db_path,git_common_dir,created_at,last_seen_at) VALUES ('live',?,?,?,1,1)").run(f.root, db.raw.name, join(f.root, "missing-common"));
  const planned = join(f.root, "planned"); mkdirSync(planned);
  db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','planned',?)").run(planned);
  const report = await localDiagnostics.runLocalDoctor({ root: f.root });
  const missing = report.diagnostics.filter(row => row.reason.startsWith("store-missing:"));
  expect(missing).toEqual(expect.arrayContaining([
    expect.objectContaining({ severity: "warning", reason: expect.stringContaining(gone), repairCommand: expect.stringContaining("Restore or mount") }),
    expect.objectContaining({ severity: "warning", reason: expect.stringContaining(join(common, "spider", "repo.db")) }),
    expect.objectContaining({ severity: "warning", reason: expect.stringContaining(join(planned, ".spider", "project.db")) }),
  ]));
  expect(report.diagnostics.filter(row => row.severity === "block" && /cannot inspect/i.test(row.reason))).toEqual([]);
  expect(await f.invoke(["roam", "stores", "prune", "--json"])).toBe(0);
  expect(db.prepare("SELECT project_key FROM projects ORDER BY project_key").all()).toEqual([{ project_key: "gone" }, { project_key: "live" }]);
  expect(JSON.parse(f.out.join("")).value).toMatchObject({ candidates: [expect.objectContaining({ path: gone }), expect.objectContaining({ key: "repository:live", path: join(f.root, "missing-common", "spider", "repo.db") })], removed: [] });
  f.out.length = 0;
  expect(await f.invoke(["roam", "stores", "prune", "--confirm", "--json"])).toBe(0);
  expect(db.prepare("SELECT project_key FROM projects ORDER BY project_key").all()).toEqual([{ project_key: "live" }]);
  expect(db.prepare("SELECT git_common_dir FROM projects WHERE project_key='live'").get()).toEqual({ git_common_dir: null });
  expect(db.prepare("SELECT path FROM roam_workspace_maps").all()).toEqual([{ path: planned }]);
  const audit = localEntries(db, "store-prune");
  expect(audit).toHaveLength(1);
  expect(await f.invoke(["roam", "stores", "prune", "--json"])).toBe(0);
  expect(localEntries(db, "store-prune")).toEqual(audit);
  db.close();
}, 5000);

it.each(["missing", "corrupt", "transport", "process", "timeout", "invalid-doctor", "missing-hc", "spawn-error", "spawn_failed", "core-unavailable"] as const)("enable and doctor distinguish a %s store peer from an unreachable box", async mode => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers[0].alias = "box-1.invalid";
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const remote = join(f.root, "remote"); mkdirSync(join(remote, "roam"), { recursive: true });
  writeFileSync(join(remote, "roam", "config.json"), JSON.stringify({ ...config, machineId: BOX, role: "box", peers: [] }), { mode: 0o600 });
  const db = openDb(join(remote, "spider.db")); migrate(db, "global", { machineId: BOX, globalRoot: remote });
  const common = join(remote, "deleted", ".git");
  db.prepare("INSERT INTO projects(project_key,real_path,db_path,git_common_dir,created_at,last_seen_at) VALUES ('gone',?,?,?,1,1)")
    .run(join(remote, "deleted"), join(remote, "deleted", ".spider", "project.db"), common);
  if (mode === "corrupt") { mkdirSync(join(common, "spider"), { recursive: true }); writeFileSync(join(common, "spider", "repo.db"), "not sqlite"); }
  db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','planned',?)").run(join(remote, "planned"));
  const ports = { config: { ...localRuntime.readLocalIdentity(f.root), machineId: BOX, role: "box" as const, peers: [], intercom: disabledIntercom() },
    root: join(remote, "roam", "staging"), journal: openJournal(join(remote, "roam", "journal.db")), openStore() { return { db }; } };
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) {
    if (mode === "transport") throw new HerdrError("machine-not-found", "unreachable");
    if (["missing-hc", "spawn-error", "spawn_failed", "core-unavailable"].includes(mode)) throw new HerdrError(mode, "private stderr"); return peer;
  }, async exec(_peer: unknown, argv: string[]) {
    if (mode === "process") throw new HerdrError("cli-exit", "private stderr", { exitCode: 1 });
    if (mode === "timeout") throw new HerdrError("cli-timeout", "private stderr");
    if (argv[1] === "agent") return Buffer.from(JSON.stringify(await agent.handleAgentOperation(JSON.parse(argv[2]), ports as never)));
    if (mode === "invalid-doctor") return Buffer.from("{}");
    return Buffer.from(JSON.stringify({ version: 1, machineId: BOX, kind: "doctor", value: await localDiagnostics.runLocalDoctor({ root: remote }) }));
  } } as never);
  expect(await f.invoke(["roam", "enable", "--json"])).toBe(1);
  const enabled = f.out.join("");
  if (mode === "transport") expect(enabled).toContain("box-unreachable:box-1.invalid");
  else {
    expect(enabled).not.toContain("box-unreachable"); expect(enabled).not.toContain("spider roam forget");
    if (mode === "corrupt") {
      expect(enabled).not.toContain("store-inventory-incomplete");
      expect(JSON.parse(enabled).value.information).toContainEqual({ machine: "box-1.invalid", reason: `corrupt:repo: ${join(common, "spider", "repo.db")}` });
    }
    if (["missing-hc", "spawn-error", "spawn_failed", "core-unavailable"].includes(mode)) expect(enabled).toContain("preflight-failed:box-1.invalid:local-herdr-unavailable");
    if (mode === "process") expect(enabled).toContain("preflight-failed:box-1.invalid:peer-command-failed");
    if (mode === "timeout") expect(enabled).toContain("preflight-failed:box-1.invalid:peer-command-timeout");
    if (mode === "invalid-doctor") expect(enabled).toContain("preflight-failed:box-1.invalid:peer-response-invalid");
  }
  f.out.length = 0;
  if (["transport", "process", "invalid-doctor"].includes(mode)) {
    expect(await f.invoke(["roam", "doctor", "box-1.invalid"])).toBe(1);
    const text = f.err.join("");
    const reason = mode === "transport" ? "box-unreachable:box-1.invalid" :
      `preflight-failed:box-1.invalid:${mode === "process" ? "peer-command-failed" : "peer-response-invalid"}`;
    expect(text).toMatch(/remote doctor.*unavailable/i);
    expect(text).toContain(reason);
    expect(text).not.toContain("private stderr");
  }
  await f.invoke(["roam", "doctor", "box-1.invalid", "--json"]);
  const doctor = f.out.join("");
  if (mode === "transport") expect(doctor).toContain("box-unreachable:box-1.invalid");
  else {
    expect(doctor).not.toContain("box-unreachable"); expect(doctor).not.toContain("spider roam forget");
    if (["missing-hc", "spawn-error", "spawn_failed", "core-unavailable"].includes(mode)) expect(doctor).toContain("preflight-failed:box-1.invalid:local-herdr-unavailable");
    if (mode === "process") expect(doctor).toContain("preflight-failed:box-1.invalid:peer-command-failed");
    if (mode === "timeout") expect(doctor).toContain("preflight-failed:box-1.invalid:peer-command-timeout");
    expect(doctor).not.toContain("private stderr");
    if (mode === "missing") expect(doctor).toContain("store-missing:repo:enoent:");
    if (mode === "corrupt") {
      expect(doctor).toContain("store-uninspectable:repo:sqlite-notadb:");
      const rows = JSON.parse(doctor).value.diagnostics.filter((row: { reason: string }) => row.reason.includes("cannot inspect the registered store"));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row: { reason: string }) => row.reason.includes(join(common, "spider", "repo.db")))).toBe(true);
    }
    if (mode === "invalid-doctor") expect(doctor).toContain("preflight-failed:box-1.invalid:peer-response-invalid");
  }
  db.close();
}, 5000);

it.each([["filesystem", "ENOENT"], ["transport", "cli-timeout"], ["unknown", "unexpected-stores"], ["spoof", "unexpected-stores"]] as const)
("enable preflight keeps the %s agent cause in text and JSON", async (mode, expected) => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers[0].alias = "box-1.invalid";
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const box = { ...localRuntime.readLocalIdentity(f.root), machineId: BOX, role: "box" as const, peers: [] };
  const ports = { config: box, root: join(f.root, "remote-stage"), journal: openJournal(join(f.root, "remote-journal.db")), openStore(): never {
    if (mode === "filesystem") readFileSync(join(f.root, "private-missing-file"));
    if (mode === "transport") throw new HerdrError("cli-timeout", "private exception details");
    throw new Error("private exception details");
  } };
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    const operation = JSON.parse(argv[2]);
    if (mode === "spoof") return Buffer.from(JSON.stringify({ operationId: operation.id, code: 1, reason: "Agent operation failed", causeCode: "private-secret" }));
    return Buffer.from(JSON.stringify(await agent.handleAgentOperation(operation, ports as never)));
  } } as never);
  expect(await f.invoke(["roam", "enable", "--json"])).toBe(1);
  const json = JSON.parse(f.out.join(""));
  expect(json).toMatchObject({ value: { issues: [{ reason: "preflight-failed:box-1.invalid:agent-operation-failed", causeCode: expected }] } });
  expect(JSON.stringify(json)).not.toContain("private exception details");
  expect(JSON.stringify(json)).not.toContain("private-missing-file");
  expect(JSON.stringify(json)).not.toContain("private-secret");
  f.err.length = 0;
  expect(await f.invoke(["roam", "enable"])).toBe(1);
  expect(f.err.join("")).toContain(expected);
  expect(f.err.join("")).not.toContain("private exception details");
  expect(f.err.join("")).not.toContain("private-missing-file");
  expect(f.err.join("")).not.toContain("private-secret");
}, 5000);

it.each([
  ["intercom-fence-mismatch", "Pair pair-old does not match the current fence."],
  ["intercom-revocation-unconfirmed", "Pair pair-old has an unconfirmed revocation."],
] as const)("enable preflight names the blocking pair for %s in text and JSON", async (reason, detail) => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; config.peers[0].alias = "box-1.invalid";
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const before = readFileSync(file);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    const operation = JSON.parse(argv[2]);
    return Buffer.from(JSON.stringify({ operationId: operation.id, code: 0,
      value: { protocol: 1, schema: 14, machineId: BOX, stores: ["global"], ungathered: [] } }));
  } } as never);
  vi.spyOn(remoteObservations, "remoteDoctor").mockResolvedValue({ enabled: false, consumers: [], diagnostics: [
    { severity: "block", reason: `${reason}: Pair pair-old: closure is unconfirmed.`, repairCommand: "spider roam intercom revoke pair-old" },
  ] });
  expect(await f.invoke(["roam", "enable", "--json"])).toBe(1);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ value: { issues: [{ reason: `preflight-failed:box-1.invalid:${reason}`, detail }] } });
  expect(await f.invoke(["roam", "enable"])).toBe(1);
  expect(f.err.join("")).toContain(detail);
  expect(readFileSync(file)).toEqual(before);
});

it("enable pending retains the real peer agent cause after broker startup", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; config.peers[0].alias = "box-1.invalid";
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const local = openDb(join(f.root, "spider.db")); migrate(local, "global", { machineId: HUB, globalRoot: f.root }); local.close();
  const remote = join(f.root, "remote"); mkdirSync(remote, { mode: 0o700 });
  const db = openDb(join(remote, "spider.db")); migrate(db, "global", { machineId: BOX, globalRoot: remote });
  let operationKind = "";
  const ports = { config: { ...localRuntime.readLocalIdentity(f.root), machineId: BOX, role: "box" as const, peers: [] },
    root: join(remote, "stage"), journal: openJournal(join(remote, "journal.db")), openStore() {
      if (operationKind === "enable-capture") readFileSync(join(remote, "private-missing-file"));
      return { db };
    } };
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 });
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl); vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
  vi.spyOn(remoteObservations, "remoteDoctor").mockResolvedValue({ diagnostics: [] } as never);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    if (argv[1] === "intercom") return Buffer.from(JSON.stringify({ kind: "intercom-broker-start", version: 1, ok: true, machineId: BOX, doctor: { enabled: false, diagnostics: [], consumers: [] } }));
    const operation = JSON.parse(argv[2]); operationKind = operation.kind;
    return Buffer.from(JSON.stringify(await agent.handleAgentOperation(operation, ports as never)));
  } } as never);
  try {
    expect(await f.invoke(["roam", "enable", "--json"])).toBe(3);
    const json = JSON.parse(f.out.join(""));
    expect(json).toMatchObject({ reason: "enable-pending", causeCode: "ENOENT" });
    expect(JSON.stringify(json)).not.toContain("private-missing-file");
    expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
  } finally { db.close(); }
}, 5000);

it("help explains recovery, JSON, non-interactive consent and the forget warning", async () => {
  const f = await fixture(HUB, undefined, false);
  expect(await f.invoke(["--help"])).toBe(0);
  const help = f.out.join("");
  for (const word of ["recover", "cancel", "forget", "claim", "--json", "--yes --consent copilot-auth"]) expect(help).toContain(word);
  expect(help).toMatch(/shell access/i); expect(help).toMatch(/two copies can run/i); expect(help).toMatch(/last mirror/i);
  expect(help).toMatch(/disabled.*not.*(hosting|enable)/i);
}, 5000);

it.each(["stop", "resume"])("%s sends a hub-issued operation to the current box home", async action => {
  const f = await fixture();
  const db = { prepare() { return { get() { return { machine_id: BOX, epoch: 3 }; } }; } };
  vi.spyOn(localRuntime, "openLocalCore").mockReturnValue({ root: f.root, db, config: localRuntime.readLocalIdentity(f.root), close() {} } as never);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  const operations: any[] = [];
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: any) { return peer; }, async exec(peer: any, argv: string[]) {
    const operation = JSON.parse(argv[2]); operations.push(operation);
    expect(peer.machineId).toBe(BOX);
    return Buffer.from(JSON.stringify({ code: 0, reason: "intent-updated", operationId: operation.id, home: null, epoch: 3, repairCommand: null, value: null }));
  } } as never);
  expect(await f.invoke(["roam", action, "s-1"])).toBe(0);
  expect(operations).toEqual([expect.objectContaining({ kind: `session-${action}`, machineId: BOX, expectedEpoch: 3, args: { sourceMachine: HUB, sessionId: "s-1" } })]);
}, 5000);

it("disabled stop controls only a session and does not permit resume", async () => {
  const f = await fixture(), file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.enabled = false; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const db = { prepare() { return { get(id: string) { return id === "session-a" ? { machine_id: BOX, epoch: 3 } : undefined; } }; } };
  vi.spyOn(localRuntime, "openLocalCore").mockReturnValue({ root: f.root, db, config: localRuntime.readLocalIdentity(f.root), close() {} } as never);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  const operations: any[] = [];
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    const op = JSON.parse(argv[2]); operations.push(op);
    return Buffer.from(JSON.stringify({ code: 0, reason: "stopped", operationId: op.id, home: null, epoch: 3, repairCommand: null, value: null }));
  } } as never);
  expect(await f.invoke(["roam", "stop", "session-a"])).toBe(0);
  expect(await f.invoke(["roam", "resume", "session-a"])).toBe(1);
  expect(await f.invoke(["roam", "stop", BOX])).toBe(1);
  expect(operations).toEqual([expect.objectContaining({ kind: "session-stop", args: { sourceMachine: HUB, sessionId: "session-a" } })]);
}, 5000);

it("stop JSON returns the production participant refusal and its actual home and epoch", async () => {
  const f = await fixture(), db = { prepare() { return { get() { return { machine_id: BOX, epoch: 3 }; } }; } };
  vi.spyOn(localRuntime, "openLocalCore").mockReturnValue({ root: f.root, db, config: localRuntime.readLocalIdentity(f.root), close() {} } as never);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  const home = { sessionId: "s-1", machineId: BOX, epoch: 5, moveId: null, updatedAt: 123 };
  let operationId = "";
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    operationId = JSON.parse(argv[2]).id;
    return Buffer.from(JSON.stringify({ code: 1, reason: "participant-home-mismatch", operationId, home, epoch: 5, repairCommand: "spider roam doctor", value: null }));
  } } as never);
  expect(await f.invoke(["roam", "stop", "s-1", "--json"])).toBe(1);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ code: 1, reason: "participant-home-mismatch", operationId, home, epoch: 5, repairCommand: "spider roam doctor" });
  expect(operationId).not.toBe("");
}, 5000);

it.each(["0", false, null])("refuses a control reply with nonnumeric code %s", async code => {
  const f = await fixture(), db = { prepare() { return { get() { return { machine_id: BOX, epoch: 3 }; } }; } };
  vi.spyOn(localRuntime, "openLocalCore").mockReturnValue({ root: f.root, db, config: localRuntime.readLocalIdentity(f.root), close() {} } as never);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    const operation = JSON.parse(argv[2]); return Buffer.from(JSON.stringify({ code, reason: "forged success", operationId: operation.id }));
  } } as never);
  expect(await f.invoke(["roam", "stop", "s-1"])).toBe(1);
  expect(f.out).toEqual([]); expect(f.err.join("")).toContain("Participant control is unavailable");
  expect(f.err.join("")).not.toContain("forged success");
}, 5000);

it("prints and serializes the exact validated blockers and explanation from a real move refusal", async () => {
  const refusal = { code: 1, reason: "move-preflight-blocked", operationId: "move-a", home: null, epoch: null, repairCommand: null, value: null,
    refusal: { code: "move-preflight-blocked", blockers: ["outbound-ask:a8f3", "receipt:abc"], message: "Unsettled work blocks this move." } };
  const f = await fixture(HUB, refusal as HubControlReply);
  expect(await f.invoke(["move", "session-a", "box-1.invalid", "--json"])).toBe(1);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ reason: refusal.reason, operationId: "move-a", refusal: refusal.refusal });
  f.out.length = 0; f.err.length = 0;
  expect(await f.invoke(["move", "session-a", "box-1.invalid"])).toBe(1);
  expect(f.err.join("")).toContain("Unsettled work blocks this move.");
  expect(f.err.join("")).toContain("outbound-ask:a8f3"); expect(f.err.join("")).toContain("receipt:abc");
}, 5000);

it("retains safe worktree adjustments and redacted key names without leaking arbitrary warning text", async () => {
  const reply: HubControlReply = { code: 0, reason: "moved", operationId: "move-a", home: null, epoch: null, repairCommand: null,
    value: { terminal: "terminal-a", intercomAddress: "session-a@box.invalid", warnings: ["tool-auth-unverified", "user.name", "http.<redacted>.extraheader",
      "sparse-cone-defaulted-to-false", "SECRET SENTINEL", "raw:conversation-body"] } };
  const f = await fixture(HUB, reply);
  expect(await f.invoke(["move", "session-a", "box-1.invalid", "--json"])).toBe(0);
  const result = JSON.parse(f.out.join(""));
  expect(result.value.warnings).toEqual(["tool-auth-unverified", "user.name", "http.<redacted>.extraheader", "sparse-cone-defaulted-to-false"]);
  expect(f.out.join("")).not.toContain("SECRET SENTINEL"); expect(f.out.join("")).not.toContain("raw:conversation-body");
}, 5000);

it("private hosting observation invokes the producer with the explicit root", async () => {
  const f = await fixture();
  const producer = vi.spyOn(hosting, "observeLocalHosting").mockResolvedValue({ readiness: [], suspensions: [{ sessionId: "s-1", epoch: 2 }] });
  expect(await f.invoke(["roam", "observe", "hosting"])).toBe(0);
  expect(producer).toHaveBeenCalledWith(f.root);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ version: 1, machineId: HUB, kind: "hosting", value: { suspensions: [{ sessionId: "s-1", epoch: 2 }] } });
}, 5000);

it.each([1, 2])("keeps early launch warnings compatible with an older hosting observer: count %s", async count => {
  const f = await fixture(HUB, undefined, false);
  const early = { sessionId: "s-1", code: "supervisor-hosting-error" as const, check: "launch" as const, since: 1, count,
    causeCode: "participant-exited-before-readiness", exitCode: 23 };
  const persistent = { sessionId: "s-2", code: "supervisor-hosting-error" as const, check: "inspection" as const, since: 2, count: 3 };
  const readiness = { origin: "hub-operation" as const, opId: "op-1", sessionId: "s-2", epoch: 1,
    file: "/home/fixture/session.jsonl", cwd: "/home/fixture/work", core: "core-1", terminal: "terminal-1" };
  vi.spyOn(hosting, "observeLocalHosting").mockResolvedValue({ readiness: [readiness], suspensions: [], warnings: [early, persistent] });
  expect(await f.invoke(["roam", "observe", "hosting"])).toBe(0);
  const value = JSON.parse(f.out.join("")).value;
  expect(value.readiness).toEqual([readiness]);
  expect(value.warnings).toEqual([persistent]);
  expect(value.earlyWarnings).toEqual([early]);
}, 5000);

it("a current hub reads early warnings without accepting private or malformed peer fields", async () => {
  const f = await fixture(HUB, undefined, false), config = localRuntime.readLocalIdentity(f.root), peer = config.peers[0];
  const early = { sessionId: "s-1", code: "supervisor-hosting-error", check: "launch", since: 1, count: 1,
    causeCode: "participant-exited-before-readiness", exitCode: 23 };
  const persistent = { sessionId: "s-2", code: "supervisor-hosting-error", check: "inspection", since: 2, count: 3 };
  const readiness = { origin: "hub-operation", opId: "op-1", sessionId: "s-2", epoch: 1,
    file: "/home/fixture/session.jsonl", cwd: "/home/fixture/work", core: "core-1", terminal: "terminal-1" };
  let value: unknown = { readiness: [readiness], suspensions: [], warnings: [persistent],
    earlyWarnings: [{ ...early, message: "private detail" }] };
  const transport = { async resolve() { return peer; }, async exec() {
    return Buffer.from(JSON.stringify({ version: 1, machineId: peer.machineId, kind: "hosting", value }));
  } } as never;
  const observed = await remoteObservations.remoteHosting(transport, peer, config);
  expect(observed).toEqual({ readiness: [{ ...readiness, terminal: `${peer.alias}/terminal-1` }], suspensions: [], warnings: [persistent, early] });
  expect(JSON.stringify(observed)).not.toContain("private detail");
  value = { readiness: [readiness], suspensions: [], earlyWarnings: [early] };
  expect((await remoteObservations.remoteHosting(transport, peer, config)).warnings).toEqual([early]);
  value = { readiness: [readiness], suspensions: [], warnings: [persistent] };
  expect((await remoteObservations.remoteHosting(transport, peer, config)).warnings).toEqual([persistent]);
  value = { readiness: [readiness], suspensions: [] };
  expect((await remoteObservations.remoteHosting(transport, peer, config)).warnings).toBeUndefined();
  for (const invalid of [
    [{ ...early, causeCode: "private detail" }], [{ ...early, exitCode: 256 }], [{ ...early, count: 3 }],
    [{ ...early, sessionId: "s-2" }], "invalid",
  ]) {
    value = { readiness: [readiness], suspensions: [], warnings: [persistent], earlyWarnings: invalid };
    await expect(remoteObservations.remoteHosting(transport, peer, config)).rejects.toThrow();
  }
}, 5000);

it.each([
  ["agent", ["roam", "agent", "{}"]],
  ["artifact receiver", ["roam", "artifact", "receive", "{}"]],
])("the private %s never writes an outcome when cleanup fails", async (_kind, argv) => {
  const f = await fixture();
  vi.spyOn(localRuntime, "openLocalRuntime").mockReturnValue({
    agent: {}, config: { role: "box", hubMachineId: HUB, limits: {} }, close() { throw new Error("cleanup failed"); },
  } as never);
  vi.spyOn(agent, "handleAgentOperation").mockResolvedValue({ code: 0, reason: "complete" } as never);
  vi.spyOn(agent, "dispatchArtifactCommand").mockResolvedValue(Buffer.from('{"code":0}'));
  expect(await f.invoke(argv)).toBe(1);
  expect(f.out).toEqual([]);
  expect(f.err.join("")).toContain("Local roaming agent is unavailable");
}, 5000);

it("sync JSON retains the real per-peer typed outcomes and receipts", async () => {
  const receipt = { batchId: "batch-a", stream: "stream-a", through: 7, sha256: "a".repeat(64), applyMs: 42 };
  const rows = [
    { code: 0, reason: "pushed", operationId: "push-a", home: null, epoch: null, repairCommand: null, value: receipt },
    { code: 1, reason: "Peer store is quarantined", operationId: "pull-a", home: null, epoch: null, repairCommand: null, value: null },
  ];
  const f = await fixture(HUB, { code: 1, reason: "Synchronization needs attention", value: { outcomes: rows } });
  expect(await f.invoke(["roam", "sync", "--json"])).toBe(1);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ reason: "Synchronization needs attention", value: { outcomes: rows } });
}, 5000);

it("enabled forget JSON includes the recovered homes and presentation status", async () => {
  const home = { sessionId: "s-1", machineId: HUB, epoch: 4, moveId: null, updatedAt: 123 };
  const f = await fixture(HUB, { code: 0, reason: "destroyed-machine-recovered", operationId: "forget-a", home: null, epoch: null, repairCommand: null,
    value: { presentation: "pending", homes: [home] } });
  expect(await f.invoke(["roam", "forget", BOX, "--confirm", `destroyed ${BOX}`, "--json"])).toBe(0);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ reason: "destroyed-machine-recovered", operationId: "forget-a", value: { presentation: "pending", homes: [home] } });
}, 5000);

it("sync prints the bounded agent cause without exposing an unrecognized code", async () => {
  const f = await fixture(HUB, { code: 1, reason: "Synchronization needs attention", value: {
    outcomes: [{ code: 1, reason: "agent-operation-failed", operationId: "op-a", home: null, epoch: null, repairCommand: null, value: null, causeCode: "ENOENT" },
      { code: 1, reason: "agent-operation-failed", operationId: "op-b", home: null, epoch: null, repairCommand: null, value: null, causeCode: "private-secret" }],
  } });
  expect(await f.invoke(["roam", "sync"])).toBe(1);
  expect(f.err.join("")).toContain("ENOENT");
  expect(f.err.join("")).not.toContain("private-secret");
  f.out.length = 0;
  expect(await f.invoke(["roam", "sync", "--json"])).toBe(1);
  const rows = JSON.parse(f.out.join("")).value.outcomes;
  expect(rows[0].causeCode).toBe("ENOENT");
  expect(rows[1]).not.toHaveProperty("causeCode");
}, 5000);

it("sync shows the failed operation kind and answered refusal without untrusted identifiers", async () => {
  const f = await fixture(HUB, { code: 1, reason: "Synchronization needs attention", value: { outcomes: [
    { code: 1, reason: "agent-operation-failed", operationId: "op-a", operationKind: "stores", causeCode: "ENOENT" },
    { code: 1, reason: "roaming-disabled", operationId: "op-b", operationKind: "mirror-export" },
    { code: 1, reason: "agent-operation-failed", operationId: "op-c", operationKind: "private-secret", causeCode: "private-secret" },
  ] } });
  expect(await f.invoke(["roam", "sync"])).toBe(1);
  expect(f.err.join("")).toContain("stores: agent-operation-failed [ENOENT]");
  expect(f.err.join("")).toContain("mirror-export: roaming-disabled");
  expect(f.err.join("")).not.toContain("private-secret");
  f.out.length = 0;
  expect(await f.invoke(["roam", "sync", "--json"])).toBe(1);
  const rows = JSON.parse(f.out.join("")).value.outcomes;
  expect(rows[0]).toMatchObject({ operationId: "op-a", operationKind: "stores", causeCode: "ENOENT" });
  expect(rows[1]).toMatchObject({ operationId: "op-b", operationKind: "mirror-export", reason: "roaming-disabled" });
  expect(rows[2]).not.toHaveProperty("operationKind");
  expect(JSON.stringify(rows)).not.toContain("private-secret");
}, 5000);

it("sync prints a named peer process failure from the hub outcome", async () => {
  const f = await fixture(HUB, { code: 1, reason: "Synchronization needs attention", value: {
    outcomes: [{ code: 1, reason: "Peer command failed (spawn_failed)" }],
  } });
  expect(await f.invoke(["roam", "sync", "--", "-box-1.invalid"])).toBe(1);
  expect(f.err.join("")).toContain("spawn_failed");
}, 5000);

it("remote doctor reports a failed peer process rather than a generic unavailable message", async () => {
  const f = await fixture(), hc = await createClientFixture();
  try {
    for (const key of ["HC_SESSION", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SOCKET", "HERDR_FAKE_ROOT"] as const)
      vi.stubEnv(key, hc.localEnv[key]!);
    vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: hc.hcBinary } } as never);
    const alias = "-box-1.invalid";
    await hc.configure({ machines: [{ id: "remote-core", name: alias, host: "box-1.invalid", target: "box-1.invalid", via: false }],
      roamFixture: { execReplyBase64: Buffer.from('{"version":1}').toString("base64"), execExitCode: 1 } });
    await hc.writeRoamFile(alias, "/fixture/global/roam/machine.json", Buffer.from(JSON.stringify({ machineId: BOX })));
    expect(await f.invoke(["roam", "doctor", "--", alias])).toBe(1);
    expect(f.err.join("")).toContain("Peer command failed (exit 1)");
  } finally { await hc.close(); }
}, 5000);

it("production hub composes intercom independently from replication peers", async () => {
  const f = await fixture(), agentDir = join(f.root, "agent"); mkdirSync(agentDir, { mode: 0o700 });
  const config = localRuntime.readLocalIdentity(f.root), other = { ...config.peers[0], machineId: "00000000-0000-4000-8000-000000000003", alias: "other.invalid" };
  config.intercom = { enabled: true, mode: "peers", machineAlias: "hub.invalid", protocolFeature: "federation-v1",
    routes: [{ kind: "direct", peer: other, edgeEpoch: "edge-1" }], limits: { queueMessages: 500, queueBytes: 5242880 } };
  const order: string[] = [], bridge = { async start() { order.push("bridge-start"); }, async stop() { order.push("bridge-stop"); },
    diagnostics() { return []; }, move: movePort, readiness() { return { state: "ready" as const, reason: null }; } };
  const factory = vi.spyOn(intercomRuntime, "createMachineIntercom").mockReturnValue(bridge);
  vi.spyOn(localRuntime, "openLocalCore").mockReturnValue({ root: f.root, config, db: {}, close() { order.push("core-close"); } } as never);
  mkdirSync(join(f.root, "herdr"), { mode: 0o700 });
  writeFileSync(join(f.root, "herdr", "config.json"), JSON.stringify({ mode: "full", agentDirectory: agentDir, globalRoot: f.root,
    core: { binary: "/fixture/hc", config: "/fixture/core" }, app: { binary: "/fixture/app", home: "/fixture/home" }, shellRc: "/fixture/rc", spaces: [], machines: [] }), { mode: 0o600 });
  vi.spyOn(localDiagnostics, "createLocalDiagnosticPorts").mockReturnValue({ async probeProcess() { return { kind: "live", startIdentity: "fixture-process" }; } } as never);
  const legacyLaunch = vi.fn();
  vi.spyOn(hcModule, "createHcClient").mockReturnValue({ run: legacyLaunch, async dispose() {} } as never);
  const app = vi.spyOn(appModule, "createAppClient").mockReturnValue({} as never);
  const transport = vi.spyOn(transportModule, "createTransport").mockReturnValue({} as never);
  const hub = vi.spyOn(hubRuntime, "runStandaloneHub").mockImplementation(async ports => {
    await ports.intercom?.start();
    return { async stop() { await ports.intercom?.stop(); }, agentPorts: {} as never };
  });
  vi.stubEnv("HC_SOCKET", "/home/fixture/private-core.sock");
  const startupLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const service = await productionHub.startProductionHub(f.root);
  try {
    expect(startupLog).toHaveBeenCalledWith("hub-core-selection: socket=explicit");
    expect(JSON.stringify(startupLog.mock.calls)).not.toContain("/home/fixture/private-core.sock");
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0][0]).toMatchObject({ root: f.root, agentDir, config: { machineId: HUB } });
    const roamingEnabled = factory.mock.calls[0][0].roamingEnabled;
    expect(roamingEnabled).toBeTypeOf("function");
    expect(roamingEnabled?.()).toBe(true);
    const configFile = join(f.root, "roam/config.json"), raw = JSON.parse(readFileSync(configFile, "utf8"));
    writeFileSync(configFile, JSON.stringify({ ...raw, enabled: false }), { mode: 0o600 });
    expect(roamingEnabled?.()).toBe(false);
    expect(transport.mock.calls.map(([input]) => input.enrolled.map(peer => peer.machineId))).toEqual([[BOX], [other.machineId]]);
    expect(hub.mock.calls[0][0].intercom).toMatchObject({ move: bridge.move });
    expect(hub.mock.calls[0][0].intercom?.readiness?.()).toEqual(bridge.readiness?.());
    expect(app).not.toHaveBeenCalled();
    expect(legacyLaunch).not.toHaveBeenCalled();
    expect(hub.mock.calls[0][0].placement).toBeUndefined();
    expect(order).toEqual(["bridge-start"]);
  } finally { await service.stop(); }
  expect(order).toEqual(["bridge-start", "bridge-stop", "core-close"]);
}, 5000);

it("the Mac hub refuses core-only mode before starting placement", async () => {
  const f = await fixture(), close = vi.fn(), app = vi.spyOn(appModule, "createAppClient");
  const hc = vi.spyOn(hcModule, "createHcClient").mockImplementation(() => { throw new Error("core started before mode check"); });
  mkdirSync(join(f.root, "herdr"), { recursive: true });
  writeFileSync(join(f.root, "herdr", "config.json"), JSON.stringify({ mode: "core-only", core: { binary: "/fixture/hc", config: "/fixture/core" }, agentDirectory: "/fixture/agent", globalRoot: f.root, shellRc: "/fixture/rc", machines: [] }));
  vi.spyOn(localRuntime, "openLocalCore").mockReturnValue({ config: { enabled: true, role: "hub" }, close } as never);
  await expect(productionHub.startProductionHub(f.root)).rejects.toThrow("This view is available on the Mac.");
  expect(app.mock.calls.length).toBe(0);
  expect(hc.mock.calls.length).toBe(0);
  expect(close).toHaveBeenCalledOnce();
}, 5000);

it("sync accepts a leading-dash alias after the end-of-options marker", async () => {
  const f = await fixture();
  expect(await f.invoke(["roam", "sync", "--", "-box-1.invalid"])).toBe(0);
  expect(f.calls).toEqual([{ op: "sync", machine: BOX }]);
  expect(f.err).toEqual([]);
}, 5000);

it("sync accepts a leading-dash alias as the explicit machine value", async () => {
  const f = await fixture();
  expect(await f.invoke(["roam", "sync", "--machine", "-box-1.invalid"])).toBe(0);
  expect(f.calls).toEqual([{ op: "sync", machine: BOX }]);
  expect(f.err).toEqual([]);
}, 5000);

it("sync refuses a mismatched local identity before socket dispatch", async () => {
  const f = await fixture(BOX);
  expect(await f.invoke(["roam", "sync", "--", "-box-1.invalid"])).toBe(1);
  expect(f.calls).toEqual([]);
}, 5000);

it("unknown machines and malformed options cannot dispatch a sync", async () => {
  const f = await fixture();
  expect(await f.invoke(["roam", "sync", "--machine", "missing.invalid"])).toBe(2);
  expect(await f.invoke(["roam", "sync", "--machine"])).toBe(2);
  expect(await f.invoke(["roam", "sync", "--bogus"])).toBe(2);
  expect(await f.invoke(["roam", "sync", "--", "-box-1.invalid", "extra"])).toBe(2);
  expect(f.calls).toEqual([]);
}, 5000);

it("disabled local doctor prints one line without inspecting move bindings", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; config.peers = [];
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const doctor = vi.spyOn(localDiagnostics, "runLocalDoctor");
  expect(await f.invoke(["roam", "doctor"])).toBe(0);
  expect(f.out.join("")).toBe("Roaming is disabled.\n"); expect(f.err).toEqual([]);
  expect(doctor).not.toHaveBeenCalled();
}, 5000);

it("disabled local doctor adds only real peer flag mismatches", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({} as never);
  vi.spyOn(remoteObservations, "remoteDoctor").mockResolvedValue({ enabled: true, diagnostics: [], consumers: [] });
  expect(await f.invoke(["roam", "doctor"])).toBe(0);
  expect(f.out.join("").trim().split("\n")).toEqual(["Roaming is disabled.", `peer-enabled-mismatch:${BOX}`]);
  expect(f.out.join("")).not.toContain("adapter-unbound");
}, 5000);

it("enabled doctor summarizes an absent move-binding inventory once", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers = [];
  config.intercom = { enabled: true, mode: "hub-only", machineAlias: "hub.invalid", protocolFeature: "federation-v1", routes: [] };
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  expect(localRuntime.readLocalIdentity(f.root).intercom.enabled).toBe(true);
  vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: true, diagnostics: [], consumers: [] });
  const code = await f.invoke(["roam", "doctor"]);
  expect(code, `stdout: ${f.out.join("")} stderr: ${f.err.join("")}`).toBe(0);
  expect(f.out.join("")).toContain("move-binding-inventory-unavailable");
  expect(f.out.join("")).not.toContain("adapter-unbound:");
}, 5000);

it("enabled doctor does not claim intercom move readiness when federation is disabled", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers = []; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: true, diagnostics: [], consumers: [] });
  expect(await f.invoke(["roam", "doctor"])).toBe(1);
  expect(f.out.join("")).toContain("intercom-move-port-unavailable");
}, 5000);

it("doctor JSON returns its real report rows instead of scraping selected stdout lines", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers = [];
  config.intercom = { enabled: true, mode: "hub-only", machineAlias: "hub.invalid", protocolFeature: "federation-v1", routes: [] };
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const diagnostic = { reason: "pi-auth-missing: Pi sign-in is unverified.", severity: "block" as const, repairCommand: null };
  vi.spyOn(localDiagnostics, "runLocalDoctor").mockResolvedValue({ enabled: true, diagnostics: [diagnostic], consumers: [] });
  expect(await f.invoke(["roam", "doctor", "--json"])).toBe(1);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ code: 1, value: { enabled: true, diagnostics: [diagnostic,
    { reason: "move-binding-inventory-unavailable", severity: "warning", repairCommand: "spider roam doctor" }] } });
}, 5000);

it.each([["roam", "forget", "box-1.invalid"], ["roam", "forget", "box-1.invalid", "--confirm", "destroyed wrong"]])
("forget warns before rejecting missing or wrong confirmation: %j", async (...args) => {
  const f = await fixture(HUB, undefined, true), file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.peers[0].alias = "box-1.invalid"; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  expect(await f.invoke(args)).toBe(2);
  expect(f.err.join("")).toMatch(/two copies can run/i); expect(f.err.join("")).toMatch(/last mirror/i);
  expect(f.calls).toEqual([]);
}, 5000);

it("normalizes an explicitly confirmed box alias to the enrolled UUID before forget", async () => {
  const f = await fixture(), file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.peers[0].alias = "box-1.invalid"; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  expect(await f.invoke(["roam", "forget", "box-1.invalid", "--confirm", "destroyed box-1.invalid"])).toBe(0);
  expect(f.calls).toContainEqual({ op: "forget", machine: "box-1.invalid", confirmation: `destroyed ${BOX}` });
}, 5000);

it("disabled forget invokes only the confirmed typed port and returns its real pending presentation", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.enabled = false; config.peers[0].alias = "box-1.invalid"; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const home = { sessionId: "s-1", machineId: HUB, epoch: 4, moveId: null, updatedAt: 123 };
  const actual: import("../move-ports").AdapterMachineRecoveryOutcome = { ok: true, code: 0, operationId: "forget-a", reason: "destroyed-machine-recovered", presentation: "pending", value: [home],
    results: [{ sessionId: home.sessionId, code: 0, reason: "restored", home, presentation: "pending", repairCommand: null }] };
  const calls: Array<{ machine: string; confirmed: true }> = [];
  const runDisabledForget = async (input: { machine: string; confirmed: true }): Promise<typeof actual> => { calls.push(input); return actual; };
  expect(await main(["roam", "forget", "box-1.invalid", "--confirm", "destroyed box-1.invalid", "--json"],
    { out: text => f.out.push(text), err: text => f.err.push(text) }, { runDisabledForget })).toBe(0);
  expect(calls).toEqual([{ machine: BOX, confirmed: true }]);
  expect(JSON.parse(f.out.join(""))).toEqual(actual);
}, 5000);

it("disabled forget prints the exact pending launch command instead of hiding it behind doctor", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.enabled = false; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const repairCommand = "cd '/fixture/workspace' && 'pi' --session '/fixture/session.jsonl'";
  const actual: import("../move-ports").AdapterMachineRecoveryOutcome = { ok: false, code: 3, operationId: "forget-a", reason: "recovery-launch-pending", value: null, recovered: [],
    results: [{ sessionId: "s-1", code: 3, reason: "recovery-launch-pending", home: null, presentation: null, repairCommand }] };
  expect(await main(["roam", "forget", BOX, "--confirm", `destroyed ${BOX}`], { out: text => f.out.push(text), err: text => f.err.push(text) }, { runDisabledForget: async () => actual })).toBe(3);
  expect(f.err.join("")).toContain(repairCommand);
  expect(f.calls).toEqual([]);
}, 5000);

it.each(["hub-running", "not-disabled"] as const)("disabled forget returns the port's %s refusal unchanged", async reason => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.enabled = false; config.peers[0].alias = "box-1.invalid"; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const actual = { ok: false as const, reason }, runDisabledForget: import("../disabled-forget-contract").RunDisabledForget = async () => actual;
  expect(await main(["roam", "forget", "box-1.invalid", "--confirm", `destroyed ${BOX}`, "--json"],
    { out: text => f.out.push(text), err: text => f.err.push(text) }, { runDisabledForget })).toBe(1);
  expect(JSON.parse(f.out.join(""))).toEqual(actual);
}, 5000);

it("disable is a verified no-op on a never-enabled hub", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...config, enabled: false, peers: [] }), { mode: 0o600 });
  expect(await f.invoke(["roam", "disable"])).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
  expect(existsSync(join(f.root, "roam/journal.db"))).toBe(false);
  expect(f.out.join("")).toMatch(/disabled|already off/i);
  expect(f.out.join("")).toContain("Reload open pi sessions (/reload) to pick up /move.");
  expect(f.out.join("")).not.toContain("reload automatically");
}, 5000);

it("disable completes interrupted service removal and retries each box flag", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.enabled = false; config.peers[0].alias = "box-1.invalid";
  const other = { ...config.peers[0], machineId: "00000000-0000-4000-8000-000000000003", alias: "box-2.invalid" };
  config.peers.push(other); writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  openJournal(join(f.root, "roam/journal.db"));
  const plist = launchd.hubServiceFile(f.root, join(f.root, "Library/LaunchAgents"));
  mkdirSync(join(f.root, "Library/LaunchAgents"), { recursive: true }); writeFileSync(plist, "fixture");
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 }); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  const removal = vi.spyOn(launchd, "removeHubService").mockImplementation(async () => { unlinkSync(plist); });
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  const requests: Record<string, unknown>[] = [];
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: { async resolve(peer: unknown) { return peer; } }, async executeProvision(peer: { machineId: string }, request: Record<string, unknown>) {
    requests.push(request); if (peer.machineId === other.machineId) throw new Error("offline"); return { enabled: request.enabled };
  } } as never);
  expect(await f.invoke(["roam", "disable"])).toBe(3);
  expect(removal).toHaveBeenCalledOnce(); expect(existsSync(plist)).toBe(false);
  expect(requests.map(request => [request.machineId, request.enabled])).toEqual([[BOX, false], [other.machineId, false]]);
  expect(f.err.join("")).toContain("box-2.invalid");
  expect(f.err.join("")).toContain("spider roam disable");
  expect(f.err.join("")).toContain("Reload open pi sessions (/reload) to pick up /move.");
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
}, 5000);

it("partial disable retains the peer operation ID across a lost reply and reconnect", async () => {
  const f = await fixture(), requests: Record<string, unknown>[] = [];
  let loseReply = true, writes = 0, boxEnabled = true;
  const receipts = new Map<unknown, { enabled: boolean }>();
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: { async resolve(peer: unknown) { return peer; } }, async executeProvision(_peer: unknown, request: Record<string, unknown>) {
    requests.push(request);
    let receipt = receipts.get(request.operationId);
    if (!receipt) { writes++; boxEnabled = request.enabled === true; receipt = { enabled: boxEnabled }; receipts.set(request.operationId, receipt); }
    if (loseReply) throw new Error("synthetic lost reply");
    return receipt;
  } } as never);
  for (let i = 0; i < 3; i++) {
    f.out.length = 0;
    expect(await f.invoke(["roam", "disable", "--json"])).toBe(3);
    expect(JSON.parse(f.out.join(""))).toMatchObject({ reason: "roaming-disabled-partial", value: { issues: [{ reason: "peer-enabled-unconfirmed:-box-1.invalid", repairCommand: "spider roam disable" }] } });
    expect(JSON.parse(readFileSync(join(f.root, "roam/config.json"), "utf8")).enabled).toBe(false);
  }
  expect(new Set(requests.map(request => request.operationId)).size).toBe(1);
  expect(writes).toBe(1); expect(boxEnabled).toBe(false);
  const journal = openJournal(join(f.root, "roam/journal.db")), id = requests[0].operationId as string;
  expect(journal.read(id).filter(row => row.action === "provision-consent")).toHaveLength(1);
  loseReply = false; f.out.length = 0;
  expect(await f.invoke(["roam", "disable", "--json"])).toBe(0);
  expect(new Set(requests.map(request => request.operationId)).size).toBe(1);
  expect(writes).toBe(1);
  expect(journal.lookupOperation(id)?.state).toBe("done");
}, 5000);

it("disable does not replay an old pending operation after a newer enable", async () => {
  const f = await fixture(), requests: Record<string, unknown>[] = [];
  let loseReply = true, enabled = true;
  const receipts = new Map<unknown, { enabled: boolean }>();
  const transport = { transport: { async resolve(peer: unknown) { return peer; } }, async executeProvision(_peer: unknown, request: Record<string, unknown>) {
    requests.push(request);
    if (!receipts.has(request.operationId)) { enabled = request.enabled === true; receipts.set(request.operationId, { enabled }); }
    if (loseReply) throw new Error("synthetic lost reply");
    return receipts.get(request.operationId);
  } };
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue(transport as never);
  expect(await f.invoke(["roam", "disable", "--json"])).toBe(3);
  loseReply = false;
  const config = localRuntime.readLocalIdentity(f.root), journal = openJournal(join(f.root, "roam/journal.db"));
  await setEnrolledPeerEnabled({ config, peer: config.peers[0], enabled: true, operationId: "00000000-0000-4000-8000-000000000004", journal, transport: transport as never });
  expect(enabled).toBe(true);
  expect(await f.invoke(["roam", "disable", "--json"])).toBe(0);
  expect(enabled).toBe(false);
  expect(requests.at(-1)!.operationId).not.toBe(requests[0].operationId);
}, 5000);

it("an answered wrong box flag remains explicitly unconfirmed", async () => {
  const f = await fixture();
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: { async resolve(peer: unknown) { return peer; } }, async executeProvision() { return { enabled: true }; } } as never);
  expect(await f.invoke(["roam", "disable", "--json"])).toBe(3);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ reason: "roaming-disabled-partial", value: { issues: [{ repairCommand: "spider roam disable" }] } });
  expect(localRuntime.readLocalIdentity(f.root).enabled).toBe(false);
}, 5000);

it("disable finds an owned service at its root-scoped path", async () => {
  const f = await fixture(), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers = []; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const directory = join(f.root, "Library/LaunchAgents"); mkdirSync(directory, { recursive: true });
  const label = `com.spider.roam.hub.${createHash("sha256").update(realpathSync(f.root)).digest("hex").slice(0, 16)}`;
  const plist = join(directory, `${label}.plist`);
  writeFileSync(plist, `<plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/home/fixture/node</string><string>/home/fixture/cli</string><string>roam</string><string>hub</string></array><key>SPIDER_GLOBAL_ROOT</key><string>${f.root}</string></dict></plist>`, { mode: 0o600 });
  const binary = join(f.root, "launchctl"); writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", binary);
  expect(await f.invoke(["roam", "disable", "--json"])).toBe(0);
  expect(existsSync(plist)).toBe(false);
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
}, 5000);

it.each([
  ["bootout succeeds", "exit 0", "exit 0", true],
  ["bootout says missing on stderr but service is loaded", "echo 'Could not find service' >&2; exit 113", "exit 0", false],
  ["bootout says missing on stdout but service is loaded", "echo 'Could not find service'; exit 113", "exit 0", false],
  ["bootout fails but print proves absence", "echo 'Boot-out failed: 5: Input/output error' >&2; exit 5", "echo 'Could not find service' >&2; exit 113", true],
  ["service print exits 113 without output", "exit 5", "exit 113", true],
  ["bootout fails and service is still loaded", "echo 'request failed' >&2; exit 5", "exit 0", false],
  ["silent bootout 113 with loaded service", "exit 113", "exit 0", false],
  ["unrelated missing file is not proof", "echo 'Could not find file' >&2; exit 113", "echo 'request failed' >&2; exit 5", false],
  ["print reports an unrelated missing file", "exit 5", "echo 'Could not find file' >&2; exit 113", false],
] as const)("disable converges only when %s", async (_name, bootout, print, removed) => {
  const f = await fixture(), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers = []; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const plistDir = join(f.root, "Library/LaunchAgents"), plist = launchd.hubServiceFile(f.root, plistDir);
  await launchd.installHubService({ node: process.execPath, cli: process.execPath, globalRoot: f.root, pi: process.execPath }, { plistDir, async launchctl() {} });
  const binary = join(f.root, "launchctl");
  writeFileSync(binary, `#!/bin/sh\nif [ "$1" = print ]; then ${print}; else ${bootout}; fi\n`, { mode: 0o700 });
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", binary);
  expect(await f.invoke(["roam", "disable", "--json"])).toBe(removed ? 0 : 3);
  const result = JSON.parse(f.out.join(""));
  if (!removed) expect(result).toMatchObject({ reason: "disable-pending", causeCode: "service-failed" });
  expect(existsSync(plist)).toBe(!removed);
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(!removed);
  expect(JSON.stringify(result)).not.toContain("request failed");
}, 5000);

it.each(["enable", "disable"] as const)("%s probes the exact service after the observed bootout exit 5", async command => {
  const f = await fixture(HUB, { code: 0, reason: "ready", value: { enabled: true } }), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = command === "disable"; config.peers = [];
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const plistDir = join(f.root, "Library/LaunchAgents"), plist = launchd.hubServiceFile(f.root, plistDir);
  if (command === "disable") await launchd.installHubService({ node: process.execPath, cli: process.execPath, globalRoot: f.root, pi: process.execPath }, { plistDir, async launchctl() {} });
  else {
    const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root }); db.close();
    vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
    vi.spyOn(transportModule, "createTransport").mockReturnValue({} as never);
    vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
    vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
  }
  const binary = join(f.root, "launchctl"), calls = join(f.root, "launchctl-calls");
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' "$1" "$2" "$3" >> '${calls}'\ncase "$1" in\n  bootout) echo 'Boot-out failed: 5: Input/output error' >&2; exit 5 ;;\n  print) exit 113 ;;\n  bootstrap) exit 0 ;;\nesac\n`, { mode: 0o700 });
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", binary);
  expect(await f.invoke(["roam", command, "--json"])).toBe(0);
  const domain = `gui/${process.getuid!()}`, label = launchd.hubServiceLabel(f.root);
  expect(readFileSync(calls, "utf8").split("\n").filter(Boolean)).toEqual([
    `bootout\t${domain}\t${plist}`,
    `print\t${domain}/${label}\t`,
    ...(command === "enable" ? [`bootstrap\t${domain}\t${plist}`] : []),
  ]);
  expect(existsSync(plist)).toBe(command === "enable");
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(command === "enable");
}, 5000);

it("disable does not boot out or delete a service owned by another root", async () => {
  const f = await fixture(), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers = []; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const plistDir = join(f.root, "Library/LaunchAgents"), plist = launchd.hubServiceFile(f.root, plistDir), marker = join(f.root, "called");
  await launchd.installHubService({ node: process.execPath, cli: process.execPath, globalRoot: f.root, pi: process.execPath }, { plistDir, async launchctl() {} });
  writeFileSync(plist, readFileSync(plist, "utf8").replace(`<key>SPIDER_GLOBAL_ROOT</key><string>${f.root}</string>`, "<key>SPIDER_GLOBAL_ROOT</key><string>/home/fixture/other</string>"));
  const binary = join(f.root, "launchctl"); writeFileSync(binary, `#!/bin/sh\necho called > '${marker}'\nexit 0\n`, { mode: 0o700 });
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", binary);
  expect(await f.invoke(["roam", "disable", "--json"])).toBe(3);
  expect(existsSync(plist)).toBe(true);
  expect(existsSync(marker)).toBe(false);
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(true);
}, 5000);

it("disable reports a real filesystem cause and keeps its enabled flag", async () => {
  const f = await fixture(), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers = []; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const plist = launchd.hubServiceFile(f.root, join(f.root, "Library/LaunchAgents"));
  mkdirSync(join(f.root, "Library/LaunchAgents"), { recursive: true }); writeFileSync(plist, "fixture");
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 }); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  vi.spyOn(launchd, "removeHubService").mockImplementation(async () => { readFileSync(join(f.root, "missing-private-file")); });
  expect(await f.invoke(["roam", "disable", "--json"])).toBe(3);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ reason: "disable-pending", causeCode: "ENOENT", repairCommand: null });
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(true);
  expect(existsSync(plist)).toBe(true);
  f.out.length = 0;
  expect(await f.invoke(["roam", "disable"])).toBe(3);
  expect(f.err.join("")).toContain("ENOENT");
  expect(f.err.join("")).not.toContain("missing-private-file");
  expect(f.err.join("")).not.toContain("Run spider roam doctor");
}, 5000);

it("disable leaves the enabled flag on when hub-service removal fails", async () => {
  const f = await fixture(), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.peers = []; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const plist = launchd.hubServiceFile(f.root, join(f.root, "Library/LaunchAgents"));
  mkdirSync(join(f.root, "Library/LaunchAgents"), { recursive: true }); writeFileSync(plist, "fixture");
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 }); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  vi.spyOn(launchd, "removeHubService").mockRejectedValue(new Error("service removal failed"));
  expect(await f.invoke(["roam", "disable"])).toBe(3);
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(true);
  expect(existsSync(plist)).toBe(true);
}, 5000);

it.each([true, false])("Mac disable propagates to a reachable box and retains an unreachable flag (reachable: %s)", async reachable => {
  const f = await fixture(), requests: Record<string, unknown>[] = [];
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: { async resolve(peer: unknown) { return peer; } }, async executeProvision(_peer: unknown, request: Record<string, unknown>) {
    requests.push(request); if (!reachable) throw new Error("offline"); return { enabled: request.enabled };
  } } as never);
  expect(await f.invoke(["roam", "disable"])).toBe(reachable ? 0 : 3);
  expect(JSON.parse(readFileSync(join(f.root, "roam/config.json"), "utf8")).enabled).toBe(false);
  expect(requests).toEqual([expect.objectContaining({ action: "roaming-enabled", machineId: BOX, hubMachineId: HUB, enabled: false })]);
  if (!reachable) expect(f.err.join("")).toContain("unconfirmed");
  expect(await f.invoke(["move", "session-a", "box"])).toBe(1);
  expect(f.err.join("")).toContain("roaming-disabled");
}, 5000);
it("enable reports every box precondition before changing capture or flags", async () => {
  const f = await fixture(HUB, { code: 0, reason: "ready", value: { enabled: true } }), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; config.peers[0].alias = "box-1.invalid";
  const other = { ...config.peers[0], machineId: "00000000-0000-4000-8000-000000000003", alias: "box-2.invalid" };
  config.peers.push(other); writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root }); db.close();
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 }); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
  const service = vi.spyOn(launchd, "installHubService").mockResolvedValue(undefined), operations: string[] = [], starts: string[] = [], flags: unknown[] = [];
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(peer: { machineId: string }, argv: string[]) {
    if (argv[1] === "intercom") { starts.push(peer.machineId); return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-broker-start", ok: true, machineId: peer.machineId, doctor: { enabled: false, diagnostics: [], consumers: [] } })); }
    const op = JSON.parse(argv[2]); operations.push(op.kind);
    if (peer.machineId === other.machineId) throw new HerdrError("machine-not-found", "offline");
    return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, value: op.kind === "stores" ? { protocol: 1, schema: 14, machineId: BOX, stores: ["global"] } : { complete: true } }));
  } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: { async resolve(peer: unknown) { return peer; } }, async executeProvision(_peer: unknown, request: unknown) { flags.push(request); return { enabled: true }; } } as never);
  const doctor = vi.spyOn(remoteObservations, "remoteDoctor").mockImplementation(async (_transport, peer) => {
    if (peer.machineId === other.machineId) throw new HerdrError("machine-not-found", "offline");
    return { enabled: false, diagnostics: [
      { severity: "warning", reason: "intercom-other-extension: ordinary-extension (not classified for intercom).", repairCommand: null },
      { severity: "block", reason: "pi-auth-missing", repairCommand: null },
      { severity: "block", reason: "intercom-federation: federation-feature-missing.", repairCommand: null },
      { severity: "block", reason: "local machine: Bundled SQLite must be at least 3.42 for roaming capture.", repairCommand: null },
    ], consumers: [] };
  });
  expect(await f.invoke(["roam", "enable"])).toBe(1);
  expect(f.err.join("")).toContain("ordinary-extension");
  expect(f.err.join("")).toContain("preflight-failed:box-1.invalid:pi-auth-missing");
  expect(f.err.join("")).toContain("preflight-failed:box-1.invalid:intercom-federation");
  expect(f.err.join("")).toContain("preflight-failed:box-1.invalid:intercom-broker");
  expect(f.err.join("")).toContain("preflight-failed:box-1.invalid:sqlite-bundled");
  expect(f.err.join("")).toContain("box-unreachable:box-2.invalid");
  expect(f.err.join("")).toContain("spider roam provision box-1.invalid");
  expect(f.err.join("")).toContain("spider roam forget box-2.invalid");
  expect(starts).toEqual([]);
  expect(operations).not.toContain("enable-capture"); expect(operations).not.toContain("recheck-store");
  expect(flags).toEqual([]); expect(service).not.toHaveBeenCalled();
  expect(doctor).toHaveBeenCalled();
  const after = openDb(join(f.root, "spider.db"));
  try { expect(after.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 }); } finally { after.close(); }
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
}, 5000);

it("reports pending enable before flags or capture if a broker cannot start after preflight", async () => {
  const f = await fixture(HUB, { code: 0, reason: "ready", value: { enabled: true } }), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; config.peers[0].alias = "box-1.invalid"; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root }); db.close();
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 }); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  const operations: string[] = [], flags: unknown[] = [], service = vi.spyOn(launchd, "installHubService").mockResolvedValue(undefined);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    if (argv[1] === "intercom") throw new Error("fixture spawn failure");
    const op = JSON.parse(argv[2]); operations.push(op.kind);
    return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, value: { protocol: 1, schema: 14, machineId: BOX, stores: ["global"] } }));
  } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: {}, async executeProvision(_p: unknown, request: unknown) { flags.push(request); } } as never);
  vi.spyOn(remoteObservations, "remoteDoctor").mockResolvedValue({ enabled: false, diagnostics: [], consumers: [] });
  vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
  expect(await f.invoke(["roam", "enable", "--json"])).toBe(3);
  const result = JSON.parse(f.out.join(""));
  expect(result.reason).toBe("preflight-failed:box-1.invalid:intercom-broker");
  expect(result.value.issues).toContainEqual({ reason: result.reason, repairCommand: "spider roam doctor box-1.invalid", causeCode: "unexpected-enable-broker" });
  expect(operations).toEqual(["stores"]); expect(flags).toEqual([]); expect(service).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
}, 5000);

it("enable installs the same core selection used for peer preflight", async () => {
  const f = await fixture(HUB, { code: 0, reason: "ready", value: { enabled: true } }), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; config.peers = [];
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root }); db.close();
  const binary = join(f.root, "launchctl"); writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", binary); vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
  const selected = join(f.root, "selected.sock"), changed = join(f.root, "changed.sock");
  vi.stubEnv("HC_SOCKET", selected);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createTransport").mockImplementation(input => {
    expect(input.env.HC_SOCKET).toBe(selected); vi.stubEnv("HC_SOCKET", changed); return {} as never;
  });
  vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
  expect(await f.invoke(["roam", "enable", "--json"])).toBe(0);
  const text = readFileSync(launchd.hubServiceFile(f.root, join(f.root, "Library/LaunchAgents")), "utf8");
  expect(text).toContain(`<key>HC_SOCKET</key><string>${selected}</string>`);
  expect(text).not.toContain(changed);
}, 5000);

it("enable pins a config-selected socket before preflight can change its config", async () => {
  const f = await fixture(HUB, { code: 0, reason: "ready", value: { enabled: true } }), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; config.peers = [];
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root }); db.close();
  const binary = join(f.root, "launchctl"); writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", binary); vi.stubEnv("SPIDER_ROAM_PI", process.execPath); vi.stubEnv("HC_SOCKET", undefined);
  const configDir = join(f.root, "hc-config"), selected = join(f.root, "selected.sock"), changed = join(f.root, "changed.sock");
  mkdirSync(join(configDir, "herdr-core"), { recursive: true });
  const coreConfig = join(configDir, "herdr-core", "config.toml"); writeFileSync(coreConfig, `socket = "${selected}"\n`);
  vi.stubEnv("XDG_CONFIG_HOME", configDir);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createTransport").mockImplementation(input => {
    expect(selectedSocket(input.env)).toBe(selected); writeFileSync(coreConfig, `socket = "${changed}"\n`); return {} as never;
  });
  vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
  expect(await f.invoke(["roam", "enable", "--json"])).toBe(0);
  const text = readFileSync(launchd.hubServiceFile(f.root, join(f.root, "Library/LaunchAgents")), "utf8");
  expect(text).toContain(`<key>HC_SOCKET</key><string>${selected}</string>`);
  expect(text).not.toContain(changed);
}, 5000);

it("enable reports a real transport cause after mutation in JSON and text", async () => {
  const f = await fixture(HUB, { code: 0, reason: "ready", value: { enabled: true } }), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; config.peers = [];
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root }); db.close();
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 });
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl); vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({} as never);
  vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
  vi.spyOn(launchd, "installHubService").mockRejectedValue(new HerdrError("cli-timeout", "private exception details"));
  const code = await f.invoke(["roam", "enable", "--json"]);
  expect(code, f.out.join("") + f.err.join("")).toBe(3);
  expect(JSON.parse(f.out.join(""))).toMatchObject({ reason: "enable-pending", causeCode: "cli-timeout", repairCommand: null });
  expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(true);
  f.out.length = 0;
  expect(await f.invoke(["roam", "enable"])).toBe(3);
  expect(f.err.join("")).toContain("cli-timeout");
  expect(f.err.join("")).not.toContain("private exception details");
  expect(f.err.join("")).not.toContain("Run spider roam doctor");
}, 5000);

it("explicit Mac enable requires box preflight before authorizing its flag", async () => {
  const f = await fixture(HUB, { code: 0, reason: "ready", value: { enabled: true } }), requests: Record<string, unknown>[] = [];
  const file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8")); writeFileSync(file, JSON.stringify({ ...config, enabled: false }), { mode: 0o600 });
  const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root }); db.close();
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 }); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
  vi.spyOn(launchd, "installHubService").mockResolvedValue(undefined);
  const starts: string[] = [];
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    if (argv[1] === "intercom") { starts.push(BOX); return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-broker-start", ok: true, machineId: BOX, doctor: { enabled: false, diagnostics: [], consumers: [] } })); }
    const op = JSON.parse(argv[2]); return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, value: op.kind === "stores" ? { protocol: 1, schema: 14, machineId: BOX, stores: ["global"] } : { complete: true } }));
  } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: { async resolve(peer: unknown) { return peer; } }, async executeProvision(_peer: unknown, request: Record<string, unknown>) { requests.push(request); return { enabled: request.enabled }; } } as never);
  const doctor = vi.spyOn(remoteObservations, "remoteDoctor").mockResolvedValue({ enabled: false, diagnostics: [{ severity: "block", reason: "fixture-preflight", repairCommand: null }], consumers: [] });
  expect(await f.invoke(["roam", "enable"])).not.toBe(0); expect(requests).toEqual([]);
  doctor.mockResolvedValue({ enabled: false, diagnostics: [{ severity: "warning", reason: "intercom-other-extension: ordinary-extension (not classified for intercom).", repairCommand: null }], consumers: [] });
  expect(await f.invoke(["roam", "enable"])).toBe(0);
  expect(f.out.join("")).toContain("ordinary-extension");
  expect(f.out.join("")).toContain("Reload open pi sessions (/reload) to pick up /move.");
  expect(f.out.join("")).not.toContain("reload automatically");
  expect(starts).toEqual([BOX]);
  expect(requests).toEqual([expect.objectContaining({ action: "roaming-enabled", enabled: true, machineId: BOX, hubMachineId: HUB })]);
}, 5000);
it.each(["ready", "unavailable", "startup-timeout", "transport-timeout", "wrong-identity"] as const)
("enable consumes the final broker startup observation (%s)", async mode => {
  const f = await fixture(HUB, { code: 0, reason: "ready", value: { enabled: true } }), file = join(f.root, "roam/config.json");
  const config = JSON.parse(readFileSync(file, "utf8")); config.enabled = false; config.peers[0].alias = "box-1.invalid";
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root }); db.close();
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 });
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl); vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
  const service = vi.spyOn(launchd, "installHubService").mockResolvedValue(undefined), operations: string[] = [], flags: unknown[] = [];
  // A second settings/doctor pass can outlive a sessionless broker's idle lifetime.
  let preflight = true;
  vi.spyOn(remoteObservations, "remoteDoctor").mockImplementation(async () => {
    if (!preflight) throw new HerdrError("cli-timeout", "private doctor stderr");
    preflight = false; return { enabled: false, diagnostics: [], consumers: [] };
  });
  let release!: () => void, started!: () => void;
  const health = new Promise<void>(resolve => { release = resolve; }), starting = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    if (argv[1] === "intercom") {
      started(); await health;
      if (mode === "transport-timeout") throw new HerdrError("cli-timeout", "private startup stderr");
      if (mode === "startup-timeout") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-broker-start", ok: false, causeCode: "broker-start-timeout" }));
      return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-broker-start", ok: true, machineId: mode === "wrong-identity" ? HUB : BOX,
        doctor: { enabled: false, consumers: [], diagnostics: mode === "unavailable" ? [
          { severity: "block", reason: "intercom-federation: intercom-broker-unavailable.", repairCommand: null },
        ] : [] } }));
    }
    const op = JSON.parse(argv[2]); operations.push(op.kind);
    return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, value: op.kind === "stores" ? { protocol: 1, schema: 14, machineId: BOX, stores: ["global"] } : { complete: true } }));
  } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: { async resolve(peer: unknown) { return peer; } },
    async executeProvision(_peer: unknown, request: unknown) { flags.push(request); return { enabled: true }; } } as never);
  const enabling = f.invoke(["roam", "enable", "--json"]);
  await starting;
  expect(f.out).toEqual([]); expect(operations).toEqual(["stores"]); expect(flags).toEqual([]);
  release();
  expect(await enabling).toBe(mode === "ready" ? 0 : 3);
  const result = JSON.parse(f.out.join(""));
  if (mode === "ready") {
    expect(result.reason).toBe("roaming-enabled"); expect(operations).toEqual(["stores", "enable-capture"]); expect(flags).toHaveLength(1);
  } else {
    const expected = mode === "unavailable" ? "intercom-broker-unavailable" : mode === "startup-timeout" ? "broker-start-timeout" : mode === "transport-timeout" ? "cli-timeout" : "invalid-reply";
    expect(result).toMatchObject({ causeCode: expected });
    expect(result.value.issues).toContainEqual(expect.objectContaining({ causeCode: expected }));
    expect(JSON.stringify(result)).not.toContain("private");
    expect(operations).toEqual(["stores"]); expect(flags).toEqual([]); expect(service).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(file, "utf8")).enabled).toBe(false);
  }
}, 5000);

it("doctor reports enabled flag drift and preserves both configurations", async () => {
  const f = await fixture(), config = localRuntime.readLocalIdentity(f.root), before = readFileSync(join(f.root, "roam/config.json"), "utf8");
  vi.spyOn(remoteObservations, "remoteDoctor").mockResolvedValue({ enabled: false, diagnostics: [], consumers: [] });
  expect(await peerEnabledDiagnostics(config, {} as never)).toEqual([{ reason: `peer-enabled-mismatch:${BOX}`, severity: "warning", repairCommand: "spider roam enable" }]);
  vi.mocked(remoteObservations.remoteDoctor).mockResolvedValue({ enabled: true, diagnostics: [], consumers: [] });
  expect(await peerEnabledDiagnostics({ ...config, enabled: false }, {} as never)).toEqual([{ reason: `peer-enabled-mismatch:${BOX}`, severity: "warning", repairCommand: "spider roam disable" }]);
  expect(readFileSync(join(f.root, "roam/config.json"), "utf8")).toBe(before);
}, 5000);


it("remote doctor retains non-stopping hosting warnings when scheduling is disabled", async () => {
  const f = await fixture(HUB, undefined, false);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({} as never);
  vi.spyOn(remoteObservations, "remoteDoctor").mockResolvedValue({ enabled: false, consumers: [], diagnostics: [
    { code: "supervisor-hosting-error", severity: "warning", reason: "Session session-a: supervisor-hosting-error (restart); hosting checks will retry automatically.", repairCommand: null },
    { severity: "warning", reason: "disabled informational diagnostic", repairCommand: null },
    { severity: "block", reason: "disabled hosting prerequisite", repairCommand: null },
  ] });
  expect(await f.invoke(["roam", "doctor", "--", "-box-1.invalid"])).toBe(0);
  expect(f.out.join("")).toContain("supervisor-hosting-error (restart)");
  expect(f.out.join("")).not.toContain("disabled hosting prerequisite");
  expect(f.out.join("")).not.toContain("disabled informational diagnostic");
});

it("enable warns for an absent store and sync enables capture when it returns", async () => {
  const f = await fixture(HUB, { code: 0, reason: "ready", value: { enabled: true } });
  const configFile = join(f.root, "roam/config.json"), raw = JSON.parse(readFileSync(configFile, "utf8"));
  raw.enabled = false; raw.peers[0].alias = "box-1.invalid"; writeFileSync(configFile, JSON.stringify(raw), { mode: 0o600 });
  const local = openDb(join(f.root, "spider.db")); migrate(local, "global", { machineId: HUB, globalRoot: f.root }); local.close();
  const net = network(), remote = net.remotes.get(BOX)!;
  const path = join(remote.global.root, "returning"), file = join(path, ".spider", "repo.db");
  remote.global.db.prepare("INSERT INTO roam_repo_maps(repo_key,path) VALUES ('returning',?)").run(path);
  writeLocal(remote.global.db, "mapping-redirect", "repo:returning", file);
  vi.spyOn(staging, "defaultStagingRoot").mockReturnValue(net.root);
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 }); vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
  vi.spyOn(launchd, "installHubService").mockResolvedValue(undefined);
  vi.spyOn(remoteObservations, "remoteDoctor").mockResolvedValue({ enabled: false, diagnostics: [], consumers: [] });
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ ...net.transport, async resolve() { return net.transport.resolve(net.peers[0]); }, async exec(peer, argv, options) {
    if (argv[1] === "intercom") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-broker-start", ok: true, machineId: BOX, doctor: { enabled: false, diagnostics: [], consumers: [] } }));
    return net.transport.exec(peer, argv, options);
  } });
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue({ transport: { async resolve(peer: unknown) { return peer; } }, async executeProvision() { return { enabled: true }; } } as never);
  try {
    expect(localRuntime.readLocalIdentity(f.root).peers).toHaveLength(1);
    const discovery = await agent.handleAgentOperation({ id: "before-enable", machineId: BOX, expectedEpoch: null, kind: "stores", args: {} }, remote.ports);
    expect(discovery).toMatchObject({ code: 0, value: { ungathered: [expect.objectContaining({ key: "repo:returning", code: "missing" })] } });
    expect(await f.invoke(["roam", "enable", "--json"])).toBe(0);
    expect(f.out.join("")).toContain("repo:returning"); expect(f.out.join("")).toContain(file);
    expect(f.out.join("")).toContain("missing");
    mkdirSync(join(path, ".spider"), { recursive: true });
    const returned = openDb(file); migrate(returned, "repo", { machineId: BOX, globalRoot: remote.global.root });
    returned.prepare("INSERT INTO memory(uuid,category,content,created_at) VALUES ('returning-memory','insight','portable',1)").run();
    expect(returned.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 0 });
    returned.close();
    const sync = createSync({ config: net.config, globalDb: net.global.db, transport: net.transport, journal: net.journal, clock: net.clock, stores: net.stores });
    expect((await sync.sync()).every(row => row.code === 0)).toBe(true);
    const captured = openDb(file);
    try { expect(captured.prepare("SELECT capture_enabled FROM roam_meta").get()).toEqual({ capture_enabled: 1 }); } finally { captured.close(); }
    expect(net.stores.openStore("repo:returning").db.prepare("SELECT content FROM memory WHERE uuid='returning-memory'").get()).toEqual({ content: "portable" });
  } finally { net.close(); }
}, 5000);

it("disabled doctor reports an ungathered corrupt store as a warning with its path", async () => {
  const f = await fixture(HUB, undefined, false), file = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(file, "utf8"));
  config.enabled = false; config.peers = []; writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root });
  const path = join(f.root, "broken"), store = join(path, ".spider", "project.db");
  mkdirSync(join(path, ".spider"), { recursive: true }); writeFileSync(store, "not sqlite");
  db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','broken',?)").run(path); db.close();
  expect(await f.invoke(["roam", "doctor", "--json"])).toBe(0);
  expect(JSON.parse(f.out.join("")).value.diagnostics).toContainEqual(expect.objectContaining({ severity: "warning", reason: expect.stringContaining(store) }));
  expect(JSON.parse(f.out.join("")).value.diagnostics.filter((row: { severity: string }) => row.severity === "block")).toEqual([]);
}, 5000);
it("disabled doctor names a foreign-machine mapped worktree without machine IDs", async () => {
  const f = await fixture(HUB, undefined, false), configFile = join(f.root, "roam/config.json"), config = JSON.parse(readFileSync(configFile, "utf8"));
  config.enabled = false; config.peers = []; writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root });
  const path = join(f.root, "foreign"), file = join(path, ".spider", "project.db");
  mkdirSync(join(path, ".spider"), { recursive: true });
  const foreign = openDb(file); migrate(foreign, "worktree", { machineId: BOX, globalRoot: f.root }); foreign.close();
  db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('foreign',?,?,1,1)").run(path, file);
  db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path) VALUES ('fixture-repo','foreign',?)").run(path); db.close();
  expect(await f.invoke(["roam", "doctor", "--json"])).toBe(0);
  const diagnostics = JSON.parse(f.out.join("")).value.diagnostics as Array<{ reason: string; repairCommand: string }>;
  const rows = diagnostics.filter(row => row.reason.includes("store-machine-mismatch"));
  expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "warning", reason: expect.stringContaining(file),
    repairCommand: expect.stringContaining("belongs to another machine identity") })]));
  expect(JSON.stringify(rows)).not.toContain(HUB); expect(JSON.stringify(rows)).not.toContain(BOX);
}, 5000);

it("prune reports a bounded failed path and check instead of discarding it", async () => {
  const f = await fixture(HUB, undefined, false), db = openDb(join(f.root, "spider.db"));
  migrate(db, "global", { machineId: HUB, globalRoot: f.root });
  const path = join(f.root, "denied"), file = join(path, "project.db"); mkdirSync(path);
  db.prepare("INSERT INTO projects(project_key,real_path,db_path,created_at,last_seen_at) VALUES ('denied',?,?,1,1)").run(path, file); db.close();
  chmodSync(path, 0);
  try {
    expect(await f.invoke(["roam", "stores", "prune", "--confirm"])).toBe(1);
    expect(f.out.join("") + f.err.join("")).toContain(file);
    expect(f.out.join("") + f.err.join("")).toContain("eacces");
    f.out.length = 0; f.err.length = 0;
    expect(await f.invoke(["roam", "stores", "prune", "--confirm", "--json"])).toBe(1);
    expect(JSON.parse(f.out.join("")).value).toEqual({ failure: { check: "eacces", path: file } });
  } finally { chmodSync(path, 0o700); }
}, 5000);
