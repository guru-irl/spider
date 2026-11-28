import { expect, it } from "vitest";
import { moveSession, validateBlockerId } from "../move";
import { createReplica } from "@spider/db-core/testutil";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openFreezeJournal } from "../journal";
import { MoveCompositionError } from "../move-failure";
import type { MovePorts } from "../contracts";
import { DEFAULT_LIMITS, type RoamConfig } from "../contracts";
import { controlRefusal, controlText, parsePublicControl, resolveControlMachine, resolveControlSession, safeControlOutcome, sourceCleanupStatusText } from "../commands";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const controls = [
  ["status", ["roam", "status"]], ["sync", ["roam", "sync"]], ["enable", ["roam", "enable"]], ["disable", ["roam", "disable"]],
  ["provision", ["roam", "provision", "box-1.invalid"]], ["doctor", ["roam", "doctor"]], ["recover", ["roam", "recover", "move-a"]],
  ["cancel", ["roam", "cancel", "move-a"]], ["forget", ["roam", "forget", "box-1.invalid", "--confirm", `destroyed ${BOX}`]],
  ["stop", ["roam", "stop", "session-a"]], ["start", ["roam", "start", "session-a"]],
  ["repo map", ["roam", "repo", "map", "repo-a", "/fixture/repo"]], ["claim", ["roam", "claim", "session-a", "mac"]],
  ["memory tag", ["roam", "memory", "tag", "global", "memory-a", "all"]],
] as const;
const config = (enabled = true, role: "hub" | "box" = "hub"): RoamConfig => ({ enabled, role, machineId: role === "hub" ? HUB : BOX, hubMachineId: HUB,
  peers: [{ machineId: BOX, alias: "box-1.invalid", node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "fixture", globalRoot: "/fixture/global" }],
  discoveryRoots: [], coreUnit: "fixture", syncMs: 1000, limits: DEFAULT_LIMITS,
  intercom: { enabled: false, mode: "hub-only", machineAlias: "hub.invalid", protocolFeature: "federation-v1", routes: [], limits: { queueMessages: 500, queueBytes: 5242880 } } });

it.each(controls)("parses %s with and without JSON", (_name, argv) => {
  expect(parsePublicControl(argv)).not.toBeNull();
  expect(parsePublicControl([...argv, "--json"])).toEqual(parsePublicControl(argv));
});
it.each(controls)("disabled %s follows the amended user-control policy", (name, argv) => {
  const allowed = ["status", "doctor", "enable", "disable", "provision", "forget"].includes(name);
  expect(controlRefusal(parsePublicControl(argv)!, config(false))).toBe(allowed ? null : "roaming-disabled");
});
it.each(controls)("box %s follows the local-only policy", (name, argv) => {
  const allowed = ["status", "doctor", "repo map"].includes(name);
  expect(controlRefusal(parsePublicControl(argv)!, config(true, "box"))).toBe(allowed ? null : "mac-hub-required");
});
it.each([
  ["move", "session-a"], ["move", "session-a", "mac", "extra"], ["roam", "claim", "session-a"],
  ["roam", "forget", "box-1.invalid"], ["roam", "repo", "map", "repo-a", "relative"],
  ["roam", "memory", "tag", "worktree:repo-a:workspace-a", "memory-a", "all"],
  ["roam", "provision", "box-1.invalid", "--consent"], ["roam", "enable", "extra"], ["roam", "recover", "--bad"], ["roam", "resume", "session-a"],
])("rejects invalid arguments %j", (...argv) => expect(parsePublicControl(argv)).toBeNull());

it("parses an explicit core-pin replacement once", () => {
  const args = ["roam", "provision", "box-1.invalid", "--replace-core-pin", "--use-destination-auth", "--yes"];
  expect(parsePublicControl(args)).toEqual({ kind: "provision", machine: "box-1.invalid", options: args.slice(3) });
  expect(parsePublicControl([...args, "--replace-core-pin"])).toBeNull();
});

it("parses a literal dash-prefixed memory-tag alias without permitting extra arguments", () => {
  const args = ["roam", "memory", "tag", "global", "memory-a", "--", "-box-1.invalid"];
  expect(parsePublicControl(args)).toEqual({ kind: "memory-tag", storeKey: "global", uuid: "memory-a", machine: "-box-1.invalid" });
  expect(parsePublicControl([...args, "--json"])).toEqual({ kind: "memory-tag", storeKey: "global", uuid: "memory-a", machine: "-box-1.invalid" });
  expect(parsePublicControl([...args, "extra"])).toBeNull();
  expect(parsePublicControl(["roam", "memory", "tag", "global", "memory-a", "-box-1.invalid"])).toBeNull();
  expect(parsePublicControl(["roam", "memory", "tag", "global", "memory-a", "--", "bad\nname"])).toBeNull();
});

