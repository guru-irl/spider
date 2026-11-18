import { expect, it } from "vitest";
import { posix } from "node:path";
import { runInNewContext } from "node:vm";
import * as bootstrap from "../bootstrap-script";
import { bootstrapPeer, healthyInventory, inventoryEnvelope } from "./bootstrap-fixture";

type Entry = { kind: "file" | "directory" | "socket" | "symlink"; uid?: number; mode?: number; nlink?: number; size?: number; readable?: boolean; executable?: boolean; content?: string; target?: string };

function fakeSystem() {
  const home = "/home/fixture", packageRoot = "/home/fixture/.local/lib/spider";
  const authPi = `${home}/.pi/agent/auth.json`, authGh = `${home}/.config/gh/hosts.yml`;
  const unitDir = `${home}/.config/systemd/user`, socketDir = "/run/user/1000/herdr-core";
  const nativeRoot = `${packageRoot}/node_modules/better-sqlite3`, nativeEntry = `${nativeRoot}/lib/index.js`;
  const entries = new Map<string, Entry>([
    [home, { kind: "directory" }],
    [posix.dirname(bootstrapPeer.cli), { kind: "directory" }],
    [bootstrapPeer.pi, { kind: "file", mode: 0o700, executable: true }],
    [bootstrapPeer.cli, { kind: "file", mode: 0o700 }],
    [`${packageRoot}/package.json`, { kind: "file", content: '{"name":"@guru-irl/spider","version":"0.1.0","privateNote":"fixture-secret"}' }],
    [nativeEntry, { kind: "file", mode: 0o600 }],
    [authPi, { kind: "file", mode: 0o600, content: "fixture-secret" }],
    [authGh, { kind: "file", mode: 0o600, content: "fixture-secret" }],
    [`${unitDir}/herdr-core.service`, { kind: "file", mode: 0o600 }],
    [`${socketDir}/default.sock`, { kind: "socket", mode: 0o600 }],
  ]);
  for (const dir of [
    `${home}/.local`, `${home}/.local/bin`, `${home}/.local/lib`, packageRoot, `${packageRoot}/dist`, `${packageRoot}/dist/roam`, `${packageRoot}/node_modules`, nativeRoot, `${nativeRoot}/lib`,
    `${home}/.pi`, `${home}/.pi/agent`, `${home}/.config`, `${home}/.config/gh`, `${home}/.config/tool`,
    `${home}/.config/systemd`, unitDir, "/run/user/1000", socketDir,
  ]) entries.set(dir, { kind: "directory" });
  const reads: string[] = [], readLimits: number[] = [], calls: string[][] = [], filesystems: string[] = [], opens: { name: string; flags: number }[] = [];
  const commandIO: { command: string; args: string[]; stdio: unknown }[] = [];
  let input: Record<string, unknown> = { core: bootstrapPeer.core, coreId: "remote-core", pi: bootstrapPeer.pi, cli: bootstrapPeer.cli, globalRoot: bootstrapPeer.globalRoot, checks: [], coreUnit: null };
  const descriptors = new Map<number, string>(); let nextFd = 3;
  const commands = new Map<string, { status: number | null; stdout?: string; error?: Error }>([
    ["git --version", { status: 0, stdout: "git version 2.45.0\n" }],
    ["git config --get user.name", { status: 0 }],
    ["git config --get user.email", { status: 0 }],
    ["systemctl --user is-system-running", { status: 0, stdout: "running\n" }],
    [`${bootstrapPeer.core} server status --json`, { status: 0, stdout: JSON.stringify({ core: { id: "remote-core" }, pid: 4321 }) }],
    ["systemctl --user show --property=MainPID --value herdr-core.service", { status: 0, stdout: "4321\n" }],
    ["loginctl show-user 1000 --property=Linger --value", { status: 0, stdout: "yes\n" }],
    [`${bootstrapPeer.pi} --version`, { status: 0, stdout: "1.2.0\n" }],
    ["gh --version", { status: 0, stdout: "gh version 2.0.0\n" }],
    ["gh auth status", { status: 0 }],
  ]);
  const stat = (name: string) => {
    const entry = entries.get(name);
    if (!entry) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
    return {
      uid: entry.uid ?? 1000, mode: entry.mode ?? (entry.kind === "directory" ? 0o700 : 0o600),
      nlink: entry.nlink ?? 1, size: entry.size ?? Buffer.byteLength(entry.content ?? ""), dev: 1, ino: name.length,
      isFile: () => entry.kind === "file", isDirectory: () => entry.kind === "directory",
      isSocket: () => entry.kind === "socket", isSymbolicLink: () => entry.kind === "symlink",
    };
  };
  const fs = {
    constants: { R_OK: 4, X_OK: 1, O_RDONLY: 0, O_NOFOLLOW: 0x20000, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 0x40, O_TRUNC: 0x200 },
    lstatSync: stat,
    statSync: stat,
    openSync(name: string, flags: number) {
      opens.push({ name, flags });
      if ((flags & (1 | 2 | 0x40 | 0x200)) !== 0) throw new Error("write is forbidden");
      const entry = entries.get(name); if (!entry || entry.kind !== "file") throw new Error("unsafe fixture");
      const fd = nextFd++; descriptors.set(fd, name); return fd;
    },
    fstatSync(fd: number) { const name = descriptors.get(fd); if (!name) throw new Error("bad descriptor"); return stat(name); },
    readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
      const name = descriptors.get(fd); if (!name) throw new Error("bad descriptor");
      reads.push(name); readLimits.push(length); const content = Buffer.from(entries.get(name)?.content ?? "");
      return content.copy(buffer, offset, position, position + length);
    },
    closeSync(fd: number) { descriptors.delete(fd); },
    realpathSync(name: string) { const entry = entries.get(name); if (!entry) throw new Error("missing fixture"); return entry.target ?? name; },
    accessSync(name: string, mode: number) {
      const entry = entries.get(name);
      if (!entry || mode === 4 && entry.readable === false || mode === 1 && entry.executable === false) throw new Error("inaccessible fixture");
    },
    readFileSync(name: string | number) {
      if (name === 0) return JSON.stringify(input);
      if (typeof name === "number") { const file = descriptors.get(name); if (!file) throw new Error("bad descriptor"); name = file; }
      reads.push(String(name));
      const proc: Record<string, string> = {
        "/proc/self/limits": "Limit                     Soft Limit           Hard Limit           Units\nMax open files            65536                65536                files\n",
        "/proc/sys/fs/inotify/max_user_instances": "1024\n",
        "/proc/sys/fs/inotify/max_user_watches": "524288\n",
      };
      if (String(name) in proc) return proc[String(name)];
      if (name === authPi || name === authGh) throw new Error("auth contents must not be read");
      const entry = entries.get(String(name));
      if (!entry || entry.content === undefined) throw new Error("missing fixture");
      return entry.content;
    },
    readdirSync(name: string) {
      if (name === unitDir) return [...entries.keys()].filter(file => posix.dirname(file) === unitDir).map(file => posix.basename(file));
      if (name === socketDir) return ["default.sock"];
      if (name === "/run/user/1000/systemd/transient") return [...entries.keys()].filter(file => posix.dirname(file) === name).map(file => posix.basename(file));
      throw new Error("missing fixture directory");
    },
    statfsSync(name: string) { filesystems.push(name); return { bavail: 2_000_000_000n, bsize: 1n }; },
  };
  const os = { homedir: () => home, platform: () => "linux", release: () => "6.8.0" };
  const spawnSync = (command: string, args: string[], options: { stdio: unknown; maxBuffer: number }) => {
    calls.push([command, ...args]); commandIO.push({ command, args, stdio: options.stdio });
    let result = commands.get([command, ...args].join(" "));
    if (!result && command === "systemctl" && args[1] === "show" && args[2] === "--property=Transient,FragmentPath,MainPID") {
      const unit = args[3], persistent = entries.has(`${unitDir}/${unit}`);
      const main = commands.get(`systemctl --user show --property=MainPID --value ${unit}`);
      if (persistent) result = { status: main?.status ?? 0, stdout: `Transient=no\nFragmentPath=${unitDir}/${unit}\nMainPID=${main?.stdout?.trim() ?? "4321"}\n` };
    }
    result ??= { status: 1 };
    return Buffer.byteLength(result.stdout ?? "") > options.maxBuffer ? { status: null } : result;
  };
  const native = { ready: true, opens: 0, closes: 0, entry: nativeEntry };
  class Database { constructor(name: string) { if (!native.ready || name !== ":memory:") throw new Error("native unavailable"); native.opens++; } close() { native.closes++; } }
  let output = "";
  const fakeProcess = {
    versions: { node: "26.4.0", modules: "144" }, getuid: () => 1000,
    stdout: { write(value: string) { output += value; } },
    get env(): never { throw new Error("environment must not be collected"); },
  };
  const modules: Record<string, unknown> = {
    "node:fs": fs, "node:os": os, "node:path": posix, "node:child_process": { spawnSync },
    "node:module": { createRequire: () => Object.assign((name: string) => { if (name !== "better-sqlite3") throw new Error("unexpected module"); return Database; }, { resolve(name: string) { if (name !== "better-sqlite3") throw new Error("unexpected module"); return native.entry; } }) },
  };
  return {
    entries, reads, readLimits, calls, commandIO, commands, filesystems, native, opens, authPi, authGh,
    setInput(value: Record<string, unknown>) { input = { globalRoot: bootstrapPeer.globalRoot, core: bootstrapPeer.core, coreId: "remote-core", ...value }; },
    run(source: string) {
      output = "";
      runInNewContext(source, { process: fakeProcess, require: (name: string) => { if (!(name in modules)) throw new Error("unexpected module"); return modules[name]; }, Buffer, JSON }, { timeout: 1000 });
      return JSON.parse(output) as { version: number; kind: string; value: ReturnType<typeof healthyInventory> };
    },
  };
}

