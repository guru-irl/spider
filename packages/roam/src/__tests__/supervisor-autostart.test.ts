import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Peer } from "../contracts";
import { parseConfig } from "../config";
import { openJournal } from "../journal";
import { runLocalDoctor } from "../local-diagnostics";
import { setEnrolledPeerEnabled } from "../peer-enabled";
import { getProvisionRemoteScript } from "../provision-remote-script";
import { migrate, openDb } from "@spider/db-core";
import { enableRoaming } from "../production-controls";
import * as productionHub from "../production-hub";
import * as transportModule from "../transport";
import * as diagnostics from "../diagnostics";
import * as remoteObservations from "../remote-observations";
import * as launchd from "../launchd";
import * as controlSocket from "../control-socket";

const HUB = "00000000-0000-4000-8000-000000000001", BOX = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const scratch = join(process.cwd(), ".spider", "scratch"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "autostart-")); roots.push(root);
  const box = join(root, "box"), roam = join(box, "roam"), bin = join(root, "bin"), state = join(root, "autostart"), calls = join(root, "systemctl-calls");
  for (const dir of [box, roam, bin]) mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(roam, "machine.json"), JSON.stringify({ machineId: BOX }), { mode: 0o600 });
  writeFileSync(join(roam, "config.json"), JSON.stringify({ enabled: false, role: "box", machineId: BOX, hubMachineId: HUB,
    peers: [], discoveryRoots: [], coreUnit: "fixture.service" }), { mode: 0o600 });
  writeFileSync(state, "disabled");
  const unit = join(root, ".config", "systemd", "user", "spider-roam-supervisor.service");
  mkdirSync(join(root, ".config", "systemd", "user"), { recursive: true, mode: 0o700 });
  writeFileSync(unit, "fixture unit");
  const core = join(bin, "core"), systemctl = join(bin, "systemctl");
  writeFileSync(core, `#!${process.execPath}\nconsole.log(JSON.stringify({core:{id:'fixture-core'},pid:123}));\n`, { mode: 0o700 });
  writeFileSync(systemctl, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');\nif(args[0]!=='--user'||args[2]!=='spider-roam-supervisor.service') process.exit(1);\nconst exists=fs.existsSync(${JSON.stringify(unit)}), value=fs.readFileSync(${JSON.stringify(state)},'utf8');\nif(args[1]==='is-enabled'){ const observed=exists?(value==='blocked'?'disabled':value):'not-found'; console.log(observed); process.exit(['disabled','not-found','masked'].includes(observed)?1:0); }\nif(!['enable','disable'].includes(args[1])||!exists||['blocked','masked'].includes(value)) process.exit(1);\nfs.writeFileSync(${JSON.stringify(state)},args[1]==='enable'?'enabled':'disabled');\n`, { mode: 0o700 });
  const peer: Peer = { machineId: BOX, alias: "box-1.invalid", node: process.execPath, pi: join(bin, "pi"), cli: join(bin, "cli"), core, globalRoot: box };
  const config = parseConfig({ enabled: false, role: "hub", machineId: HUB, hubMachineId: HUB, peers: [peer], discoveryRoots: [], coreUnit: "fixture.service" });
  const journal = openJournal(join(root, "journal.db"));
  const transport = { transport: { async resolve(value: Peer) { return value; } }, async executeProvision(_peer: Peer, request: Record<string, unknown>) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", getProvisionRemoteScript()], {
      input: JSON.stringify({ ...request, core, coreId: "fixture-core" }), encoding: "utf8", timeout: 5000,
      env: { ...process.env, HOME: root, PATH: bin },
    });
    if (child.status !== 0) throw new Error(`remote fixture failed: ${child.stderr}`);
    const reply = JSON.parse(child.stdout) as { value?: unknown; error?: string };
    if (reply.error) throw Object.assign(new Error(reply.error), { code: reply.error });
    return reply.value;
  } };
  return { root, box, roam, bin, state, unit, calls, peer, config, journal, transport };
}

it("queries the v0 supervisor autostart when both definitions remain", async () => {
  const f=fixture();
  writeFileSync(join(f.root,".config/systemd/user/spider-roam-supervisor-v0.service"),"fixture v0 unit");
  writeFileSync(join(f.bin,"systemctl"), `#!${process.execPath}\nconst args=process.argv.slice(2);\nif (args.join(' ') !== '--user is-enabled spider-roam-supervisor-v0.service') process.exit(1);\nconsole.log('enabled');\n`, {mode:0o700});
  vi.stubEnv("PATH",f.bin);vi.stubEnv("HOME",f.root);vi.stubEnv("XDG_CONFIG_HOME",join(f.root,".config"));
  const {inspectSupervisorAutostart}=await import("../local-diagnostics");
  expect(await inspectSupervisorAutostart()).toBe("enabled");
});