it("rounds finite non-negative receipt durations and refuses invalid durations", () => {
  const receipt = { batchId: "batch-a", stream: "stream-a", through: 7, sha256: "a".repeat(64), applyMs: 1.6 };
  const row = { code: 0, reason: "pushed", operationId: "", home: null, epoch: null, repairCommand: null };
  const sanitize = (applyMs: unknown) => safeControlOutcome({ code: 0, reason: "Synchronization complete", operationId: "",
    home: null, epoch: null, repairCommand: null, value: { outcomes: [{ ...row, value: { ...receipt, applyMs } }] } }).value;
  for (const [input, output] of [[1.6, 2], [1.4, 1], [0, 0], [null, null], [Number.MAX_SAFE_INTEGER + 2, Number.MAX_SAFE_INTEGER + 2]] as const) {
    expect(sanitize(input)).toMatchObject({ outcomes: [{ value: { ...receipt, applyMs: output } }] });
  }
  for (const input of [-1, -0.1, Infinity, -Infinity, NaN, "1"]) {
    expect(sanitize(input)).toMatchObject({ outcomes: [{ value: null }] });
  }
});

it("retains typed authority and drops arbitrary participant data", () => {
  const home = { sessionId: "session-a", machineId: BOX, epoch: 2, moveId: "move-a", updatedAt: 1 };
  const safe = safeControlOutcome({ code: 3, reason: "destination-unknown", operationId: "move-a", home, epoch: 2,
    repairCommand: "spider roam recover move-a", value: { conversation: "PRIVATE-CONTENT", uncommitted: "PRIVATE-EDIT", warnings: ["tool-auth-unverified", "PRIVATE CONTENT"] } });
  expect(safe).toEqual({ code: 3, reason: "destination-unknown", operationId: "move-a", home, epoch: 2,
    repairCommand: "spider roam recover move-a", value: { warnings: ["tool-auth-unverified"] } });
  expect(controlText(safe)).toContain("The source is paused to avoid running two copies.");
});
it.each([
  ["intercom-fence-mismatch", "Pair pair-old does not match the current fence."],
  ["intercom-revocation-unconfirmed", "Pair pair-old has an unconfirmed revocation."],
] as const)("preserves only the named pair detail for %s through repeated sanitization", (check, detail) => {
  const base = { code: 1 as const, reason: `preflight-failed:peer.invalid:${check}`, operationId: "", home: null, epoch: null, repairCommand: null };
  const issue = { reason: base.reason, detail, repairCommand: "spider roam provision peer.invalid" };
  const first = safeControlOutcome({ ...base, value: { issues: [issue] } });
  expect(first.value).toEqual({ issues: [issue] });
  expect(safeControlOutcome(first)).toEqual(first);
  for (const bad of ["Pair /fixture/private does not match the current fence.", `${detail} private exception`,
    detail.replace("pair-old", "x".repeat(129)), detail.replace("pair-old", "pair-old\nprivate"), "private exception"]) {
    expect(safeControlOutcome({ ...base, value: { issues: [{ ...issue, detail: bad }] } }).value).toEqual({ issues: [{ reason: issue.reason, repairCommand: issue.repairCommand }] });
  }
  expect(safeControlOutcome({ ...base, value: { issues: [{ ...issue, reason: "preflight-failed:peer.invalid:other" }] } }).value)
    .toEqual({ issues: [{ reason: "preflight-failed:peer.invalid:other", repairCommand: issue.repairCommand }] });
});

it("never relays a legacy intent repair as a public session action", () => {
  const base = { code: 3 as const, reason: "intent-reconciliation-required", operationId: "op-1", home: null, epoch: null, value: null };
  for (const repairCommand of ["spider roam stop session-a", "spider roam start session-a", "spider roam resume session-a"])
    expect(safeControlOutcome({ ...base, repairCommand }).repairCommand).toBeNull();
  expect(safeControlOutcome({ ...base, repairCommand: "spider roam doctor" }).repairCommand).toBe("spider roam doctor");
});

it("keeps the legacy guide without exposing arbitrary launch detail", () => {
  const result = safeControlOutcome({ code: 0, reason: "roaming-enabled", operationId: "", home: null, epoch: null, repairCommand: null,
    value: { issues: [{ severity: "warning", reason: `exact-launch:${BOX}:session-a`, repairCommand: "spider roam doctor",
      detail: "PRIVATE-CONTENT docs/guide/roaming-upgrade.md#settle-old-work-only-after-approval" }] } });
  expect(JSON.stringify(result)).toContain("roaming-upgrade.md#settle-old-work-only-after-approval");
  expect(JSON.stringify(result)).not.toContain("PRIVATE-CONTENT");
});

