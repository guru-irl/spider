import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { createIntercomRegistry } from "../intercom-registry";
import type { NativeProcess } from "../intercom-exclusion";
import type { IntercomEnrollmentPair } from "../provision-contracts";
import { main } from "../cli";
import { inspectLocalIntercomDoctor } from "../intercom-doctor";
import { openIntercomStore } from "../intercom-store";
import { parseConfig } from "../config";
import { FEDERATION_NOTICE_ACK_FEATURE, HELPER_EXCHANGE_FEATURE } from "@spider/intercom/protocol";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const FENCE = "00000000-0000-4000-8000-000000000003";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(side: "host" | "connect" = "host") {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "pair-unit-")); roots.push(root);
  const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
  const peer = (machineId: string, alias: string) => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: root });
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const pair: IntercomEnrollmentPair = { pairId: "pair-1", source: peer(A, "box-a.invalid"), target: peer(B, "box-b.invalid"), edgeEpoch: "edge-1",
    connector: { tunnelId: "tunnel-1", remotePort: 22, session: "default" }, sshUser: "fixture", hostKey: { type: "ssh-ed25519", base64: blob.toString("base64") }, hostKeyAlias: `spider-${"a".repeat(32)}` };
  const registry = createIntercomRegistry(root); await registry.register(pair, "enroll-1", "a".repeat(64)); await registry.bind(pair, "enroll-1");
  const calls: string[][] = []; let active = "inactive", pid = 0, processes: number[] = [], straggler = false, connection = false, wrongName = false;
  const name = `spider-pair-pair-1-${side}.service`, file = join(home, ".config", "systemd", "user", name), group = "/user.slice/pair-1";
  const run = async (argv: readonly string[]) => {
    calls.push([...argv]);
    if (!existsSync(file) && active === "inactive" && ["stop", "disable"].includes(argv[2])) return { code: 1, stdout: "" };
    if (argv[2] === "start") { active = "active"; pid = 123; processes = [123, 124]; connection = true; }
    if (argv[2] === "stop") { active = "inactive"; pid = 0; processes = straggler ? [124] : []; connection = straggler; }
    const missing = !existsSync(file) && active === "inactive";
    return { code: 0, stdout: argv[2] === "show" ? `Id=${wrongName ? "other.service" : name}\nLoadState=${missing ? "not-found" : "loaded"}\nActiveState=${active}\nMainPID=${pid}\nControlGroup=${missing ? "" : group}\nKillMode=control-group\nFragmentPath=${missing ? "" : file}\nDropInPaths=\nNeedDaemonReload=no\n` : "" };
  };
  const recipe = { check: ["/fixture/connector", "check"], host: ["/fixture/connector", "host", "{pairId}", "{tunnelId}"], connect: ["/fixture/connector", "connect", "{pairId}"], localPort: 23222 };
  const ports = { machineId: side === "host" ? B : A, root, home, run, recipe, systemctl: "/fixture/systemctl",
    process: (value: number): NativeProcess => processes.includes(value) ? { kind: "live" as const, startIdentity: "linux:100" } : { kind: "absent" as const },
    cgroup: () => processes };
  return { root, home, pair, registry, ports, calls, file, remove: () => { active = "inactive"; pid = 0; processes = []; connection = false; unlinkSync(file); }, connected: () => connection, straggler: () => { straggler = true; }, drain: () => { straggler = false; processes = []; connection = false; }, mismatch: () => { wrongName = true; } };
}

it.each(["host", "connect"] as const)("reports a missing recorded %s unit as unready without querying systemd", async side => {
  const f = await fixture(side), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, side, f.ports);
  unlinkSync(f.file); const before = f.calls.length;
  expect(await api.inspectPairUnit(f.pair, side, f.ports)).toBe("intercom-pair-unit-missing");
  expect(f.calls).toHaveLength(before);
  expect(await f.registry.get("pair-1")).toMatchObject({ state: "pending", unit: { main: { pid: 123 } } });
}, 5000);

