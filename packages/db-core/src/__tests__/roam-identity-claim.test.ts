import { afterEach, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as machine from "../roam/machine";

const roots: string[] = [];
const wanted = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
type Claim = (root: string, id: string, options?: machine.MachineIdentityOptions) => string;
const claim = (machine as typeof machine & { claimMachineIdentity?: Claim }).claimMachineIdentity;

function fixture(): string {
  const scratch = join(process.cwd(), ".spider", "scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "identity-claim-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("claims the requested private identity and accepts an identical retry", () => {
  expect(claim).toBeTypeOf("function");
  const root = fixture();
  expect(claim!(root, wanted)).toBe(wanted);
  const file = join(root, "roam", "machine.json"), original = readFileSync(file, "utf8");
  expect(claim!(root, wanted)).toBe(wanted);
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(machine.loadMachineIdentity(root)).toBe(wanted);
  expect(lstatSync(join(root, "roam")).mode & 0o777).toBe(0o700);
  expect(lstatSync(file).mode & 0o777).toBe(0o600);
}, 5000);

it("refuses a different existing identity without replacing its bytes", () => {
  expect(claim).toBeTypeOf("function");
  const root = fixture(), directory = join(root, "roam"), file = join(directory, "machine.json");
  mkdirSync(directory, { mode: 0o700 });
  const original = JSON.stringify({ machineId: other, marker: "keep" }) + "\n";
  writeFileSync(file, original, { mode: 0o600 });
  expect(() => claim!(root, wanted)).toThrow(expect.objectContaining({ code: "machine-mismatch" }));
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(machine.readMachineIdentity(root)).toBe(other);
}, 5000);

it("refuses a symlink identity and preserves the target", () => {
  expect(claim).toBeTypeOf("function");
  const root = fixture(), directory = join(root, "roam"), target = join(root, "target");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(target, JSON.stringify({ machineId: other }), { mode: 0o600 });
  symlinkSync(target, join(directory, "machine.json"));
  expect(() => claim!(root, wanted)).toThrow();
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ machineId: other });
}, 5000);

it("refuses a foreign-owned root without changing its mode", () => {
  expect(claim).toBeTypeOf("function");
  const root = fixture(), owner = lstatSync(root).uid;
  chmodSync(root, 0o755);
  expect(() => claim!(root, wanted, { platform: "linux", uid: owner + 1 })).toThrow(/foreign-owned/i);
  expect(lstatSync(root).mode & 0o777).toBe(0o755);
  expect(() => lstatSync(join(root, "roam"))).toThrow();
}, 5000);

it("rejects malformed requested identities before creating a roaming directory", () => {
  expect(claim).toBeTypeOf("function");
  const root = fixture();
  expect(() => claim!(root, "not-a-uuid")).toThrow();
  expect(() => lstatSync(join(root, "roam"))).toThrow();
}, 5000);
