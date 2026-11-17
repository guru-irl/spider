import { expect, it } from "vitest";
import { createReplica } from "@spider/db-core/testutil";
import { join } from "node:path";
import { openFreezeJournal } from "@spider/roam/journal";
import { recordMoveNoStart } from "../launch-observation";
import { launchJournalDigest } from "@spider/roam/pending-handoff";
import type { LaunchEvidence } from "@spider/herdr/sessions/launcher";
const MACHINE = "00000000-0000-4000-8000-000000000001";
it.each(["timeout", "missing-readiness", "suspended", "wrong-launch", "wrong-core", "started"])("%s never produces a no-start receipt", async bad => {
  const fixture = createReplica("global", MACHINE);
  try {
    const journal = openFreezeJournal(join(fixture.root, "journal.db"));
    journal.begin({ id: "move-a", machineId: MACHINE, expectedEpoch: 1, kind: "move", args: {} });
    const evidence: LaunchEvidence = { receipt: "unknown", terminal: "absent", proof: { kind: "no-terminal-after-hc-exit", operationId: "launch-a", coreIdBefore: "core-a", hcExitedAt: 1,
      first: { coreId: "core-a", issuedAt: 2, terminal: "absent" }, second: { coreId: "core-a", issuedAt: 252, terminal: "absent" }, confirmationBoundMs: 250 } };
    if (bad === "missing-readiness") delete evidence.proof;
    if (bad === "wrong-launch") evidence.proof!.operationId = "other-launch";
    if (bad === "wrong-core" && evidence.proof!.kind === "no-terminal-after-hc-exit") evidence.proof!.second.coreId = "other-core";
    if (bad === "started") evidence.receipt = "started";
    const result = await recordMoveNoStart({ journal, operationId: "move-a", launchId: "launch-a", sessionId: "session-a", epoch: 2, coreId: "core-a", bootId: "boot-a",
      intent: { sessionId: "session-a", epoch: 2, file: "/fixture/a.jsonl", cwd: "/fixture", desired: "running", suspended: bad === "suspended" ? "failed" : null, moveId: "move-a" },
      readiness: async () => null, ownership: async () => null, evidence: async () => { if (bad === "timeout") throw new Error("timeout"); return evidence; } });
    expect(result).toBeNull(); expect(journal.read("move-a")).toEqual([]);
  } finally { fixture.close(); }
});
it("only the exact existing provedNoStart predicate permits a durable receipt", async () => {
  const fixture = createReplica("global", MACHINE);
  try {
    const file = join(fixture.root, "journal.db"), journal = openFreezeJournal(file);
    journal.begin({ id: "move-a", machineId: MACHINE, expectedEpoch: 1, kind: "move", args: {} });
    const evidence: LaunchEvidence = { receipt: "unknown", terminal: "unknown", proof: { kind: "prelaunch-error", operationId: "launch-a", beforeLaunch: true, errorCode: "missing-hc", hcPid: null } };
    const result = await recordMoveNoStart({ journal, operationId: "move-a", launchId: "launch-a", sessionId: "session-a", epoch: 2, coreId: "core-a", bootId: "boot-a",
      intent: { sessionId: "session-a", epoch: 2, file: "/fixture/a.jsonl", cwd: "/fixture", desired: "running", suspended: null, moveId: "move-a" }, readiness: async () => null, ownership: async () => null, evidence: async () => evidence });
    expect(result).toMatchObject({ kind: "never-started", launchId: "launch-a" });
    expect(openFreezeJournal(file).read("move-a")).toEqual([{ action: "move-no-start", result: { kind: "never-started", moveId: "move-a", launchDigest: launchJournalDigest(journal, "launch-a"), launchId: "launch-a", sessionId: "session-a", epoch: 2, coreId: "core-a", bootId: "boot-a", evidence } }]);
  } finally { fixture.close(); }
});

