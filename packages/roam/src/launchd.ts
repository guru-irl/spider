import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assertTestConfigPath } from "@spider/db-core";
import { privateDirectory } from "./staging";

const LABEL = "com.spider.roam.hub";

export interface LaunchdPorts {
  plistDir: string;
  /** Implementations normalize an absent service to the code `service-not-loaded`. */
  launchctl(argv: readonly string[]): Promise<void>;
}

function absolute(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("An absolute service path is required");
  return resolve(path);
}
function executable(path: string, node: boolean): string {
  const file = absolute(realpathSync(absolute(path)));
  const stat = lstatSync(file);
  if (!stat.isFile() || node && process.platform !== "win32" && (stat.mode & 0o111) === 0) throw new Error("Service executable is not a regular executable file");
  try { accessSync(file, node ? constants.X_OK : constants.R_OK); }
  catch { throw new Error("Service executable is not accessible"); }
  return file;
}
function existingFile(file: string): void {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw new Error("Unsafe service file or symlink");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function openLog(file: string): void {
  existingFile(file);
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Unsafe service log");
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
}
function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function definition(node: string, cli: string, root: string, out: string, err: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(cli)}</string><string>roam</string><string>hub</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>EnvironmentVariables</key><dict><key>SPIDER_GLOBAL_ROOT</key><string>${xml(root)}</string></dict>
<key>StandardOutPath</key><string>${xml(out)}</string>
<key>StandardErrorPath</key><string>${xml(err)}</string>
<key>Umask</key><integer>63</integer>
</dict></plist>\n`;
}
function writeDefinition(file: string, contents: string): void {
  existingFile(file);
  const temporary = `${file}.${randomBytes(12).toString("hex")}.new`;
  let created = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
    existingFile(file); renameSync(temporary, file);
  } finally {
    if (created) try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** No service manager or user path is selected unless the caller supplies it. */
export async function installHubService(input: { node: string; cli: string; globalRoot: string }, ports: LaunchdPorts): Promise<void> {
  const node = executable(input.node, true), cli = executable(input.cli, false);
  const root = absolute(input.globalRoot), directory = absolute(ports.plistDir);
  const file = join(directory, `${LABEL}.plist`), logDirectory = join(root, "roam", "logs");
  const out = join(logDirectory, "hub.out.log"), err = join(logDirectory, "hub.err.log");
  // In tests the shared guard rejects both live databases and other user paths.
  assertTestConfigPath(file); assertTestConfigPath(out); assertTestConfigPath(err);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Launchd user domain is unavailable");
  privateDirectory(directory); privateDirectory(root); privateDirectory(join(root, "roam")); privateDirectory(logDirectory);
  existingFile(file);
  openLog(out); openLog(err);
  writeDefinition(file, definition(node, cli, root, out, err));
  const domain = `gui/${uid}`;
  try { await ports.launchctl(["bootout", domain, file]); }
  catch (error) { if ((error as { code?: unknown } | null)?.code !== "service-not-loaded") throw error; }
  await ports.launchctl(["bootstrap", domain, file]);
}
