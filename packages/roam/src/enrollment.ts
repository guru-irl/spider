import * as enrollFs from "node:fs";
import * as enrollPath from "node:path";
import { randomUUID as enrollmentUuid } from "node:crypto";
import { parseConfig as parseRoamConfig } from "./config";

/** A matching enrollment is never rewritten. Call only after consent and identity claim. */
export function installBoxEnrollment(root: string, machineId: string, hubMachineId: string, coreUnit: string,
  ports: { publish?(source: string, target: string): void } = {}): "enrolled" | "already-enrolled" {
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
  if (matching()) return "already-enrolled";
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
