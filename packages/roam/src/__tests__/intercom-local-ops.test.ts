import { paths } from "@spider/db-core";
import { main as setupCli } from "../cli";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IntercomEnrollmentPair, IntercomEnrollmentPlan } from "../provision-contracts";
import { systemSshFixture } from "./intercom-ssh-system-fixture";
const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function fixture() {
  const root = mkdtempSync(join(paths.scratch("worktree", process.cwd()), "local-pair-")); roots.push(root);
  const sourceRoot = join(root, "source"), targetRoot = join(root, "target"), home = join(root, "home");
  for (const dir of [sourceRoot, targetRoot, home]) mkdirSync(dir, { mode: 0o700 });
  const peer = (machineId: string, alias: string, globalRoot: string) => ({ machineId, alias, node: "/fixture/node", pi: "/fixture/pi", cli: "/fixture/cli", core: "/fixture/hc", globalRoot });
  const plan: IntercomEnrollmentPlan = { pairId: "pair-1", edgeEpoch: "edge-1", source: peer(A, "box-1.invalid", sourceRoot), target: peer(B, "box-2.invalid", targetRoot),
    connector: { tunnelId: "tunnel", remotePort: 22, session: "default" } };
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  const pair: IntercomEnrollmentPair = { ...plan, sshUser: "fixture", hostKey: { type: "ssh-ed25519", base64: blob.toString("base64") }, hostKeyAlias: `spider-${"a".repeat(32)}` };
  const proof = { approved: true as const, actor: "fixture", at: 1000, operationId: "approval-1", graphDigest: createHash("sha256").update(JSON.stringify([plan])).digest("hex"), pairs: [plan] };
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => { calls.push([...argv]); if (argv[0] === "/fixture/keygen") {
    const file = argv[argv.indexOf("-f") + 1]; writeFileSync(file, "private-fixture", { mode: 0o600 }); writeFileSync(`${file}.pub`, `${pair.hostKey.type} ${pair.hostKey.base64}\n`, { mode: 0o644 });
  } return { code: 0, stdout: "" }; };
  const recipe = { check: ["/fixture/connector", "check"], host: ["/fixture/connector", "host"], connect: ["/fixture/connector", "connect"], localPort: 23222 };
  const systemSshFiles = systemSshFixture(root, [pair.hostKey]).filesystem;
  const ports = { machineId: A, root: sourceRoot, home, node: process.execPath, ssh: "/fixture/ssh", keygen: "/fixture/keygen", recipe, run, systemSshFiles };
  return { root, sourceRoot, targetRoot, home, pair, plan, proof, calls, ports };
}
async function registerFixture(f: ReturnType<typeof fixture>) {
  const { createIntercomRegistry } = await import("../intercom-registry");
  for (const root of [f.sourceRoot, f.targetRoot]) await createIntercomRegistry(root).register(f.plan, f.proof.operationId, f.proof.graphDigest);
}
async function api() { return await import("../intercom-local-ops").catch(() => ({})) as typeof import("../intercom-local-ops"); }

it("the private CLI refuses credential setup until pair-scoped connector support exists", async () => {
  const f = fixture(), directory = join(f.sourceRoot, "roam"); mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "config.json"), JSON.stringify({ role: "hub", machineId: A, hubMachineId: A, coreUnit: "fixture.service" }), { mode: 0o600 });
  writeFileSync(join(directory, "machine.json"), JSON.stringify({ machineId: A }), { mode: 0o600 });
  const { main } = await import("../cli"); let out = "", err = "";
  const code = await main(["--global-root", f.sourceRoot, "roam", "intercom", "setup-local"], { out: text => { out += text; }, err: text => { err += text; } },
    { stdin: Buffer.from(JSON.stringify({ action: "ensure-key", pair: f.pair, approval: f.proof })), pairPorts: f.ports } as any);
  expect(code).toBe(0); expect(err).toBe("");
  expect(JSON.parse(out)).toMatchObject({ version: 1, kind: "intercom-setup", ok: false, reason: "connector-not-pair-scoped" });
  expect(f.calls).toHaveLength(0);
}, 5000);

