import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrate, openDb, paths } from "@spider/db-core";
import * as repoMap from "@spider/db-core/roam/repo-map";
import { readLocal } from "@spider/db-core/roam/local-state";
import { createReplica, scratchDbPath } from "@spider/db-core/testutil";
import { parseConfig } from "@spider/roam/config";
import { main as roamCli } from "@spider/roam/cli";
import type { Peer, Transport } from "@spider/roam/contracts";
import * as productionHub from "@spider/roam/production-hub";
import * as transport from "@spider/roam/transport";
import { openFreezeJournal, openJournal } from "@spider/roam/journal";
import { runLocalDoctor } from "@spider/roam/local-diagnostics";
import { MoveCompositionError } from "@spider/roam/move-failure";
import { createRunningIntentAuthority } from "@spider/roam/session-control";
import { recordMoveSetupFailure } from "@spider/roam/setup-diagnostics";
import { createHostSessionFixture } from "../../__tests__/fixtures/pi-events";
import { registerAdmission, type AdmissionPorts } from "../admission";
import { createParticipantAdmission, productionParticipantAdmission } from "../readiness";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const blocked = () => { throw new Error("Unexpected process launch in fixture"); };
  const execFileSync = (file: unknown, args: unknown) => {
    if ((file === "ps" || file === "/bin/ps") && Array.isArray(args) && args[0] === "-p" &&
        args[1] === String(process.pid) && args[2] === "-o" && args[3] === "lstart=") return "fixture-start";
    if (file === "sqlite3" && JSON.stringify(args) === JSON.stringify(["--version"])) return "3.42.0";
    return blocked();
  };
  const safe = { exec: blocked, execFile: blocked, execFileSync, execSync: blocked, fork: blocked, spawn: blocked, spawnSync: blocked };
  return { ...original, ...safe, default: { ...original, ...safe } };
});
vi.mock("child_process", async () => await import("node:child_process"));

const BOX = "00000000-0000-4000-8000-000000000002";
const HUB = "00000000-0000-4000-8000-000000000001";
const SESSION = "session-1";
const FIRST = 1_700_000_000_000;
const LAST = FIRST + 30_000;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type Failure = "freeze" | "cwd" | "header" | "cwd-header" | "invalid-header" | "mapping" | "stores" | "seed" | "unknown" | "success";
function fixture(failure: Failure, participant = false) {
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  const parent = dirname(scratchDbPath("preparation-causes"));
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "preparation-"));
  const db = openDb(join(root, "spider.db"));
  migrate(db, "global", { machineId: BOX, globalRoot: root });
  db.prepare("UPDATE roam_meta SET store_key='global',capture_enabled=1 WHERE id=1").run();
  const config = parseConfig({ role: "box", machineId: BOX, hubMachineId: HUB, coreUnit: "fixture.service" });
  const journal = openJournal(join(root, "roam", "journal.db"));
  const worktree = failure === "success" ? createReplica("worktree", BOX) : null;
  if (failure === "freeze") openFreezeJournal(join(root, "roam", "journal.db")).beginFreeze(SESSION, "move-1", 1);
  const file = join(root, "session.jsonl");
  writeFileSync(file, failure === "invalid-header" ? "invalid" : JSON.stringify({ type: "session", id: failure === "header" ? "other-session" : SESSION,
    cwd: failure === "cwd-header" ? "/home/fixture/other" : root, version: 3 }) + "\n");
  const hooks = createParticipantAdmission({ cwd: () => failure === "cwd" ? undefined : root,
    async open() {
      if (failure === "unknown") throw new Error("private-content /home/fixture/private");
      return { db, config, journal, authority: createRunningIntentAuthority(db), close() {},
        async stores() {
          if (failure === "mapping") throw new MoveCompositionError("participant-store-mapping-failed");
          if (failure === "stores") throw new Error("private-content /home/fixture/private");
          return worktree ? [{ db: worktree.db, key: worktree.storeKey }] : [];
        } };
    },
    async terminal() { throw new Error("Unexpected terminal lookup"); },
  });
  const host = createHostSessionFixture({ cwd: root, sessionId: SESSION, sessionFile: file });
  const ports: AdmissionPorts = { expectedEpoch: null, localMachine: async () => BOX, knownParticipant: () => participant,
    warnOnce() {}, prepare: hooks.prepare,
    load: async () => ({ home: null, states: participant ? [{ sessionId: SESSION, epoch: 1, state: "active", moveId: null, freezeSeq: null }] : [],
      origin: participant ? BOX : null, participating: participant, captureSafe: true, unfinishedFreeze: false, initialConflict: false }),
    lock: async () => async () => {}, setupDiagnostic: (id, value) => recordMoveSetupFailure(db, id, value),
  };
  const gate = registerAdmission(host.pi as never, ports);
  cleanups.push(async () => { await gate.close(); db.close(); worktree?.close(); rmSync(root, { recursive: true, force: true }); });
  const start = async () => { for (const handler of host.hooks.get("session_start") ?? []) await handler({}, host.ctx); };
  return { db, root, gate, start, worktree };
}

