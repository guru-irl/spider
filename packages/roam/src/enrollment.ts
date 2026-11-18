import * as enrollFs from "node:fs";
import * as enrollPath from "node:path";
import { spawnSync as pinSpawn } from "node:child_process";
import { createHash as enrollmentHash, randomUUID as enrollmentUuid } from "node:crypto";
import { beginShortWrite, endShortWrite, type ReleaseOwner } from "./release-receipt";
import { parseConfig as parseRoamConfig } from "./config";

/** A matching enrollment is never rewritten. Call only after consent and identity claim. */
export function installBoxEnrollment(root: string, machineId: string, hubMachineId: string, coreUnit: string,
  ports: { publish?(source: string, target: string): void; corePin?: SupervisorCorePin } = {}): "enrolled" | "already-enrolled" {
  const refuse = (reason: string): never => { throw Object.assign(new Error(reason), { code: reason }); };
  const enrollment = { enabled: false, role: "box", machineId, hubMachineId, peers: [], coreUnit };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/.test(coreUnit)) refuse("invalid-enrollment");
  try { parseRoamConfig(enrollment); } catch { refuse("invalid-enrollment"); }
  const roam = enrollPath.join(root, "roam"), file = enrollPath.join(roam, "config.json");
  if (!enrollPath.isAbsolute(root) || enrollFs.realpathSync(root) !== root) refuse("unsafe-enrollment");
  for (const [path, mode] of [[root, null], [roam, 0o700]] as const) {
    const stat = enrollFs.lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid() ||
        mode !== null && process.platform !== "win32" && (stat.mode & 0o7777) !== mode) refuse("unsafe-enrollment");
  }
  function read(path: string): Record<string, unknown> | null {
    let fd: number;
    try { fd = enrollFs.openSync(path, enrollFs.constants.O_RDONLY | enrollFs.constants.O_NOFOLLOW | enrollFs.constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return refuse("unsafe-enrollment"); }
    try {
      const stat = enrollFs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || typeof process.getuid === "function" && stat.uid !== process.getuid() ||
          process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600) refuse("unsafe-enrollment");
      let value: unknown;
      try { value = JSON.parse(enrollFs.readFileSync(fd, "utf8")); } catch { refuse("invalid-enrollment"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid-enrollment");
      return value as Record<string, unknown>;
    } finally { enrollFs.closeSync(fd); }
  }
  if (read(enrollPath.join(roam, "machine.json"))?.machineId !== machineId) refuse("enrollment-identity-mismatch");
  function matching(): boolean {
    const value = read(file); if (!value) return false;
    let config: ReturnType<typeof parseRoamConfig>;
    try { config = parseRoamConfig(value); } catch { return refuse("enrollment-conflict"); }
    if (config.machineId !== machineId || config.hubMachineId !== hubMachineId || config.role !== "box") refuse("enrollment-conflict");
    return true;
  }
  const existing = matching();
  if (ports.corePin) installSupervisorCorePin(root, ports.corePin);
  if (existing) return "already-enrolled";
  const temporary = enrollPath.join(roam, `.enrollment-${enrollmentUuid()}`);
  const fd = enrollFs.openSync(temporary, enrollFs.constants.O_WRONLY | enrollFs.constants.O_CREAT | enrollFs.constants.O_EXCL | enrollFs.constants.O_NOFOLLOW, 0o600);
  try { enrollFs.fchmodSync(fd, 0o600); enrollFs.writeFileSync(fd, JSON.stringify(enrollment) + "\n"); enrollFs.fsyncSync(fd); }
  finally { enrollFs.closeSync(fd); }
  try {
    try { (ports.publish ?? enrollFs.linkSync)(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !matching()) throw error; }
  } finally { enrollFs.unlinkSync(temporary); }
  const directory = enrollFs.openSync(roam, enrollFs.constants.O_RDONLY | enrollFs.constants.O_DIRECTORY | enrollFs.constants.O_NOFOLLOW);
  try { enrollFs.fsyncSync(directory); } finally { enrollFs.closeSync(directory); }
  if (!matching()) refuse("enrollment-publication-pending");
  return "enrolled";
}

export interface SupervisorCorePin {
  binary: string; coreId: string; socket: string; sessionNamespace: string; stateHome: string; configHome: string;
}
/** Terminal context must never redirect a pinned core operation. */
export function supervisorCoreEnvironment(pin: SupervisorCorePin, base: Readonly<NodeJS.ProcessEnv>): Readonly<NodeJS.ProcessEnv> {
  const clean = Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith("HC_")));
  return Object.freeze({ ...clean, HC_SOCKET: pin.socket, HC_SESSION: pin.sessionNamespace, XDG_STATE_HOME: pin.stateHome, XDG_CONFIG_HOME: pin.configHome });
}
function supervisorPinError(code: string): never { throw Object.assign(new Error(code), { code }); }
function parseSupervisorCorePin(value: unknown): SupervisorCorePin {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "binary,configHome,coreId,sessionNamespace,socket,stateHome") return supervisorPinError("core-pin-invalid");
  const pin = value as SupervisorCorePin;
  for (const field of [pin.binary, pin.socket, pin.stateHome, pin.configHome]) {
    if (typeof field !== "string" || field.length > 4096 || !enrollPath.isAbsolute(field) || enrollPath.resolve(field) !== field || /[\u0000-\u001f\u007f]/.test(field)) return supervisorPinError("core-pin-invalid");
  }
  if (typeof pin.coreId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(pin.coreId) || typeof pin.sessionNamespace !== "string" ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(pin.sessionNamespace) || [".", ".."].includes(pin.sessionNamespace)) return supervisorPinError("core-pin-invalid");
  return { binary: pin.binary, coreId: pin.coreId, socket: pin.socket, sessionNamespace: pin.sessionNamespace, stateHome: pin.stateHome, configHome: pin.configHome };
}
function supervisorPinDirectory(root: string): string {
  if (!enrollPath.isAbsolute(root) || enrollFs.realpathSync(root) !== root) return supervisorPinError("core-pin-invalid");
  const roam = enrollPath.join(root, "roam");
  for (const file of [root, roam]) {
    const stat = enrollFs.lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid() ||
        file === roam && (stat.mode & 0o7777) !== 0o700) return supervisorPinError("core-pin-invalid");
  }
  return roam;
}
function supervisorPinOwner(): ReleaseOwner {
  if (process.platform !== "linux") return { pid: process.pid, bootId: "nonlinux", start: "0" };
  return { pid: process.pid, bootId: enrollFs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    start: enrollFs.readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[19] };
}
function supervisorPinOwnerState(owner: ReleaseOwner): "live" | "absent" | "unknown" {
  try {
    if (process.platform !== "linux") { process.kill(owner.pid, 0); return "live"; }
    if (enrollFs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== owner.bootId) return "absent";
    const fields = enrollFs.readFileSync(`/proc/${owner.pid}/stat`, "utf8").split(") ")[1].split(" ");
    return fields[0] === "Z" || fields[19] !== owner.start ? "absent" : "live";
  } catch (error) { return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "") ? "absent" : "unknown"; }
}
function supervisorPinSync(roam: string): void {
  const fd = enrollFs.openSync(roam, enrollFs.constants.O_RDONLY | enrollFs.constants.O_DIRECTORY | enrollFs.constants.O_NOFOLLOW);
  try { enrollFs.fsyncSync(fd); } finally { enrollFs.closeSync(fd); }
}
function withSupervisorPinLock<T>(root: string, work: (roam: string) => T): T {
  const roam = supervisorPinDirectory(root);
  const input = { directory: roam, operationId: "core-pin", digest: "0".repeat(64), owner: supervisorPinOwner() };
  const claim = beginShortWrite(input, supervisorPinOwnerState);
  if (claim.kind === "busy") return supervisorPinError("core-pin-busy");
  try {
    // All pin readers and writers use this lock, including crash cleanup.
    for (const entry of enrollFs.readdirSync(roam)) {
      if (!/^\.core-[a-f0-9-]{36}$/.test(entry)) continue;
      const file = enrollPath.join(roam, entry), stat = enrollFs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o600 ||
          typeof process.getuid === "function" && stat.uid !== process.getuid()) return supervisorPinError("core-pin-invalid");
      enrollFs.unlinkSync(file);
    }
    supervisorPinSync(roam);
    return work(roam);
  } finally { endShortWrite(input, claim.token); }
}
function supervisorPinJson(roam: string, name: string): unknown {
  let fd: number | undefined;
  try {
    fd = enrollFs.openSync(enrollPath.join(roam, name), enrollFs.constants.O_RDONLY | enrollFs.constants.O_NOFOLLOW | enrollFs.constants.O_NONBLOCK);
    const stat = enrollFs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > (name === "core.json" ? 16_384 : 40_000) || (stat.mode & 0o7777) !== 0o600 ||
        typeof process.getuid === "function" && stat.uid !== process.getuid()) return supervisorPinError("core-pin-invalid");
    return JSON.parse(enrollFs.readFileSync(fd, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return supervisorPinError("core-pin-required");
    return supervisorPinError("core-pin-invalid");
  } finally { if (fd !== undefined) enrollFs.closeSync(fd); }
}
function writeSupervisorPinJson(roam: string, name: string, value: unknown, replace: boolean): void {
  const temporary = enrollPath.join(roam, `.core-${enrollmentUuid()}`), file = enrollPath.join(roam, name);
  const fd = enrollFs.openSync(temporary, enrollFs.constants.O_WRONLY | enrollFs.constants.O_CREAT | enrollFs.constants.O_EXCL | enrollFs.constants.O_NOFOLLOW, 0o600);
  try { enrollFs.fchmodSync(fd, 0o600); enrollFs.writeFileSync(fd, JSON.stringify(value) + "\n"); enrollFs.fsyncSync(fd); }
  finally { enrollFs.closeSync(fd); }
  try { if (replace) enrollFs.renameSync(temporary, file); else enrollFs.linkSync(temporary, file); }
  finally { if (enrollFs.existsSync(temporary)) enrollFs.unlinkSync(temporary); }
  supervisorPinSync(roam);
}
/** An absent pin must never turn the current core into a newly trusted identity. */
export function readSupervisorCorePin(root: string): SupervisorCorePin {
  return withSupervisorPinLock(root, roam => parseSupervisorCorePin(supervisorPinJson(roam, "core.json")));
}
/** Enrollment may add a missing pin, but may never replace an existing one. */
export function installSupervisorCorePin(root: string, value: SupervisorCorePin): void {
  const pin = parseSupervisorCorePin(value);
  withSupervisorPinLock(root, roam => {
    let prior: SupervisorCorePin;
    try { prior = parseSupervisorCorePin(supervisorPinJson(roam, "core.json")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "core-pin-required") throw error;
      writeSupervisorPinJson(roam, "core.json", pin, false); return;
    }
    if (prior.coreId !== pin.coreId) return supervisorPinError("core-pin-changed");
    if (JSON.stringify(prior) !== JSON.stringify(pin)) return supervisorPinError("core-pin-conflict");
  });
}
export const CORE_PIN_STATUSES = ["ready", "core-pin-required", "core-pin-invalid", "core-pin-changed", "core-pin-unreachable"] as const;
export type CorePinStatus = typeof CORE_PIN_STATUSES[number];
export function isCorePinStatus(value: unknown): value is CorePinStatus {
  return typeof value === "string" && (CORE_PIN_STATUSES as readonly string[]).includes(value);
}
/** Doctor must observe the pin without starting or enrolling any core. */
export function inspectSupervisorCorePin(root: string, base: Readonly<NodeJS.ProcessEnv>): CorePinStatus {
  let pin: SupervisorCorePin;
  try { pin = readSupervisorCorePin(root); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "core-pin-required" ? "core-pin-required" : "core-pin-invalid"; }
  const status = pinSpawn(pin.binary, ["server", "status", "--json"], { env: supervisorCoreEnvironment(pin, base),
    encoding: "utf8", timeout: 5000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "ignore"] });
  if (status.status !== 0) return "core-pin-unreachable";
  try {
    const reply = JSON.parse(status.stdout);
    if (typeof reply?.core?.id !== "string" || !reply.core.id || !Number.isSafeInteger(reply.pid) || reply.pid <= 0) return "core-pin-invalid";
    return reply.core.id === pin.coreId ? "ready" : "core-pin-changed";
  } catch { return "core-pin-invalid"; }
}
export interface CorePinReplacement { oldCoreId: string; newCoreId: string; oldPinSha256: string; newPinSha256: string }
/** Explicit recovery journals both identities before atomically replacing the pin. */
export function replaceSupervisorCorePin(root: string, value: SupervisorCorePin, operationId: string, assertIdle: () => void): CorePinReplacement {
  const pin = parseSupervisorCorePin(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)) return supervisorPinError("core-pin-invalid");
  return withSupervisorPinLock(root, roam => {
    assertIdle();
    const current = parseSupervisorCorePin(supervisorPinJson(roam, "core.json"));
    const name = `core-pin-replacement-${operationId}.json`;
    let previous = current;
    try {
      const raw = supervisorPinJson(roam, name) as { version?: unknown; previous?: unknown; replacement?: unknown };
      if (!raw || Object.keys(raw).sort().join() !== "previous,replacement,version" || raw.version !== 1) return supervisorPinError("core-pin-invalid");
      previous = parseSupervisorCorePin(raw.previous);
      const replacement = parseSupervisorCorePin(raw.replacement);
      if (JSON.stringify(replacement) !== JSON.stringify(pin)) return supervisorPinError("operation-arguments-changed");
      if (![JSON.stringify(previous), JSON.stringify(pin)].includes(JSON.stringify(current))) return supervisorPinError("core-pin-conflict");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "core-pin-required") throw error;
      writeSupervisorPinJson(roam, name, { version: 1, previous, replacement: pin }, false);
    }
    if (JSON.stringify(current) !== JSON.stringify(pin)) writeSupervisorPinJson(roam, "core.json", pin, true);
    const hash = (pin: SupervisorCorePin) => enrollmentHash("sha256").update(JSON.stringify(pin)).digest("hex");
    return { oldCoreId: previous.coreId, newCoreId: pin.coreId, oldPinSha256: hash(previous), newPinSha256: hash(pin) };
  });
}