it("retains only shell-safe destination permission repair commands", () => {
  const base = { code: 3 as const, reason: "destination-permissions-unsafe", operationId: "provision-a", home: null, epoch: null, value: null };
  const repair = "chmod go-w '/home/fixture/.pi/agent/user'\\''s themes'";
  expect(safeControlOutcome({ ...base, repairCommand: repair }).repairCommand).toBe(repair);
  for (const bad of ["chmod go-w /home/fixture/.pi/agent; touch /home/fixture/unwanted", "chmod go-w '/home/fixture/../other'", "chmod go-w '/home/fixture/agent' && id", "chmod go-w '/'"]) {
    expect(safeControlOutcome({ ...base, repairCommand: bad }).repairCommand).toBeNull();
  }
  expect(safeControlOutcome({ ...base, reason: "other-error", repairCommand: repair }).repairCommand).toBeNull();
});

it("serializes only bounded provisioning counts and strips unrelated private data", () => {
  const base = { code: 0 as const, reason: "installed", operationId: "provision-a", home: null, epoch: null, repairCommand: null };
  for (const count of [0, 1_000_000, null]) {
    const result = safeControlOutcome({ ...base, value: { hostingReady: true, permissionTightenings: count, path: "/fixture/private" } });
    expect(result.value).toEqual({ hostingReady: true, permissionTightenings: count });
    expect(JSON.stringify(result)).not.toContain("/fixture/private");
  }
  for (const count of [-1, 1.5, 1_000_001, "/fixture/private", { path: "/fixture/private" }]) {
    const result = safeControlOutcome({ ...base, value: { hostingReady: true, permissionTightenings: count } });
    expect(result.value).toEqual({ hostingReady: true });
    expect(JSON.stringify(result)).not.toContain("/fixture/private");
  }
  expect(safeControlOutcome({ ...base, reason: "other-result", value: { hostingReady: true, permissionTightenings: 3 } }).value)
    .toEqual({ hostingReady: true });
});

it("only successful moves expose a bounded checkout path", () => {
  const base = { code: 0 as const, reason: "moved", operationId: "move-a", home: null, epoch: null, repairCommand: null };
  expect(safeControlOutcome({ ...base, value: { destinationRoot: "/fixture/checkout" } }).value).toEqual({ destinationRoot: "/fixture/checkout" });
  for (const path of ["relative", "/fixture/private\nexception", "/" + "a".repeat(4096)]) {
    expect(safeControlOutcome({ ...base, value: { destinationRoot: path } }).value).toBeNull();
  }
  expect(safeControlOutcome({ ...base, code: 1, value: { destinationRoot: "/fixture/private" } }).value).toBeNull();
  expect(safeControlOutcome({ ...base, reason: "complete", value: { destinationRoot: "/fixture/private" } }).value).toBeNull();
});

it("ambiguous name refuses with candidates", () => {
  const candidates = [{ id: "session-a", name: "same" }, { id: "session-b", name: "same" }];
  expect(resolveControlSession("same", candidates)).toEqual({ reason: "ambiguous-session", candidates: ["session-a", "session-b"] });
  expect(resolveControlSession("session-a", candidates)).toEqual({ sessionId: "session-a" });
  expect(resolveControlSession("session-b", candidates)).toEqual({ sessionId: "session-b" });
  expect(resolveControlSession("session-", candidates)).toEqual({ reason: "ambiguous-session", candidates: ["session-a", "session-b"] });
});
it("the mac alias resolves to the hub identity", () => {
  expect(resolveControlMachine("mac", config())).toBe(HUB);
});
it("the public parser has fourteen roam controls and move", () => {
  expect(controls).toHaveLength(14);
  expect(parsePublicControl(["move", "session-a", "mac"])).toMatchObject({ kind: "move" });
});


