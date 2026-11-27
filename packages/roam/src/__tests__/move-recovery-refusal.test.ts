import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { DEFAULT_LIMITS, disabledIntercom, type MovePorts, type Operation } from "../contracts";
import { openFreezeJournal } from "../journal";
import { recoverMove } from "../move";
import { sessionHome } from "../homes";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

it.each(["readiness", "refusal"] as const)("conflicting final start %s appends a refusal without changing prior evidence or the home", async conflict => {
  const global = createReplica("global", HUB); fixtures.push(global);
  mkdirSync(join(global.root, "roam"), { mode: 0o700 });
  const journal = openFreezeJournal(join(global.root, "roam", "journal.db"));
  const home = { sessionId: "session-a", machineId: BOX, epoch: 2, moveId: "move-a", updatedAt: 1 };
  global.db.prepare("INSERT INTO session_homes (session_id, machine_id, epoch, move_id, updated_at) VALUES (?,?,2,'move-a',1)").run(home.sessionId, BOX);
  const operation: Operation = { id: "move-a", kind: "move", machineId: HUB, expectedEpoch: 1,
    args: { sessionId: home.sessionId, destinationMachine: BOX } };
  journal.begin(operation);
  journal.record(operation.id, "move-request", { sessionId: home.sessionId, destinationMachine: BOX, operation: { ...operation } });
  const ready = { origin: "hub-operation", opId: operation.id, sessionId: home.sessionId, epoch: 2,
    file: join(global.root, "session.jsonl"), cwd: global.root, core: "core-a", terminal: "terminal-a" };
  const start = { code: 0, reason: "ready", operationId: operation.id, home, epoch: 2, repairCommand: null, value: ready };
  journal.record(operation.id, "move-action-complete", { action: "start", value: start });
  journal.record(operation.id, "move-action-complete", { action: "start", value: conflict === "refusal"
    ? { ...start, code: 1, reason: "participant-start-refused", value: null }
    : { ...start, value: { ...ready, terminal: "different-terminal" } } });
  const saved = journal.read(operation.id), inspect = vi.fn(), launch = vi.fn();
  const ports = { config: { enabled: true, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [], discoveryRoots: [],
    coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS, intercom: disabledIntercom() }, globalDb: global.db, journal,
    inspect, start: launch } as unknown as MovePorts;
  expect(await recoverMove(operation.id, ports)).toMatchObject({ code: 3, reason: "move-journal-invalid" });
  expect(journal.read(operation.id)).toEqual([...saved, {
    action: "move-recovery-refused", result: { reason: "move-journal-invalid", blockers: [] },
  }]);
  expect(sessionHome(global.db, home.sessionId)).toEqual(home);
  expect(inspect).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});
