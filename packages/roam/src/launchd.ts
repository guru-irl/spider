import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
type ManagedDefinition = { text: string; device: number | bigint; inode: number | bigint };
function managedDefinition(file: string, root: string): ManagedDefinition | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Unsafe service definition symlink");
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024 || typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw new Error("Unsafe service definition");
    const text = readFileSync(fd, "utf8");
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1];
    const values = [...(args ?? "").matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => match[1]);
    if (!text.includes(`<key>Label</key><string>${LABEL}</string>`) ||
        !text.includes(`<key>SPIDER_GLOBAL_ROOT</key><string>${xml(root)}</string>`) ||
        values.length !== 4 || values[2] !== "roam" || values[3] !== "hub") throw new Error("Unrelated service definition");
    return { text, device: stat.dev, inode: stat.ino };
  } finally { closeSync(fd); }
}
function unchanged(before: ManagedDefinition | null, after: ManagedDefinition | null): boolean {
  return before === null ? after === null : after !== null && before.text === after.text && before.device === after.device && before.inode === after.inode;
}
function writeDefinition(file: string, contents: string, root: string, previous: ManagedDefinition | null): void {
  const temporary = `${file}.${randomBytes(12).toString("hex")}.new`;
  let created = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
    if (!unchanged(previous, managedDefinition(file, root))) throw new Error("Service definition changed during installation");
    renameSync(temporary, file);
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
  const previous = managedDefinition(file, root);
  openLog(out); openLog(err);
  writeDefinition(file, definition(node, cli, root, out, err), root, previous);
  const domain = `gui/${uid}`;
  try { await ports.launchctl(["bootout", domain, file]); }
  catch (error) { if ((error as { code?: unknown } | null)?.code !== "service-not-loaded") throw error; }
  await ports.launchctl(["bootstrap", domain, file]);
}

/** A service with another definition or root is not ours to remove. */
export async function removeHubService(input: { globalRoot: string }, ports: LaunchdPorts): Promise<void> {
  const root = absolute(input.globalRoot), file = join(absolute(ports.plistDir), `${LABEL}.plist`);
  assertTestConfigPath(file);
  const before = managedDefinition(file, root);
  if (!before) return;
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Launchd user domain is unavailable");
  try { await ports.launchctl(["bootout", `gui/${uid}`, file]); }
  catch (error) { if ((error as { code?: unknown } | null)?.code !== "service-not-loaded") throw error; }
  if (!unchanged(before, managedDefinition(file, root))) throw new Error("Service definition changed during removal");
  unlinkSync(file);
}
