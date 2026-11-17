import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createReplica, scratchDbPath } from "@spider/db-core/testutil";
import { recordLocation } from "@spider/db-core/roam/catalog";
import type { Probe } from "@spider/db-core/roam/types";
import { installPiAuth } from "../auth";
import { DEFAULT_LIMITS, disabledIntercom } from "../contracts";
import type { Transport } from "../contracts";
import { openJournal } from "../journal";
import { createParticipantSupervisor } from "../participant-supervisor";
import * as participantSupervisor from "../participant-supervisor";
import * as productionSupervisor from "../production-supervisor";
import * as launcher from "../launcher";
import * as runtime from "../runtime";
import * as productionHub from "../production-hub";
import * as hcModule from "@spider/herdr/client/hc";
import { handleSessionOperation } from "../participant-runtime";
import { provision } from "../provision";
import type { ProvisionPorts } from "../provision-contracts";
import { inspectDestinationSettings, installSelectedFiles } from "../selected-files";
import { createRunningIntentAuthority } from "../session-control";
import { enterHostingEnvironment } from "../../../herdr/e2e/fixtures/roam-hosting";
import { bootstrapPeer, healthyInventory } from "./bootstrap-fixture";
// @ts-ignore The executable runner is exercised through its public functions.
import { buildMatrix, complete, parseOptions, profileIds, storyWorkers } from "../../../../scripts/herdr-e2e.mjs";

