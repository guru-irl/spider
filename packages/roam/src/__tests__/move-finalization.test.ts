import { afterEach, expect, it } from "vitest";
import { dirname } from "node:path";
import type { HubOperationReadiness } from "@spider/db-core/roam/types";
import type { MoveCheck, MoveRequest, PreparedMove } from "../contracts";
import { moveSession, recoverMove } from "../move";
import { recoveryFixture, HUB, OTHER } from "./recovery-fixture";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
async function fixture() {
  const f = await recoveryFixture(); cleanups.push(f.close);
  const operation = { id: "finalize-move", kind: "move", machineId: HUB, expectedEpoch: 1, args: { sessionId: "session-a", destinationMachine: OTHER } };
  const request: MoveRequest = { operation, sessionId: "session-a", destinationMachine: OTHER };
  const check: MoveCheck = { source: f.oldHome!, destinationMachine: OTHER, repoKey: "fixture-repo", workspaceId: "fixture-workspace",
    sourceRoot: dirname(f.file), sourceFile: f.file, sourceCwd: f.source.cwd, destinationRoot: dirname(f.file), destinationCwd: f.source.cwd,
    storeKeys: ["global", "repo:fixture-repo", "worktree:fixture-repo:fixture-workspace"], warnings: [] };
  const prepared = (stage: "pre" | "final"): PreparedMove => ({ session: f.source, workspace: { root: check.destinationRoot, moveId: operation.id, previous: null, adjustments: [], snapshot: {
    root: check.sourceRoot, repoKey: check.repoKey, workspaceId: check.workspaceId, moveId: operation.id, stage, head: "a".repeat(40), branch: null,
    objectFormat: "sha1", indexTree: "b".repeat(40), workingTree: "b".repeat(40), relativeCwd: ".", sparsePatterns: null, worktreeConfig: null,
    droppedConfigKeys: [], normalization: { autocrlf: null, eol: null }, sparse: { enabled: false, cone: null }, refs: [], prerequisites: [], bundle: { kind: "unbundled" },
  } } });
  const barriers = check.storeKeys.map(storeKey => ({ storeKey, stream: "fixture-stream", through: 0 }));
  const readiness = (home: typeof check.source): HubOperationReadiness => ({ origin: "hub-operation", opId: operation.id, sessionId: request.sessionId, epoch: home.epoch,
    core: "fixture-core", terminal: "fixture-terminal", file: f.source.file, cwd: f.source.cwd });
  f.ports.check = async () => check;
  f.ports.seed = async () => barriers;
  f.ports.barriers = async () => true;
  f.ports.prepare = async () => prepared("pre");
  f.ports.freeze = async () => ({ operationId: operation.id, sessionId: request.sessionId, epoch: 1, file: f.source.file, cwd: f.source.cwd, leaf: f.source.leaf,
    size: f.source.size, sha256: f.source.sha256, owner: null, barriers, intercomGeneration: "fixture-generation" });
  f.ports.transfer = async () => prepared("final");
  f.ports.verifySource = async () => {};
  f.ports.start = async home => ({ code: 0, reason: "ready", operationId: operation.id, home, epoch: home.epoch, repairCommand: null, value: readiness(home) });
  f.ports.inspect = async home => ({ home, owner: { kind: "live", identity: { bootId: "fixture-boot", pid: 42, startTime: "fixture-start" } }, readiness: readiness(home), launchFailure: null, retired: false });
  f.ports.retire = async () => ({ kind: "absent" });
  f.ports.cleanup = async () => {};
  f.ports.intercom.ports.inspect = async () => ({ blockers: [], cancelledWork: [], warnings: [] });
  f.ports.intercom.ports.checkGeneration = async () => {};
  f.ports.intercom.ports.ready = async () => ({ intercomAddress: "session-a@box.invalid", warnings: [] });
  f.ports.intercom.destinationEndpoint = async home => ({ address: f.ports.intercom.address, machineId: home.machineId, homeEpoch: home.epoch, activationEpoch: "fixture-activation" });
  return { ...f, request };
}

it.each(["power-release", "state-done", "done", "released"] as const)("proved move stays moved when finalization fails at %s", async failure => {
  const f = await fixture(), record = f.ports.journal.record.bind(f.ports.journal);
  let fault = true;
  if (failure === "power-release") f.ports.power = async () => async () => { if (fault) { fault = false; throw new Error("fixture-power-release"); } };
  else f.ports.journal.record = (id, action, result) => {
    if (fault && (failure === "released" ? action === "released" : id === f.request.operation.id && (failure === "state-done" ? action === "move-state" && result.state === "done" : action === "done"))) {
      fault = false; throw new Error("fixture-journal-unavailable");
    }
    record(id, action, result);
  };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 0, reason: "moved", value: { sourceCleanup: { status: "done" } } });
  f.ports.journal.record = record;
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 0, reason: "moved", value: { sourceCleanup: { status: "done" } } });
  expect(await recoverMove(f.request.operation.id, f.ports)).toMatchObject({ code: 0, reason: "moved", value: { sourceCleanup: { status: "done" } } });
}, 5000);
it("an unknown failure after check but before freeze is pending rather than a preflight refusal", async () => {
  const f = await fixture(); f.ports.seed = async () => { throw new Error("fixture-seed-unavailable"); };
  expect(await moveSession(f.request, f.ports)).toMatchObject({ code: 3, reason: "move-pending" });
});
