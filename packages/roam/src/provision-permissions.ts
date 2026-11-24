import { posix } from "node:path";
import type { AgentPrivateModeFailure, AgentPrivateModeRepair, AgentModePreview } from "./selected-files";

export const MAX_PERMISSION_TIGHTENINGS = 1_000_000;
export function isPermissionTighteningCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PERMISSION_TIGHTENINGS;
}

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

function agentPath(path: unknown, home: string, root: string): path is string {
  return destinationPermissionPath(path, home, [root]) && (path === root || path.startsWith(`${root}/`));
}
function mode(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0o7777; }
function uid(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function isAgentModeFailure(value: unknown, home?: string, root?: string): value is AgentPrivateModeFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join() === "mode,path,problem,uid" && (home !== undefined && root !== undefined ? agentPath(v.path, home, root) : absolutePath(v.path)) && mode(v.mode) && uid(v.uid) &&
    typeof v.problem === "string" && ["owner", "symlink", "type", "hard-link", "owner-mode", "changed", "tightening-failed", "limit"].includes(v.problem);
}
export function isAgentModeRepairs(value: unknown, home?: string, root?: string): value is readonly AgentPrivateModeRepair[] {
  return Array.isArray(value) && value.length <= 10_000 && new Set(value.map(v => v?.path)).size === value.length && value.every(v =>
    v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === "after,before,path,uid" &&
    (home !== undefined && root !== undefined ? agentPath(v.path, home, root) : absolutePath(v.path)) && uid(v.uid) && mode(v.before) && (v.after === 0o600 || v.after === 0o700) &&
    v.before !== v.after && (v.before & 0o7700) === v.after);
}
export function isAgentModePreview(value: unknown, home: string, root: string): value is AgentModePreview {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === "authPresent,repairs" &&
    "authPresent" in value && typeof value.authPresent === "boolean" && "repairs" in value && isAgentModeRepairs(value.repairs, home, root);
}
export function agentModeRefusal(value: AgentPrivateModeFailure): string {
  const found = value.mode.toString(8).padStart(4, "0"), path = `'${value.path.replaceAll("'", "'\\''")}'`;
  const target = (value.mode & 0o100) !== 0 ? "0700" : "0600";
  const repair = value.problem === "tightening-failed" ? `Allow chmod ${target} ${path} for the provisioning uid, then reprovision.`
    : value.problem === "owner" ? `Have the owner move ${path} out of the agent tree, then reprovision.`
    : value.problem === "symlink" || value.problem === "hard-link" || value.problem === "type" ? `Replace ${path} with a same-uid regular file or directory without links, then reprovision.`
    : value.problem === "owner-mode" ? `Set owner permissions to ${target} on ${path}, then reprovision.`
    : value.problem === "limit" ? `Reduce the agent tree to at most 10000 entries, then reprovision.`
    : `Stop writers changing ${path}, then reprovision.`;
  return `unsafe-destination (${value.path}; mode ${found}; uid ${value.uid}; ${value.problem}). ${repair}`;
}
export function isAgentModeRefusal(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 16_384) return false;
  const match = /^unsafe-destination \((.+); mode ([0-7]{4}); uid ([0-9]+); ([a-z-]+)\)\. /.exec(value);
  if (!match || !absolutePath(match[1])) return false;
  const details = { path: match[1], mode: Number.parseInt(match[2], 8), uid: Number(match[3]), problem: match[4] };
  return isAgentModeFailure(details) && agentModeRefusal(details) === value;
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
