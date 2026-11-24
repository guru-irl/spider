import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@spider/db-core";
import { parseConfig } from "../config";
import { createIntercomRegistry } from "../intercom-registry";

import { scenario, cleanupPairScenarios } from "./intercom-pair-fixture";
import { provisionIntercomEnrollment } from "../intercom-enrollment";
import { safeCauseCode } from "../cause-codes";

const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const roots: string[] = []; afterEach(() => { cleanupPairScenarios(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
it.each([
  { side: "connect" as const, state: "pending" }, { side: "host" as const, state: "pending" },
  { side: "connect" as const, state: "active" }, { side: "host" as const, state: "active" },
])("doctor names the missing $state $side unit and its hub repair", async ({ side, state }) => {
  const f = await scenario();
  const enrollment = state === "pending" ? { ...f.enrollment, connect: async (...args: Parameters<typeof f.enrollment.connect>) => {
    await f.enrollment.connect(...args); return "peer-port-unreachable" as const;
  } } : f.enrollment;
  expect((await provisionIntercomEnrollment(f.request, enrollment)).code).toBe(state === "pending" ? 3 : 0);
  const local = side === "connect" ? f.source : f.target, ports = f.locals.get(local.machineId)!;
  const row = (await createIntercomRegistry(local.globalRoot).get("pair-1"))!; unlinkSync(row.unit!.file);
  const config = parseConfig(JSON.parse(readFileSync(join(local.globalRoot, "roam", "config.json"), "utf8")));
  const { inspectLocalIntercomDoctor } = await import("../intercom-doctor");
  const diagnostics = await inspectLocalIntercomDoctor({ root: local.globalRoot, config, agentDir: ports.home, resourcePorts: ports, run: ports.run,
    features: async () => [], inspectSsh: async () => ({ targetMachineId: local.machineId, sshUser: "fixture", hostKeys: [] }),
    link: async () => ({ status: "down", reason: "link-down" }) });
  expect(diagnostics).toContainEqual({ severity: "block", reason: `intercom-pair-unit-missing: The ${side} unit for pair-1 is missing. Run the repair on the hub.`,
    repairCommand: state === "pending" ? 'spider roam intercom enroll --graph "$GRAPH_FILE" --operation enroll-1' : "spider roam intercom revoke pair-1" });
  expect(diagnostics.some(item => item.reason.startsWith("intercom-pair-unit-unavailable"))).toBe(false);
  expect(safeCauseCode("intercom-pair-unit-missing")).toBe("intercom-pair-unit-missing");
  expect(safeCauseCode("intercom-pair-unit-missing: private detail")).toBeUndefined();
  expect(row.state).toBe(state);
}, 5000);

it("reports connector, host-key, legacy extension, broker feature and link issues without repair", async () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "icdoctor-")); roots.push(root);
  const agentDir = join(root, "agent"); mkdirSync(agentDir, { mode: 0o700 });
  const settings = join(agentDir, "settings.json"), before = '{"packages":["npm:pi-intercom"],"extensions":[]}'; writeFileSync(settings, before, { mode: 0o600 });
  const peer = (machineId: string, alias: string, globalRoot: string) => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot });
  const blob = (n: number) => Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, n)]).toString("base64");
  const pair = { pairId: "pair-1", source: peer(A, "box-a.invalid", "/fixture/source"), target: peer(B, "box-b.invalid", root), edgeEpoch: "edge-1",
    connector: { tunnelId: "tunnel", remotePort: 22, session: "default" }, sshUser: "fixture", hostKey: { type: "ssh-ed25519", base64: blob(7) }, hostKeyAlias: `spider-${"a".repeat(32)}` };
  const registry = createIntercomRegistry(root); await registry.register(pair, "approval-1", "a".repeat(64)); await registry.bind(pair, "approval-1"); await registry.activate("pair-1", "approval-1");
  const recipe = { check: ["/fixture/connector", "check"], host: ["/fixture/connector", "host"], connect: ["/fixture/connector", "connect"], localPort: 2222 };
  const config = parseConfig({ enabled: true, role: "box", machineId: B, hubMachineId: A, coreUnit: "fixture.service",
    intercom: { enabled: true, mode: "peers", machineAlias: "box-b.invalid", connector: recipe } });
  const calls: string[][] = [], { inspectLocalIntercomDoctor } = await import("../intercom-doctor");
  const diagnostics = await inspectLocalIntercomDoctor({ root, config, agentDir,
    async run(argv) { calls.push([...argv]); return { code: 0, stdout: JSON.stringify({ connector: "ready", login: "required", tunnel: "unhosted", peerPort: "unreachable" }) }; },
    async inspectSsh() { return { targetMachineId: B, sshUser: "fixture", hostKeys: [{ type: "ssh-ed25519", base64: blob(8) }] }; },
    async features() { return ["intercom-exchange-v1"]; }, async link() { return { status: "down", reason: "link-down" }; },
  });
  for (const reason of ["intercom-connector-sign-in-required", "intercom-tunnel-unhosted", "intercom-peer-port-unreachable", "host-key-changed", "intercom-extension-duplicate", "intercom-feature-missing", "intercom-link-down"]) {
    expect(diagnostics.some(item => item.reason.includes(reason)), reason).toBe(true);
  }
  expect(calls).toEqual([["/fixture/connector", "check"]]); expect(readFileSync(settings, "utf8")).toBe(before);
  mkdirSync(join(root, "roam"), { recursive: true, mode: 0o700 }); writeFileSync(join(root, "roam", "config.json"), JSON.stringify(config), { mode: 0o600 });
  const { runLocalDoctor } = await import("../local-diagnostics"); let explicit = 0;
  const inspector = async () => { explicit++; return diagnostics; };
  await runLocalDoctor({ root, intercomDoctor: inspector }); expect(explicit).toBe(0);
  const report = await runLocalDoctor({ root, inspectIntercomDoctor: true, intercomDoctor: inspector });
  expect(explicit).toBe(1); expect(report.diagnostics.some(item => item.reason.includes("host-key-changed"))).toBe(true);
}, 5000);

