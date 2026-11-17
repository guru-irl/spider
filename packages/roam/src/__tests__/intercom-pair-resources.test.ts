import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { createIntercomRegistry } from "../intercom-registry";
import type { NativeProcess } from "../intercom-exclusion";
import type { IntercomEnrollmentPair } from "../provision-contracts";

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
    if (argv[2] === "start") { active = "active"; pid = 123; processes = [123, 124]; connection = true; }
    if (argv[2] === "stop") { active = "inactive"; pid = 0; processes = straggler ? [124] : []; connection = straggler; }
    return { code: 0, stdout: argv[2] === "show" ? `Id=${wrongName ? "other.service" : name}\nActiveState=${active}\nMainPID=${pid}\nControlGroup=${group}\nKillMode=control-group\nFragmentPath=${file}\nDropInPaths=\nNeedDaemonReload=no\n` : "" };
  };
  const recipe = { check: ["/fixture/connector", "check"], host: ["/fixture/connector", "host", "{pairId}", "{tunnelId}"], connect: ["/fixture/connector", "connect", "{pairId}"], localPort: 23222, sshPort: 2222 };
  const ports = { machineId: side === "host" ? B : A, root, home, run, recipe, systemctl: "/fixture/systemctl",
    process: (value: number): NativeProcess => processes.includes(value) ? { kind: "live" as const, startIdentity: "linux:100" } : { kind: "absent" as const },
    cgroup: () => processes };
  return { root, home, pair, registry, ports, calls, file, connected: () => connection, straggler: () => { straggler = true; }, drain: () => { straggler = false; processes = []; connection = false; }, mismatch: () => { wrongName = true; } };
}

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

it("substitutes the configured SSH listener port into the host command", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  const ports = { ...f.ports, recipe: { ...f.ports.recipe, sshPort: 2222, host: [...f.ports.recipe.host, "--ssh-port={sshPort}"] } };
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  expect(await api.ensurePairUnit(f.pair, "host", ports)).toEqual({ status: "ready" });
  expect(readFileSync(f.file, "utf8")).toContain('"--ssh-port=2222"');
}, 5000);

it("keeps the SSH listener port distinct from the per-pair connect port", async () => {
  const f = await fixture("connect"), api = await import("../intercom-pair-resources");
  const ports = { ...f.ports, recipe: { ...f.ports.recipe, sshPort: 2222, pairPorts: { "pair-1": 23223 }, connect: [...f.ports.recipe.connect, "{sshPort}", "{localPort}"] } };
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  expect(await api.ensurePairUnit(f.pair, "connect", ports)).toEqual({ status: "ready" });
  expect(readFileSync(f.file, "utf8")).toContain('"2222" "23223"');
  expect(await f.registry.get("pair-1")).toMatchObject({ unit: { localPort: 23223 } });
}, 5000);

it("does not substitute a missing SSH listener port into a unit", async () => {
  const f = await fixture(), api = await import("../intercom-pair-resources");
  const { sshPort: _sshPort, ...recipe } = f.ports.recipe;
  await f.registry.bindResources("pair-1", "enroll-1", api.pairResources(f.pair, "core-b"));
  await expect(api.ensurePairUnit(f.pair, "host", { ...f.ports, recipe: { ...recipe, host: [...recipe.host, "{sshPort}"] } })).rejects.toThrow("intercom-connector-recipe-invalid");
  expect(f.calls).toEqual([]); expect(existsSync(f.file)).toBe(false);
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
