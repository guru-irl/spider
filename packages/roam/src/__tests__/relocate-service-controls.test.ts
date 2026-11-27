import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { migrate, openDb } from "@spider/db-core";
import { installHubService, hubServiceFile } from "../launchd";
import { renderSupervisorUnit } from "../systemd";
import { configureV0Service } from "../production-controls";
import { main } from "../cli";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(role: "hub" | "box") {
  const root = mkdtempSync(join(resolve(".spider/scratch"), "vsc-")); roots.push(root);
  mkdirSync(join(root, "roam"), { mode: 0o700 });
  const hub = "11111111-1111-4111-8111-111111111111", box = "22222222-2222-4222-8222-222222222222";
  const machineId = role === "hub" ? hub : box;
  const configFile = join(root, "roam", "config.json"), coreUnit = "herdr-core.service";
  writeFileSync(configFile, JSON.stringify({ enabled: false, role, machineId, hubMachineId: hub, coreUnit }), { mode: 0o600 });
  writeFileSync(join(root, "roam", "machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  const db = openDb(join(root, "spider.db"));
  try { migrate(db, "global", { machineId, globalRoot: root }); } finally { db.close(); }
  const cli = join(root, "cli.mjs"), supervisor = join(root, "supervisor.mjs");
  writeFileSync(cli, ""); writeFileSync(supervisor, "");
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root); vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
  const calls: string[][] = [];
  const launchd = { plistDir: join(root, "LaunchAgents"), serviceHome: root, async launchctl(argv: readonly string[]) { calls.push([...argv]); } };
  const systemd = { unitDir: join(root, "units"), async run(argv: readonly string[]) { calls.push([...argv]); } };
  const options = { resolveCli: () => cli, launchd, systemd };
  return { root, options, calls, launchd, systemd, cli, supervisor, coreUnit,
    enabled: () => JSON.parse(readFileSync(configFile, "utf8")).enabled };
}

it("enable removes the scoped legacy hub before starting v0 and disable removes v0", async () => {
  const f = fixture("hub");
  const legacy = hubServiceFile(f.root, f.launchd.plistDir);
  const v0 = hubServiceFile(f.root, f.launchd.plistDir, "v0");
  await installHubService({ node: process.execPath, cli: f.cli, globalRoot: f.root, pi: process.execPath }, f.launchd);
  f.calls.length = 0;
  const enabled = await configureV0Service(f.root, true, f.options);
  expect(enabled).toMatchObject({ code: 0, reason: "roaming-enabled", message: expect.stringMatching(/removed.*legacy.*hub/i) });
  expect(f.enabled()).toBe(true);
  expect(existsSync(legacy)).toBe(false);
  expect(readFileSync(v0, "utf8")).toContain("<string>hub-v0</string>");
  expect(f.calls[0]).toEqual(["bootout", expect.any(String), legacy]);
  expect(f.calls.at(-1)).toEqual(["bootstrap", expect.any(String), v0]);
  expect(await configureV0Service(f.root, false, f.options)).toMatchObject({ code: 0, reason: "roaming-disabled" });
  expect(f.enabled()).toBe(false);
  expect(f.calls.at(-1)).toEqual(["bootout", expect.any(String), v0]);
  expect(existsSync(v0)).toBe(false);
  expect(await configureV0Service(f.root, false, f.options)).toMatchObject({ code: 0 });
});

it("a box enables and disables only its local v0 supervisor", async () => {
  const f = fixture("box");
  const legacyName = "spider-roam-supervisor.service", v0Name = "spider-roam-supervisor-v0.service";
  const legacy = join(f.systemd.unitDir, legacyName), v0 = join(f.systemd.unitDir, v0Name);
  mkdirSync(f.systemd.unitDir, { mode: 0o700 });
  writeFileSync(legacy, renderSupervisorUnit({ node: process.execPath, supervisor: f.supervisor, globalRoot: f.root, coreUnit: f.coreUnit }), { mode: 0o600 });
  const io = { out: vi.fn(), err: vi.fn() }, cliOptions = { v0: { lifecycle: f.options } };
  expect(await main(["roam", "enable"], io, cliOptions)).toBe(0);
  expect(io.out.mock.calls.flat().join("")).toContain(legacyName);
  expect(f.enabled()).toBe(true);
  expect(existsSync(legacy)).toBe(false);
  expect(readFileSync(v0, "utf8")).toMatch(/ExecStart=.* --v0/);
  expect(f.calls).toEqual([["--user", "disable", "--now", legacyName], ["--user", "daemon-reload"], ["--user", "enable", "--now", v0Name]]);
  expect(await main(["roam", "disable"], io, cliOptions)).toBe(0);
  expect(f.enabled()).toBe(false);
  expect(existsSync(v0)).toBe(false);
  expect(f.calls.slice(-2)).toEqual([["--user", "disable", "--now", v0Name], ["--user", "daemon-reload"]]);
});

it("retired legacy CLI move aliases name relocate before trying to contact a hub", async () => {
  const f = fixture("hub");
  const io = { out: vi.fn(), err: vi.fn() };
  for (const args of [["move", "session-a", "mac"], ["roam", "move", "session-a", "mac"]]) {
    io.err.mockClear();
    expect(await main(args, io)).toBe(1);
    expect(io.err.mock.calls.flat().join("")).toContain("spider roam relocate");
  }
  expect(f.calls).toEqual([]);
});