it("checks a connector without a separate SSH listener port", async () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "icport-")); roots.push(root);
  const recipe = { check: ["/fixture/connector", "check"], host: ["/fixture/connector", "host"], connect: ["/fixture/connector", "connect"], localPort: 23222 };
  const config = parseConfig({ role: "box", machineId: B, hubMachineId: A, coreUnit: "fixture.service", intercom: { enabled: true, mode: "peers", machineAlias: "box-1.invalid", connector: recipe } });
  const { inspectLocalIntercomDoctor } = await import("../intercom-doctor");
  const diagnostics = await inspectLocalIntercomDoctor({ root, config, agentDir: root,
    async run(argv) { if (argv[0] !== "/fixture/connector") throw new Error("unexpected fixture command"); return { code: 0, stdout: JSON.stringify({ connector: "ready", login: "ready", tunnel: "hosted", peerPort: "reachable" }) }; },
    async features() { return []; } });
  expect(diagnostics.some(item => item.reason.startsWith("intercom-ssh-port-missing"))).toBe(false);
  expect(diagnostics.some(item => item.reason.startsWith("intercom-connector-check-invalid"))).toBe(false);
}, 5000);

it("uses the approved target port for host-key doctor checks", async () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "icport-pair-")); roots.push(root);
  const { userInfo } = await import("node:os");
  const peer = (machineId: string, alias: string) => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: root });
  const blob = (n: number) => Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, n)]).toString("base64");
  const pair = { pairId: "pair-1", source: peer(A, "box-1.invalid"), target: peer(B, "box-2.invalid"), edgeEpoch: "edge-1",
    connector: { tunnelId: "tunnel", remotePort: 22, session: "default" }, sshUser: userInfo().username, hostKey: { type: "ssh-ed25519", base64: blob(7) }, hostKeyAlias: `spider-${"a".repeat(32)}` };
  const registry = createIntercomRegistry(root); await registry.register(pair, "approval-1", "a".repeat(64)); await registry.bind(pair, "approval-1"); await registry.activate("pair-1", "approval-1");
  const recipe = { check: ["/fixture/connector", "check"], host: ["/fixture/connector", "host"], connect: ["/fixture/connector", "connect"], localPort: 23222 };
  const config = (connector: typeof recipe) => parseConfig({ role: "box", machineId: B, hubMachineId: A, coreUnit: "fixture.service", intercom: { enabled: true, mode: "peers", machineAlias: "box-2.invalid", connector } });
  const calls: string[][] = [], { inspectLocalIntercomDoctor } = await import("../intercom-doctor");
  const run = async (argv: readonly string[]) => { calls.push([...argv]);
    if (JSON.stringify(argv) === JSON.stringify(["/fixture/connector", "check"])) return { code: 0, stdout: JSON.stringify({ connector: "ready", login: "ready", tunnel: "hosted", peerPort: "reachable" }) };
    if (JSON.stringify(argv) === JSON.stringify(["/usr/bin/ssh-keyscan", "-T", "5", "-t", "ed25519", "-p", "22", "127.0.0.1"])) return { code: 0, stdout: `127.0.0.1 ssh-ed25519 ${blob(8)}\n` };
    throw new Error("unexpected fixture command");
  };
  const common = { root, agentDir: root, run, async features() { return []; }, async link() { return { status: "live", reason: null }; } };
  const observed = await inspectLocalIntercomDoctor({ ...common, config: config({ ...recipe }) });
  expect(observed.some(item => item.reason.startsWith("host-key-changed"))).toBe(true);
  expect(observed.some(item => item.reason.startsWith("intercom-ssh-port-missing"))).toBe(false);
  expect(calls).toContainEqual(["/usr/bin/ssh-keyscan", "-T", "5", "-t", "ed25519", "-p", "22", "127.0.0.1"]);
  calls.length = 0;
  const missing = await inspectLocalIntercomDoctor({ ...common, config: config(recipe) });
  expect(missing.some(item => item.reason.startsWith("intercom-ssh-port-missing"))).toBe(false);
  expect(missing.some(item => item.reason.startsWith("intercom-ssh-host-unavailable"))).toBe(false);
  expect(calls).toContainEqual(["/usr/bin/ssh-keyscan", "-T", "5", "-t", "ed25519", "-p", "22", "127.0.0.1"]);
}, 5000);

