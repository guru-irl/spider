import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getProvisionRemoteScript } from "../provision-remote-script";
import { DatabaseSync } from "node:sqlite";

it("keeps the provisioning launch within Linux's single-argument limit", () => {
  expect(Buffer.byteLength(getProvisionRemoteScript()) + 1).toBeLessThanOrEqual(128 * 1024);
});

// Disabled 2026-11-25: flaky in CI (compiler child exited with null status).
it.skip("loads provisioning definitions without runtime compiler warnings", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
import { createServer } from 'vite';
const server = await createServer({ configFile: false, logLevel: 'silent', server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true } });
try { await server.ssrLoadModule('/packages/roam/src/provision-remote-script.ts'); }
finally { await server.close(); }
`], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" }, timeout: 5000 });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stderr).toBe("");
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = resolve(".spider/scratch/provision-core-pin"); mkdirSync(base, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(base, "f-")); roots.push(home);
  const root = join(home, "global"), configHome = join(home, "config"), stateHome = join(home, "state"), core = join(home, "hc");
  for (const dir of [root, join(root, "roam"), join(configHome, "herdr-core"), stateHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const machineId = "00000000-0000-4000-8000-000000000001", hubMachineId = "00000000-0000-4000-8000-000000000002";
  writeFileSync(join(root, "roam/machine.json"), JSON.stringify({ machineId }), { mode: 0o600 });
  writeFileSync(core, `#!${process.execPath}\nconsole.log(JSON.stringify({core:{id:'fixture-core'},pid:4321,version:'0.1.16'}));\n`, { mode: 0o700 });
  const request = { action: "enrollment", operationId: "pin-enrollment", machineId, hubMachineId, home, globalRoot: root,
    agentDir: join(home, "agent"), npmPrefix: join(home, "prefix"), core, coreId: "fixture-core",
    coreUnit: "fixture.service", maximum: 1024 * 1024, chunkBytes: 1024 };
  const run = (socket: string | null, operationId = request.operationId, inherited: NodeJS.ProcessEnv = {}, extra: Record<string, unknown> = {}) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, HC_SESSION: "fixture", XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome, ...inherited };
    if (socket === null) delete env.HC_SOCKET; else env.HC_SOCKET = socket;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", getProvisionRemoteScript()], {
      env, input: JSON.stringify({ ...request, operationId, ...extra }), encoding: "utf8", timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  return { home, root, core, configHome, stateHome, run };
}

it("records the peer executable, core identity and selected startup environment", () => {
  const f = fixture(), socket = join(f.home, "core.sock");
  expect(f.run(socket)).toMatchObject({ value: "enrolled" });
  expect(JSON.parse(readFileSync(join(f.root, "roam/core.json"), "utf8"))).toEqual({ binary: f.core, coreId: "fixture-core", socket,
    sessionNamespace: "fixture", stateHome: f.stateHome, configHome: f.configHome });
  expect(f.run(socket)).toMatchObject({ value: "already-enrolled" });
});

it.each(["identity", "pid"])("does not save a pin whose sanitized settings reach a different %s", field => {
  const f = fixture(), socket = join(f.home, "core.sock");
  writeFileSync(f.core, `#!${process.execPath}
const pinned = !Object.keys(process.env).some(key => key.startsWith('HC_TERMINAL_') || key === 'HC_SCOPE');
if (process.argv.slice(2).join(' ') !== 'server status --json') process.exit(1);
console.log(JSON.stringify({core:{id:pinned && ${JSON.stringify(field)} === 'identity' ? 'other-core' : 'fixture-core'},pid:pinned && ${JSON.stringify(field)} === 'pid' ? 5678 : 4321,version:'0.1.16'}));
`, { mode: 0o700 });
  expect(f.run(socket, "mismatch-" + field, { HC_TERMINAL_ID: "fixture-terminal", HC_TERMINAL_SOCKET: socket, HC_SCOPE: "fixture" })).toMatchObject({ error: "core-changed" });
  expect(existsSync(join(f.root, "roam/core.json"))).toBe(false);
});

