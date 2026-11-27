import { execFile } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";

export interface SupervisorInstallPorts {
  unitDir: string;
  run(args: readonly string[]): Promise<void>;
}

const legacyUnit = "spider-roam-supervisor.service";
const v0Unit = "spider-roam-supervisor-v0.service";
export function localSupervisorInstallPorts(): SupervisorInstallPorts {
  if (process.platform !== "linux" || process.env.SPIDER_TEST_FIXTURE_CHECKOUT) throw new Error("The roaming supervisor service needs Linux systemd.");
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  if (!isAbsolute(config)) throw new Error("The systemd configuration directory must be absolute.");
  return { unitDir: join(config, "systemd", "user"), run: argv => new Promise<void>((done, reject) => {
    execFile("/usr/bin/systemctl", [...argv], { timeout: 15_000, maxBuffer: 64 * 1024 }, error => error ? reject(new Error("systemd could not change the roaming service.")) : done());
  }) };
}

function definition(file: string, rootLine: string, v0: boolean) {
  assertTestConfigPath(file);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024 || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || process.getuid && stat.uid !== process.getuid()) {
      throw new Error("Unsafe roaming supervisor definition.");
    }
    const text = readFileSync(fd, "utf8"), lines = text.split("\n");
    const starts = lines.filter(line => line.startsWith("ExecStart="));
    if (!lines.includes(rootLine) || !lines.includes("Description=Spider roaming supervisor") || starts.length !== 1 ||
        !starts[0].endsWith(`supervisor.mjs"${v0 ? " --v0" : ""}`)) throw new Error("The supervisor definition belongs to a different installation.");
    return { dev: stat.dev, ino: stat.ino, text };
  } finally { closeSync(fd); }
}

export async function removeLocalSupervisor(ports: SupervisorInstallPorts, rootLine: string, v0: boolean): Promise<string | null> {
  const name = v0 ? v0Unit : legacyUnit, file = join(ports.unitDir, name);
  assertTestConfigPath(file);
  if (!lstatExists(file)) return null;
  if (realpathSync(ports.unitDir) !== ports.unitDir) throw new Error("The systemd user unit directory is not canonical.");
  const before = definition(file, rootLine, v0);
  if (!before) return null;
  await ports.run(["--user", "disable", "--now", name]);
  const after = definition(file, rootLine, v0);
  if (!after || after.dev !== before.dev || after.ino !== before.ino || after.text !== before.text) throw new Error("The supervisor definition changed during removal.");
  unlinkSync(file);
  return name;
}

function prepareUnitDirectory(directory: string): void {
  const root = parse(directory).root;
  let current = root, created = false;
  for (const part of directory.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { mkdirSync(current, { mode: 0o700 }); if (current === directory) created = true; }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("The systemd user unit directory contains a symlink or is not a directory.");
  }
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (process.getuid && stat.uid !== process.getuid()) throw new Error("The systemd user unit directory has a different owner; use a directory owned by the current user.");
    if ((stat.mode & 0o022) !== 0 || created && (stat.mode & 0o7777) !== 0o700) {
      try { fchmodSync(fd, 0o700); }
      catch { throw new Error("The systemd user unit directory is group- or world-writable or has unsafe creation permissions; fix its permissions and retry."); }
    }
  } finally { closeSync(fd); }
}

export async function installLocalV0Supervisor(ports: SupervisorInstallPorts, rootLine: string, unit: string): Promise<void> {
  const file = join(ports.unitDir, v0Unit), temp = `${file}.${randomUUID()}.new`;
  assertTestConfigPath(file);
  if (resolve(ports.unitDir) !== ports.unitDir) throw new Error("The systemd user unit directory is not canonical.");
  prepareUnitDirectory(ports.unitDir);
  const before = definition(file, rootLine, true);
  if (before && before.text !== unit) await removeLocalSupervisor(ports, rootLine, true);
  if (before?.text !== unit) {
    writeFileSync(temp, unit, { mode: 0o600, flag: "wx" });
    try {
      if (definition(file, rootLine, true)) throw new Error("The supervisor definition appeared during installation.");
      renameSync(temp, file);
    } finally { if (lstatExists(temp)) unlinkSync(temp); }
  }
  await ports.run(["--user", "daemon-reload"]);
  await ports.run(["--user", "enable", "--now", v0Unit]);
}

function lstatExists(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
