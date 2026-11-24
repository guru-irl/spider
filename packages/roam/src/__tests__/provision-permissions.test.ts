import { expect, it } from "vitest";
import { safeControlOutcome } from "../commands";
import { destinationPermissionPath, isPermissionRepairCommand, permissionRepairCommand } from "../provision-permissions";

it("keeps private-mode repairs and hosting readiness in provisioning JSON", () => {
  const repairs = [{ path: "/home/fixture/agent/settings.json", uid: 1000, before: 0o664, after: 0o600 }];
  const result = { code: 0 as const, reason: "installed", operationId: "op-1", home: null, epoch: null, repairCommand: null,
    value: { hostingReady: true, permissionTightenings: 0, privateModeRepairs: repairs } };
  expect(safeControlOutcome(result).value).toEqual(result.value);
  expect(safeControlOutcome({ ...result, value: { ...result.value, privateModeRepairs: [{ ...repairs[0], path: "/home/fixture/agent/spoof\u202e" }] } }).value)
    .toEqual({ hostingReady: true, permissionTightenings: 0 });
});

it("keeps only exact generated private-mode refusal advice in public JSON", () => {
  const reason = "unsafe-destination (/home/fixture/agent/settings.json; mode 0664; uid 1001; owner). Have the owner move '/home/fixture/agent/settings.json' out of the destination tree, then reprovision.";
  const result = { code: 1 as const, reason, operationId: "op-1", home: null, epoch: null, repairCommand: null, value: null };
  expect(safeControlOutcome(result).reason).toBe(reason);
  expect(safeControlOutcome({ ...result, reason: reason + " arbitrary output" }).reason).toBe("control-failed");
  expect(safeControlOutcome({ ...result, reason: reason.replace("settings.json;", "settings\u202e.json;") }).reason).toBe("control-failed");
});

it("keeps exact install writable-path advice in public JSON", () => {
  const reason = "unsafe-destination (/home/fixture/install/prefix/bin; mode 0775; uid 1000; writable-parent). Run chmod go-w '/home/fixture/install/prefix/bin', then reprovision.";
  const result = { code: 1 as const, reason, operationId: "op-1", home: null, epoch: null, repairCommand: null, value: null };
  expect(safeControlOutcome(result).reason).toBe(reason);
  expect(safeControlOutcome({ ...result, reason: reason.replace("chmod go-w", "chmod 0777") }).reason).toBe("control-failed");
  expect(safeControlOutcome({ ...result, reason: reason + " arbitrary output" }).reason).toBe("control-failed");
});

it("accepts recursive repairs only for exact package tree roots", () => {
  const pi = "/home/fixture/prefix/lib/node_modules/@earendil-works/pi-coding-agent";
  const release = `/home/fixture/prefix/spider-releases/${"a".repeat(64)}`;
  for (const root of [pi, release]) {
    expect(permissionRepairCommand(root, true)).toBe(`chmod -R go-w '${root}'`);
    expect(isPermissionRepairCommand(`chmod -R go-w '${root}'`)).toBe(true);
    expect(isPermissionRepairCommand(`chmod -R go-w '${root}/child'`)).toBe(false);
  }
  for (const root of ["/home/fixture/prefix", "/home/fixture/.pi/agent", "/home/fixture/.pi/agent/extensions", "/home/fixture/.local/bin", "/etc", "/home/fixture/prefix/spider-releases/abc"]) {
    expect(isPermissionRepairCommand(`chmod -R go-w '${root}'`)).toBe(false);
  }
  expect(isPermissionRepairCommand("chmod go-w '/home/fixture/.pi/agent'" )).toBe(true);
});

it.each(["\u0001", "\u007f", "\u0080", "\u009b", "\u009f", "\u061c", "\u200e", "\u200f", "\u202a", "\u202e", "\u2066", "\u2069"])("rejects display controls in a reported path %j", control => {
  const path = `/home/fixture/agent/${control}name`;
  expect(destinationPermissionPath(path, "/home/fixture", ["/home/fixture/agent"])).toBe(false);
  expect(isPermissionRepairCommand(`chmod go-w '${path}'`)).toBe(false);
});