it("refuses a legacy autostart request before changing participation or systemd", async () => {
  const f = fixture();
  const before = readFileSync(join(f.roam, "config.json"));
  await expect(f.transport.executeProvision(f.peer, { action: "roaming-enabled", machineId: BOX, hubMachineId: HUB,
    globalRoot: f.box, enabled: true, restoreAutostart: true })).rejects.toMatchObject({ code: "invalid-request" });
  expect(readFileSync(join(f.roam, "config.json"))).toEqual(before);
  expect(readFileSync(f.state, "utf8")).toBe("disabled");
  expect(existsSync(f.calls)).toBe(false);
});

it.each([true, false])("changes participation without a service command (unit present: %s)", async unitPresent => {
  const f = fixture();
  if (!unitPresent) rmSync(f.unit);
  for (const enabled of [true, false]) {
    await setEnrolledPeerEnabled({ ...f, enabled, transport: f.transport as never });
    expect(JSON.parse(readFileSync(join(f.roam, "config.json"), "utf8")).enabled).toBe(enabled);
  }
  expect(existsSync(f.calls)).toBe(false);
  expect(readFileSync(f.state, "utf8")).toBe("disabled");
});

it("does not write participation on an enrollment conflict", async () => {
  const f = fixture(); rmSync(f.unit);
  writeFileSync(join(f.roam, "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  await expect(setEnrolledPeerEnabled({ ...f, enabled: true, transport: f.transport as never }))
    .rejects.toMatchObject({ code: "enrollment-conflict" });
  expect(JSON.parse(readFileSync(join(f.roam, "config.json"), "utf8")).enabled).toBe(false);
  expect(existsSync(f.calls)).toBe(false);
});

it("hub enable changes participation after preflight but never changes the box service", async () => {
  const f = fixture(), roam = join(f.root, "roam"); mkdirSync(roam, { mode: 0o700 });
  writeFileSync(join(roam, "machine.json"), JSON.stringify({ machineId: HUB }), { mode: 0o600 });
  writeFileSync(join(roam, "config.json"), JSON.stringify({ ...f.config, coreUnit: "fixture.service", discoveryRoots: [] }), { mode: 0o600 });
  const db = openDb(join(f.root, "spider.db")); migrate(db, "global", { machineId: HUB, globalRoot: f.root }); db.close();
  const launchctl = join(f.root, "launchctl"); writeFileSync(launchctl, "fixture", { mode: 0o700 });
  vi.stubEnv("HOME", f.root); vi.stubEnv("SPIDER_GLOBAL_ROOT", f.root); vi.stubEnv("SPIDER_ROAM_PI", process.execPath);
  vi.stubEnv("SPIDER_TEST_ROAM_LAUNCHCTL", launchctl);
  vi.spyOn(productionHub, "loadHerdrConfig").mockReturnValue({ core: { binary: f.peer.core } } as never);
  vi.spyOn(diagnostics, "assertCompatibleConsumers").mockResolvedValue(undefined);
  const service = vi.spyOn(launchd, "installHubService").mockRejectedValue(new Error("fixture prevents service launch"));
  let startupBlocked = false;
  vi.spyOn(transportModule, "createTransport").mockReturnValue({ async resolve(peer: Peer) { return peer; }, async exec(_peer: Peer, argv: string[]) {
    if (argv[1] === "intercom") return Buffer.from(JSON.stringify({ version: 1, kind: "intercom-broker-start", ok: true, machineId: BOX,
      doctor: { enabled: false, diagnostics: startupBlocked ? [
        { severity: "block", reason: "intercom-federation: intercom-broker-unavailable.", repairCommand: null },
      ] : [], consumers: [] } }));
    const op = JSON.parse(argv[2]);
    return Buffer.from(JSON.stringify({ operationId: op.id, code: 0, value: op.kind === "stores"
      ? { protocol: 1, schema: 14, machineId: BOX, stores: ["global"] } : { complete: true } }));
  } } as never);
  vi.spyOn(transportModule, "createProvisionTransport").mockReturnValue(f.transport as never);
  const doctor = vi.spyOn(remoteObservations, "remoteDoctor").mockResolvedValue({ enabled: false, diagnostics: [
    { severity: "block", reason: "fixture-not-ready", repairCommand: null }], consumers: [] });
  expect((await enableRoaming(f.root, () => process.execPath)).code).toBe(1);
  expect(readFileSync(f.state, "utf8")).toBe("disabled");
  doctor.mockResolvedValue({ enabled: false, diagnostics: [], consumers: [] });
  startupBlocked = true;
  expect(await enableRoaming(f.root, () => process.execPath)).toMatchObject({ code: 3, causeCode: "intercom-broker-unavailable" });
  expect(readFileSync(f.state, "utf8")).toBe("disabled");
  expect(JSON.parse(readFileSync(join(f.roam, "config.json"), "utf8")).enabled).toBe(false);
  startupBlocked = false;
  const ready = await enableRoaming(f.root, () => process.execPath);
  expect(ready, JSON.stringify(ready)).toMatchObject({ code: 3, reason: "enable-pending" });
  expect(readFileSync(f.state, "utf8")).toBe("disabled");
  expect(existsSync(f.calls)).toBe(false);
  expect(JSON.parse(readFileSync(join(f.roam, "config.json"), "utf8")).enabled).toBe(true);

  // Retry after the hub service failure and verify the fully successful path too.
  writeFileSync(f.state, "disabled");
  const boxConfig = JSON.parse(readFileSync(join(f.roam, "config.json"), "utf8"));
  writeFileSync(join(f.roam, "config.json"), JSON.stringify({ ...boxConfig, enabled: false }), { mode: 0o600 });
  service.mockResolvedValue(undefined);
  vi.spyOn(controlSocket, "requestHubControl").mockResolvedValue({ code: 0, value: { enabled: true } } as never);
  expect(await enableRoaming(f.root, () => process.execPath)).toMatchObject({ code: 0, reason: "roaming-enabled" });
  expect(readFileSync(f.state, "utf8")).toBe("disabled");
  expect(existsSync(f.calls)).toBe(false);
  expect(JSON.parse(readFileSync(join(f.roam, "config.json"), "utf8")).enabled).toBe(true);
});

it("observes persistent autostart through the systemctl result", async () => {
  const f = fixture(); vi.stubEnv("PATH", f.bin); vi.stubEnv("HOME", f.root);
  const { inspectSupervisorAutostart } = await import("../local-diagnostics");
  for (const [actual, expected] of [["disabled", "disabled"], ["enabled", "enabled"], ["enabled-runtime", "disabled"], ["not-found", "unknown"], ["masked", "unknown"]] as const) {
    writeFileSync(f.state, actual);
    expect(await inspectSupervisorAutostart()).toBe(expected);
  }
  rmSync(join(f.bin, "systemctl"));
  expect(await inspectSupervisorAutostart()).toBe("unknown");
});

it("warns when an enabled box has disabled supervisor autostart", async () => {
  const f = fixture();
  writeFileSync(join(f.roam, "config.json"), JSON.stringify({ enabled: true, role: "box", machineId: BOX, hubMachineId: HUB,
    peers: [], discoveryRoots: [], coreUnit: "fixture.service" }), { mode: 0o600 });
  const run = (state: "enabled" | "disabled" | "unknown") => runLocalDoctor({ root: f.box, supervisorAutostart: async () => state });
  const disabled = await run("disabled");
  expect(disabled.diagnostics).toContainEqual({ reason: "supervisor-autostart-disabled: Supervisor autostart is disabled. Run spider roam enable locally on this box.",
    severity: "warning", repairCommand: "spider roam enable" });
  for (const state of ["enabled", "unknown"] as const) {
    const report = await run(state);
    expect(report.diagnostics.some(row => row.reason.startsWith("supervisor-autostart-disabled:"))).toBe(false);
  }
  expect((await run("unknown")).diagnostics).toContainEqual({ reason: "supervisor-autostart-unavailable: Supervisor autostart cannot be verified. Check the supervisor unit and systemd user service.",
    severity: "warning", repairCommand: null });
  expect((await run("enabled")).diagnostics.some(row => row.reason.startsWith("supervisor-autostart-unavailable:"))).toBe(false);
  writeFileSync(join(f.roam, "config.json"), JSON.stringify({ enabled: false, role: "box", machineId: BOX, hubMachineId: HUB,
    peers: [], discoveryRoots: [], coreUnit: "fixture.service" }), { mode: 0o600 });
  expect((await run("disabled")).diagnostics.some(row => row.reason.startsWith("supervisor-autostart-disabled:"))).toBe(false);
});