it.each(["mode", "symlink", "contents", "parent"] as const)("does not classify an unsafe %s as a missing unit", async failure => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, "host", f.ports);
  if (failure === "mode") chmodSync(f.file, 0o644);
  if (failure === "contents") writeFileSync(f.file, "foreign unit", { mode: 0o600 });
  if (failure === "symlink") { unlinkSync(f.file); symlinkSync(join(f.home, "absent.service"), f.file); }
  if (failure === "parent") rmSync(join(f.home, ".config", "systemd", "user"), { recursive: true });
  await expect(api.inspectPairUnit(f.pair, "host", f.ports)).rejects.toThrow();
}, 5000);

it.each(["EIO", "EACCES"])("keeps %s from the recorded unit as a refusal", async code => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, "host", f.ports);
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(lstatSync).mockImplementation(file => {
    if (file === f.file) throw Object.assign(new Error("synthetic filesystem failure"), { code });
    return actual.lstatSync(file);
  });
  try { await expect(api.inspectPairUnit(f.pair, "host", f.ports)).rejects.toMatchObject({ code }); }
  finally { vi.mocked(lstatSync).mockImplementation(actual.lstatSync); }
}, 5000);

it("refuses a recorded unit owned by another user", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, "host", f.ports);
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(lstatSync).mockImplementation(file => {
    const info = actual.lstatSync(file);
    return file === f.file ? Object.assign(Object.create(info), { uid: info.uid + 1 }) : info;
  });
  try { await expect(api.inspectPairUnit(f.pair, "host", f.ports)).rejects.toThrow("intercom-unit-mismatch"); }
  finally { vi.mocked(lstatSync).mockImplementation(actual.lstatSync); }
}, 5000);

it("creates and records a pair host with literal argv and explicit control-group killing", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  expect(await api.ensurePairUnit(f.pair, "host", f.ports)).toEqual({ status: "ready" });
  expect(readFileSync(f.file, "utf8")).toContain('ExecStart="/fixture/connector" "host" "pair-1" "tunnel-1"');
  expect(readFileSync(f.file, "utf8")).toContain("KillMode=control-group\n");
  expect(await f.registry.get("pair-1")).toMatchObject({ resources: { hostUnit: "spider-pair-pair-1-host.service", connectUnit: "spider-pair-pair-1-connect.service", route: { name: "spider-pair-pair-1", targetCoreId: "core-b", session: "default" } }, unit: { localPort: 23222, main: { pid: 123, startIdentity: "linux:100" } } });
  await api.ensurePairUnit(f.pair, "host", f.ports);
  expect(f.calls.filter(argv => argv[2] === "start")).toHaveLength(1);
  expect(f.calls.some(argv => argv[2] === "enable" && argv[3] === "spider-pair-pair-1-host.service")).toBe(true);
}, 5000);