it("retains a redacted underlying cause in setup JSON and diagnostics", async () => {
  const f = fixture(), directory = join(f.sourceRoot, "roam"); mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "config.json"), JSON.stringify({ role: "hub", machineId: A, hubMachineId: A, coreUnit: "fixture.service" }), { mode: 0o600 });
  writeFileSync(join(directory, "machine.json"), JSON.stringify({ machineId: A }), { mode: 0o600 });
  const failure = Object.assign(new Error(`EEXIST: file already exists, open '${f.sourceRoot}/private key'; token=secret-value Authorization: Bearer secret-bearer https://private.invalid/key`), { code: "EEXIST" });
  let out = "", diagnostics = "";
  expect(await setupCli(["--global-root", f.sourceRoot, "roam", "intercom", "setup-local"], { out: text => { out += text; }, err: text => { diagnostics += text; } }, {
    stdin: Buffer.from(JSON.stringify({ action: "register-pair", pair: f.pair, approval: f.proof })),
    get pairPorts(): typeof f.ports { throw failure; },
  })).toBe(0);
  const reply = JSON.parse(out);
  expect(reply).toMatchObject({ ok: false, reason: "intercom-setup-pending", cause: { code: "EEXIST", message: expect.stringContaining("file already exists") } });
  expect(JSON.parse(diagnostics)).toEqual({ reason: reply.reason, cause: reply.cause });
  for (const secret of [f.sourceRoot, "private key", "secret-value", "secret-bearer", "private.invalid"]) {
    expect(out).not.toContain(secret); expect(diagnostics).not.toContain(secret);
  }
  expect(f.calls).toEqual([]);
}, 5000);

it.each([
  ["EACCES", "EACCES"], ["ERR_STREAM_DESTROYED", "ERR_STREAM_DESTROYED"], ["SQLITE_BUSY", "SQLITE_BUSY"],
  ["diagnostic-snapshot-changing", "diagnostic-snapshot-changing"], ["ghp_syntheticIdentifierShapedCredential1234", "unknown"],
  ["identifierShapedSecret", "unknown"], ["/private/fixture.key", "unknown"], ["E".repeat(65), "unknown"],
])("validates setup cause-code families at the helper boundary: %s", async (code, expected) => {
  const f = fixture(), directory = join(f.sourceRoot, "roam"); mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "config.json"), JSON.stringify({ role: "hub", machineId: A, hubMachineId: A, coreUnit: "fixture.service" }), { mode: 0o600 });
  writeFileSync(join(directory, "machine.json"), JSON.stringify({ machineId: A }), { mode: 0o600 });
  let out = "", diagnostics = "";
  expect(await setupCli(["--global-root", f.sourceRoot, "roam", "intercom", "setup-local"], { out: text => { out += text; }, err: text => { diagnostics += text; } }, {
    stdin: Buffer.from(JSON.stringify({ action: "register-pair", pair: f.pair, approval: f.proof })),
    get pairPorts(): typeof f.ports { throw Object.assign(new Error("setup failed"), { code }); },
  })).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ ok: false, cause: { code: expected } });
  expect(JSON.parse(diagnostics)).toMatchObject({ cause: { code: expected } });
  expect(f.calls).toEqual([]);
}, 5000);

it("reads a machine-bound authoritative fence without running setup", async () => {
  const f = fixture(), directory = join(f.sourceRoot, "roam"); mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "config.json"), JSON.stringify({ role: "hub", machineId: A, hubMachineId: A, coreUnit: "fixture.service" }), { mode: 0o600 });
  writeFileSync(join(directory, "machine.json"), JSON.stringify({ machineId: A }), { mode: 0o600 });
  const { main } = await import("../cli"); let out = "", calls = 0;
  const options = { stdin: Buffer.from(JSON.stringify({ version: 1, action: "inspect-fence", machineId: A, peer: B })),
    fencePort: async (_root: string, input: unknown) => { calls++; return { machineId: A, peer: B, fence: null }; } };
  expect(await main(["--global-root", f.sourceRoot, "roam", "intercom", "observe-fence"], { out: text => { out += text; }, err: () => {} }, options as any)).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ version: 1, kind: "intercom-fence", ok: true, value: { machineId: A, peer: B, fence: null } });
  expect(calls).toBe(1); expect(f.calls).toHaveLength(0);
}, 5000);

it("does not run setup effects without an exact separately approved graph", async () => {
  const f = fixture(), mod = await api(); expect(mod.runLocalPairOperation).toBeTypeOf("function");
  const bad = { ...f.proof, graphDigest: "a".repeat(64) };
  await expect(mod.runLocalPairOperation({ action: "ensure-key", pair: f.pair, approval: bad }, f.ports)).rejects.toThrow("peer-consent-required");
  expect(f.calls).toEqual([]); expect(existsSync(join(f.sourceRoot, "roam"))).toBe(false);
}, 5000);