/** Only the authenticated provisioning channel calls this; it cannot enroll a box. */
export function setBoxRoamingEnabled(root: string, machineId: string, hubMachineId: string, enabled: boolean): void {
  const refuse = (): never => { throw Object.assign(new Error("enrollment-conflict"), { code: "enrollment-conflict" }); };
  if (typeof enabled !== "boolean" || !enrollPath.isAbsolute(root) || enrollFs.realpathSync(root) !== root) refuse();
  const roam = enrollPath.join(root, "roam"), file = enrollPath.join(roam, "config.json");
  for (const directory of [root, roam]) {
    const stat = enrollFs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === "function" && stat.uid !== process.getuid() ||
        directory === roam && process.platform !== "win32" && (stat.mode & 0o7777) !== 0o700) refuse();
  }
  function read(path: string): Record<string, unknown> {
    const fd = enrollFs.openSync(path, enrollFs.constants.O_RDONLY | enrollFs.constants.O_NOFOLLOW | enrollFs.constants.O_NONBLOCK);
    try {
      const stat = enrollFs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || typeof process.getuid === "function" && stat.uid !== process.getuid() ||
          process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600) refuse();
      const value: unknown = JSON.parse(enrollFs.readFileSync(fd, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
      return value as Record<string, unknown>;
    } finally { enrollFs.closeSync(fd); }
  }
  if (read(enrollPath.join(roam, "machine.json")).machineId !== machineId) refuse();
  const raw = read(file), current = parseRoamConfig(raw);
  if (current.role !== "box" || current.machineId !== machineId || current.hubMachineId !== hubMachineId) refuse();
  if (current.enabled === enabled) return;
  const temporary = enrollPath.join(roam, `.enabled-${enrollmentUuid()}`);
  const fd = enrollFs.openSync(temporary, enrollFs.constants.O_WRONLY | enrollFs.constants.O_CREAT | enrollFs.constants.O_EXCL | enrollFs.constants.O_NOFOLLOW, 0o600);
  try { enrollFs.writeFileSync(fd, JSON.stringify({ ...raw, enabled }) + "\n"); enrollFs.fsyncSync(fd); } finally { enrollFs.closeSync(fd); }
  try { if (JSON.stringify(read(file)) !== JSON.stringify(raw)) refuse(); enrollFs.renameSync(temporary, file); }
  finally { if (enrollFs.existsSync(temporary)) enrollFs.unlinkSync(temporary); }
  const directory = enrollFs.openSync(roam, enrollFs.constants.O_RDONLY | enrollFs.constants.O_DIRECTORY | enrollFs.constants.O_NOFOLLOW);
  try { enrollFs.fsyncSync(directory); } finally { enrollFs.closeSync(directory); }
}