it.each([
  ["freeze", "participant-freeze-unfinished"],
  ["cwd", "participant-cwd-unavailable"],
  ["header", "participant-header-mismatch"],
  ["cwd-header", "participant-header-mismatch"],
  ["invalid-header", "participant-header-invalid"],
  ["mapping", "participant-store-mapping-failed"],
  ["stores", "participant-stores-unavailable"],
  ["seed", "participant-seed-failed"],
] as const)("reports the %s preparation failure and its occurrence times", async (failure, causeCode) => {
  const now = vi.spyOn(Date, "now").mockReturnValue(FIRST);
  const f = fixture(failure);
  await f.start();
  expect(f.gate.inspect()).toMatchObject({ kind: "ordinary", setupFailure: { stage: "preparation", causeCode } });
  now.mockReturnValue(LAST);
  await f.start();
  expect(readLocal(f.db, "move-setup", "admission")).toEqual({ sessionId: SESSION, failure: { stage: "preparation", causeCode }, firstAt: FIRST, lastAt: LAST });
  const report = await runLocalDoctor({ root: f.root });
  const diagnostic = report.diagnostics.find(row => row.reason.includes(causeCode));
  expect(diagnostic).toMatchObject({ severity: "warning", repairCommand: "spider roam doctor" });
  expect(diagnostic?.reason).toContain(SESSION);
  expect(diagnostic?.reason).toContain("2023-11-14T22:13:20.000Z");
  expect(diagnostic?.reason).toContain("2023-11-14T22:13:50.000Z");
  expect(diagnostic?.reason).not.toContain(f.root);
  expect(diagnostic?.reason).not.toContain("private");
});

it("seeds a valid participant without leaving a setup diagnostic", async () => {
  const f = fixture("success");
  await f.start();
  expect(f.gate.inspect()).toMatchObject({ kind: "ordinary" });
  expect(f.gate.inspect().setupFailure).toBeUndefined();
  expect(f.worktree!.db.prepare("SELECT state,epoch FROM roam_sessions WHERE session_id=?").get(SESSION)).toEqual({ state: "active", epoch: 1 });
  expect(readLocal(f.db, "move-setup", "admission")).toBeUndefined();
});

