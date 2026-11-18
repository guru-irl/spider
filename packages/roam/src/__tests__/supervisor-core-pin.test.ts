import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as enrollment from "../enrollment";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = resolve(".spider/scratch/core-pin"); mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(base, "f-")); roots.push(root); mkdirSync(join(root, "roam"), { mode: 0o700 });
  const pin = { binary: "/home/fixture/bin/hc", coreId: "fixture-core", socket: "/run/user/1000/herdr-core/default.sock",
    sessionNamespace: "default", stateHome: "/home/fixture/.local/state", configHome: "/home/fixture/.config" };
  return { root, pin, file: join(root, "roam/core.json") };
}

it("publishes a private startup pin once and retains an identical pin", () => {
  const { root, pin, file } = fixture();
  enrollment.installSupervisorCorePin(root, pin);
  const before = readFileSync(file, "utf8");
  enrollment.installSupervisorCorePin(root, pin);
  expect(enrollment.readSupervisorCorePin(root)).toEqual(pin);
  expect(readFileSync(file, "utf8")).toBe(before);
});

it("refuses an identity change without replacing the enrollment pin", () => {
  const { root, pin, file } = fixture();
  enrollment.installSupervisorCorePin(root, pin);
  const before = readFileSync(file, "utf8");
  expect(() => enrollment.installSupervisorCorePin(root, { ...pin, coreId: "foreign-core" })).toThrowError(expect.objectContaining({ code: "core-changed" }));
  expect(readFileSync(file, "utf8")).toBe(before);
});

it.each(["binary", "socket", "stateHome", "configHome"] as const)("refuses an unpinned change to %s", key => {
  const { root, pin } = fixture(); enrollment.installSupervisorCorePin(root, pin);
  expect(() => enrollment.installSupervisorCorePin(root, { ...pin, [key]: "/different/path" })).toThrowError(expect.objectContaining({ code: "core-pin-conflict" }));
});

it("refuses a missing pin rather than trusting the current core", () => {
  expect(() => enrollment.readSupervisorCorePin(fixture().root)).toThrowError(expect.objectContaining({ code: "core-pin-required" }));
});

it.each(["binary", "socket", "stateHome", "configHome"] as const)("refuses relative pin field %s", key => {
  const { root, pin } = fixture();
  expect(() => enrollment.installSupervisorCorePin(root, { ...pin, [key]: "relative" })).toThrowError(expect.objectContaining({ code: "core-pin-invalid" }));
});

it.each(["symlink", "mode", "parent"])("rejects an unsafe %s before trusting a pin", kind => {
  const { root, pin, file } = fixture();
  if (kind === "symlink") {
    const other = join(root, "other.json"); writeFileSync(other, JSON.stringify(pin), { mode: 0o600 }); symlinkSync(other, file);
  } else {
    writeFileSync(file, JSON.stringify(pin), { mode: kind === "mode" ? 0o644 : 0o600 });
    if (kind === "parent") chmodSync(join(root, "roam"), 0o755);
  }
  expect(() => enrollment.readSupervisorCorePin(root)).toThrowError(expect.objectContaining({ code: "core-pin-invalid" }));
});