it.each([[0o600, true], [0o400, false], [0o000, false], [0o644, false], [0o1600, false]] as const)("accepts only destination auth mode 0600, observed %s", (mode, modeSafe) => {
  const system = fakeSystem();
  system.entries.set(system.authPi, { kind: "file", mode });
  expect(system.run(bootstrap.BOOTSTRAP_SCRIPT).value.auth.pi).toMatchObject({ present: true, modeSafe });
  expect(system.reads).not.toContain(system.authPi);
}, 5000);

it("classifies a symlinked destination auth parent as unsafe rather than missing", () => {
  const system = fakeSystem();
  system.entries.set(posix.dirname(system.authPi), { kind: "symlink", target: "/home/fixture/other-agent" });
  expect(system.run(bootstrap.BOOTSTRAP_SCRIPT).value.auth.pi).toEqual({ present: true, readable: false, modeSafe: false });
  expect(system.reads).not.toContain(system.authPi);
}, 5000);

it("reports only approved inventory fields from fake system resources", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem();
  const reply = system.run(source!);
  expect(reply).toEqual(inventoryEnvelope());
  expect(system.reads).not.toContain(system.authPi);
  expect(system.reads).not.toContain(system.authGh);
  expect(JSON.stringify(reply)).not.toContain("fixture-secret");
  expect(system.native).toMatchObject({ ready: true, opens: 1, closes: 1 });
  expect(system.filesystems).toEqual([posix.dirname(bootstrapPeer.cli)]);
  expect(system.calls.some(([command]) => ["sudo", "su", "ps"].includes(command))).toBe(false);
}, 5000);