it("classifies a production repository mapping failure through admission", async () => {
  const f = fixture("seed");
  const previous = paths.globalRoot;
  paths.globalRoot = f.root;
  cleanups.push(async () => { paths.globalRoot = previous; });
  const roam = join(f.root, "roam");
  chmodSync(roam, 0o700);
  writeFileSync(join(roam, "config.json"), JSON.stringify(parseConfig({ role: "box", machineId: BOX, hubMachineId: HUB, coreUnit: "fixture.service" })), { mode: 0o600 });
  writeFileSync(join(roam, "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  vi.spyOn(paths, "projectRoot").mockImplementation(cwd => join(cwd, ".spider"));
  vi.spyOn(repoMap, "resolveRepositoryKey").mockImplementation(() => { throw new Error("Non-Git repositories require an explicit map /home/fixture/private"); });
  const host = createHostSessionFixture({ cwd: f.root, sessionId: SESSION, sessionFile: join(f.root, "session.jsonl") });
  const ports: AdmissionPorts = { expectedEpoch: null, localMachine: async () => BOX, knownParticipant: () => false, warnOnce() {},
    prepare: productionParticipantAdmission(() => f.root).prepare,
    load: async () => ({ home: null, states: [], origin: null, participating: false, captureSafe: true, unfinishedFreeze: false, initialConflict: false }),
    lock: async () => async () => {}, setupDiagnostic: (id, value) => recordMoveSetupFailure(f.db, id, value),
  };
  const gate = registerAdmission(host.pi as never, ports);
  cleanups.push(() => gate.close());
  for (const handler of host.hooks.get("session_start") ?? []) await handler({}, host.ctx);
  expect(gate.inspect()).toMatchObject({ kind: "ordinary", setupFailure: { stage: "preparation", causeCode: "participant-store-mapping-failed" } });
  expect(JSON.stringify(gate.inspect())).not.toContain("private");
});

it("keeps a known participant blocked after a named preparation failure", async () => {
  const f = fixture("mapping", true);
  await f.start();
  expect(f.gate.inspect()).toMatchObject({ kind: "blocked", setupFailure: { stage: "preparation", causeCode: "participant-store-mapping-failed" } });
});

it("shows the retained admission failure in public doctor while roaming is disabled", async () => {
  const f = fixture("cwd");
  await f.start();
  const snapshot = readLocal<{ firstAt: number; lastAt: number }>(f.db, "move-setup", "admission")!;
  const directory = join(f.root, "roam");
  writeFileSync(join(directory, "config.json"), JSON.stringify({ enabled: false, role: "box", machineId: BOX,
    hubMachineId: HUB, coreUnit: "fixture.service" }), { mode: 0o600 });
  writeFileSync(join(directory, "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root);
  let out = "";
  await roamCli(["roam", "doctor", "--json"], { out: text => { out += text; }, err: () => {} });
  const report = JSON.parse(out) as { value: { diagnostics: Array<{ reason: string }> } };
  expect(report.value.diagnostics).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("participant-cwd-unavailable") }));
  const diagnostic = report.value.diagnostics.find(row => row.reason.includes("participant-cwd-unavailable"));
  expect(diagnostic?.reason).toContain(SESSION);
  expect(diagnostic?.reason).toContain(new Date(snapshot.firstAt).toISOString());
  expect(diagnostic?.reason).toContain(new Date(snapshot.lastAt).toISOString());
  expect(out).not.toContain(f.root);
});

it("shows a safe admission diagnostic from a disabled remote box", async () => {
  const f = fixture("cwd");
  await f.start();
  const boxDirectory = join(f.root, "roam");
  writeFileSync(join(boxDirectory, "config.json"), JSON.stringify({ enabled: false, role: "box", machineId: BOX,
    hubMachineId: HUB, coreUnit: "fixture.service" }), { mode: 0o600 });
  writeFileSync(join(boxDirectory, "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  const hub = mkdtempSync(join(dirname(f.root), "doctor-hub-")), directory = join(hub, "roam");
  cleanups.push(async () => { rmSync(hub, { recursive: true, force: true }); });
  mkdirSync(directory, { mode: 0o700 });
  const peer: Peer = { machineId: BOX, alias: "box-1.invalid", node: "/home/fixture/node", pi: "/home/fixture/pi",
    cli: "/home/fixture/cli", core: "/home/fixture/core", globalRoot: f.root };
  writeFileSync(join(directory, "config.json"), JSON.stringify({ enabled: false, role: "hub", machineId: HUB,
    hubMachineId: HUB, coreUnit: "fixture.service", peers: [peer] }), { mode: 0o600 });
  writeFileSync(join(directory, "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/core" } } as never);
  vi.spyOn(transport, "createTransport").mockReturnValue({
    async resolve(value: Peer) { return value; },
    async exec(_value: Peer, argv: readonly string[]) {
      expect(argv).toEqual(["roam", "observe", "doctor"]);
      let out = "";
      expect(await roamCli(["--global-root", f.root, ...argv], { out: text => { out += text; }, err: () => {} })).toBe(0);
      const reply = JSON.parse(out);
      reply.value.diagnostics.push({ severity: "warning", repairCommand: "spider roam doctor",
        reason: "Move setup failed at preparation (setup-unavailable). Run spider roam doctor, repair the local setup, then reload this session. Session /home/fixture/private." });
      return Buffer.from(JSON.stringify(reply));
    },
  } as unknown as Transport);
  vi.stubEnv("SPIDER_GLOBAL_ROOT", hub);
  let out = "";
  await roamCli(["roam", "doctor", "box-1.invalid", "--json"], { out: text => { out += text; }, err: () => {} });
  const report = JSON.parse(out) as { value: { diagnostics: Array<{ reason: string }> } };
  expect(report.value.diagnostics).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("participant-cwd-unavailable") }));
  expect(out).toContain(SESSION);
  expect(out).not.toContain("/home/fixture/private");
  expect(out).not.toContain(f.root);
});

it("keeps unknown preparation exceptions private and classified as unavailable", async () => {
  const f = fixture("unknown");
  await f.start();
  expect(f.gate.inspect()).toMatchObject({ kind: "ordinary", setupFailure: { stage: "preparation", causeCode: "setup-unavailable" } });
  const report = await runLocalDoctor({ root: f.root });
  const diagnostic = report.diagnostics.find(row => row.reason.includes("setup-unavailable"));
  expect(diagnostic?.reason).toContain(SESSION);
  expect(diagnostic?.reason).not.toContain("private");
});