async function stoppedFixture(side: "host" | "connect" = "host") {
  const f = await fixture(side), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, side, f.ports); await f.registry.activate("pair-1", "enroll-1");
  const machineId = f.ports.machineId;
  const config = { enabled: false, role: "box", machineId, hubMachineId: "00000000-0000-4000-8000-000000000004", peers: [], discoveryRoots: [], coreUnit: "fixture",
    intercom: { enabled: true, mode: "peers", machineAlias: side === "host" ? "box-b.invalid" : "box-a.invalid", routes: [], connector: f.ports.recipe } };
  writeFileSync(join(f.root, "roam", "machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  writeFileSync(join(f.root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  await f.ports.run(["/fixture/systemctl", "--user", "stop", `spider-pair-pair-1-${side}.service`]);
  const doctor = () => inspectLocalIntercomDoctor({ root: f.root, config: parseConfig(config), agentDir: f.home, resourcePorts: f.ports,
    run: f.ports.run, features: async () => [HELPER_EXCHANGE_FEATURE, FEDERATION_NOTICE_ACK_FEATURE],
    inspectSsh: async pair => ({ targetMachineId: B, sshUser: "fixture", hostKeys: [pair.hostKey] }),
    link: async () => ({ status: "live", reason: null }) });
  const runRepair = async () => {
    let out = "", err = "";
    const code = await main(["--global-root", f.root, "roam", "intercom", "repair-units"],
      { out: text => { out += text; }, err: text => { err += text; } },
      { pairPorts: { ...f.ports, node: process.execPath, ssh: "/fixture/ssh", keygen: "/fixture/keygen" } });
    return { code, out, err };
  };
  return { ...f, api, doctor, runRepair };
}

it.each(["host", "connect"] as const)("inspects a stopped or running owned %s unit without changing it", async side => {
  const f = await stoppedFixture(side);
  const inspect = async () => {
    let out = "", err = "";
    const code = await main(["--global-root", f.root, "roam", "intercom", "inspect-units"],
      { out: text => { out += text; }, err: text => { err += text; } },
      { pairPorts: { ...f.ports, node: process.execPath, ssh: "/fixture/ssh", keygen: "/fixture/keygen" } });
    expect(code, out + err).toBe(0);
    return JSON.parse(out);
  };
  const before = f.calls.length;
  expect(await inspect()).toEqual({ version: 1, kind: "intercom-unit-inspect", ok: true, machineId: f.ports.machineId, needsRepair: true });
  expect(f.calls.slice(before).some(argv => ["enable", "start", "stop"].includes(argv[2]))).toBe(false);
  expect((await f.runRepair()).code).toBe(0);
  const after = f.calls.length;
  expect(await inspect()).toEqual({ version: 1, kind: "intercom-unit-inspect", ok: true, machineId: f.ports.machineId, needsRepair: false });
  expect(f.calls.slice(after).some(argv => ["enable", "start", "stop"].includes(argv[2]))).toBe(false);
}, 5000);

it("reports an unverified unit as unknown without changing it", async () => {
  const f = await stoppedFixture(); f.mismatch(); const before = f.calls.length;
  let out = "", err = "";
  const code = await main(["--global-root", f.root, "roam", "intercom", "inspect-units"],
    { out: text => { out += text; }, err: text => { err += text; } },
    { pairPorts: { ...f.ports, node: process.execPath, ssh: "/fixture/ssh", keygen: "/fixture/keygen" } });
  expect(code, out + err).toBe(0);
  expect(JSON.parse(out)).toEqual({ version: 1, kind: "intercom-unit-inspect", ok: true, machineId: f.ports.machineId, needsRepair: null });
  expect(f.calls.slice(before).some(argv => ["enable", "start", "stop"].includes(argv[2]))).toBe(false);
}, 5000);

it.each(["host", "connect"] as const)("repairs a stopped owned %s unit and keeps doctor blocking until it is active", async side => {
  const f = await stoppedFixture(side), foreign = join(f.home, ".config/systemd/user/foreign.service");
  writeFileSync(foreign, "foreign unit", { mode: 0o600 });
  expect(await f.api.inspectPairUnit(f.pair, side, f.ports)).toBe(false);
  expect(await f.doctor()).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringContaining("intercom-pair-unit-unavailable") }));
  const first = await f.runRepair();
  expect(first.code, first.out + first.err).toBe(0);
  expect(JSON.parse(first.out)).toMatchObject({ version: 1, kind: "intercom-unit-repair", ok: true, machineId: f.ports.machineId });
  expect(await f.api.inspectPairUnit(f.pair, side, f.ports)).toBe(true);
  expect((await f.doctor()).some(row => row.reason.startsWith("intercom-pair-unit-unavailable"))).toBe(false);
  const starts = f.calls.filter(argv => argv[2] === "start").length;
  const second = await f.runRepair();
  expect(second.code, second.out + second.err).toBe(0);
  expect(JSON.parse(second.out)).toMatchObject({ ok: true });
  expect(f.calls.filter(argv => argv[2] === "start")).toHaveLength(starts);
  expect(readFileSync(foreign, "utf8")).toBe("foreign unit");
  expect(f.calls.some(argv => argv.includes("foreign.service"))).toBe(false);
}, 5000);