it("checks local UUIDs and creates the source key and strictly pinned route using fixture paths", async () => {
  const f = fixture(), mod = await api(); expect(mod.runLocalPairOperation).toBeTypeOf("function");
  await registerFixture(f);
  await expect(mod.runLocalPairOperation({ action: "ensure-key", pair: f.pair, approval: f.proof }, { ...f.ports, machineId: B })).rejects.toThrow("machine-mismatch");
  const key = await mod.runLocalPairOperation({ action: "ensure-key", pair: f.pair, approval: f.proof }, f.ports);
  expect(key).toMatchObject({ publicKey: `ssh-ed25519 ${f.pair.hostKey.base64}`, privateMode: 0o600 });
  const route = await mod.runLocalPairOperation({ action: "write-route", pair: f.pair, approval: f.proof }, f.ports) as { knownHosts: string; via: string };
  expect(readFileSync(route.knownHosts, "utf8")).toContain(f.pair.hostKeyAlias); expect(existsSync(route.via)).toBe(true);
  expect(f.calls).toHaveLength(1);
}, 5000);

it("records the bound pair privately on both approved endpoints", async () => {
  const f = fixture(), mod = await api(); expect(mod.runLocalPairOperation).toBeTypeOf("function");
  const source = f.ports, target = { ...f.ports, machineId: B, root: f.targetRoot };
  expect(await mod.runLocalPairOperation({ action: "register-pair", pair: f.pair, approval: f.proof }, source)).toEqual({ registered: true });
  expect(await mod.runLocalPairOperation({ action: "register-pair", pair: f.pair, approval: f.proof }, target)).toEqual({ registered: true });
  const { createIntercomRegistry } = await import("../intercom-registry");
  expect(await createIntercomRegistry(f.sourceRoot).get("pair-1")).toMatchObject({ pair: f.pair, state: "pending" });
  expect(await createIntercomRegistry(f.targetRoot).get("pair-1")).toMatchObject({ pair: f.pair, state: "pending" });
}, 5000);

