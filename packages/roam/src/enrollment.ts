import * as enrollFs from "node:fs";
import * as enrollPath from "node:path";
import { randomUUID as enrollmentUuid } from "node:crypto";
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
/** An absent pin must never turn the current core into a newly trusted identity. */
export function readSupervisorCorePin(root: string): SupervisorCorePin {
  let fd: number | undefined;
  try {
    const roam = supervisorPinDirectory(root);
    fd = enrollFs.openSync(enrollPath.join(roam, "core.json"), enrollFs.constants.O_RDONLY | enrollFs.constants.O_NOFOLLOW | enrollFs.constants.O_NONBLOCK);
    const stat = enrollFs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384 || (stat.mode & 0o7777) !== 0o600 ||
        typeof process.getuid === "function" && stat.uid !== process.getuid()) return supervisorPinError("core-pin-invalid");
    return parseSupervisorCorePin(JSON.parse(enrollFs.readFileSync(fd, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return supervisorPinError("core-pin-required");
    return supervisorPinError("core-pin-invalid");
  } finally { if (fd !== undefined) enrollFs.closeSync(fd); }
}
/** Enrollment may add a missing pin, but may never replace an existing one. */
export function installSupervisorCorePin(root: string, value: SupervisorCorePin): void {
  const pin = parseSupervisorCorePin(value), roam = supervisorPinDirectory(root), file = enrollPath.join(roam, "core.json");
  function matching(): boolean {
    let prior: SupervisorCorePin;
    try { prior = readSupervisorCorePin(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "core-pin-required") return false; throw error; }
    if (prior.coreId !== pin.coreId) return supervisorPinError("core-changed");
    if (JSON.stringify(prior) !== JSON.stringify(pin)) return supervisorPinError("core-pin-conflict");
    return true;
  }
  if (matching()) return;
  const temporary = enrollPath.join(roam, `.core-${enrollmentUuid()}`);
  const fd = enrollFs.openSync(temporary, enrollFs.constants.O_WRONLY | enrollFs.constants.O_CREAT | enrollFs.constants.O_EXCL | enrollFs.constants.O_NOFOLLOW, 0o600);
  try { enrollFs.fchmodSync(fd, 0o600); enrollFs.writeFileSync(fd, JSON.stringify(pin) + "\n"); enrollFs.fsyncSync(fd); }
  finally { enrollFs.closeSync(fd); }
  try { try { enrollFs.linkSync(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
  finally { enrollFs.unlinkSync(temporary); }
  const directory = enrollFs.openSync(roam, enrollFs.constants.O_RDONLY | enrollFs.constants.O_DIRECTORY | enrollFs.constants.O_NOFOLLOW);
  try { enrollFs.fsyncSync(directory); } finally { enrollFs.closeSync(directory); }
  if (!matching()) return supervisorPinError("core-pin-invalid");
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