it("refuses a foreign loaded unit before enabling or starting it", async () => {
  const f = await stoppedFixture(); f.mismatch(); const before = f.calls.length;
  const result = await f.runRepair();
  expect(result.code, result.out + result.err).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ version: 1, kind: "intercom-unit-repair", ok: false });
  expect(f.calls.slice(before).some(argv => ["enable", "start"].includes(argv[2]))).toBe(false);
  expect(f.connected()).toBe(false);
}, 5000);

it("does not enable a foreign loaded unit when ensuring the recorded pair", async () => {
  const f = await stoppedFixture(); f.mismatch(); const before = f.calls.length;
  await expect(f.api.ensurePairUnit(f.pair, "host", f.ports)).rejects.toThrow("intercom-unit-mismatch");
  expect(f.calls.slice(before).some(argv => ["enable", "start"].includes(argv[2]))).toBe(false);
  expect(f.connected()).toBe(false);
}, 5000);

it("does not restart a pair being revoked", async () => {
  const f = await stoppedFixture(); await f.registry.beginRevocation("pair-1", FENCE); const before = f.calls.length;
  const result = await f.runRepair();
  expect(result.code, result.out + result.err).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ ok: true });
  expect(f.calls.slice(before).some(argv => ["enable", "start"].includes(argv[2]))).toBe(false);
  expect(f.connected()).toBe(false);
}, 5000);

it("refuses a missing recorded unit rather than recreating it during repair", async () => {
  const f = await stoppedFixture(); unlinkSync(f.file); const before = f.calls.length;
  const result = await f.runRepair();
  expect(result.code, result.out + result.err).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ ok: false });
  expect(existsSync(f.file)).toBe(false);
  expect(f.calls.slice(before).some(argv => ["enable", "start"].includes(argv[2]))).toBe(false);
}, 5000);

it("does not adopt a unit without its recorded ownership metadata", async () => {
  const f = await stoppedFixture(), file = join(f.root, "roam/intercom/enrollments/pair-1.json");
  const record = JSON.parse(readFileSync(file, "utf8")); delete record.unit; writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  const before = f.calls.length, result = await f.runRepair();
  expect(result.code, result.out + result.err).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ ok: false });
  expect(f.calls.slice(before).some(argv => ["enable", "start"].includes(argv[2]))).toBe(false);
  expect(f.connected()).toBe(false);
}, 5000);

it("ignores a pair record belonging to another machine root", async () => {
  const f = await stoppedFixture(), other = { ...f.pair, pairId: "pair-2", edgeEpoch: "edge-2",
    target: { ...f.pair.target, globalRoot: join(f.root, "foreign") } };
  await f.registry.register(other, "enroll-2", "b".repeat(64)); await f.registry.bind(other, "enroll-2");
  await f.registry.bindResources("pair-2", "enroll-2", f.api.pairResources(other, "core-b")); await f.registry.activate("pair-2", "enroll-2");
  const result = await f.runRepair();
  expect(result.code, result.out + result.err).toBe(0);
  expect(JSON.parse(result.out)).toMatchObject({ ok: true });
  expect(f.calls.some(argv => argv.includes("spider-pair-pair-2-host.service"))).toBe(false);
  expect(existsSync(join(f.home, ".config/systemd/user/spider-pair-pair-2-host.service"))).toBe(false);
}, 5000);

it("does not restart an active registry entry with a durable revocation fence", async () => {
  const f = await stoppedFixture(), queue = openIntercomStore({ file: join(f.root, "roam", "intercom", "queue.db"), machineId: B,
    clock: { now: () => 1000 } });
  try {
    queue.fencePair(A, "edge-1", FENCE); const before = f.calls.length;
    const result = await f.runRepair();
    expect(result.code, result.out + result.err).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, reason: "revocation-pending" });
    expect(f.calls.slice(before).some(argv => ["enable", "start"].includes(argv[2]))).toBe(false);
    expect(f.connected()).toBe(false);
  } finally { queue.close(); }
}, 5000);

