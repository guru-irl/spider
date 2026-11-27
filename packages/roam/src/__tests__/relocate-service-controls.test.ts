import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { migrate, openDb } from "@spider/db-core";
import { installHubService, hubServiceFile } from "../launchd";
import { renderSupervisorUnit } from "../systemd";
import { configureV0Service } from "../production-controls";
import { installLocalV0Supervisor } from "../relocate/service-install";
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
  const release = join(root, "extension.js");
  writeFileSync(release, "// SPIDER_BUILD_ID=01234567@2026-01-01T00:00:00.000Z v0.1.0\n", { mode: 0o600 });
  writeFileSync(cli, "", { mode: 0o700 }); writeFileSync(supervisor, "");
  vi.stubEnv("SPIDER_GLOBAL_ROOT", root); vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
  const calls: string[][] = [];
  const launchd = { plistDir: join(root, "LaunchAgents"), serviceHome: root, async launchctl(argv: readonly string[]) { calls.push([...argv]); } };
  const systemd = { unitDir: join(root, "units"), async run(argv: readonly string[]) { calls.push([...argv]); } };
  const options = { resolveCli: () => cli, bundleUrl: pathToFileURL(release), launchd, systemd };
  return { root, options, calls, launchd, systemd, cli, supervisor, coreUnit, hub, box, machineId,
    enabled: () => JSON.parse(readFileSync(configFile, "utf8")).enabled };
}

it.each(["hub", "box"] as const)("enable pins the local Herdr installation in the %s service", async role => {
  const f=fixture(role), binary=join(f.root,"bin","hc"), socket=join(f.root,"socket"), agentDirectory=join(f.root,"agent");
  mkdirSync(join(f.root,"herdr"));mkdirSync(join(f.root,"bin"));
  writeFileSync(binary,"#!/bin/sh\nexit 1\n",{mode:0o700});
  writeFileSync(join(f.root,"herdr","config.json"),JSON.stringify({mode:"core-only",core:{binary,config:join(f.root,"core.toml")},
    globalRoot:f.root,agentDirectory,shellRc:join(f.root,"shell.rc"),machines:[]}));
  vi.stubEnv("SPIDER_ROAM_HC",undefined);vi.stubEnv("PI_CODING_AGENT_DIR",undefined);
  vi.stubEnv("HC_SESSION","work");vi.stubEnv("HC_SOCKET",socket);
  vi.stubEnv("PATH",`/fixture/login/bin:${process.env.PATH}`);
  const result=await configureV0Service(f.root,true,f.options);
  expect(result.code,result.message).toBe(0);
  const file=role==="hub"?hubServiceFile(f.root,f.launchd.plistDir,"v0"):join(f.systemd.unitDir,"spider-roam-supervisor-v0.service");
  const text=readFileSync(file,"utf8");
  expect(text).toContain(binary);expect(text).toContain(socket);expect(text).toContain("/fixture/login/bin");
  if(role==="box") {
    expect(text).toContain('Environment="HC_SESSION=work"');
    expect(text).toContain(`Environment="PI_CODING_AGENT_DIR=${agentDirectory}"`);
  }
});

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

it("enable refuses a non-executable CLI from the configured hub service before changing it", async () => {
  const f = fixture("hub");
  const enabled = await configureV0Service(f.root, true, f.options);
  expect(enabled.code, enabled.message).toBe(0);
  const plist = hubServiceFile(f.root, f.launchd.plistDir, "v0"), before = readFileSync(plist, "utf8");
  chmodSync(f.cli, 0o600);
  f.calls.length = 0;
  const result = await configureV0Service(f.root, true, f.options);
  expect(result).toMatchObject({ code: 1, message: expect.stringContaining("CLI executable is missing or inaccessible.") });
  expect(f.calls).toEqual([]);
  expect(readFileSync(plist, "utf8")).toBe(before);
});

it("enable preserves an existing 0755 systemd user directory", async () => {
  const f = fixture("box"), io = { out: vi.fn(), err: vi.fn() };
  vi.stubEnv("HOME", resolve("."));
  f.systemd.unitDir = join(f.root, ".config", "systemd", "user");
  mkdirSync(f.systemd.unitDir, { recursive: true, mode: 0o755 });
  chmodSync(f.systemd.unitDir, 0o755);

  expect(await main(["roam", "enable"], io, { v0: { lifecycle: f.options } }), io.err.mock.calls.flat().join("")).toBe(0);
  expect(f.enabled()).toBe(true);
  expect(lstatSync(f.systemd.unitDir).mode & 0o7777).toBe(0o755);
  expect(existsSync(join(f.systemd.unitDir, "spider-roam-supervisor-v0.service"))).toBe(true);
});

it.each([0o750, 0o711])("enable preserves other safe systemd user directory modes: %o", async mode => {
  const f = fixture("box"), io = { out: vi.fn(), err: vi.fn() };
  vi.stubEnv("HOME", resolve("."));
  mkdirSync(f.systemd.unitDir, { mode });
  chmodSync(f.systemd.unitDir, mode);

  expect(await main(["roam", "enable"], io, { v0: { lifecycle: f.options } }), io.err.mock.calls.flat().join("")).toBe(0);
  expect(f.enabled()).toBe(true);
  expect(lstatSync(f.systemd.unitDir).mode & 0o7777).toBe(mode);
});

