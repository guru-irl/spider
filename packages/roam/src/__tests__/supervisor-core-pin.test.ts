import { afterEach, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  expect(() => enrollment.installSupervisorCorePin(root, { ...pin, coreId: "foreign-core" })).toThrowError(expect.objectContaining({ code: "core-pin-changed" }));
  expect(readFileSync(file, "utf8")).toBe(before);
});

it("replaces a pin only after the idle check and retains both identities across retries", () => {
  const { root, pin, file } = fixture(); enrollment.installSupervisorCorePin(root, pin);
  const next = { ...pin, coreId: "replacement-core", binary: "/home/fixture/bin/hc-next" };
  const replace = (enrollment as typeof enrollment & { replaceSupervisorCorePin?: (root: string, pin: typeof next, operationId: string, idle: () => void) => { oldCoreId: string; newCoreId: string; oldPinSha256: string; newPinSha256: string } }).replaceSupervisorCorePin;
  expect(replace).toBeTypeOf("function");
  expect(() => replace!(root, next, "replace-pin", () => { throw Object.assign(new Error("busy"), { code: "core-pin-in-use" }); })).toThrowError(expect.objectContaining({ code: "core-pin-in-use" }));
  expect(enrollment.readSupervisorCorePin(root)).toEqual(pin);
  const receipt = replace!(root, next, "replace-pin", () => { expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(pin); });
  expect(receipt).toMatchObject({ oldCoreId: "fixture-core", newCoreId: "replacement-core", oldPinSha256: expect.stringMatching(/^[a-f0-9]{64}$/), newPinSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(receipt.oldPinSha256).not.toBe(receipt.newPinSha256);
  expect(enrollment.readSupervisorCorePin(root)).toEqual(next);
  expect(replace!(root, next, "replace-pin", () => {})).toEqual(receipt);
  const journal = JSON.parse(readFileSync(join(root, "roam/core-pin-replacement-replace-pin.json"), "utf8"));
  expect(journal).toEqual({ version: 1, previous: pin, replacement: next });
  expect(() => replace!(root, { ...next, coreId: "different-core" }, "replace-pin", () => {})).toThrowError(expect.objectContaining({ code: "operation-arguments-changed" }));
});

it.each(["read", "write"])("repairs a crashed pin publication before the next %s", action => {
  const { root, pin, file } = fixture(); enrollment.installSupervisorCorePin(root, pin);
  const temporary = join(root, "roam/.core-00000000-0000-4000-8000-000000000001"); linkSync(file, temporary);
  if (action === "write") enrollment.installSupervisorCorePin(root, pin);
  expect(enrollment.readSupervisorCorePin(root)).toEqual(pin);
  expect(existsSync(temporary)).toBe(false);
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