it("checks a pinned RSA key without selecting a newly available preferred key", async () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "icdoctor-rsa-")); roots.push(root);
  const { userInfo } = await import("node:os");
  const peer = (machineId: string, alias: string) => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: root });
  const field = (value: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(value.length); return Buffer.concat([length, value]); };
  const base64 = Buffer.concat([field(Buffer.from("ssh-rsa")), field(Buffer.from([1, 0, 1])), field(Buffer.concat([Buffer.from([0]), Buffer.alloc(256, 0x81)]))]).toString("base64");
  const pair = { pairId: "pair-1", source: peer(A, "box-1.invalid"), target: peer(B, "box-2.invalid"), edgeEpoch: "edge-1",
    connector: { tunnelId: "tunnel", remotePort: 22, session: "default" }, sshUser: userInfo().username, hostKey: { type: "ssh-rsa", base64 }, hostKeyAlias: `spider-${"a".repeat(32)}` };
  const registry = createIntercomRegistry(root); await registry.register(pair, "approval-1", "a".repeat(64)); await registry.bind(pair, "approval-1"); await registry.activate("pair-1", "approval-1");
  const config = parseConfig({ role: "box", machineId: B, hubMachineId: A, coreUnit: "fixture.service", intercom: { enabled: true, mode: "peers", machineAlias: "box-2.invalid" } });
  const calls: string[][] = [], { inspectLocalIntercomDoctor } = await import("../intercom-doctor");
  const ed = Buffer.concat([field(Buffer.from("ssh-ed25519")), field(Buffer.alloc(32, 7))]).toString("base64");
  const diagnostics = await inspectLocalIntercomDoctor({ root, config, agentDir: root,
    async run(argv) { calls.push([...argv]); if (argv[0] !== "/usr/bin/ssh-keyscan") throw new Error("unexpected command");
      return { code: 0, stdout: `${argv[4] === "rsa" ? "" : `127.0.0.1 ssh-ed25519 ${ed}\n`}127.0.0.1 ssh-rsa ${base64}\n` }; },
    async features() { return []; }, async link() { return { status: "live", reason: null }; } });
  expect(calls).toEqual([["/usr/bin/ssh-keyscan", "-T", "5", "-t", "rsa", "-p", "22", "127.0.0.1"]]);
  expect(diagnostics.some(item => item.reason.startsWith("host-key-changed"))).toBe(false);
  expect(diagnostics.some(item => item.reason.startsWith("intercom-ssh-host-unavailable"))).toBe(false);
}, 5000);