it("reports a safely absent roaming root and machine identity", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem(), reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  expect(reply.value.roaming).toEqual({ rootExists: false, rootSafe: true, identityExists: false, machineId: null });
}, 5000);

it("can inspect the user home itself when it is a private roaming root", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem();
  system.setInput({ pi: bootstrapPeer.pi, cli: bootstrapPeer.cli, globalRoot: "/home/fixture", checks: [], coreUnit: null });
  const reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  expect(reply.value.roaming).toEqual({ rootExists: true, rootSafe: true, identityExists: false, machineId: null });
}, 5000);

it("distinguishes a missing identity inside an existing private root", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem(), root = bootstrapPeer.globalRoot;
  system.entries.set(root, { kind: "directory", mode: 0o700 });
  system.entries.set(`${root}/roam`, { kind: "directory", mode: 0o700 });
  const reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  expect(reply.value.roaming).toEqual({ rootExists: true, rootSafe: true, identityExists: false, machineId: null });
}, 5000);

it("reports only the ID from an owned private machine identity", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem(), root = bootstrapPeer.globalRoot, identity = `${root}/roam/machine.json`;
  system.entries.set(root, { kind: "directory", mode: 0o700 });
  system.entries.set(`${root}/roam`, { kind: "directory", mode: 0o700 });
  system.entries.set(identity, { kind: "file", mode: 0o600, content: JSON.stringify({ machineId: bootstrapPeer.machineId, privateNote: "fixture-secret" }) });
  const reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  expect(reply.value.roaming).toEqual({ rootExists: true, rootSafe: true, identityExists: true, machineId: bootstrapPeer.machineId });
  expect(system.reads.filter(name => name === identity)).toHaveLength(1);
  expect(system.opens).toHaveLength(1);
  expect(system.opens[0].flags & (1 | 2 | 0x40 | 0x200)).toBe(0);
  expect(system.opens[0].flags & 0x20000).not.toBe(0);
  expect(JSON.stringify(reply)).not.toContain("fixture-secret");
  expect(JSON.stringify(reply)).not.toContain(identity);
}, 5000);

