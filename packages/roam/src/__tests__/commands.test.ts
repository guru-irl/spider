import { expect, it } from "vitest";
import { DEFAULT_LIMITS, type RoamConfig } from "../contracts";
import { controlRefusal, controlText, parsePublicControl, resolveControlMachine, resolveControlSession, safeControlOutcome } from "../commands";

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