it.each(["launch", "core", "boot", "epoch", "session"] as const)("a conflicting second %s no-start receipt is refused rather than reusing the first", async changed => {
  const fixture = createReplica("global", MACHINE);
  try {
    const journal = openFreezeJournal(join(fixture.root, "journal.db"));
    journal.begin({ id: "move-a", machineId: MACHINE, expectedEpoch: 1, kind: "move", args: {} });
    const input = { journal, operationId: "move-a", launchId: "launch-a", sessionId: "session-a", epoch: 2, coreId: "core-a", bootId: "boot-a",
      intent: { sessionId: "session-a", epoch: 2, file: "/fixture/a.jsonl", cwd: "/fixture", desired: "running" as const, suspended: null, moveId: "move-a" }, readiness: async () => null, ownership: async () => null,
      evidence: async (): Promise<LaunchEvidence> => ({ receipt: "unknown", terminal: "unknown", proof: { kind: "prelaunch-error", operationId: input.launchId, beforeLaunch: true, errorCode: "missing-hc", hcPid: null } }) };
    expect(await recordMoveNoStart(input)).toMatchObject({ kind: "never-started", launchId: "launch-a" }); const rows = journal.read("move-a");
    if (changed === "launch") input.launchId = "launch-b";
    if (changed === "core") input.coreId = "core-b";
    if (changed === "boot") input.bootId = "boot-b";
    if (changed === "epoch") { input.epoch = 3; input.intent.epoch = 3; }
    if (changed === "session") { input.sessionId = "session-b"; input.intent.sessionId = "session-b"; }
    expect(await recordMoveNoStart(input)).toBeNull();
    expect(journal.read("move-a")).toEqual(rows);
  } finally { fixture.close(); }
}, 5000);


it.each(["unadopted-exit", "running", "adopted-readiness", "adopted-ownership", "durable-readiness", "other-launch", "other-terminal", "missing-terminal-record"] as const)("an exact started launch with %s uses only its own no-live-owner proof", async state => {
  const fixture = createReplica("global", MACHINE);
  try {
    const journal = openFreezeJournal(join(fixture.root, "journal.db"));
    journal.begin({ id: "move-a", machineId: MACHINE, expectedEpoch: 1, kind: "move", args: {} });
    journal.begin({ id: "launch-a", machineId: MACHINE, expectedEpoch: 2, kind: "exact-session-launch", args: { sessionId: "session-a" } });
    if (state !== "missing-terminal-record") journal.record("launch-a", "exact-terminal", { terminalId: "t1" });
    if (state === "durable-readiness") journal.record("launch-a", "ready-durable", { opId: "launch-a", sessionId: "session-a" });
    const evidence: LaunchEvidence = { receipt: "started", terminal: "present", ...(state === "running" ? {} : { proof: {
      kind: "terminal-exited-without-adoption", operationId: state === "other-launch" ? "launch-b" : "launch-a", coreId: "core-a",
      terminalId: state === "other-terminal" ? "t2" : "t1", terminalExited: true, lockNeverAdopted: true,
    } as const }) };
    const input = { journal, operationId: "move-a", launchId: "launch-a", sessionId: "session-a", epoch: 2, coreId: "core-a", bootId: "boot-a",
      intent: { sessionId: "session-a", epoch: 2, file: "/fixture/a.jsonl", cwd: "/fixture", desired: "running" as const, suspended: null, moveId: "move-a" },
      readiness: async () => state === "adopted-readiness" ? { opId: "launch-a" } : null,
      ownership: async () => state === "adopted-ownership" ? { operationId: "launch-a" } : null, evidence: async () => evidence };
    const result = await recordMoveNoStart(input);
    if (state !== "unadopted-exit") {
      expect(result).toBeNull();
      expect(journal.read("move-a")).toEqual([]);
    } else {
      expect(result).toMatchObject({ kind: "exited-without-adoption", launchId: "launch-a", terminalId: "t1", evidence });
      expect(journal.read("move-a")).toEqual([{ action: "move-unadopted-launch-exit", result }]);
      expect(JSON.stringify(journal.read("move-a"))).not.toContain("no-start");
      expect(await recordMoveNoStart(input)).toEqual(result);
      expect(journal.read("move-a")).toHaveLength(1);
    }
  } finally { fixture.close(); }
});