it("reports a malformed existing identity without copying its contents", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem(), root = bootstrapPeer.globalRoot;
  system.entries.set(root, { kind: "directory", mode: 0o700 });
  system.entries.set(`${root}/roam`, { kind: "directory", mode: 0o700 });
  system.entries.set(`${root}/roam/machine.json`, { kind: "file", mode: 0o600, content: '{"machineId":"not-a-uuid","note":"fixture-secret"}' });
  const reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  expect(reply.value.roaming).toEqual({ rootExists: true, rootSafe: true, identityExists: true, machineId: null });
  expect(JSON.stringify(reply)).not.toContain("fixture-secret");
}, 5000);

it("caps an identity read when the file grows after its size check", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem(), root = bootstrapPeer.globalRoot;
  system.entries.set(root, { kind: "directory", mode: 0o700 });
  system.entries.set(`${root}/roam`, { kind: "directory", mode: 0o700 });
  system.entries.set(`${root}/roam/machine.json`, { kind: "file", mode: 0o600, size: 10, content: "x".repeat(10_000) });
  const reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  expect(reply.value.roaming).toEqual({ rootExists: true, rootSafe: true, identityExists: true, machineId: null });
  expect(system.readLimits).toEqual([4097]);
}, 5000);

it("does not inspect a roaming root outside the user home", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem();
  system.setInput({ pi: bootstrapPeer.pi, cli: bootstrapPeer.cli, globalRoot: "/outside/private/spider", checks: [], coreUnit: null });
  const reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  expect(reply.value.roaming).toEqual({ rootExists: null, rootSafe: false, identityExists: null, machineId: null });
  expect(system.reads.some(name => name.startsWith("/outside"))).toBe(false);
  expect(JSON.stringify(reply)).not.toContain("/outside/private");
}, 5000);

