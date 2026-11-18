import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PROVISION_REMOTE_SCRIPT } from "../provision-remote-script";
import { DatabaseSync } from "node:sqlite";

it("keeps the provisioning launch within Linux's single-argument limit", () => {
  expect(Buffer.byteLength(PROVISION_REMOTE_SCRIPT) + 1).toBeLessThanOrEqual(128 * 1024);
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
    agentDir: join(home, "agent"), npmPrefix: join(home, "prefix"), unitDir: join(home, "units"), core, coreId: "fixture-core",
    coreUnit: "fixture.service", maximum: 1024 * 1024, chunkBytes: 1024 };
  const run = (socket: string | null, operationId = request.operationId, inherited: NodeJS.ProcessEnv = {}, extra: Record<string, unknown> = {}) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, HC_SESSION: "fixture", XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: configHome, ...inherited };
    if (socket === null) delete env.HC_SOCKET; else env.HC_SOCKET = socket;
    const result = spawnSync(process.execPath, ["--input-type=module-typescript", "-e", PROVISION_REMOTE_SCRIPT], {
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

it.each(["idle", "sessions", "active", "enabled"])("replaces a pin only on an idle stopped box: %s", condition => {
  const f = fixture(), socket = join(f.home, "core.sock"), file = join(f.root, "roam/core.json");
  expect(f.run(socket)).toMatchObject({ value: "enrolled" });
  const old = { ...JSON.parse(readFileSync(file, "utf8")), coreId: "previous-core" };
  writeFileSync(file, JSON.stringify(old), { mode: 0o600 });
  writeFileSync(join(f.home, "systemctl"), `#!${process.execPath}\nconsole.log(${JSON.stringify(condition === "active" ? "active" : "inactive")});\n`, { mode: 0o700 });
  if (condition === "enabled") {
    const config = join(f.root, "roam/config.json");
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), enabled: true }), { mode: 0o600 });
  }
  const db = new DatabaseSync(join(f.root, "spider.db"));
  try {
    db.exec("CREATE TABLE roam_meta (id INTEGER, machine_id TEXT); CREATE TABLE session_homes (session_id TEXT, machine_id TEXT)");
    db.prepare("INSERT INTO roam_meta VALUES(1, ?)").run("00000000-0000-4000-8000-000000000001");
    if (condition === "sessions") db.prepare("INSERT INTO session_homes VALUES('fixture-session', ?)").run("00000000-0000-4000-8000-000000000001");
  } finally { db.close(); }
  const result = f.run(socket, "replace-pin", { PATH: f.home }, { replaceCorePin: true });
  if (condition !== "idle") {
    expect(result).toMatchObject({ error: "core-pin-in-use" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(old);
    expect(existsSync(join(f.root, "roam/core-pin-replacement-replace-pin.json"))).toBe(false);
  } else {
    expect(result).toMatchObject({ value: { enrollment: "already-enrolled", replacement: { oldCoreId: "previous-core", newCoreId: "fixture-core" } } });
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveProperty("coreId", "fixture-core");
    expect(f.run(socket, "replace-pin", { PATH: f.home }, { replaceCorePin: true })).toEqual(result);
  }
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
