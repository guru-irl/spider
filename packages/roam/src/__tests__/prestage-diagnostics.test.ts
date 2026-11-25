// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createReplica, scratchDbPath } from "@spider/db-core/testutil";
import type { Home, JsonObject } from "@spider/db-core/roam/types";
import { handleAgentOperation } from "../agent";
import { main as roamCli } from "../cli";
import { safeControlOutcome } from "../commands";
import { DEFAULT_LIMITS, disabledIntercom, type Operation, type RoamConfig, type Transport } from "../contracts";
import { assignInitialHome, sessionHome } from "../homes";
import { openJournal } from "../journal";
import { moveSession } from "../move";
import { createMovePorts, handleMoveParticipantOperation, type MoveAdapterBindings } from "../move-ports";

const HUB = "00000000-0000-4000-8000-000000000001", PEER = "00000000-0000-4000-8000-000000000002";
const cleanup: Array<() => void> = [];
afterEach(() => { vi.unstubAllEnvs(); for (const close of cleanup.splice(0).reverse()) close(); });
const unused = async (): Promise<never> => { throw new Error("Unexpected external effect"); };
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value));
function fixture(sourceMachine = HUB) {
  const parent = dirname(scratchDbPath("prestage-diagnostics")); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "prestage-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const global = createReplica("global", HUB), remote = createReplica("global", PEER);
  cleanup.push(() => global.close(), () => remote.close());
  const coordinatorRoot = join(root, "coordinator"), participantRoot = join(root, "participant");
  const journal = openJournal(join(coordinatorRoot, "roam", "journal.db"));
  const remoteJournal = openJournal(join(participantRoot, "roam", "journal.db"));
  const config: RoamConfig = { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB,
    peers: [{ machineId: PEER, alias: "peer.invalid", node: "/bin/node", pi: "/bin/pi", cli: "/bin/spider", core: "fixture", globalRoot: participantRoot }],
    discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() };
  const remoteConfig: RoamConfig = { ...config, role: "box", machineId: PEER, peers: [] };
  const destinationMachine = sourceMachine === HUB ? PEER : HUB;
  const operation: Operation = { id: "move-fixture", kind: "move", machineId: HUB, expectedEpoch: 1,
    args: { sessionId: "session-a", destinationMachine } };
  const home = assignInitialHome(global.db, "session-a", sourceMachine, HUB) as Home;
  const check = { source: home, destinationMachine, repoKey: "fixture-repo", workspaceId: "fixture-workspace",
    sourceRoot: root, sourceFile: join(root, "session.jsonl"), sourceCwd: root, destinationRoot: participantRoot,
    destinationCwd: participantRoot, storeKeys: ["global", "repo:fixture-repo", "worktree:fixture-repo:fixture-workspace"] as const, warnings: [] };
  const bindings: MoveAdapterBindings = { root: participantRoot, participant: {
    pi: "/bin/pi", config: remoteConfig, globalDb: remote.db, root: participantRoot, runtimeRoot: participantRoot, stores: [],
    withBothLocks: async (_id, effect) => effect(), probe: unused, git: { run: unused, scratch: join(root, "git"), worktreeCommand: null },
    writers: async () => { throw Object.assign(new Error("fixture-private"), { code: "ENOENT" }); },
    sessionTarget: unused, auth: unused, identityCurrent: unused, wake: unused, readiness: unused, observation: unused,
    dormant: () => unused, retireFailed: unused, readmitLive: unused, cleanupTerminal: unused,
  } };
  const dispatch = (op: Operation) => handleAgentOperation(op, { config: remoteConfig, root: participantRoot,
    journal: remoteJournal, openStore: () => { throw new Error("Unexpected replicated store access"); },
    move: value => handleMoveParticipantOperation(value, remoteJournal, bindings) });
  const transport: Transport = { resolve: async peer => peer, bootstrapProbe: unused, run: unused, read: unused, write: unused,
    exec: async (_peer, argv) => Buffer.from(JSON.stringify(await dispatch(JSON.parse(argv[2])))) };
  const localParticipant = { ...bindings.participant!, config, globalDb: global.db, root: coordinatorRoot };
  const ports = createMovePorts(config, transport, journal, { root: coordinatorRoot, globalDb: global.db,
    participant: localParticipant,
    intercom: { address: { sessionId: "session-a", scopeId: null }, destinationEndpoint: unused,
      ports: { close: unused, drain: unused, inspect: unused, checkGeneration: unused, abort: unused, ready: unused },
      rollback: { currentFence: unused, reopen: unused } } });
  return { journal, remoteJournal, coordinatorRoot, participantRoot, operation, home, global, check, dispatch, ports, localParticipant };
}
async function observe(root: string, moveId: string) {
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  let out = "", err = "";
  const exit = await roamCli(["roam", "observe", "transfer", moveId], { out: text => { out += text; }, err: text => { err += text; } });
  expect({ exit, err }).toEqual({ exit: 0, err: "" });
  const parsed = JSON.parse(out);
  expect(parsed).toMatchObject({ version: 1, kind: "private-transfer-diagnostics" });
  return parsed.value;
}