it.each([
  ["world-readable root", { kind: "directory", mode: 0o755 } as Entry, { kind: "file", mode: 0o600 } as Entry, null],
  ["foreign root", { kind: "directory", uid: 0, mode: 0o700 } as Entry, { kind: "file", mode: 0o600 } as Entry, null],
  ["symlinked root", { kind: "symlink", target: "/outside/private" } as Entry, { kind: "file", mode: 0o600 } as Entry, null],
  ["foreign identity", { kind: "directory", mode: 0o700 } as Entry, { kind: "file", uid: 0, mode: 0o600 } as Entry, true],
  ["world-readable identity", { kind: "directory", mode: 0o700 } as Entry, { kind: "file", mode: 0o644 } as Entry, true],
  ["symlinked identity", { kind: "directory", mode: 0o700 } as Entry, { kind: "symlink", target: "/outside/private" } as Entry, true],
  ["hard-linked identity", { kind: "directory", mode: 0o700 } as Entry, { kind: "file", mode: 0o600, nlink: 2 } as Entry, true],
  ["oversized identity", { kind: "directory", mode: 0o700 } as Entry, { kind: "file", mode: 0o600, content: "x".repeat(4097) } as Entry, true],
])("marks %s unsafe without reading identity contents", (_name, rootEntry, identityEntry, identityExists) => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem(), root = bootstrapPeer.globalRoot, identity = `${root}/roam/machine.json`;
  system.entries.set(root, rootEntry); system.entries.set(`${root}/roam`, { kind: "directory", mode: 0o700 });
  system.entries.set(identity, { content: JSON.stringify({ machineId: bootstrapPeer.machineId, privateNote: "fixture-secret" }), ...identityEntry });
  const reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  expect(reply.value.roaming).toEqual({ rootExists: true, rootSafe: false, identityExists, machineId: null });
  expect(system.reads).not.toContain(identity);
  expect(JSON.stringify(reply)).not.toContain("/outside/private");
}, 5000);

it.each([
  ["world-readable directory", { kind: "directory", mode: 0o755 } as Entry],
  ["foreign directory", { kind: "directory", uid: 0, mode: 0o700 } as Entry],
  ["symlinked directory", { kind: "symlink", target: "/outside/private" } as Entry],
])("marks a %s inside the root unsafe", (_name, directory) => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem(), root = bootstrapPeer.globalRoot, identity = `${root}/roam/machine.json`;
  system.entries.set(root, { kind: "directory", mode: 0o700 }); system.entries.set(`${root}/roam`, directory);
  system.entries.set(identity, { kind: "file", mode: 0o600, content: JSON.stringify({ machineId: bootstrapPeer.machineId }) });
  const reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  expect(reply.value.roaming).toEqual({ rootExists: true, rootSafe: false, identityExists: null, machineId: null });
  expect(system.reads).not.toContain(identity);
}, 5000);

it("does not load a native module resolved outside the user home", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem(); system.native.entry = "/outside/private/native/index.js";
  const reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  expect(reply.value.spider.nativeModuleReady).toBe(false);
  expect(system.native.opens).toBe(0);
  expect(JSON.stringify(reply)).not.toContain("/outside/private");
}, 5000);

it("discards auth and identity command output before it enters the probe", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem();
  system.run(source!);
  for (const call of system.commandIO.filter(row => row.command === "git" && row.args[0] === "config" || row.command === "gh")) {
    expect(call.stdio).toEqual(["ignore", "ignore", "ignore"]);
  }
  expect(system.commandIO.filter(row => row.command === "git" && row.args[0] === "config" || row.command === "gh")).toHaveLength(4);
}, 5000);

it("returns no outside-home pi path and reports missing resources without repairs", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem();
  system.setInput({ pi: "/outside/private/pi", cli: bootstrapPeer.cli, checks: [], coreUnit: null });
  system.commands.set("git --version", { status: 1 });
  system.commands.set("systemctl --user is-system-running", { status: 1, stdout: "offline\n" });
  system.entries.delete(system.authPi);
  system.native.ready = false;
  const value = system.run(source!).value;
  expect(value.pi).toBeNull();
  expect(value.piVersion).toBeNull();
  expect(value.gitVersion).toBeNull();
  expect(value.systemdUser).toBe(false);
  expect(value.auth.pi).toEqual({ present: false, readable: false, modeSafe: false });
  expect(value.spider.nativeModuleReady).toBe(false);
  expect(system.calls.some(([command]) => command === "/outside/private/pi" || command === "sudo")).toBe(false);
  expect(JSON.stringify(value)).not.toContain("/outside/private");
}, 5000);