it("substitutes the approved remote port into the host command", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  const ports = { ...f.ports, recipe: { ...f.ports.recipe, host: [...f.ports.recipe.host, "--ssh-port={remotePort}"] } };
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  expect(await api.ensurePairUnit(f.pair, "host", ports)).toEqual({ status: "ready" });
  expect(readFileSync(f.file, "utf8")).toContain('"--ssh-port=22"');
}, 5000);

it("keeps the approved remote port distinct from the per-pair connect port", async () => {
  const f = await fixture("connect"), api = await import("../intercom-pair-resources");
  const ports = { ...f.ports, recipe: { ...f.ports.recipe, pairPorts: { "pair-1": 23223 }, connect: [...f.ports.recipe.connect, "{remotePort}", "{localPort}"] } };
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  expect(await api.ensurePairUnit(f.pair, "connect", ports)).toEqual({ status: "ready" });
  expect(readFileSync(f.file, "utf8")).toContain('"22" "23223"');
  expect(await f.registry.get("pair-1")).toMatchObject({ unit: { localPort: 23223 } });
}, 5000);

it("rejects the retired SSH port placeholder", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  const recipe = f.ports.recipe;
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await expect(api.ensurePairUnit(f.pair, "host", { ...f.ports, recipe: { ...recipe, host: [...recipe.host, "{sshPort}"] } })).rejects.toThrow("intercom-connector-recipe-invalid");
  expect(f.calls).toEqual([]); expect(existsSync(f.file)).toBe(false);
}, 5000);

it.each(["host", "connect"] as const)("proves an already-absent %s unit closed under the retained fence", async side => {
  const f = await fixture(side), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, side, f.ports); f.remove();
  await f.registry.beginRevocation("pair-1", FENCE);
  expect(await api.stopPairUnit(f.pair, side, FENCE, f.ports)).toMatchObject({ activeState: "inactive", mainPid: 123, mainStartIdentity: "linux:100", mainProcess: "exited", controlGroup: "empty" });
  expect(await f.registry.get("pair-1")).toMatchObject({ unit: { closedFenceId: FENCE } });
  expect(f.calls.some(argv => ["stop", "disable"].includes(argv[2]))).toBe(false);
  expect(await api.stopPairUnit(f.pair, side, FENCE, f.ports)).toMatchObject({ mainProcess: "exited", controlGroup: "empty" });
}, 5000);

it("does not stop a cached live unit merely because its file was deleted", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, "host", f.ports); unlinkSync(f.file); await f.registry.beginRevocation("pair-1", FENCE);
  await expect(api.stopPairUnit(f.pair, "host", FENCE, f.ports)).rejects.toThrow();
  expect(f.connected()).toBe(true); expect(f.calls.some(argv => argv[2] === "stop")).toBe(false);
  expect((await f.registry.get("pair-1"))?.unit?.closedFenceId).toBeNull();
}, 5000);

it.each(["process", "cgroup"] as const)("absence does not replace missing %s closure proof", async failure => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, "host", f.ports); f.remove(); await f.registry.beginRevocation("pair-1", FENCE);
  const ports = { ...f.ports, ...(failure === "process" ? { process: (): NativeProcess => ({ kind: "unknown" }) } : { cgroup: () => [124] }) };
  expect(await api.stopPairUnit(f.pair, "host", FENCE, ports)).toMatchObject(failure === "process" ? { mainProcess: "unknown" } : { controlGroup: "nonempty" });
  expect((await f.registry.get("pair-1"))?.unit?.closedFenceId).toBeNull();
}, 5000);

it.each([
  ["LoadState", "loaded"], ["ActiveState", "active"], ["MainPID", "123"], ["ControlGroup", "/user.slice/foreign"],
  ["FragmentPath", "/home/fixture/foreign.service"], ["DropInPaths", "/home/fixture/override.conf"], ["NeedDaemonReload", "yes"], ["KillMode", "process"],
])("refuses an absent unit with unsafe %s evidence", async (field, value) => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, "host", f.ports); f.remove(); await f.registry.beginRevocation("pair-1", FENCE);
  const run = f.ports.run, ports = { ...f.ports, run: async (argv: readonly string[]) => {
    const reply = await run(argv);
    return argv[2] === "show" ? { ...reply, stdout: reply.stdout.replace(new RegExp(`^${field}=.*$`, "m"), `${field}=${value}`) } : reply;
  } };
  await expect(api.stopPairUnit(f.pair, "host", FENCE, ports)).rejects.toThrow();
  expect((await f.registry.get("pair-1"))?.unit?.closedFenceId).toBeNull();
  expect(f.calls.some(argv => ["stop", "disable"].includes(argv[2]))).toBe(false);
}, 5000);

