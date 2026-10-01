import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { findPiPackageRootFromEntry } from "./pi-spawn";

interface Compatibility { fallback: boolean; warning?: string }
const cached = new Map<string, Compatibility>();

/** Resolve exactly the PATH/custom binary (or Windows node script) being launched. */
function resolveLaunchEntry(binary: string, cwd: string): string | undefined {
  const explicit = isAbsolute(binary) || /[/\\]/.test(binary);
  const candidates = explicit ? [resolve(cwd, binary)] : (process.env.PATH ?? "").split(delimiter).flatMap(dir => {
    const entry = resolve(cwd, dir, binary);
    return process.platform === "win32" ? [entry, ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map(ext => entry + ext)] : [entry];
  });
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch { /* Continue PATH search exactly as the launcher does. */ }
  }
  return undefined;
}

function fingerprint(file: string): string {
  try {
    const stat = statSync(file, { bigint: true });
    return `${file}:${stat.mtimeNs}:${stat.size}`;
  } catch { return `${file}:missing`; }
}

function launchCacheKey(entry: string): string {
  const parts = [fingerprint(entry)];
  // Stat the metadata search path without reading it. This also invalidates an
  // unknown lookup when a formerly missing package.json appears after an upgrade.
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    parts.push(fingerprint(join(dir, "package.json")));
  }
  return JSON.stringify(parts);
}

/** Metadata only, never a subprocess. Failed/unknown lookups are cached too. */
export function piRpcCompatibility(spawn: { command: string; args: string[] }, cwd: string): Compatibility {
  const binary = spawn.args[0] ?? spawn.command;
  const entry = resolveLaunchEntry(binary, cwd);
  const key = entry ? launchCacheKey(entry) : JSON.stringify([binary, cwd, process.env.PATH, process.env.PATHEXT]);
  const prior = cached.get(key);
  if (prior) return prior;
  let version: string | undefined;
  try {
    const root = entry && findPiPackageRootFromEntry(entry);
    if (root) {
      const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
      if (typeof metadata.version === "string") version = metadata.version;
    }
  } catch { /* Missing metadata is not evidence of an incompatible version. */ }
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:([-+]).*)?$/);
  let result: Compatibility;
  if (!match) result = { fallback: false, warning: "pi version unknown; using RPC mode." };
  else {
    const [major, minor, patch] = match.slice(1, 4).map(Number);
    const supported = major > 0 || minor > 85 || (minor === 85 && (patch > 1 || (patch === 1 && match[4] !== "-")));
    result = supported ? { fallback: false } : { fallback: true, warning: `Using print mode: installed pi ${version} is below the verified RPC minimum 0.85.1.` };
  }
  cached.set(key, result);
  return result;
}