it("uses the terminal socket when HC_SOCKET is absent and verifies it without terminal context", () => {
  const f = fixture(), socket = join(f.home, "terminal.sock");
  writeFileSync(f.core, `#!${process.execPath}
const e = process.env;
if (process.argv.slice(2).join(' ') !== 'server status --json') process.exit(1);
const selected = e.HC_TERMINAL_SOCKET || e.HC_SOCKET;
if (selected !== ${JSON.stringify(socket)} || e.HC_SESSION !== 'fixture' || e.XDG_STATE_HOME !== ${JSON.stringify(f.stateHome)} || e.XDG_CONFIG_HOME !== ${JSON.stringify(f.configHome)}) process.exit(1);
console.log(JSON.stringify({core:{id:'fixture-core'},pid:4321,version:'0.1.16'}));
`, { mode: 0o700 });
  expect(f.run(null, "terminal-socket", { HC_TERMINAL_ID: "fixture-terminal", HC_TERMINAL_SOCKET: socket })).toMatchObject({ value: "enrolled" });
  expect(JSON.parse(readFileSync(join(f.root, "roam/core.json"), "utf8"))).toHaveProperty("socket", socket);
});

it("refuses conflicting terminal and explicit sockets before publishing a pin", () => {
  const f = fixture();
  expect(f.run(join(f.home, "core.sock"), "socket-conflict", { HC_TERMINAL_SOCKET: join(f.home, "other.sock") })).toMatchObject({ error: "core-pin-invalid" });
  expect(existsSync(join(f.root, "roam/core.json"))).toBe(false);
});

const LEGACY_UNIT = "spider-roam-supervisor.service", V0_UNIT = "spider-roam-supervisor-v0.service";
// systemctl show (unlike status) exits 0 for an absent unit and prints all four properties on Linux.
const absent = { code: 0, stdout: "Id=$unit\nLoadState=not-found\nActiveState=inactive\nMainPID=0\n" };
const inactive = { code: 0, stdout: "MainPID=0\nId=$unit\nLoadState=loaded\nActiveState=inactive\n" };
const active = { code: 0, stdout: "Id=$unit\nLoadState=loaded\nActiveState=active\nMainPID=4322\n" };
type ManagerReply = typeof absent | null;

function replacement({ legacy = absent, v0 = inactive, home, enabled = false }: {
  legacy?: ManagerReply; v0?: ManagerReply; home?: "local" | "incoming" | "elsewhere" | "legacy" | "corrupt" | "partial-layout" | "foreign-db"; enabled?: boolean;
} = {}) {
  const f = fixture(), socket = join(f.home, "core.sock"), file = join(f.root, "roam/core.json");
  expect(f.run(socket)).toMatchObject({ value: "enrolled" });
  const old = JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), coreId: "previous-core" });
  writeFileSync(file, old);
  const calls = join(f.home, "systemctl-calls"), units = { [LEGACY_UNIT]: legacy, [V0_UNIT]: v0 };
  writeFileSync(join(f.home, "systemctl"), String.raw`#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2), [user, verb, unit] = args;
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\n');
if (user !== '--user' || verb !== 'show') process.exit(1);
const reply = ${JSON.stringify(units)}[unit];
if (reply === null) process.kill(process.pid, 'SIGTERM');
if (!reply) process.exit(2);
// Keep the old one-property query working so it cannot hide missing v0 or home checks.
if (args.includes('--value')) console.log(/ActiveState=([^\n]+)/.exec(reply.stdout)?.[1] ?? '');
else process.stdout.write(reply.stdout.replaceAll('$unit', unit));
process.exitCode = reply.code;
`, { mode: 0o700 });
  if (enabled) {
    const config = join(f.root, "roam/config.json");
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), enabled: true }));
  }
  const dbFile = join(f.root, "spider.db");
  if (home === "corrupt") writeFileSync(dbFile, "not SQLite");
  else {
    const box = "00000000-0000-4000-8000-000000000001", hub = "00000000-0000-4000-8000-000000000002";
    const db = new DatabaseSync(dbFile);
    try {
      db.exec("CREATE TABLE roam_meta (id INTEGER, machine_id TEXT); CREATE TABLE session_homes (session_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, epoch INTEGER NOT NULL, move_id TEXT, updated_at INTEGER NOT NULL)");
      db.prepare("INSERT INTO roam_meta VALUES(1, ?)").run(home === "foreign-db" ? hub : box);
      if (home !== "legacy") db.exec("ALTER TABLE session_homes ADD COLUMN state TEXT");
      if (home !== "legacy" && home !== "partial-layout") db.exec("ALTER TABLE session_homes ADD COLUMN destination TEXT");
      if (home === "local" || home === "incoming" || home === "elsewhere") db.prepare("INSERT INTO session_homes VALUES('fixture-session', ?, 1, 'fixture-move', 1, ?, ?)")
        .run(home === "local" ? box : hub, home === "local" ? "stopped" : "moving", home === "incoming" ? box : home === "elsewhere" ? hub : null);
    } finally { db.close(); }
  }
  return { file, old, calls, dbFile, receipt: join(f.root, "roam/core-pin-replacement-replace-pin.json"),
    run: () => f.run(socket, "replace-pin", { PATH: f.home }, { replaceCorePin: true }) };
}