it("shares one single-type scan across pairs and reports ports it did not check", async () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "icdoctor-shared-")); roots.push(root);
  const { userInfo } = await import("node:os");
  const peer = (machineId: string, alias: string) => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot: root });
  const base64 = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]).toString("base64");
  const registry = createIntercomRegistry(root);
  for (let i = 1; i <= 7; i++) {
    const pair = { pairId: `pair-${i}`, source: peer(A, "box-1.invalid"), target: peer(B, "box-2.invalid"), edgeEpoch: `edge-${i}`,
      connector: { tunnelId: `tunnel-${i}`, remotePort: i === 7 ? 2223 : 22, session: "default" }, sshUser: userInfo().username,
      hostKey: { type: "ssh-ed25519", base64 }, hostKeyAlias: `spider-${"a".repeat(32)}` };
    await registry.register(pair, `approval-${i}`, "a".repeat(64)); await registry.bind(pair, `approval-${i}`); await registry.activate(pair.pairId, `approval-${i}`);
  }
  const recipe = { check: ["/fixture/connector", "check"], host: ["/fixture/connector", "host"], connect: ["/fixture/connector", "connect"], localPort: 23222 };
  const config = parseConfig({ role: "box", machineId: B, hubMachineId: A, coreUnit: "fixture.service", intercom: { enabled: true, mode: "peers", machineAlias: "box-2.invalid", connector: recipe } });
  const calls: string[][] = [], { inspectLocalIntercomDoctor } = await import("../intercom-doctor");
  const diagnostics = await inspectLocalIntercomDoctor({ root, config, agentDir: root,
    async run(argv) { calls.push([...argv]); if (argv[0] === "/fixture/connector") return { code: 0, stdout: JSON.stringify({ connector: "ready", login: "ready", tunnel: "hosted", peerPort: "reachable" }) };
      if (argv[0] === "/usr/bin/ssh-keyscan") return { code: 0, stdout: `127.0.0.1 ssh-ed25519 ${base64}\n` }; throw new Error("unexpected command"); },
    async features() { return []; }, async link() { return { status: "live", reason: null }; } });
  expect(calls.filter(argv => argv[0] === "/usr/bin/ssh-keyscan")).toEqual([["/usr/bin/ssh-keyscan", "-T", "5", "-t", "ed25519", "-p", "22", "127.0.0.1"]]);
  expect(diagnostics.some(item => item.reason.startsWith("host-key-changed"))).toBe(false);
  expect(diagnostics.some(item => item.reason.startsWith("intercom-ssh-host-unavailable"))).toBe(false);
  expect(diagnostics.some(item => item.reason.startsWith("intercom-ssh-check-deferred") && item.reason.includes("pair-7"))).toBe(true);
}, 10000);

it("reports failed positive intercom evidence during box preflight even while roaming is disabled", async () => {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "icpreflight-")); roots.push(root);
  mkdirSync(join(root, "roam"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "roam", "config.json"), JSON.stringify({ enabled: false, role: "box", machineId: B, hubMachineId: A,
    coreUnit: "fixture.service" }), { mode: 0o600 });
  const { runLocalDoctor } = await import("../local-diagnostics");
  let calls = 0;
  const input = { root, inspectIntercomDoctor: true, async intercomReadiness() {
    calls++;
    return { intercomUnique: true, legacyDrained: false, federation: true,
      intercomEvidence: { settings: "settings-unique", legacy: "legacy-pending-asks", federation: "federation-v1", otherExtensions: [] } };
  } };
  const report = await runLocalDoctor(input);
  expect(calls).toBe(1);
  expect(report.diagnostics).toContainEqual(expect.objectContaining({ severity: "block", reason: expect.stringContaining("intercom-legacy-drained: legacy-pending-asks") }));
}, 5000);
