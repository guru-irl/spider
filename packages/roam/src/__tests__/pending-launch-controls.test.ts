import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate, openDb } from "@spider/db-core";
import { claimIdLock } from "@spider/herdr/sessions/id-lock";
import { main } from "../cli";
import { disabledIntercom } from "../contracts";
import { handleAgentOperation } from "../agent";
import { openJournal } from "../journal";
import { readLocalIdentity } from "../runtime";
import { runLocalDoctor } from "../local-diagnostics";
import * as transportModule from "../transport";
import * as productionHub from "../production-hub";
import { enrollFixtureCore } from "./supervisor-core-fixture";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [], databases: ReturnType<typeof openDb>[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "pending-controls-")); roots.push(root);
  const release = join(root, "release.js"), bundleUrl = pathToFileURL(release);
  writeFileSync(release, "// SPIDER_BUILD_ID=01234567@2026-01-01T00:00:00.000Z v0.1.0\n", { mode: 0o600 });
  const remote = join(root, "remote"); mkdirSync(join(remote, "roam"), { recursive: true, mode: 0o700 }); mkdirSync(join(root, "roam"), { mode: 0o700 });
  const config = { enabled: false, role: "hub" as const, machineId: HUB, hubMachineId: HUB, peers: [{ machineId: BOX, alias: "box-1.invalid", node: "/home/fixture/node", pi: "/home/fixture/pi", cli: "/home/fixture/spider", core: "/home/fixture/hc", globalRoot: "/home/fixture/global" }], discoveryRoots: [], coreUnit: "fixture.service", intercom: disabledIntercom() };
  const box = { ...config, role: "box" as const, machineId: BOX, peers: [] };
  for (const [directory, value] of [[root, config], [remote, box]] as const) {
    writeFileSync(join(directory, "roam", "config.json"), JSON.stringify(value), { mode: 0o600 });
    writeFileSync(join(directory, "roam", "machine.json"), JSON.stringify({ machineId: value.machineId }), { mode: 0o600 });
  }
  enrollFixtureCore(remote);
  const db = openDb(join(remote, "spider.db")); databases.push(db); migrate(db, "global", { machineId: BOX, globalRoot: remote });
  db.prepare("UPDATE roam_meta SET capture_enabled=1 WHERE id=1").run();
  const owner = { pid: 201, startIdentity: "previous-supervisor" };
  const id = await claimIdLock(join(remote, "herdr"), "session-1", owner, async () => ({ kind: "live", startIdentity: owner.startIdentity }), { bootId: async () => "boot-1" });
  await id.prepareHandoff("launch-1", join(remote, "session.jsonl"), "core-1");
  const journal = openJournal(join(remote, "roam", "journal.db"));
  const ports = { config: readLocalIdentity(remote), root: join(remote, "roam", "staging"), journal, openStore() { return { db }; } };
  vi.stubEnv("HOME", root); vi.stubEnv("SPIDER_GLOBAL_ROOT", root);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: "/home/fixture/hc" } } as never);
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: unknown) { return peer; }, async exec(_peer: unknown, argv: string[]) {
    if (argv[1] === "agent") return Buffer.from(JSON.stringify(await handleAgentOperation(JSON.parse(argv[2]), ports as never)));
    expect(argv).toEqual(["roam", "observe", "doctor"]);
    return Buffer.from(JSON.stringify({ version: 1, machineId: BOX, kind: "doctor", value: await runLocalDoctor({ root: remote, bundleUrl, currentCore: async () => "core-1", launchRecovery: { bootId: async () => "boot-1", probe: async () => ({ kind: "absent" }) } }) }));
  } } as never);
  const out: string[] = [], err: string[] = [];
  const invoke = async (args: string[]) => { out.length = 0; err.length = 0; const code = await main(args, { out: text => out.push(text), err: text => err.push(text) }, { bundleUrl }); return { code, value: JSON.parse(out.join("")), err: err.join("") }; };
  return { root, remote, invoke };
}

it("disabled remote doctor and enable agree on the pending launch and its stop repair", async () => {
  const f = await fixture();
  const doctor = await f.invoke(["roam", "doctor", "box-1.invalid", "--json"]);
  expect(doctor.code).toBe(1);
  expect(doctor.value.value).toMatchObject({ enabled: false, consumers: [] });
  expect(doctor.value.value.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block", reason: expect.stringMatching(/session-1.*launch-1.*pending/i), repairCommand: "spider roam stop session-1" })]));
  const enable = await f.invoke(["roam", "enable", "--json"]);
  expect(enable.code).toBe(1);
  expect(enable.value.value.issues).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("exact-launch"), repairCommand: "spider roam stop session-1" })]));
  expect(JSON.stringify(enable.value)).not.toContain("spider roam provision");
});

it("enable prescribes stop rather than provision for the persisted pending launch", async () => {
  const f = await fixture(), enable = await f.invoke(["roam", "enable", "--json"]);
  expect(enable.code).toBe(1);
  expect(enable.value.value.issues).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("exact-launch"), repairCommand: "spider roam stop session-1" })]));
  expect(JSON.stringify(enable.value)).not.toContain("spider roam provision");
});

it("disabled local box doctor still returns a pending-launch block", async () => {
  const f = await fixture(); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.remote);
  const doctor = await f.invoke(["roam", "doctor", "--json"]);
  expect(doctor.code).toBe(1);
  expect(doctor.value.reason).toBe("doctor-blocked");
  expect(doctor.value.value.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "block", reason: expect.stringMatching(/session-1.*launch-1.*pending/i), repairCommand: "spider roam stop session-1" })]));
});