it("publishes only the approved pair route while preserving other local configuration", async () => {
  const f = fixture(), directory = join(f.sourceRoot, "roam"); mkdirSync(directory, { mode: 0o700 });
  const config = { enabled: true, role: "hub", machineId: A, hubMachineId: A, coreUnit: "fixture.service", peers: [],
    intercom: { enabled: true, mode: "peers", machineAlias: "box-1.invalid", routes: [], connector: f.ports.recipe } };
  writeFileSync(join(directory, "config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(directory, "machine.json"), JSON.stringify({ machineId: A }), { mode: 0o600 });
  const mod = await api(); await mod.runLocalPairOperation({ action: "register-pair", pair: f.pair, approval: f.proof }, f.ports);
  expect(await mod.runLocalPairOperation({ action: "publish-config", pair: f.pair, approval: f.proof }, f.ports)).toEqual({ published: true });
  const saved = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
  expect(saved.peers).toEqual([]); expect(saved.intercom.connector).toEqual(f.ports.recipe);
  expect(saved.intercom.routes).toEqual([{ kind: "direct", peer: f.pair.target, edgeEpoch: "edge-1" }]);
  expect(await mod.runLocalPairOperation({ action: "publish-config", pair: f.pair, approval: f.proof }, f.ports)).toEqual({ published: true });
}, 5000);

it("forwards the approved epoch and fence generation to the local live helper", async () => {
  const f = fixture(), mod = await api(), seen: unknown[] = [];
  await registerFixture(f);
  const ports = { ...f.ports, async enrollBridge(input: unknown) { seen.push(input); return { machineId: A, peer: B, edgeEpoch: "edge-1", applied: true }; } };
  expect(await mod.runLocalPairOperation({ action: "enroll-live", pair: f.pair, approval: f.proof, expectedFenceId: null }, ports)).toMatchObject({ applied: true });
  expect(seen).toEqual([{ version: 1, action: "enroll-pair", machineId: A, peer: B, pairId: "pair-1", edgeEpoch: "edge-1",
    operationId: f.proof.operationId, graphDigest: f.proof.graphDigest, expectedFenceId: null }]);
}, 5000);

it("does not activate a pair until the live helper observes federation", async () => {
  const f = fixture(), mod = await api(); let state = "unknown";
  const ports = { ...f.ports, async inspectBridge() { return { machineId: A, peer: B, edgeEpoch: "edge-1", status: state, reason: null }; } };
  await mod.runLocalPairOperation({ action: "register-pair", pair: f.pair, approval: f.proof }, ports);
  expect(await mod.runLocalPairOperation({ action: "verify-federation", pair: f.pair, approval: f.proof }, ports)).toMatchObject({ federation: false });
  await expect(mod.runLocalPairOperation({ action: "activate-pair", pair: f.pair, approval: f.proof }, ports)).rejects.toThrow("intercom-verification-pending");
  const { createIntercomRegistry } = await import("../intercom-registry"), registry = createIntercomRegistry(f.sourceRoot);
  expect(await registry.get("pair-1")).toMatchObject({ state: "pending" });
  state = "live";
  expect(await mod.runLocalPairOperation({ action: "verify-federation", pair: f.pair, approval: f.proof }, ports)).toMatchObject({ federation: true });
  expect(await mod.runLocalPairOperation({ action: "activate-pair", pair: f.pair, approval: f.proof }, ports)).toEqual({ active: true });
  expect(await registry.get("pair-1")).toMatchObject({ state: "active" });
}, 5000);

it("removes a pair key only after the local authoritative fence exists", async () => {
  const f = fixture(), mod = await api(), token = "00000000-0000-4000-8000-000000000009";
  const source = f.ports, target = { ...f.ports, machineId: B, root: f.targetRoot, home: f.home };
  await mod.runLocalPairOperation({ action: "register-pair", pair: f.pair, approval: f.proof }, source);
  await mod.runLocalPairOperation({ action: "register-pair", pair: f.pair, approval: f.proof }, target);
  const key = await mod.runLocalPairOperation({ action: "ensure-key", pair: f.pair, approval: f.proof }, source) as { publicKey: string };
  await mod.runLocalPairOperation({ action: "authorize", pair: f.pair, approval: f.proof, publicKey: key.publicKey }, target);
  const { createIntercomRegistry } = await import("../intercom-registry");
  const { pairResources, ensurePairUnit } = await import("../intercom-pair-resources");
  await createIntercomRegistry(f.sourceRoot).bindResources("pair-1", f.proof.operationId, pairResources(f.pair, "core-target"));
  await createIntercomRegistry(f.targetRoot).bindResources("pair-1", f.proof.operationId, pairResources(f.pair, "core-target"));
  let hostActive = false;
  const unitName = "spider-pair-pair-1-host.service", unitFile = join(f.home, ".config", "systemd", "user", unitName);
  const hostPorts = { ...target, systemctl: "/fixture/systemctl", recipe: { ...target.recipe, host: ["/fixture/connector", "host", "{pairId}"], connect: ["/fixture/connector", "connect", "{pairId}"] },
    process: () => hostActive ? { kind: "live" as const, startIdentity: "linux:123" } : { kind: "absent" as const }, cgroup: () => hostActive ? [123] : [],
    async run(argv: readonly string[]) {
      if (argv[2] === "start") hostActive = true; if (argv[2] === "stop") hostActive = false;
      return { code: 0, stdout: argv[2] === "show" ? `Id=${unitName}\nActiveState=${hostActive ? "active" : "inactive"}\nMainPID=${hostActive ? 123 : 0}\nControlGroup=/user.slice/${unitName}\nKillMode=control-group\nFragmentPath=${unitFile}\nDropInPaths=\nNeedDaemonReload=no\n` : "" };
    } };
  await ensurePairUnit(f.pair, "host", hostPorts);
  await createIntercomRegistry(f.sourceRoot).beginRevocation("pair-1", token);
  await createIntercomRegistry(f.targetRoot).beginRevocation("pair-1", token);
  const fence = async () => ({ machineId: A, peer: B, fence: { edgeEpoch: "edge-1", fenceId: token } });
  const sourceCleanup = { ...source, inspectFence: fence }, targetCleanup = { ...hostPorts, inspectFence: async () => ({ machineId: B, peer: A, fence: { edgeEpoch: "edge-1", fenceId: token } }) };
  expect(await mod.runLocalPairCleanup({ action: "read-public", pairId: "pair-1", fenceId: token }, sourceCleanup)).toEqual({ publicKey: key.publicKey });
  writeFileSync(join(f.sourceRoot, "roam", "config.json"), JSON.stringify({ role: "hub", machineId: A, hubMachineId: A, coreUnit: "fixture.service" }), { mode: 0o600 });
  writeFileSync(join(f.sourceRoot, "roam", "machine.json"), JSON.stringify({ machineId: A }), { mode: 0o600 });
  const { main } = await import("../cli"); let out = "";
  expect(await main(["--global-root", f.sourceRoot, "roam", "intercom", "cleanup-local"], { out: text => { out += text; }, err: () => {} },
    { stdin: Buffer.from(JSON.stringify({ action: "read-public", pairId: "pair-1", fenceId: token })), pairPorts: sourceCleanup })).toBe(0);
  expect(JSON.parse(out)).toMatchObject({ kind: "intercom-cleanup", ok: true, machineId: A, value: { publicKey: key.publicKey } });
  await expect(mod.runLocalPairCleanup({ action: "remove-authorized", pairId: "pair-1", fenceId: "00000000-0000-4000-8000-000000000010", publicKey: key.publicKey }, targetCleanup)).rejects.toThrow();
  expect(readFileSync(join(f.home, ".ssh", "authorized_keys"), "utf8")).toContain("spider-intercom:pair-1");
  expect(await mod.runLocalPairCleanup({ action: "remove-authorized", pairId: "pair-1", fenceId: token, publicKey: key.publicKey }, targetCleanup)).toEqual({ removed: true });
  expect(readFileSync(join(f.home, ".ssh", "authorized_keys"), "utf8")).not.toContain("spider-intercom:pair-1");
}, 5000);

it("checks the connector but refuses unscoped host and connect commands", async () => {
  const f = fixture(), mod = await api(); expect(mod.runLocalPairOperation).toBeTypeOf("function");
  await registerFixture(f);
  const runner = async (argv: readonly string[]) => { f.calls.push([...argv]); return { code: 0, stdout: JSON.stringify({ connector: "ready", login: "ready", tunnel: "hosted", peerPort: "reachable" }) }; };
  const source = { ...f.ports, run: runner }, target = { ...source, machineId: B, root: f.targetRoot };
  expect(await mod.runLocalPairOperation({ action: "check-connector", pair: f.plan, approval: f.proof }, source)).toEqual({ status: "ready" });
  expect(await mod.runLocalPairOperation({ action: "host-connector", pair: f.plan, approval: f.proof }, target)).toEqual({ status: "connector-not-pair-scoped" });
  expect(await mod.runLocalPairOperation({ action: "connect-connector", pair: f.plan, approval: f.proof }, source)).toEqual({ status: "connector-not-pair-scoped" });
  await expect(mod.runLocalPairOperation({ action: "host-connector", pair: f.plan, approval: f.proof }, source)).rejects.toThrow("machine-mismatch");
  expect(f.calls).toEqual([["/fixture/connector", "check"]]);
}, 5000);

it("adds only the pair-owned hc alias with argv and refuses an alias bound to another core", async () => {
  const f = fixture(), mod = await api(); expect(mod.runLocalPairOperation).toBeTypeOf("function");
  await registerFixture(f);
  await mod.runLocalPairOperation({ action: "ensure-key", pair: f.pair, approval: f.proof }, f.ports);
  const files = await mod.runLocalPairOperation({ action: "write-route", pair: f.pair, approval: f.proof }, f.ports) as { via: string };
  let machines: Array<{ name: string; id: string; via: boolean; target: string; session: string; temporary: boolean }> = [];
  const run = async (argv: readonly string[]) => { f.calls.push([...argv]);
    if (argv[1] === "machine" && argv[2] === "ls") return { code: 0, stdout: JSON.stringify({ machines }) };
    if (argv[1] === "machine" && argv[2] === "add") { machines = [{ name: "spider-pair-pair-1", id: "core-target", via: true, target: files.via, session: "default", temporary: false }]; return { code: 0, stdout: "{}" }; }
    if (argv[1] === "exec") return { code: 0, stdout: JSON.stringify({ version: 1, kind: "doctor", machineId: B, value: {} }) };
    throw new Error("unexpected command");
  };
  const source = { ...f.ports, run };
  const operation = { action: "add-machine" as const, pair: f.pair, approval: f.proof, targetCoreId: "core-target" };
  expect(await mod.runLocalPairOperation(operation, source)).toEqual({ added: true });
  expect(await mod.runLocalPairOperation(operation, source)).toEqual({ added: false });
  expect(await mod.runLocalPairOperation({ ...operation, action: "verify-transport" }, source)).toEqual({ sourceMachineId: A, targetMachineId: B, connector: true, key: true, route: true });
  const verify = f.calls.find(argv => argv[1] === "exec")!;
  expect(verify).toContain("spider-pair-pair-1"); expect(verify).toContain("--global-root"); expect(verify).toContain(f.targetRoot);
  const added = f.calls.filter(argv => argv[1] === "machine" && argv[2] === "add");
  expect(added).toEqual([["/fixture/hc", "machine", "add", "--via", join(f.sourceRoot, "roam", "intercom", "pairs", "pair-1", "edge-1", "via"),
    "--name", "spider-pair-pair-1", "--session", "default", "--json"]]);
  machines = [{ name: "spider-pair-pair-1", id: "wrong-core", via: true, target: files.via, session: "default", temporary: false }];
  await expect(mod.runLocalPairOperation(operation, source)).rejects.toThrow("intercom-alias-conflict");
  expect(f.calls.filter(argv => argv[2] === "add")).toHaveLength(1);
}, 5000);

it("scans the port in the approved pair rather than the machine recipe", async () => {
  const f = fixture(), mod = await api();
  const target = { ...f.ports, machineId: B, root: f.targetRoot, sshUser: "fixture", keyscan: "/fixture/ssh-keyscan",
    async run(argv: readonly string[]) {
      f.calls.push([...argv]);
      if (JSON.stringify(argv) !== JSON.stringify(["/fixture/ssh-keyscan", "-T", "5", "-t", "ed25519,ecdsa,rsa", "-p", "22", "127.0.0.1"])) throw new Error("wrong port");
      return { code: 0, stdout: `127.0.0.1 ${f.pair.hostKey.type} ${f.pair.hostKey.base64}\n` };
    } };
  expect(await mod.runLocalPairOperation({ action: "inspect-ssh", pair: f.plan, approval: f.proof }, target)).toMatchObject({ hostKeys: [f.pair.hostKey] });
  expect(f.calls[0]).toContain("22");
}, 5000);

it("reads the served SSH host key and account on the exact approved target", async () => {
  const f = fixture(), mod = await api(); expect(mod.runLocalPairOperation).toBeTypeOf("function");
  const expected = ["/fixture/ssh-keyscan", "-T", "5", "-t", "ed25519,ecdsa,rsa", "-p", "22", "127.0.0.1"];
  const target = { ...f.ports, machineId: B, root: f.targetRoot, sshUser: "fixture", keyscan: "/fixture/ssh-keyscan",
    async run(argv: readonly string[]) { f.calls.push([...argv]); if (JSON.stringify(argv) !== JSON.stringify(expected)) throw new Error("unexpected fixture command"); return { code: 0, stdout: `127.0.0.1 ${f.pair.hostKey.type} ${f.pair.hostKey.base64}\n` }; } };
  expect(await mod.runLocalPairOperation({ action: "inspect-ssh", pair: f.plan, approval: f.proof }, target)).toEqual({
    targetMachineId: B, sshUser: "fixture", hostKeys: [f.pair.hostKey],
  });
  expect(f.calls).toEqual([expected]);
}, 5000);

it("rejects an invalid approved SSH port without scanning", async () => {
  const f = fixture(), mod = await api();
  const pair = { ...f.plan, connector: { ...f.plan.connector, remotePort: 0 } };
  const approval = { ...f.proof, pairs: [pair], graphDigest: createHash("sha256").update(JSON.stringify([pair])).digest("hex") };
  const target = { ...f.ports, machineId: B, root: f.targetRoot, sshUser: "fixture", keyscan: "/fixture/ssh-keyscan" };
  await expect(mod.runLocalPairOperation({ action: "inspect-ssh", pair, approval }, target)).rejects.toThrow("intercom-ssh-host-unavailable");
  expect(f.calls).toEqual([]);
}, 5000);

it("authorizes the target key only on the exact approved target", async () => {
  const f = fixture(), mod = await api(); expect(mod.runLocalPairOperation).toBeTypeOf("function");
  await registerFixture(f);
  const target = { ...f.ports, machineId: B, root: f.targetRoot };
  const pub = `ssh-ed25519 ${f.pair.hostKey.base64}`;
  await mod.runLocalPairOperation({ action: "authorize", pair: f.pair, approval: f.proof, publicKey: pub }, target);
  const line = readFileSync(join(f.home, ".ssh", "authorized_keys"), "utf8");
  expect(line).toMatch(/^from="127\.0\.0\.1",restrict,command="/);
  expect(line).toContain(`${pub} spider-intercom:pair-1\n`);
  expect(f.calls).toEqual([]);
}, 5000);
