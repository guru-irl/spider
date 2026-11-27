import { resolveParticipantPi } from "./launcher";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir, userInfo } from "node:os";
import { assertTestConfigPath } from "@spider/db-core";
import { selectedSocket } from "@spider/herdr/client/parse";
import { configSocket } from "@spider/herdr/client/socket-config";
import { privateDirectory } from "./staging";
import { toolPath } from "./relocate/launch-environment";

const LABEL = "com.spider.roam.hub";
const V0_LABEL = "com.spider.roam.hub-v0";

export interface LaunchdPorts {
  plistDir: string;
  /** Override the service manager's home in isolated fixtures. */
  serviceHome?: string;
  /** Implementations normalize an absent service to the code `service-not-loaded`. */
  launchctl(argv: readonly string[]): Promise<void>;
}

function absolute(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("An absolute service path is required");
  return resolve(path);
}
function canonical(path: string): string {
  let current = absolute(path);
  const missing: string[] = [];
  for (;;) {
    try { return resolve(realpathSync(current), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current)); current = parent;
    }
  }
}

/** The default root retains the original label; other roots have stable namespaces. */
export function hubServiceLabel(globalRoot: string, mode?: "v0"): string {
  const root = canonical(globalRoot), defaultRoot = canonical(join(homedir(), ".pi", "agent", "spider"));
  const label = mode === "v0" ? V0_LABEL : LABEL;
  return root === defaultRoot ? label : `${label}.${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}
export function hubServiceFile(globalRoot: string, plistDir: string, mode?: "v0"): string {
  return join(absolute(plistDir), `${hubServiceLabel(globalRoot, mode)}.plist`);
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
type CoreSelection = { session: string; socket: string };
/** Resolve all hc socket inputs once, rather than passing through unrelated environment. */
export function hubCoreSelection(env: Readonly<NodeJS.ProcessEnv>): CoreSelection {
  const raw = env.HC_SESSION ?? "";
  if (/[\u0000-\u001f\u007f\ud800-\udfff\ufffe\uffff]/u.test(raw)) throw new Error("Invalid HC_SESSION");
  const session = raw.trim() || "default";
  if (session === "." || session === ".." || /[\/\\:*?"<>|]/.test(session)) throw new Error("Invalid HC_SESSION");
  const socket = selectedSocket({ ...env, HC_SESSION: session });
  if (!isAbsolute(socket) || /[\u0000-\u001f\u007f\ud800-\udfff\ufffe\uffff]/u.test(socket)) throw new Error("Invalid hc socket selection: an absolute path without invalid characters is required");
  return { session, socket: resolve(socket) };
}
function serviceManagerHome(): string {
  // Test fixtures must never consult the real account's configuration.
  return absolute(process.env.SPIDER_TEST_FIXTURE_CHECKOUT ? homedir() : userInfo().homedir);
}
function selectionEnvironment(selection: CoreSelection, serviceHome: string): string {
  // An explicit selection can work even when the default configuration is invalid.
  let standard: CoreSelection | undefined;
  try { standard = hubCoreSelection({ HOME: serviceHome }); } catch { /* Pin the usable selection. */ }
  let configured = false;
  try { configured = configSocket(readFileSync(join(serviceHome, ".config", "herdr-core", "config.toml"), "utf8")) !== undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") configured = true; }
  if (!configured && standard && selection.session === standard.session && selection.socket === standard.socket) return "";
  return `<key>HC_SESSION</key><string>${xml(selection.session)}</string><key>HC_SOCKET</key><string>${xml(selection.socket)}</string>`;
}
function definition(node: string, cli: string, root: string, out: string, err: string, pi: string, label: string, selection: CoreSelection, serviceHome: string, hc?: string, v0Path?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(cli)}</string><string>roam</string><string>${label.startsWith(V0_LABEL) ? "hub-v0" : "hub"}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>SPIDER_GLOBAL_ROOT</key><string>${xml(root)}</string><key>SPIDER_ROAM_PI</key><string>${xml(pi)}</string>${selectionEnvironment(selection, serviceHome)}${hc ? `<key>SPIDER_ROAM_HC</key><string>${xml(hc)}</string>` : ""}${v0Path ? `<key>PATH</key><string>${xml(v0Path)}</string>` : ""}</dict>
<key>StandardOutPath</key><string>${xml(out)}</string>
<key>StandardErrorPath</key><string>${xml(err)}</string>
<key>Umask</key><integer>63</integer>
</dict></plist>\n`;
}
type ManagedDefinition = { text: string; device: number | bigint; inode: number | bigint };
function managedDefinition(file: string, root: string, label: string, ignoreUnrelated = false): ManagedDefinition | null {
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
    if (!text.includes(`<key>Label</key><string>${label}</string>`) ||
        !text.includes(`<key>SPIDER_GLOBAL_ROOT</key><string>${xml(root)}</string>`) ||
        values.length !== 4 || values[2] !== "roam" || values[3] !== (label.startsWith(V0_LABEL) ? "hub-v0" : "hub")) {
      if (ignoreUnrelated) return null;
      throw new Error("Unrelated service definition");
    }
    return { text, device: stat.dev, inode: stat.ino };
  } finally { closeSync(fd); }
}
function unchanged(before: ManagedDefinition | null, after: ManagedDefinition | null): boolean {
  return before === null ? after === null : after !== null && before.text === after.text && before.device === after.device && before.inode === after.inode;
}
function writeDefinition(file: string, contents: string, root: string, label: string, previous: ManagedDefinition | null): void {
  const temporary = `${file}.${randomBytes(12).toString("hex")}.new`;
  let created = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
    if (!unchanged(previous, managedDefinition(file, root, label))) throw new Error("Service definition changed during installation");
    renameSync(temporary, file);
  } finally {
    if (created) try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** Install only into the supplied service directory and scoped global root. */
export async function installHubService(input: { node: string; cli: string; globalRoot: string; pi?: string; hc?: string; env?: Readonly<NodeJS.ProcessEnv>; mode?: "v0" }, ports: LaunchdPorts): Promise<void> {
  const env = input.env ?? process.env;
  const selection = hubCoreSelection(env), serviceHome = absolute(ports.serviceHome ?? serviceManagerHome());
  const configuredHc = input.mode === "v0" ? input.hc ?? env.SPIDER_ROAM_HC : undefined;
  const hc = configuredHc ? executable(configuredHc, true) : undefined;
  const node = executable(input.node, true), cli = executable(input.cli, false);
  const root = absolute(input.globalRoot), directory = absolute(ports.plistDir), label = hubServiceLabel(root, input.mode);
  const file = hubServiceFile(root, directory, input.mode), logDirectory = join(root, "roam", "logs");
  const logName = input.mode === "v0" ? "hub-v0" : "hub";
  const out = join(logDirectory, `${logName}.out.log`), err = join(logDirectory, `${logName}.err.log`);
  // In tests the shared guard rejects both live databases and other user paths.
  assertTestConfigPath(file); assertTestConfigPath(out); assertTestConfigPath(err);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Launchd user domain is unavailable");
  privateDirectory(directory); privateDirectory(root); privateDirectory(join(root, "roam")); privateDirectory(logDirectory);
  const previous = managedDefinition(file, root, label);
  openLog(out); openLog(err);
  const pi = input.pi ?? resolveParticipantPi();
  if (!pi) throw new Error("participant-pi-unavailable");
  const participant = executable(pi, true);
  if (input.mode !== "v0" && label !== LABEL) await removeDefinition(join(directory, `${LABEL}.plist`), root, LABEL, ports, true);
  writeDefinition(file, definition(node, cli, root, out, err, participant, label, selection, serviceHome, hc, input.mode === "v0" ? toolPath(env.PATH,node) : undefined), root, label, previous);
  const domain = `gui/${uid}`;
  try { await ports.launchctl(["bootout", domain, file]); }
  catch (error) { if ((error as { code?: unknown } | null)?.code !== "service-not-loaded") throw error; }
  await ports.launchctl(["bootstrap", domain, file]);
}

async function removeDefinition(file: string, root: string, label: string, ports: LaunchdPorts, ignoreUnrelated: boolean): Promise<void> {
  assertTestConfigPath(file);
  const before = managedDefinition(file, root, label, ignoreUnrelated);
  if (!before) return;
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Launchd user domain is unavailable");
  try { await ports.launchctl(["bootout", `gui/${uid}`, file]); }
  catch (error) { if ((error as { code?: unknown } | null)?.code !== "service-not-loaded") throw error; }
  if (!unchanged(before, managedDefinition(file, root, label))) throw new Error("Service definition changed during removal");
  unlinkSync(file);
}

/** Include a pre-scoping plist only if its guarded definition belongs to this root. */
export function hubServiceExists(globalRoot: string, plistDir: string): boolean {
  const root = absolute(globalRoot), directory = absolute(plistDir), label = hubServiceLabel(root), file = hubServiceFile(root, directory);
  assertTestConfigPath(file);
  try { lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const legacy = join(directory, `${LABEL}.plist`);
  assertTestConfigPath(legacy);
  return label !== LABEL && managedDefinition(legacy, root, LABEL, true) !== null;
}

/** Compare the managed service's effective hc selection, including older plists. */
export function hubServiceSelectionMatches(globalRoot: string, plistDir: string, env: Readonly<NodeJS.ProcessEnv>, serviceHome: string = serviceManagerHome(), mode?: "v0"): boolean | null {
  const root = absolute(globalRoot), directory = absolute(plistDir), label = hubServiceLabel(root, mode), file = hubServiceFile(root, directory, mode);
  assertTestConfigPath(file);
  let definition = managedDefinition(file, root, label);
  if (!definition && mode !== "v0" && label !== LABEL) {
    const legacy = join(directory, `${LABEL}.plist`);
    assertTestConfigPath(legacy);
    definition = managedDefinition(legacy, root, LABEL, true);
  }
  if (!definition) return null;
  const section = /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(definition.text)?.[1];
  if (section === undefined) throw new Error("Invalid service environment");
  const values: Record<string, string> = Object.create(null);
  const pattern = /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g;
  let consumed = "";
  for (const match of section.matchAll(pattern)) {
    if (Object.hasOwn(values, match[1]) || /&(?!amp;|lt;|gt;|quot;|apos;)/.test(match[2])) throw new Error("Invalid service environment");
    values[match[1]] = match[2].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    consumed += match[0];
  }
  if (consumed.replace(/\s/g, "") !== section.replace(/\s/g, "")) throw new Error("Invalid service environment");
  const installed = hubCoreSelection({ HOME: absolute(serviceHome), HC_SESSION: values.HC_SESSION, HC_SOCKET: values.HC_SOCKET });
  const current = hubCoreSelection(env);
  return installed.session === current.session && installed.socket === current.socket;
}

/** A service with another definition or root is not ours to remove. */
export async function removeHubService(input: { globalRoot: string; mode?: "v0" }, ports: LaunchdPorts): Promise<void> {
  const root = absolute(input.globalRoot), directory = absolute(ports.plistDir), label = hubServiceLabel(root, input.mode);
  await removeDefinition(hubServiceFile(root, directory, input.mode), root, label, ports, false);
  if (input.mode !== "v0" && label !== LABEL) await removeDefinition(join(directory, `${LABEL}.plist`), root, LABEL, ports, true);
}