const HUB = "00000000-0000-4000-8000-000000000001";
const BOX = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function provisionFixture() {
  const root = mkdtempSync(join(dirname(scratchDbPath("hosting-acceptance")), "hosting-acceptance-")); roots.push(root);
  const source = join(root, "source"), destination = join(root, "agent"), stage = join(root, "stage"), units = join(root, "units");
  for (const dir of [source, destination, stage, units]) mkdirSync(dir, { mode: 0o700 });
  const release = join(source, "release.tgz"), core = join(units, "herdr-core.service"), terminals = join(root, "terminals.json");
  writeFileSync(release, "fixture release", { mode: 0o600 });
  writeFileSync(join(source, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-only" } }), { mode: 0o600 });
  writeFileSync(core, "existing core unit", { mode: 0o600 });
  writeFileSync(terminals, '["existing-terminal"]', { mode: 0o600 });
  const journal = openJournal(join(root, "journal.db"));
  const actions: string[] = [], diagnostics: Array<{ reason: string; severity: string }> = [];
  const state = { consent: true, signedIn: false, peerEnabled: false };
  const inventory = healthyInventory();
  const transport: Transport = {
    async bootstrapProbe() { return structuredClone(inventory); }, async resolve(peer) { return peer; },
    async exec() { throw new Error("unexpected transport"); }, async run() { throw new Error("unexpected transport"); },
    async read() { throw new Error("unexpected transport"); }, async write() { throw new Error("unexpected transport"); },
  };
  const home = "/fixture/home", agentDir = `${home}/.pi/agent`, npmPrefix = `${home}/.local`;
  const peer = { ...bootstrapPeer, machineId: BOX, pi: `${npmPrefix}/bin/pi`, cli: `${npmPrefix}/lib/spider/dist/roam/cli.mjs`,
    core: `${npmPrefix}/bin/hc`, globalRoot: `${agentDir}/spider` };
  inventory.pi = peer.pi;
  const supervisor = `${npmPrefix}/lib/spider/dist/roam/supervisor.mjs`, stageFile = join(stage, "auth");
  const ports: ProvisionPorts = {
    transport, journal, hubMachineId: HUB, limits: DEFAULT_LIMITS, coreUnit: "herdr-core.service",
    async withPeerLock(_machine, work) { return work(); },
    async setParticipation(target, ready) {
      if (ready !== null) { await ports.transfer.setEnabled(target, HUB, ready); state.peerEnabled = ready; }
    },
    async confirm() { actions.push("confirm"); return state.consent; },
    systemd: {
      unitDir: `${home}/.config/systemd/user`,
      async writeUnit(name, bytes) { actions.push(`write:${name}`); writeFileSync(join(units, name), bytes, { mode: 0o600 }); },
      async systemctl(argv) {
        actions.push(`systemctl:${argv.join(" ")}`);
        if (argv[0] === "--user" && ["stop", "restart", "kill"].includes(argv[1]) && argv.includes("herdr-core.service")) {
          writeFileSync(terminals, "[]", { mode: 0o600 });
        }
      },
    },
    async resources() { throw new Error("host resource probe forbidden"); },
    async bootId() { throw new Error("host boot probe forbidden"); },
    release: { pi: "1.2.0", intercom: "spider-owned", spiderSha256: createHash("sha256").update(readFileSync(release)).digest("hex"), nodeRange: "22.23.4 || 26.4.0" },
    source: { agentRoot: source, releaseFile: release, piProviders: ["fixture"] },
    destination: { home, agentDir, npmPrefix, supervisor },
    async present() {}, async report(rows) { diagnostics.push(...rows); },
    async verifyPeer() { return { piSignedIn: state.signedIn, nativeSqlite: true, extensionLoaded: true, exactSession: true, privateModes: true,
      bundledIntercom: true, intercomUnique: true, legacyDrained: true, federation: true,
      intercomEvidence: { settings: "settings-unique", legacy: "legacy-drained-private-agent", federation: "federation-v1", otherExtensions: [] } }; },
    bootstrap: {
      async probeAgentDirectory() { return { status: "default", core: { local: "local-core", remote: "box-core" } }; },
      async previewSettings(_peer, _home, entries, maximum) { return inspectDestinationSettings({ home: root, destinationRoot: destination, entries, maximum }); },
      async claimIdentity() { actions.push("identity"); return { machineId: BOX, coreId: "box-core" }; },
    },
    transfer: {
      async setEnabled(_peer, _hub, enabled) { actions.push(`enabled:${enabled}`); },
      async enroll() { actions.push("enroll"); }, async cleanupSecrets() { actions.push("cleanup"); },
      async installRelease() { actions.push("release"); return { pi: peer.pi, cli: peer.cli, supervisor }; },
      async installFiles(_peer, files, expectedSettingsFingerprint) { installSelectedFiles({ destinationRoot: destination, files, expectedSettingsFingerprint }); },
      async installCredentialFiles() { throw new Error("unexpected credential file"); },
      auth() { return {
        async stage(bytes) { actions.push("auth-stage"); writeFileSync(stageFile, bytes, { mode: 0o600 }); return { file: stageFile }; },
        async install(staged, providers) { actions.push("auth-install"); installPiAuth({ destinationRoot: destination, stagingRoot: stage, stagedFile: staged.file, providers }); },
        async remove(staged) { rmSync(staged?.file ?? stageFile, { force: true }); },
      }; },
      async switchover() { actions.push("switchover"); return { status: "applied" }; },
    },
    async persistPeer() { actions.push("peer"); },
  };
  const request = (id: string, includeAuth = false) => ({ operation: { id, kind: "provision", machineId: BOX, expectedEpoch: null, args: {} }, peer,
    selected: [], includeAuth, confirmedProviders: includeAuth ? ["fixture"] : [] });
  const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  return { root, core, terminals, destination, stageFile, units, journal, actions, diagnostics, state, ports, request, digest };
}

it("A10 fixture models existing terminal loss on a core restart", async () => {
  const f = provisionFixture(), before = f.digest(f.terminals);
  await f.ports.systemd.systemctl(["--user", "restart", "herdr-core.service"]);
  expect(f.digest(f.terminals)).not.toBe(before);
}, 5000);

it("A10 provision never changes existing core", async () => {
  const f = provisionFixture();
  const coreBefore = f.digest(f.core), terminalsBefore = f.digest(f.terminals);
  f.state.consent = false;
  expect(await provision(f.request("provision-1", true), f.ports)).toMatchObject({ code: 1, reason: "consent-refused" });
  expect(f.actions).toEqual(["confirm"]);
  expect(existsSync(join(f.destination, "auth.json"))).toBe(false);
  expect(existsSync(join(f.units, "spider-roam-supervisor.service"))).toBe(false);
  f.state.consent = true; f.state.signedIn = true;
  expect(await provision(f.request("provision-1", true), f.ports)).toMatchObject({ code: 0, value: { hostingReady: true } });
  expect(JSON.parse(readFileSync(join(f.destination, "auth.json"), "utf8"))).toEqual({ fixture: { type: "api_key", key: "fixture-only" } });
  expect(existsSync(f.stageFile)).toBe(false);
  expect(f.digest(f.core)).toBe(coreBefore);
  expect(f.digest(f.terminals)).toBe(terminalsBefore);
  const actionsAfterInstall = [...f.actions];
  expect(await provision(f.request("provision-1", true), f.ports)).toMatchObject({ code: 0, value: { hostingReady: true } });
  expect(f.actions).toEqual(actionsAfterInstall);
  expect(f.actions.filter(action => action === "systemctl:--user enable spider-roam-supervisor.service")).toHaveLength(1);
  expect(f.actions.some(action => /(?:restart|stop).*herdr-core/.test(action))).toBe(false);
}, 5000);

it("missing sign-in blocks hosting not installation", async () => {
  const f = provisionFixture();
  expect(await provision(f.request("without-auth"), f.ports)).toMatchObject({ code: 0, reason: "installed-hosting-disabled", value: { hostingReady: false } });
  expect(existsSync(join(f.units, "spider-roam-supervisor.service"))).toBe(true);
  expect(f.actions).toContain("release");
  expect(f.actions).not.toContain("auth-stage");
  expect(f.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block", reason: expect.stringMatching(/sign-in/i) })]));
}, 5000);

it("A11 deliberate stop is durable", async () => {
  const global = createReplica("global", BOX), worktree = createReplica("worktree", BOX);
  const config = { enabled: false, role: "box" as const, machineId: BOX, hubMachineId: HUB, peers: [], discoveryRoots: [],
    coreUnit: "fixture.service", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  try {
    mkdirSync(join(global.root, "roam"), { mode: 0o700 });
    writeFileSync(join(global.root, "roam", "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
    writeFileSync(join(global.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
    const file = join(worktree.root, "session.jsonl"), sessionId = "session-1";
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: worktree.root }) + "\n", { mode: 0o600 });
    global.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
    global.db.prepare("INSERT INTO session_homes VALUES (?,?,1,NULL,1)").run(sessionId, BOX);
    worktree.db.prepare("INSERT INTO sessions(id,started_at,origin_machine) VALUES (?,1,?)").run(sessionId, BOX);
    worktree.db.prepare("INSERT INTO roam_sessions(session_id,epoch,state) VALUES (?,1,'active')").run(sessionId);
    worktree.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
    recordLocation(global.db, { sessionId, stores: [worktree.storeKey], home: null, file, cwd: worktree.root });
    const journal = openJournal(join(global.root, "roam", "journal.db"));
    const agent = { config, root: join(global.root, "roam", "stage"), journal,
      openStore(key: string) { return { db: key === "global" ? global.db : worktree.db, effects: {} as never, policy: {} as never }; } };
    const authority = createRunningIntentAuthority(global.db);
    await authority.set({ sessionId, epoch: 1, desired: "running", suspended: null, file, cwd: worktree.root, moveId: null }, "start-1", { kind: "box-participant", machineId: BOX, hubMachineId: HUB });
    let owner: Probe = { kind: "live", identity: { bootId: "fixture-boot", pid: 123, startTime: "fixture-start" } }, launches = 0, stops = 0;
    const make = () => createParticipantSupervisor({ root: global.root, agent,
      clock: { now: () => 1, later: () => () => {} }, events: { subscribe: () => () => {} }, owner: async () => owner,
      diagnostics: async () => [], async stop() { stops++; owner = { kind: "absent" }; return owner; }, notify: async () => {},
      async launch() { launches++; throw new Error("stopped session must not launch"); } });
    const first = make(); await first.reconcile();
    expect(await handleSessionOperation({ id: "stop-1", kind: "session-stop", machineId: BOX, expectedEpoch: 1,
      args: { sourceMachine: HUB, sessionId } }, agent, { wake: async () => {} })).toMatchObject({ code: 0, reason: "stopped-intent" });
    await first.reconcile(); await first.stop();
    expect(stops).toBe(1);
    const restarted = make(); await restarted.reconcile(); await restarted.stop();
    expect(await createRunningIntentAuthority(global.db).get(sessionId)).toMatchObject({ desired: "stopped", epoch: 1 });
    expect(global.db.prepare("SELECT machine_id,epoch FROM session_homes WHERE session_id=?").get(sessionId)).toEqual({ machine_id: BOX, epoch: 1 });
    expect(launches).toBe(0);
  } finally { global.close(); worktree.close(); }
}, 5000);

it("isolates fixture supervisor environment and restores the caller's environment", () => {
  vi.stubEnv("HC_SCOPE", "untrusted-scope");
  vi.stubEnv("SSH_AUTH_SOCK", "untrusted-socket");
  vi.stubEnv("SPIDER_HERDR_SSH_DESCRIPTOR", "untrusted-descriptor");
  vi.stubEnv("FIXTURE_API_KEY", "untrusted-credential");
  const originalHome = process.env.HOME;
  const restore = enterHostingEnvironment({ HOME: "/fixture/home", HC_SOCKET: "/fixture/core.sock" });
  try {
    expect(process.env.HOME).toBe("/fixture/home");
    expect(process.env.HC_SOCKET).toBe("/fixture/core.sock");
    expect(process.env.HC_SCOPE).toBeUndefined();
    expect(process.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(process.env.SPIDER_HERDR_SSH_DESCRIPTOR).toBeUndefined();
    expect(process.env.FIXTURE_API_KEY).toBeUndefined();
    expect(process.env.VITEST).toBeDefined();
  } finally { restore(); }
  expect(process.env.HOME).toBe(originalHome);
  expect(process.env.HC_SCOPE).toBe("untrusted-scope");
  expect(process.env.SSH_AUTH_SOCK).toBe("untrusted-socket");
  expect(process.env.SPIDER_HERDR_SSH_DESCRIPTOR).toBe("untrusted-descriptor");
  expect(process.env.FIXTURE_API_KEY).toBe("untrusted-credential");
}, 5000);

it("uses the fixture shell for a supervised exact launch", async () => {
  const global = createReplica("global", BOX);
  try {
    const config = { enabled: false, role: "box" as const, machineId: BOX, hubMachineId: HUB, peers: [], discoveryRoots: [],
      coreUnit: "fixture.service", syncMs: 120000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
    mkdirSync(join(global.root, "roam"), { mode: 0o700 });
    const agentDir = join(global.root, "agent"); mkdirSync(agentDir, { mode: 0o700 });
    writeFileSync(join(global.root, "roam", "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
    writeFileSync(join(global.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
    global.db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
    await global.db.raw.backup(join(global.root, "spider.db"));
    const file = join(global.root, "session.jsonl"); writeFileSync(file, "session", { mode: 0o600 });
    const journal = openJournal(join(global.root, "roam", "journal.db"));
    vi.spyOn(runtime, "openLocalRuntime").mockReturnValue({ config, db: global.db, journal, agent: {} as never, close() {} } as never);
    vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ agentDirectory: agentDir, core: { binary: "/fixture/hc" } } as never);
    vi.spyOn(hcModule, "createHcClient").mockReturnValue({ async identity() { return { coreId: "core-1", sessionNamespace: "owned", socket: "/fixture/socket" }; },
      events() { return { subscribe() { return () => {}; }, dispose() {} }; }, async dispose() {} } as never);
    vi.spyOn(launcher, "createProductionLocalExactHc").mockReturnValue({ async coreId() { return "core-1"; }, async dispose() {} } as never);
    const adapter = vi.spyOn(launcher, "createExactLaunchAdapter").mockReturnValue({ async launch(request: { file: string; sessionId: string; cwd: string; operationId: string }) {
      return { pid: 123, startIdentity: "fixture-process", sessionFile: request.file, sessionId: request.sessionId,
        cwd: request.cwd, token: "fixture", operationId: request.operationId };
    } } as never);
    let launch: Parameters<typeof createParticipantSupervisor>[0]["launch"] | undefined;
    vi.spyOn(participantSupervisor, "createParticipantSupervisor").mockImplementation(input => {
      launch = input.launch; return { async reconcile() {}, start() {}, async stop() {} };
    });
    vi.stubEnv("SPIDER_ROAM_PI", "/fixture/pi");
    const system = { shell: "/fixture/shell", bootId: async () => "fixture-boot", limits: async () => ({ soft: 1, hard: 1 }),
      inventory: { async probe() { return { kind: "live" as const, startIdentity: "fixture-process" }; }, leases: {} } } as never;
    const service = await productionSupervisor.startProductionSupervisor(global.root, { system });
    try {
      if (!launch) throw new Error("supervisor did not register a launch port");
      await launch({ sessionId: "session-1", epoch: 1, desired: "running", suspended: null, file, cwd: global.root, moveId: null }, "launch-1", "initial");
      expect(adapter.mock.calls[0][0].base.shell).toBe("/fixture/shell");
    } finally { await service.stop(); }
  } finally { global.close(); }
}, 5000);

it("selects the three packaged hosting stories serially and never counts missing results as passed", () => {
  const ids = ["R03", "R04", "R05"];
  expect(parseOptions(["--tier", "headless", "--story", ids.join(",")], {}).ids).toEqual(ids);
  for (const id of ids) {
    expect(profileIds.headless).toContain(id);
    expect(profileIds.ci).not.toContain(id);
    expect(storyWorkers({ tier: "headless", ids: [id] })).toBe(1);
    expect(buildMatrix("ci", profileIds.ci, []).find((row: { id: string }) => row.id === id).result).toBe("not exercised");
  }
  expect(storyWorkers({ tier: "headless", ids })).toBe(1);
  const missing = buildMatrix("headless", ids, []);
  expect(missing.filter((row: { id: string }) => ids.includes(row.id)).map((row: { result: string }) => row.result)).toEqual(["failed", "failed", "failed"]);
  expect(complete(missing, ids)).toBe(false);
}, 5000);