it("reports configured CLI and auth metadata without returning paths or contents", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem();
  const binary = "/home/fixture/.local/bin/tool", auth = "/home/fixture/.config/tool/auth.json";
  system.entries.set(binary, { kind: "file", mode: 0o700, executable: true });
  system.entries.set(auth, { kind: "file", mode: 0o600, content: "fixture-secret" });
  system.setInput({ pi: bootstrapPeer.pi, cli: bootstrapPeer.cli, coreUnit: null, checks: [{ executable: binary, authFile: auth }, { executable: "/outside/private/tool", authFile: null }] });
  const reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  const value = reply.value;
  expect(value.cli.configured).toEqual([
    { executable: { present: true, readable: true, modeSafe: true, executable: true }, auth: { present: true, readable: true, modeSafe: true } },
    { executable: null, auth: null },
  ]);
  expect(system.reads).not.toContain(auth);
  expect(JSON.stringify(value)).not.toContain(binary);
  expect(JSON.stringify(value)).not.toContain("/outside/private");
  expect(JSON.stringify(value)).not.toContain("fixture-secret");
}, 5000);

it("returns a negative auth status rather than following an unsafe fixed parent", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem();
  system.entries.set("/home/fixture/.pi", { kind: "symlink", target: "/outside/private" });
  const reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  expect(reply.value.auth.pi).toEqual({ present: true, readable: false, modeSafe: false });
  expect(reply.value.roaming).toEqual({ rootExists: null, rootSafe: false, identityExists: null, machineId: null });
  expect(system.reads).not.toContain(system.authPi);
}, 5000);

it("refuses configured files beneath a symlinked parent", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem();
  const parent = "/home/fixture/.config/link", binary = `${parent}/tool`, auth = `${parent}/auth.json`;
  system.entries.set(parent, { kind: "symlink", target: "/outside/private" });
  system.entries.set(binary, { kind: "file", mode: 0o700, executable: true });
  system.entries.set(auth, { kind: "file", mode: 0o600, content: "fixture-secret" });
  system.setInput({ pi: bootstrapPeer.pi, cli: bootstrapPeer.cli, checks: [{ executable: binary, authFile: auth }], coreUnit: null });
  const reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  expect(reply.value.cli.configured).toEqual([{ executable: null, auth: null }]);
  expect(system.reads).not.toContain(auth);
  expect(JSON.stringify(reply)).not.toContain("/outside/private");
}, 5000);

const transientUnit = "hc-serve-0a1b2c3d.service", transientDirectory = "/run/user/1000/systemd/transient";
const transientShow = (unit = transientUnit) => `systemctl --user show --property=Transient,FragmentPath,MainPID ${unit}`;
function transientSystem() {
  const system = fakeSystem();
  system.entries.delete("/home/fixture/.config/systemd/user/herdr-core.service");
  system.entries.set("/run/user/1000/systemd", { kind: "directory" });
  system.entries.set(transientDirectory, { kind: "directory" });
  system.entries.set(`${transientDirectory}/${transientUnit}`, { kind: "file" });
  system.commands.set(transientShow(), { status: 0, stdout: `Transient=yes\nFragmentPath=${transientDirectory}/${transientUnit}\nMainPID=4321\n` });
  return system;
}

it.each([false, true])("accepts an owned transient core unit (explicit=%s)", explicit => {
  const system = transientSystem();
  if (explicit) system.setInput({ pi: bootstrapPeer.pi, cli: bootstrapPeer.cli, checks: [], coreUnit: transientUnit });
  expect(system.run(bootstrap.BOOTSTRAP_SCRIPT)).toMatchObject({ value: { core: { unit: transientUnit, transient: true, unitExists: true, unitOwned: true } } });
});