// A stage-blind label or an unwrapped pre-stage participant breaks these cases.
it.each(["pre", "final"] as const)("persists %s participant failures for every transfer operation", async stage => {
  const f = fixture();
  for (const [kind, phase, code] of [
    ["move-prerequisites", "participant-prerequisites", "move-workspace-unmapped"],
    ["move-export", "participant-export", "ENOENT"],
    ["move-import", "participant-import", "untyped-error"],
  ] as const) {
    const operation: Operation = { id: `${f.operation.id}-${stage}-${kind}-${PEER}`, kind, machineId: PEER, expectedEpoch: 2,
      args: { sourceMachine: HUB, sessionId: "session-a", moveId: f.operation.id, stage, parent: json(f.operation),
        root: f.participantRoot, repoKey: "fixture-repo", workspaceId: "fixture-workspace", sourceCheckoutName: "fixture",
        ...(kind === "move-import" ? { stage: stage === "pre" ? "final" : "pre" } : {}),
        check: json({ ...f.check, storeKeys: [] }), exported: { workspace: { stage } } } };
    // Only the participant operation is known here, not the coordinator's move.
    f.remoteJournal.begin(operation);
    if (kind === "move-prerequisites") expect(() => f.remoteJournal.record(f.operation.id, "probe", {})).toThrow("Operation has not begun");
    const result = await f.dispatch(operation);
    const step = stage === "pre" ? "remote-prepare" : "transfer";
    expect.soft(result).toMatchObject({ code: 1, failure: { step, code: kind === "move-prerequisites" ? code : "unknown" } });
    const rows = f.remoteJournal.read(f.operation.id).filter(row => row.action === "move-transfer-diagnostic").map(row => row.result);
    expect.soft(rows).toContainEqual({ stage, phase, code, codeSource: code === "untyped-error" ? "untyped" : "code", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const observed = await observe(f.participantRoot, f.operation.id);
    expect.soft(observed).toEqual(rows);
    expect.soft(observed).toContainEqual(expect.objectContaining({ stage, phase, code }));
    expect.soft(JSON.stringify(safeControlOutcome(result))).not.toMatch(/fixture-private|ENOENT|fingerprint|participant-export/);
  }
});

// Removing the coordinator pre-stage wrapper or the participant's accepted journal ID loses rows.
it.each(["pre", "final"] as const)("observes %s prerequisite failures on independent coordinator and participant journals", async stage => {
  const f = fixture();
  f.journal.begin(f.operation);
  const fail = stage === "pre" ? f.ports.prepare(f.check, f.operation) : f.ports.transfer(f.check, {} as never, f.operation);
  await expect.soft(fail).rejects.toMatchObject({ failure: { step: stage === "pre" ? "remote-prepare" : "transfer", code: "move-workspace-unmapped" } });
  for (const [root, journal, phase] of [[f.coordinatorRoot, f.journal, "prerequisites"], [f.participantRoot, f.remoteJournal, "participant-prerequisites"]] as const) {
    const rows = journal.read(f.operation.id).filter(row => row.action === "move-transfer-diagnostic").map(row => row.result);
    expect.soft(rows).toContainEqual(expect.objectContaining({ stage, phase, code: "move-workspace-unmapped" }));
    expect.soft(await observe(root, f.operation.id)).toEqual(rows);
    expect.soft(await observe(root, f.operation.id)).toContainEqual(expect.objectContaining({ stage, phase }));
  }
  expect(sessionHome(f.global.db, "session-a")).toEqual(f.home);
});

// A remote export refusal must retain its stage at both private boundaries and in the public outcome.
it("records a private pre-stage result failure around the whole coordinator action", async () => {
  const f = fixture(PEER);
  // Satisfy destination Git prerequisites locally; the remote export is the failing effect.
  f.global.db.prepare("INSERT INTO roam_repo_maps(repo_key,path) VALUES(?,?)").run("fixture-repo", f.participantRoot);
  f.global.db.prepare("INSERT INTO roam_workspace_maps(repo_key,workspace_id,path,snapshot_json) VALUES(?,?,?,NULL)")
    .run("fixture-repo", "fixture-workspace", f.participantRoot);
  f.localParticipant.git = { ...f.localParticipant.git, run: async (_cwd, argv) =>
    Buffer.from(argv[1] === "worktree" ? `worktree ${f.participantRoot}\0` : "a".repeat(40)) };
  Object.assign(f.ports, { check: async () => f.check, power: async () => async () => {},
    seed: async () => f.check.storeKeys.map(storeKey => ({ storeKey, stream: "fixture-stream", through: 0 })),
    barriers: async () => true, replicateHome: async () => {} });
  const result = await moveSession({ operation: f.operation, sessionId: "session-a", destinationMachine: HUB }, f.ports);
  const coordinator = await observe(f.coordinatorRoot, f.operation.id), participant = await observe(f.participantRoot, f.operation.id);
  const comparisonFile = process.env.SPIDER_TEST_TRANSFER_COMPARISON;
  if (comparisonFile) writeFileSync(comparisonFile, JSON.stringify({ failure: result.failure, coordinator, participant }, null, 2) + "\n");
  expect.soft(result).toMatchObject({ failure: { step: "remote-prepare", code: "unknown" } });
  expect.soft(coordinator).toEqual([
    expect.objectContaining({ stage: "pre", phase: "export" }), expect.objectContaining({ stage: "pre", phase: "result" }),
  ]);
  expect.soft(participant).toEqual([
    expect.objectContaining({ stage: "pre", phase: "participant-export", code: "ENOENT" }),
  ]);
  expect(JSON.stringify(safeControlOutcome(result))).not.toMatch(/fixture-private|ENOENT|fingerprint|participant-export|codeSource/);
  expect(sessionHome(f.global.db, "session-a")).toEqual(f.home);
});
