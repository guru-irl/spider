import { posix } from "node:path";

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && posix.isAbsolute(value) &&
    posix.normalize(value) === value && !/[\u0000-\u001f\u007f]/.test(value);
}

/** A reported path must be in the destination home and related to an approved root. */
export function destinationPermissionPath(value: unknown, home: unknown, roots: readonly unknown[]): value is string {
  if (!absolutePath(value) || !absolutePath(home) || home === "/" || !(value === home || value.startsWith(`${home}/`))) return false;
  return roots.some(root => absolutePath(root) && (root === home || root.startsWith(`${home}/`)) &&
    (value === root || root.startsWith(`${value}/`) || value.startsWith(`${root}/`)));
}

export function permissionRepairCommand(path: string): string {
  return `chmod go-w '${path.replaceAll("'", "'\\''")}'`;
}

/** Accept only a command produced by permissionRepairCommand for a normalized absolute path. */
export function isPermissionRepairCommand(value: unknown): value is string {
  const prefix = "chmod go-w '";
  if (typeof value !== "string" || !value.startsWith(prefix) || !value.endsWith("'")) return false;
  const path = value.slice(prefix.length, -1).replaceAll("'\\''", "'");
  return absolutePath(path) && path !== "/" && permissionRepairCommand(path) === value;
}