it.each(["foreign file", "symlink", "wrong PID", "outside fragment", "persistent flag", "unsafe directory"])("does not accept a transient core with %s", condition => {
  const system = transientSystem(), file = `${transientDirectory}/${transientUnit}`;
  if (condition === "foreign file") system.entries.set(file, { kind: "file", uid: 2000 });
  if (condition === "symlink") system.entries.set(file, { kind: "symlink", target: "/outside/unit" });
  if (condition === "unsafe directory") system.entries.set(transientDirectory, { kind: "directory", uid: 2000 });
  const fragment = condition === "outside fragment" ? `/home/fixture/${transientUnit}` : file;
  const pid = condition === "wrong PID" ? 5432 : 4321;
  const transient = condition === "persistent flag" ? "no" : "yes";
  system.commands.set(transientShow(), { status: 0, stdout: `Transient=${transient}\nFragmentPath=${fragment}\nMainPID=${pid}\n` });
  expect(system.run(bootstrap.BOOTSTRAP_SCRIPT)).toEqual({ version: 1, kind: "inventory", error: "peer-core-unit-required" });
});

it.each([
  "Transient=yes\nTransient=no\nFragmentPath=/unexpected\nMainPID=4321\n",
  `Transient=yes\nFragmentPath=${transientDirectory}/${transientUnit}\nMainPID=4321\nMainPID=5432\n`,
  `Transient=maybe\nFragmentPath=${transientDirectory}/${transientUnit}\nMainPID=4321\n`,
  `Transient=yes\nFragmentPath=${transientDirectory}/${transientUnit}\nMainPID=4321\nOther=yes\n`,
  "Transient=yes\nMainPID=4321\n",
  `Transient=yes\nFragmentPath=${transientDirectory}/${transientUnit}\nMainPID=NaN\n`,
])("fails closed on malformed or conflicting unit properties %j", stdout => {
  const system = transientSystem(); system.commands.set(transientShow(), { status: 0, stdout });
  expect(system.run(bootstrap.BOOTSTRAP_SCRIPT)).toEqual({ version: 1, kind: "inventory", error: "bootstrap-probe-failed" });
});

it("discovers only the hc service whose main PID is the configured core", () => {
  const system = fakeSystem(), dir = "/home/fixture/.config/systemd/user";
  system.entries.delete(`${dir}/herdr-core.service`);
  system.entries.set(`${dir}/hc-serve-0a1b2c3d.service`, { kind: "file" });
  system.entries.set(`${dir}/hc-serve-1234abcd.service`, { kind: "file" });
  system.commands.set("systemctl --user show --property=MainPID --value hc-serve-0a1b2c3d.service", { status: 0, stdout: "4321\n" });
  system.commands.set("systemctl --user show --property=MainPID --value hc-serve-1234abcd.service", { status: 0, stdout: "5432\n" });
  expect(system.run(bootstrap.BOOTSTRAP_SCRIPT).value.core).toMatchObject({ unit: "hc-serve-0a1b2c3d.service", unitExists: true, unitOwned: true });
});

it("discovers a unit when core status contains a bounded list of holders", () => {
  const system = fakeSystem();
  system.commands.set(`${bootstrapPeer.core} server status --json`, { status: 0, stdout: JSON.stringify({ core: { id: "remote-core" }, pid: 4321, holders: Array.from({ length: 100 }, (_, index) => ({ pid: 5000 + index })) }) });
  expect(system.run(bootstrap.BOOTSTRAP_SCRIPT).value?.core).toMatchObject({ unit: "herdr-core.service", unitOwned: true });
});

it("refuses ambiguous hc services matching the configured core", () => {
  const system = fakeSystem(), dir = "/home/fixture/.config/systemd/user";
  system.entries.delete(`${dir}/herdr-core.service`);
  for (const unit of ["hc-serve-0a1b2c3d.service", "hc-serve-1234abcd.service"]) {
    system.entries.set(`${dir}/${unit}`, { kind: "file" });
    system.commands.set(`systemctl --user show --property=MainPID --value ${unit}`, { status: 0, stdout: "4321\n" });
  }
  expect(system.run(bootstrap.BOOTSTRAP_SCRIPT)).toEqual({ version: 1, kind: "inventory", error: "peer-core-unit-ambiguous" });
});