it("does not invent process closure for an absent unit without a recorded main identity", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, "host", f.ports); f.remove();
  const unit = (await f.registry.get("pair-1"))!.unit!;
  await f.registry.recordUnit("pair-1", { ...unit, main: null }); await f.registry.beginRevocation("pair-1", FENCE);
  await expect(api.stopPairUnit(f.pair, "host", FENCE, f.ports)).rejects.toThrow("intercom-revocation-unconfirmed");
  expect((await f.registry.get("pair-1"))?.unit?.closedFenceId).toBeNull();
}, 5000);

it("absence still requires the recorded fence before any systemd inspection", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, "host", f.ports); f.remove(); await f.registry.beginRevocation("pair-1", FENCE);
  const before = f.calls.length;
  await expect(api.stopPairUnit(f.pair, "host", A, f.ports)).rejects.toThrow("intercom-revocation-unconfirmed");
  expect(f.calls).toHaveLength(before); expect((await f.registry.get("pair-1"))?.unit?.closedFenceId).toBeNull();
}, 5000);

it("stopping B drops a live connection and proves every member of the pair cgroup exited", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, "host", f.ports); expect(f.connected()).toBe(true);
  await f.registry.beginRevocation("pair-1", FENCE);
  expect(await api.stopPairUnit(f.pair, "host", FENCE, f.ports)).toMatchObject({ machineId: B, unit: "spider-pair-pair-1-host.service", activeState: "inactive", mainPid: 123, mainStartIdentity: "linux:100", mainProcess: "exited", controlGroup: "empty", killMode: "control-group" });
  expect(f.connected()).toBe(false);
  expect(f.calls.findIndex(argv => argv[2] === "disable")).toBeLessThan(f.calls.findIndex(argv => argv[2] === "stop"));
  expect(f.calls.some(argv => argv[2] === "disable")).toBe(true);
  expect(await api.stopPairUnit(f.pair, "host", FENCE, f.ports)).toMatchObject({ mainProcess: "exited", controlGroup: "empty" });
  expect(f.calls.filter(argv => argv[2] === "stop").every(argv => argv[3] === "spider-pair-pair-1-host.service")).toBe(true);
}, 5000);

it("a straggler keeps B closure unconfirmed until recovery finds an empty cgroup", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, "host", f.ports); await f.registry.beginRevocation("pair-1", FENCE); f.straggler();
  expect(await api.stopPairUnit(f.pair, "host", FENCE, f.ports)).toMatchObject({ controlGroup: "nonempty" });
  expect(await f.registry.get("pair-1")).toMatchObject({ unit: { closedFenceId: null } });
  f.drain();
  expect(await api.stopPairUnit(f.pair, "host", FENCE, f.ports)).toMatchObject({ controlGroup: "empty" });
  expect(await f.registry.get("pair-1")).toMatchObject({ unit: { closedFenceId: FENCE } });
}, 5000);

it("refuses a mismatched systemd unit without stopping any unit", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await api.ensurePairUnit(f.pair, "host", f.ports); await f.registry.beginRevocation("pair-1", FENCE); f.mismatch();
  await expect(api.stopPairUnit(f.pair, "host", FENCE, f.ports)).rejects.toThrow("intercom-unit-mismatch");
  expect(f.calls.some(argv => argv[2] === "stop")).toBe(false); expect(f.connected()).toBe(true);
}, 5000);