it.each([0o775, 0o757])("enable tightens an existing unsafe systemd user directory with mode %o", async mode => {
  const f = fixture("box"), io = { out: vi.fn(), err: vi.fn() };
  vi.stubEnv("HOME", resolve("."));
  mkdirSync(f.systemd.unitDir, { mode });
  chmodSync(f.systemd.unitDir, mode);

  expect(await main(["roam", "enable"], io, { v0: { lifecycle: f.options } }), io.err.mock.calls.flat().join("")).toBe(0);
  expect(f.enabled()).toBe(true);
  expect(lstatSync(f.systemd.unitDir).mode & 0o7777).toBe(0o700);
  expect(existsSync(join(f.systemd.unitDir, "spider-roam-supervisor-v0.service"))).toBe(true);
});

it("enable creates a missing systemd user directory with mode 0700", async () => {
  const f = fixture("box"), io = { out: vi.fn(), err: vi.fn() };
  vi.stubEnv("HOME", resolve("."));
  expect(existsSync(f.systemd.unitDir)).toBe(false);

  expect(await main(["roam", "enable"], io, { v0: { lifecycle: f.options } }), io.err.mock.calls.flat().join("")).toBe(0);
  expect(lstatSync(f.systemd.unitDir).mode & 0o7777).toBe(0o700);
  expect(existsSync(join(f.systemd.unitDir, "spider-roam-supervisor-v0.service"))).toBe(true);
});

it("enable refuses a symlinked systemd user directory without changing its target", async () => {
  const f = fixture("box"), io = { out: vi.fn(), err: vi.fn() }, target = join(f.root, "target");
  vi.stubEnv("HOME", resolve("."));
  mkdirSync(target, { mode: 0o755 }); chmodSync(target, 0o755);
  symlinkSync(target, f.systemd.unitDir);

  expect(await main(["roam", "enable"], io, { v0: { lifecycle: f.options } })).not.toBe(0);
  expect(io.err.mock.calls.flat().join("")).toMatch(/symlink|canonical/i);
  expect(f.enabled()).toBe(false);
  expect(lstatSync(target).mode & 0o7777).toBe(0o755);
  expect(existsSync(join(target, "spider-roam-supervisor-v0.service"))).toBe(false);
});

it("refuses a systemd user directory owned by another user", async () => {
  const f = fixture("box"), uid = process.getuid?.();
  if (uid === undefined) return;
  mkdirSync(f.systemd.unitDir, { mode: 0o755 });
  const getuid = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
  try {
    await expect(installLocalV0Supervisor(f.systemd, "root", "unit")).rejects.toThrow(/owner/i);
    expect(existsSync(join(f.systemd.unitDir, "spider-roam-supervisor-v0.service"))).toBe(false);
  } finally { getuid.mockRestore(); }
});

it("a Linux box enables and disables only its configured local v0 supervisor", async () => {
  const f = fixture("box");
  // The test runner's real home in CI is outside the permitted fixture paths.
  vi.stubEnv("HOME", resolve("."));
  // A box has no launchd service even when this fixture runs on a Mac.
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", join(f.root, "unused-launchctl"));
  const legacyName = "spider-roam-supervisor.service", v0Name = "spider-roam-supervisor-v0.service";
  const legacy = join(f.systemd.unitDir, legacyName), v0 = join(f.systemd.unitDir, v0Name);
  mkdirSync(f.systemd.unitDir, { mode: 0o700 });
  writeFileSync(legacy, renderSupervisorUnit({ node: process.execPath, supervisor: f.supervisor, globalRoot: f.root, coreUnit: f.coreUnit }), { mode: 0o600 });
  const io = { out: vi.fn(), err: vi.fn() }, cliOptions = { v0: { lifecycle: f.options } };
  expect(await main(["roam", "enable"], io, cliOptions), io.err.mock.calls.flat().join("")).toBe(0);
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

it.each([
  ["hub", "source"], ["hub", "destination"], ["box", "source"], ["box", "destination"],
] as const)("disable leaves the %s running while it is the moving home's %s", async (role, side) => {
  const f = fixture(role), io = { out: vi.fn(), err: vi.fn() }, options = { v0: { lifecycle: f.options } };
  expect(await main(["roam", "enable"], io, options)).toBe(0);
  const other = role === "hub" ? f.box : f.hub;
  const [source, destination] = side === "source" ? [f.machineId, other] : [other, f.machineId];
  const db = openDb(join(f.root, "spider.db"));
  try {
    db.prepare("INSERT INTO session_homes(session_id,machine_id,epoch,move_id,updated_at,state,destination) VALUES (?,?,2,?,1,'moving',?)")
      .run("session-a", source, "v0-33333333-3333-4333-8333-333333333333", destination);
  } finally { db.close(); }
  f.calls.length = 0;
  expect(await main(["roam", "disable"], io, options)).toBe(1);
  const refusal = io.err.mock.calls.flat().join("");
  expect(refusal).toContain(`spider roam relocate session-a ${destination}`);
  expect(refusal).toContain(`spider roam relocate session-a ${source}`);
  expect(refusal).toContain(`spider roam set-home session-a ${source} --force`);
  expect(await main(["roam", "disable", "--json"], io, options)).toBe(1);
  expect(JSON.parse(io.out.mock.calls.at(-1)![0])).toMatchObject({ code: 1, reason: "v0-move-in-progress",
    operationId: "v0-33333333-3333-4333-8333-333333333333", nextStep: expect.stringContaining(`spider roam relocate session-a ${destination}`) });
  expect(f.enabled()).toBe(true);
  expect(f.calls).toEqual([]);
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
