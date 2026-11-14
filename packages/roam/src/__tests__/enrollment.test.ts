import { afterEach, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplica } from "@spider/db-core/testutil";
import { loadMachineIdentity } from "@spider/db-core/roam/machine";
import { installBoxEnrollment } from "../enrollment";
import { parseConfig } from "../config";
const HUB = "00000000-0000-4000-8000-000000000001", OTHER = "00000000-0000-4000-8000-000000000003";
const fixtures: ReturnType<typeof createReplica>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
function fixture() { const f = createReplica("global", HUB); fixtures.push(f); return { ...f, box: loadMachineIdentity(f.root), file: join(f.root, "roam", "config.json") }; }
it("publishes a disabled enrollment once and a lost reply repeats without replacement", () => {
  const f = fixture();
  expect(installBoxEnrollment(f.root, f.box, HUB, "fixture.service")).toBe("enrolled");
  const before = lstatSync(f.file).ino;
  expect(installBoxEnrollment(f.root, f.box, HUB, "fixture.service")).toBe("already-enrolled");
  expect(lstatSync(f.file).ino).toBe(before);
  expect(JSON.parse(readFileSync(f.file, "utf8"))).toMatchObject({ enabled: false, role: "box", machineId: f.box, hubMachineId: HUB, peers: [] });
  expect(lstatSync(f.file).mode & 0o777).toBe(0o600);
}, 5000);
it("a matching enrollment preserves existing intercom configuration and enabled settings", () => {
  const f = fixture(); installBoxEnrollment(f.root, f.box, HUB, "fixture.service");
  const previous = { ...JSON.parse(readFileSync(f.file, "utf8")), enabled: true, syncMs: 180000 };
  expect(parseConfig(previous)).toMatchObject({ enabled: true, role: "box", peers: [] });
  writeFileSync(f.file, JSON.stringify(previous)); const before = readFileSync(f.file), inode = lstatSync(f.file).ino;
  mkdirSync(join(f.root, "intercom"), { mode: 0o700 });
  const intercom = join(f.root, "intercom", "config.json"), saved = Buffer.from('{"stableId":"box-agent"}');
  writeFileSync(intercom, saved, { mode: 0o600 });
  expect(installBoxEnrollment(f.root, f.box, HUB, "fixture.service")).toBe("already-enrolled");
  expect(readFileSync(f.file)).toEqual(before); expect(lstatSync(f.file).ino).toBe(inode);
  expect(readFileSync(intercom)).toEqual(saved);
}, 5000);

it.each([
  ["outbound replication peers", { peers: [{ machineId: OTHER, alias: "box-2.invalid", node: "/home/fixture/node", pi: "/home/fixture/pi", cli: "/home/fixture/cli", core: "/home/fixture/hc", globalRoot: "/home/fixture/global" }] }],
  ["invalid enabled setting", { enabled: "yes" }],
  ["inconsistent limits", { limits: { chunkBytes: 1025, replyBytes: 1024 } }],
])("refuses an existing enrollment with %s without replacing it", (_label, patch) => {
  const f = fixture(); installBoxEnrollment(f.root, f.box, HUB, "fixture.service");
  const previous = { ...JSON.parse(readFileSync(f.file, "utf8")), ...patch };
  writeFileSync(f.file, JSON.stringify(previous)); const before = readFileSync(f.file), inode = lstatSync(f.file).ino;
  expect(() => installBoxEnrollment(f.root, f.box, HUB, "fixture.service")).toThrow("enrollment-conflict");
  expect(readFileSync(f.file)).toEqual(before); expect(lstatSync(f.file).ino).toBe(inode);
}, 5000);

it("refuses malformed enrollment JSON without replacing it", () => {
  const f = fixture(); installBoxEnrollment(f.root, f.box, HUB, "fixture.service");
  const saved = Buffer.from('{"role":'); writeFileSync(f.file, saved);
  expect(() => installBoxEnrollment(f.root, f.box, HUB, "fixture.service")).toThrow("invalid-enrollment");
  expect(readFileSync(f.file)).toEqual(saved);
}, 5000);

it.each(["hub", "machine", "symlink", "mode"])("refuses an unsafe or conflicting %s without replacing it", kind => {
  const f = fixture(); installBoxEnrollment(f.root, f.box, HUB, "fixture.service");
  if (kind === "mode") chmodSync(f.file, 0o644);
  if (kind === "symlink") { const target = join(f.root, "target"); writeFileSync(target, "unchanged"); unlinkSync(f.file); symlinkSync(target, f.file); expect(() => installBoxEnrollment(f.root, f.box, HUB, "fixture.service")).toThrow(); expect(readFileSync(target, "utf8")).toBe("unchanged"); return; }
  const before = readFileSync(f.file);
  expect(() => installBoxEnrollment(f.root, kind === "machine" ? OTHER : f.box, kind === "hub" ? OTHER : HUB, "fixture.service")).toThrow(/enrollment|identity/);
  expect(readFileSync(f.file)).toEqual(before);
}, 5000);
it("a crash between write and publish leaves enrollment absent and a retry converges", () => {
  const f = fixture();
  expect(() => installBoxEnrollment(f.root, f.box, HUB, "fixture.service", { publish(source) {
    expect(lstatSync(source).mode & 0o777).toBe(0o600); throw new Error("crash");
  } })).toThrow("crash");
  expect(existsSync(f.file)).toBe(false);
  expect(installBoxEnrollment(f.root, f.box, HUB, "fixture.service")).toBe("enrolled");
}, 5000);