it.each(["unrelated PID", "unavailable core", "changed core identity"])("requires a peer core unit for %s", condition => {
  const system = fakeSystem();
  if (condition === "unrelated PID") system.commands.set("systemctl --user show --property=MainPID --value herdr-core.service", { status: 0, stdout: "5432\n" });
  if (condition === "unavailable core") system.commands.delete(`${bootstrapPeer.core} server status --json`);
  if (condition === "changed core identity") system.commands.set(`${bootstrapPeer.core} server status --json`, { status: 0, stdout: JSON.stringify({ core: { id: "other-core" }, pid: 4321 }) });
  expect(system.run(bootstrap.BOOTSTRAP_SCRIPT)).toEqual({ version: 1, kind: "inventory", error: "peer-core-unit-required" });
});

it("checks the explicitly configured core unit without returning its file path", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem();
  system.entries.set("/home/fixture/.config/systemd/user/session-host.service", { kind: "file", mode: 0o600 });
  system.setInput({ pi: bootstrapPeer.pi, cli: bootstrapPeer.cli, checks: [], coreUnit: "session-host.service" });
  const reply = system.run(source!);
  expect(reply).toHaveProperty("value");
  expect(reply.value.core).toMatchObject({ unit: "session-host.service", unitExists: true, unitOwned: true });
  expect(JSON.stringify(reply)).not.toContain("/.config/systemd/user");
}, 5000);

it("does not claim safe auth or core ownership for foreign or symlinked files", () => {
  const source = (bootstrap as { BOOTSTRAP_SCRIPT?: string }).BOOTSTRAP_SCRIPT;
  expect(typeof source).toBe("string");
  const system = fakeSystem();
  system.entries.set(system.authPi, { kind: "symlink", target: "/outside/private", uid: 1000, mode: 0o777 });
  system.entries.set(system.authGh, { kind: "file", uid: 2000, mode: 0o644, readable: false });
  system.entries.set("/home/fixture/.config/systemd/user/herdr-core.service", { kind: "file", uid: 2000 });
  system.entries.set("/run/user/1000/herdr-core/default.sock", { kind: "socket", uid: 2000 });
  const value = system.run(source!).value;
  expect(value.auth.pi.modeSafe).toBe(false);
  expect(value.auth.gh).toEqual({ present: true, readable: false, modeSafe: false });
  expect(value.core).toMatchObject({ unitExists: true, unitOwned: false, socketExists: true, socketOwned: false });
  expect(JSON.stringify(value)).not.toContain("/outside/private");
}, 5000);


it("inspects only the configured destination sign-in metadata", () => {
  const system = fakeSystem(), agentDir = "/home/fixture/install/agent", file = `${agentDir}/auth.json`;
  for (const dir of ["/home/fixture/install", agentDir]) system.entries.set(dir, { kind: "directory" });
  system.entries.set(file, { kind: "file", mode: 0o600, content: ["destination", "credential"].join("-") });
  system.setInput({ pi: bootstrapPeer.pi, cli: bootstrapPeer.cli, coreUnit: null, checks: [], agentDir });
  expect(system.run(bootstrap.BOOTSTRAP_SCRIPT)).toMatchObject({ value: { auth: { pi: { present: true, readable: true, modeSafe: true } } } });
  system.entries.set(file, { kind: "file", mode: 0o644 });
  expect(system.run(bootstrap.BOOTSTRAP_SCRIPT).value.auth.pi.modeSafe).toBe(false);
  system.entries.delete(file);
  expect(system.run(bootstrap.BOOTSTRAP_SCRIPT).value.auth.pi.present).toBe(false);
  expect(system.reads).not.toContain(file); expect(system.opens.map(row => row.name)).not.toContain(file);
}, 5000);
