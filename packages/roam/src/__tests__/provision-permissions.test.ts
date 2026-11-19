import { expect, it } from "vitest";
import { destinationPermissionPath, isPermissionRepairCommand, permissionRepairCommand } from "../provision-permissions";

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