it.each(['done', 'pending'] as const)('serializes the exhaustive source cleanup status %s', status => {
  const sourceCleanup = status === 'done' ? { status } : { status, reason: 'move-source-stop-pending', blockers: ['process-exit-unproven'] };
  const safe = safeControlOutcome({ code: 0, reason: 'moved', operationId: 'move-a', home: null, epoch: 2, repairCommand: null,
    value: { terminal: 't1', intercomAddress: 'box/session-a', warnings: ['tool-auth-unverified'], sourceCleanup } });
  expect(safe.value).toMatchObject({ sourceCleanup });
  expect(JSON.parse(JSON.stringify(safe)).value.sourceCleanup).toEqual(sourceCleanup);
  expect(controlText(safe).includes('Source cleanup pending')).toBe(status === 'pending');
  if (status === 'pending') {
    expect(controlText(safe)).toContain('Source cleanup pending: The source process has not been proved stopped and retired. It finishes on its own; check with `spider roam status`.');
    expect(controlText(safe)).not.toContain('process-exit-unproven');
    const text = controlText(safe, 'box-1.invalid');
    expect(text).toContain('Moved to box-1.invalid; terminal t1; intercom box/session-a.');
    expect(text.indexOf('gh auth status')).toBeGreaterThan(text.indexOf('intercom box/session-a'));
    expect(text.indexOf('Source cleanup pending')).toBeGreaterThan(text.indexOf('gh auth status'));
  }
});
it('fails closed without exposing malformed cleanup evidence', () => {
  const safe = safeControlOutcome({ code: 0, reason: 'moved', operationId: 'move-a', home: null, epoch: 2, repairCommand: null,
    value: { sourceCleanup: { status: 'pending', blockers: ['PRIVATE CONTENT'] } } });
  expect(JSON.stringify(safe)).not.toContain('PRIVATE CONTENT');
  expect(safe.value).toMatchObject({ sourceCleanup: { status: 'pending', reason: 'move-journal-invalid', blockers: ['move-journal-invalid'] } });
  expect(controlText(safe)).toContain('Source cleanup pending');
});

it("pending cleanup describes its reason rather than an arbitrary blocker identity", () => {
  const sourceCleanup = { status: "pending" as const, reason: "move-cleanup-pending" as const, blockers: [validateBlockerId("fixture-blocker")] };
  const safe = safeControlOutcome({ code: 0, reason: "moved", operationId: "move-a", home: null, epoch: 2, repairCommand: null,
    value: { sourceCleanup, intercomAddress: "session-a@box.invalid" } });
  expect(safe.value).toMatchObject({ sourceCleanup });
  expect(controlText(safe)).toContain("The source has stopped; its remaining local cleanup has not finished.");
  expect(controlText(safe)).not.toContain("not been proved stopped");
  const status = sourceCleanupStatusText({ sessionId: "session-a", sourceMachine: BOX, sourceCleanup });
  expect(status).toContain("The source has stopped; its remaining local cleanup has not finished.");
  expect(status).not.toContain("fixture-blocker");
});


it("preserves a typed hosting warning through repeated public outcome sanitization", () => {
  const warning = { code: "supervisor-hosting-error", check: "restart", since: 1, count: 3 };
  const message = "The source is paused to avoid running two copies. Destination readiness needs reconciliation. supervisor-hosting-error (restart); hosting checks will retry automatically.";
  const result = { code: 3 as const, reason: "move-destination-pending", operationId: "move-a", home: null, epoch: 2, repairCommand: null, value: null,
    refusal: { code: "move-destination-pending", blockers: [], message, hostingWarning: { ...warning, contents: "PRIVATE-CONTENT" } } };
  const safe = safeControlOutcome(result);
  expect(safe.refusal).toEqual({ code: "move-destination-pending", blockers: [], message, hostingWarning: warning });
  expect(controlText(safe)).toContain("supervisor-hosting-error (restart)");
  expect(JSON.stringify(safe)).not.toContain("PRIVATE-CONTENT");
  expect(safeControlOutcome(safe)).toEqual(safe);
});

it("preserves safe launch details through repeated move-refusal sanitization", () => {
  const warning = { code: "supervisor-hosting-error", check: "launch", since: 1, count: 1,
    causeCode: "participant-exited-before-readiness", exitCode: 23 };
  const message = "The source is paused to avoid running two copies. Destination readiness needs reconciliation. supervisor-hosting-error (launch: participant-exited-before-readiness, exit code 23); hosting checks will retry automatically.";
  const result = { code: 3 as const, reason: "move-destination-pending", operationId: "move-a", home: null, epoch: 2, repairCommand: null, value: null,
    refusal: { code: "move-destination-pending", blockers: [], message, hostingWarning: { ...warning, contents: "PRIVATE-CONTENT" } } };
  const safe = safeControlOutcome(result);
  expect(safe.refusal).toEqual({ code: "move-destination-pending", blockers: [], message, hostingWarning: warning });
  expect(controlText(safe)).toContain("participant-exited-before-readiness, exit code 23");
  expect(JSON.stringify(safe)).not.toContain("PRIVATE-CONTENT");
  expect(safeControlOutcome(safe)).toEqual(safe);
});

