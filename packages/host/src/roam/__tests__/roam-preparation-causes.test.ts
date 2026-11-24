import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrate, openDb, paths } from "@spider/db-core";
import * as repoMap from "@spider/db-core/roam/repo-map";
import { readLocal } from "@spider/db-core/roam/local-state";
import { createReplica, scratchDbPath } from "@spider/db-core/testutil";
import { parseConfig } from "@spider/roam/config";
import { openFreezeJournal, openJournal } from "@spider/roam/journal";
import { runLocalDoctor } from "@spider/roam/local-diagnostics";
import { MoveCompositionError } from "@spider/roam/move-failure";
import { createRunningIntentAuthority } from "@spider/roam/session-control";
import { recordMoveSetupFailure } from "@spider/roam/setup-diagnostics";
import { createHostSessionFixture } from "../../__tests__/fixtures/pi-events";
import { registerAdmission, type AdmissionPorts } from "../admission";
import { createParticipantAdmission, productionParticipantAdmission } from "../readiness";

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

it("keeps unknown preparation exceptions private and classified as unavailable", async () => {
  const f = fixture("unknown");
  await f.start();
  expect(f.gate.inspect()).toMatchObject({ kind: "ordinary", setupFailure: { stage: "preparation", causeCode: "setup-unavailable" } });
  const report = await runLocalDoctor({ root: f.root });
  const diagnostic = report.diagnostics.find(row => row.reason.includes("setup-unavailable"));
  expect(diagnostic?.reason).toContain(SESSION);
  expect(diagnostic?.reason).not.toContain("private");
});