it.each([
  ["stopped v0", inactive, undefined],
  ["failed v0", { ...inactive, stdout: inactive.stdout.replace("inactive", "failed") }, "elsewhere"],
  ["absent v0 with a pre-v0 DB", absent, "legacy"],
] as const)("replaces a pin with a positively absent legacy unit and %s", (_name, v0, home) => {
  const f = replacement({ v0, home });
  const before = readFileSync(f.dbFile);
  const result = f.run();
  expect(result).toMatchObject({ value: { enrollment: "already-enrolled", replacement: { oldCoreId: "previous-core", newCoreId: "fixture-core" } } });
  expect(JSON.parse(readFileSync(f.file, "utf8"))).toHaveProperty("coreId", "fixture-core");
  expect(readFileSync(f.dbFile)).toEqual(before);
  expect(readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([LEGACY_UNIT, V0_UNIT].map(unit =>
    ["--user", "show", unit, "--property=Id,LoadState,ActiveState,MainPID", "--all"]));
  expect(f.run()).toEqual(result);
});

it.each([
  ["active legacy supervisor", { legacy: active }],
  ["active v0 supervisor", { v0: active }],
  ["manager connection error", { v0: { code: 1, stdout: "" } }],
  ["interrupted manager call", { v0: null }],
  ["not-found response with the wrong exit status", { v0: { ...absent, code: 4 } }],
  ["masked unit", { v0: { ...inactive, stdout: inactive.stdout.replace("loaded", "masked") } }],
  ["unsettled activity", { v0: { ...inactive, stdout: inactive.stdout.replace("inactive", "deactivating") } }],
  ["aliased unit", { v0: { ...inactive, stdout: inactive.stdout.replace("$unit", "other.service") } }],
  ["partial reply", { v0: { ...inactive, stdout: inactive.stdout.replace("MainPID=0\n", "") } }],
  ["duplicate property", { v0: { ...inactive, stdout: inactive.stdout + "MainPID=0\n" } }],
  ["stopped unit with a PID", { v0: { ...inactive, stdout: inactive.stdout.replace("MainPID=0", "MainPID=4322") } }],
  ["local home", { home: "local" }],
  ["incoming moving home", { home: "incoming" }],
  ["enabled roaming", { enabled: true }],
  ["unreadable DB", { home: "corrupt" }],
  ["partial v0 layout", { home: "partial-layout" }],
  ["foreign DB identity", { home: "foreign-db" }],
] as const)("leaves the pin and writes no receipt with %s", (_name, options) => {
  const f = replacement(options);
  const before = readFileSync(f.dbFile);
  expect(f.run()).toMatchObject({ error: "core-pin-in-use" });
  expect(readFileSync(f.file, "utf8")).toBe(f.old);
  expect(existsSync(f.receipt)).toBe(false);
  expect(readFileSync(f.dbFile)).toEqual(before);
});

it("reports invalid-config when the configured socket is malformed", () => {
  const f = fixture();
  writeFileSync(join(f.configHome, "herdr-core/config.toml"), "socket = 42\n");
  expect(f.run(null)).toMatchObject({ error: "invalid-config" });
  expect(existsSync(join(f.root, "roam/core.json"))).toBe(false);
});

it("resolves a configured socket when the core has no HC_SOCKET override", () => {
  const f = fixture(), socket = join(f.home, "configured.sock");
  writeFileSync(join(f.configHome, "herdr-core/config.toml"), `socket = '${socket}'\n`);
  expect(f.run(null)).toMatchObject({ value: "enrolled" });
  expect(JSON.parse(readFileSync(join(f.root, "roam/core.json"), "utf8"))).toHaveProperty("socket", socket);
});