it.each([
  { code: "PRIVATE-CONTENT", check: "restart", since: 1, count: 3 },
  { code: "supervisor-hosting-error", check: "PRIVATE-CONTENT", since: 1, count: 3 },
  { code: "supervisor-hosting-error", check: "restart", since: -1, count: 3 },
  { code: "supervisor-hosting-error", check: "restart", since: 1, count: 2 },
])("does not expose malformed hosting warning evidence: %j", hostingWarning => {
  const safe = safeControlOutcome({ code: 3, reason: "move-destination-pending", operationId: "move-a", home: null, epoch: 2, repairCommand: null, value: null,
    refusal: { code: "move-destination-pending", blockers: [],
      message: `The source is paused to avoid running two copies. Destination readiness needs reconciliation. ${hostingWarning.code} (${hostingWarning.check}); hosting checks will retry automatically.`, hostingWarning } });
  expect(JSON.stringify(safe)).not.toContain("PRIVATE-CONTENT");
  expect(safe.refusal).toBeUndefined();
});


it.each([
  "participant-pi-unavailable", "participant-stores-unavailable", "participant-config-unavailable",
  "participant-context-unavailable", "participant-home-unavailable", "move-adapter-unavailable", "move-workspace-unmapped", "move-checkout-conflict",
])("preserves a real move refusal and safe cause %s through repeated sanitization", async cause => {
  const global = createReplica("global", HUB);
  try {
    mkdirSync(join(global.root, "roam"), { mode: 0o700 });
    const failure = new MoveCompositionError(cause);
    failure.message = "PRIVATE-EXCEPTION-SENTINEL";
    const ports = { globalDb: global.db, config: config(), journal: openFreezeJournal(join(global.root, "roam", "journal.db")),
      intercom: { address: { sessionId: "session-a", scopeId: null }, destinationEndpoint: async () => null,
        ports: Object.fromEntries(["close", "drain", "inspect", "checkGeneration", "abort", "ready"].map(name => [name, async () => {}])) },
      check: async () => { throw failure; } } as unknown as MovePorts;
    const result = await moveSession({ sessionId: "session-a", destinationMachine: BOX,
      operation: { id: "move-cause", kind: "move", machineId: HUB, expectedEpoch: null,
        args: { sessionId: "session-a", destinationMachine: BOX } } }, ports);
    if (result.ok) throw new Error("Expected a move refusal");
    const first = safeControlOutcome(result), serialized = JSON.stringify(first);
    expect(first).toMatchObject({ code: 1, causeCode: cause, reason: "move-preflight-refused", repairCommand: cause === "move-workspace-unmapped" ? "spider roam repo map <repo> <path>" : "spider roam doctor",
      refusal: { code: "move-preflight-refused", blockers: [cause] } });
    expect(first.refusal?.message).toContain(cause === "move-workspace-unmapped" ? "spider roam repo map <repo> <path>" : "spider roam doctor");
    expect(controlText(first)).toContain(cause);
    expect(serialized).not.toContain("PRIVATE-EXCEPTION-SENTINEL");
    expect(JSON.stringify(safeControlOutcome(first))).toBe(serialized);
    expect(safeControlOutcome({ ...result, refusal: { ...result.refusal, message: `${result.refusal.message} PRIVATE-EXCEPTION-SENTINEL` } }).refusal).toBeUndefined();
    expect(safeControlOutcome({ ...result, refusal: { ...result.refusal, blockers: ["private\nblocker"] } }).refusal).toBeUndefined();
  } finally { global.close(); }
});

it("prints verified resume doctor blockers and the next command in text and JSON", () => {
  const diagnostic = { severity: "block", reason: "global: roaming capture is not initialized.", repairCommand: "spider roam doctor" };
  const result = { code: 1 as const, reason: "participant-doctor-refused", operationId: "resume-1", home: null, epoch: null,
    repairCommand: `spider roam doctor ${BOX}`, value: { diagnostics: [diagnostic, { severity: "block", reason: "invalid\ntext", repairCommand: "unsafe" }] } };
  const safe = safeControlOutcome(result);
  expect(safe.value).toEqual({ diagnostics: [diagnostic] });
  expect(controlText(safe)).toContain(diagnostic.reason); expect(controlText(safe)).toContain(`spider roam doctor ${BOX}`);
  expect(JSON.parse(JSON.stringify(safe)).value.diagnostics).toEqual([diagnostic]);
  expect(safeControlOutcome({ ...result, reason: "unrelated-failure" }).value).toBeNull();
});
