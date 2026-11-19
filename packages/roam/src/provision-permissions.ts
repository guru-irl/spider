import { posix } from "node:path";

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && posix.isAbsolute(value) &&
    posix.normalize(value) === value && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value);
}

/** A reported path must be in the destination home and related to an approved root. */
export function destinationPermissionPath(value: unknown, home: unknown, roots: readonly unknown[]): value is string {
  if (!absolutePath(value) || !absolutePath(home) || home === "/" || !(value === home || value.startsWith(`${home}/`))) return false;
  return roots.some(root => absolutePath(root) && (root === home || root.startsWith(`${home}/`)) &&
    (value === root || root.startsWith(`${value}/`) || value.startsWith(`${root}/`)));
}

/** Recursive repair applies to a whole package, never its shared ancestors. */
export function permissionTreeRoot(path: unknown, prefix?: string): path is string {
  if (!absolutePath(path)) return false;
  if (prefix !== undefined) {
    const releases = `${prefix}/spider-releases/`;
    return path === posix.join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent") ||
      path.startsWith(releases) && /^[a-f0-9]{64}$/.test(path.slice(releases.length));
  }
  return /\/lib\/node_modules\/@earendil-works\/pi-coding-agent$/.test(path) || /\/spider-releases\/[a-f0-9]{64}$/.test(path);
}

export function permissionRepairCommand(path: string, recursive = false): string {
  return `chmod ${recursive ? "-R " : ""}go-w '${path.replaceAll("'", "'\\''")}'`;
}

/** Accept only a command produced by permissionRepairCommand for a normalized absolute path. */
export function isPermissionRepairCommand(value: unknown): value is string {
  const recursive = typeof value === "string" && value.startsWith("chmod -R ");
  const prefix = recursive ? "chmod -R go-w '" : "chmod go-w '";
  if (typeof value !== "string" || !value.startsWith(prefix) || !value.endsWith("'")) return false;
  const path = value.slice(prefix.length, -1).replaceAll("'\\''", "'");
  return absolutePath(path) && path !== "/" && (!recursive || permissionTreeRoot(path)) && permissionRepairCommand(path, recursive) === value;
}
