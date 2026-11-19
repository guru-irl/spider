import { expect, it } from "vitest";
import { validateBlockerId } from "../move";
import { DEFAULT_LIMITS, type RoamConfig } from "../contracts";
import { controlRefusal, controlText, parsePublicControl, resolveControlMachine, resolveControlSession, safeControlOutcome, sourceCleanupStatusText } from "../commands";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const controls = [
  ["status", ["roam", "status"]], ["sync", ["roam", "sync"]], ["enable", ["roam", "enable"]], ["disable", ["roam", "disable"]],
  ["provision", ["roam", "provision", "box-1.invalid"]], ["doctor", ["roam", "doctor"]], ["recover", ["roam", "recover", "move-a"]],
  ["cancel", ["roam", "cancel", "move-a"]], ["forget", ["roam", "forget", "box-1.invalid", "--confirm", `destroyed ${BOX}`]],
  ["stop", ["roam", "stop", "session-a"]], ["resume", ["roam", "resume", "session-a"]],
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
  const allowed = ["status", "doctor", "enable", "disable", "provision", "forget", "stop"].includes(name);
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
  ["roam", "provision", "box-1.invalid", "--consent"], ["roam", "enable", "extra"], ["roam", "recover", "--bad"],
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

it("retains typed authority and drops arbitrary participant data", () => {
  const home = { sessionId: "session-a", machineId: BOX, epoch: 2, moveId: "move-a", updatedAt: 1 };
  const safe = safeControlOutcome({ code: 3, reason: "destination-unknown", operationId: "move-a", home, epoch: 2,
    repairCommand: "spider roam recover move-a", value: { conversation: "PRIVATE-CONTENT", uncommitted: "PRIVATE-EDIT", warnings: ["tool-auth-unverified", "PRIVATE CONTENT"] } });
  expect(safe).toEqual({ code: 3, reason: "destination-unknown", operationId: "move-a", home, epoch: 2,
    repairCommand: "spider roam recover move-a", value: { warnings: ["tool-auth-unverified"] } });
  expect(controlText(safe)).toContain("The source is paused to avoid running two copies.");
});
it("retains only shell-safe destination permission repair commands", () => {
  const base = { code: 3 as const, reason: "destination-permissions-unsafe", operationId: "provision-a", home: null, epoch: null, value: null };
  const repair = "chmod go-w '/home/fixture/.pi/agent/user'\\''s themes'";
  expect(safeControlOutcome({ ...base, repairCommand: repair }).repairCommand).toBe(repair);
  for (const bad of ["chmod go-w /home/fixture/.pi/agent; touch /home/fixture/unwanted", "chmod go-w '/home/fixture/../other'", "chmod go-w '/home/fixture/agent' && id"]) {
    expect(safeControlOutcome({ ...base, repairCommand: bad }).repairCommand).toBeNull();
  }
  expect(safeControlOutcome({ ...base, reason: "other-error", repairCommand: repair }).repairCommand).toBeNull();
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