it.each([["KillMode", "process"], ["FragmentPath", "/fixture/foreign"], ["DropInPaths", "/fixture/foreign"], ["NeedDaemonReload", "yes"], ["ActiveState", "activating"]])("refuses unsafe systemd observations without issuing stop %#", async (field, value) => {
  const f = await fixture(), api = await import("../intercom-pair-resources"); await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b")); await api.ensurePairUnit(f.pair, "host", f.ports);
  const run = f.ports.run; f.ports.run = async argv => { const result = await run(argv); return argv[2] === "show" ? { ...result, stdout: result.stdout.replace(new RegExp(`^${field}=.*$`, "m"), `${field}=${value}`) } : result; };
  await f.registry.beginRevocation("pair-1", FENCE); await expect(api.stopPairUnit(f.pair, "host", FENCE, f.ports)).rejects.toThrow(/intercom-unit-/);
  expect(f.connected()).toBe(true); expect(f.calls.some(argv => argv[2] === "stop")).toBe(false);
}, 5000);
it.each(["live", "unknown"] as const)("does not confirm closure while the original process is %s", async kind => {
  const f = await fixture(), api = await import("../intercom-pair-resources"); await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b")); await api.ensurePairUnit(f.pair, "host", f.ports);
  const probe = f.ports.process; f.ports.process = value => { const state = probe(value); return state.kind !== "absent" ? state : kind === "live" ? { kind, startIdentity: "linux:100" } : { kind }; };
  await f.registry.beginRevocation("pair-1", FENCE); expect(await api.stopPairUnit(f.pair, "host", FENCE, f.ports)).toMatchObject({ activeState: "inactive", mainProcess: kind, controlGroup: "empty" });
  expect((await f.registry.get("pair-1"))?.unit?.closedFenceId).toBeNull();
}, 5000);
it("proves the original process exited when its PID has been reused", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources"); await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b")); await api.ensurePairUnit(f.pair, "host", f.ports);
  const probe = f.ports.process; f.ports.process = value => { const state = probe(value); return state.kind === "absent" ? { kind: "live", startIdentity: "linux:200" } : state; };
  await f.registry.beginRevocation("pair-1", FENCE); expect(await api.stopPairUnit(f.pair, "host", FENCE, f.ports)).toMatchObject({ mainProcess: "exited", controlGroup: "empty" });
  expect((await f.registry.get("pair-1"))?.unit).toMatchObject({ main: { pid: 123, startIdentity: "linux:100" }, closedFenceId: FENCE });
}, 5000);

it("refuses a second outgoing pair on the same operator port without changing the first", async () => {
  const f = await fixture("connect"), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b")); await api.ensurePairUnit(f.pair, "connect", f.ports);
  const second = { ...f.pair, pairId: "pair-2", edgeEpoch: "edge-2", target: { ...f.pair.target, machineId: "00000000-0000-4000-8000-000000000004", alias: "box-c.invalid" } };
  await f.registry.register(second, "enroll-2", "b".repeat(64)); await f.registry.bind(second, "enroll-2"); await f.registry.bindResources("pair-2", "enroll-2", api.pairResources(second, "core-c"));
  await expect(api.ensurePairUnit(second, "connect", f.ports)).rejects.toThrow("intercom-peer-port-in-use");
  expect(f.calls.filter(argv => argv[2] === "start")).toHaveLength(1); expect(f.connected()).toBe(true);
}, 5000);

it("preserves literal spaces, quotes, backslashes, percent signs and dollars in operator argv", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources"); f.ports.recipe.host.push("two words", 'quote" slash\\ % $HOME');
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b")); expect(await api.ensurePairUnit(f.pair, "host", f.ports)).toEqual({ status: "ready" });
  expect(readFileSync(f.file, "utf8")).toContain(String.raw`"two words" "quote\" slash\\ %% $$HOME"`);
}, 5000);

it("does not write or start units for an unscoped recipe", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  expect(await api.ensurePairUnit(f.pair, "host", { ...f.ports, recipe: { ...f.ports.recipe, host: ["/fixture/connector", "host"] } })).toEqual({ status: "connector-not-pair-scoped" });
  expect(f.calls).toEqual([]); expect(existsSync(f.file)).toBe(false);
}, 5000);
