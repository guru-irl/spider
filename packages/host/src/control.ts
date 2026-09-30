// packages/host/src/control.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { bundleDoctorLine, type LoadedBundle } from "./build-id";
import { openGlobal, resolveProject, paths, assertTestConfigPath } from "@spider/db-core";

export { controlMigrate } from "./control/migrate-cmd";

// ── config (plain JSON; precedence defaults < global < project) ──
export const DEFAULTS: Readonly<Record<string, unknown>> = {
  "ui.footer": true,
  "subagents.childMode": "rpc",
  "memory.reviewer.enabled": true,
  "memory.reviewer.model": "github-copilot/gpt-6-luna",
  "memory.reviewer.timeoutMs": 45000,
  "memory.reviewer.thinking": "medium",
  "skills.reviewer.enabled": true,
  "skills.reviewer.model": "github-copilot/gpt-6-luna",
  "skills.reviewer.timeoutMs": 180000,
  "skills.reviewer.thinking": "xhigh",
};

function configFile(scopeRoot: string): string {
  return join(scopeRoot, "config.json");
}
class ConfigParseError extends Error {}

function readJson(file: string): Record<string, unknown> {
  assertTestConfigPath(file);
  if (!existsSync(file)) return {};
  let text: string;
  try { text = readFileSync(file, "utf-8"); }
  catch (error) {
    throw new ConfigParseError(`unreadable config file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ConfigParseError(`cannot parse config file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function readLayer(file: string): { config: Record<string, unknown>; error?: string } {
  try { return { config: readJson(file) }; }
  catch (error) {
    if (!(error instanceof ConfigParseError)) throw error;
    return { config: {}, error: error.message };
  }
}

function configLayers(cwd: string) {
  const globalFile = configFile(paths.globalRoot);
  const localFile = configFile(paths.projectRoot(cwd));
  const global = readLayer(globalFile);
  const local = readLayer(localFile);
  const errors = [global.error, local.error].filter((s): s is string => s !== undefined);
  for (const [layer, file] of [[global, globalFile], [local, localFile]] as const) {
    const value = layer.config["models.defaults"];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
      errors.push(`invalid models.defaults in ${file}: expected an object`);
    }
    if (Object.hasOwn(layer.config, "exec.enforce") && typeof layer.config["exec.enforce"] !== "boolean") {
      errors.push(`invalid value for exec.enforce in ${file}: expected a boolean`);
    }
  }
  return { global, local, globalFile, localFile, errors };
}

/** One read of each layer supplies the effective enforcement value, parse errors, and diagnostics. */
export function execEnforcement(cwd: string): { current: unknown; errors: string[]; diagnostics: string[] } {
  const { global, local, globalFile, localFile, errors: diagnostics } = configLayers(cwd);
  const localWins = Object.hasOwn(local.config, "exec.enforce");
  const current = localWins ? local.config["exec.enforce"] : global.config["exec.enforce"];
  const effectiveFile = localWins ? localFile : globalFile;
  const errors = [global.error, local.error].filter((s): s is string => s !== undefined);
  if (current !== undefined && typeof current !== "boolean") {
    errors.push(`invalid value for exec.enforce in ${effectiveFile}: expected a boolean`);
  }
  return { current, errors, diagnostics };
}

/** Malformed read layers are skipped, but their paths remain visible to callers. */
export function configReadErrors(cwd: string): string[] { return configLayers(cwd).errors; }

function roleMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** Per-role precedence: explicit local roles shadow global roles, not the entire map. */
export function modelDefaultLayers(cwd: string): {
  global: Record<string, string>; local: Record<string, string>;
  defaults: Record<string, string>; sources: Record<string, "global" | "local">; errors: string[];
} {
  const layers = configLayers(cwd);
  const global = roleMap(layers.global.config["models.defaults"]);
  const local = roleMap(layers.local.config["models.defaults"]);
  return {
    global, local, errors: layers.errors, defaults: { ...global, ...local },
    sources: Object.fromEntries(Object.keys({ ...global, ...local }).map(role => [role, role in local ? "local" : "global"])),
  };
}

/** Scoped model edits use the unfiltered map and the strict write-side parser. */
export function modelDefaultLayerForEdit(cwd: string, scope: "local" | "global"): Record<string, unknown> {
  const file = configFile(scope === "global" ? paths.globalRoot : paths.projectRoot(cwd));
  const value = readJson(file)["models.defaults"];
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid models.defaults in ${file}: expected an object`);
  return value as Record<string, unknown>;
}

type ConfigSource = "default" | "global" | "local" | Record<string, "global" | "local">;

/** Effective config and its provenance come from the same read of both layers. */
export function configValues(cwd: string): {
  config: Record<string, unknown>; sources: Record<string, ConfigSource>; errors: string[];
} {
  const layers = configLayers(cwd);
  const g = layers.global.config;
  const p = layers.local.config;
  const all = { ...DEFAULTS, ...g, ...p };
  const sources: Record<string, ConfigSource> = Object.fromEntries(Object.keys(all).map(key =>
    [key, Object.hasOwn(p, key) ? "local" : Object.hasOwn(g, key) ? "global" : "default"]));
  if ("models.defaults" in g || "models.defaults" in p) {
    const global = roleMap(g["models.defaults"]);
    const local = roleMap(p["models.defaults"]);
    all["models.defaults"] = { ...global, ...local };
    sources["models.defaults"] = Object.fromEntries(Object.keys({ ...global, ...local }).map(role =>
      [role, Object.hasOwn(local, role) ? "local" : "global"]));
  }
  return { config: all, sources, errors: layers.errors };
}

export interface ConfigWriteResult {
  ok: true; op: "set" | "unset"; key: string; value: unknown;
  scope: "local" | "global"; file: string; shadowedBy?: "local";
}

export function controlConfig(op: "set" | "unset", cwd: string, key: string, value?: unknown, scope?: "local" | "global"): ConfigWriteResult;
export function controlConfig(op: "get" | "set" | "unset", cwd: string, key?: string, value?: unknown, scope?: "local" | "global"): unknown;
export function controlConfig(op: "get" | "set" | "unset", cwd: string, key?: string, value?: unknown, scope: "local" | "global" = "local"): unknown {
  if (op === "get") {
    const all = configValues(cwd).config;
    return key === undefined ? all : all[key];
  }
  if (scope !== "local" && scope !== "global") throw new Error("control config: scope must be global or local");
  if (key === undefined) throw new Error(`control config ${op}: key required`);
  // Ordinary edits stay local unless the caller explicitly chooses global.
  const root = scope === "global" ? paths.globalRoot : paths.projectRoot(cwd);
  const file = configFile(root);
  assertTestConfigPath(file);
  mkdirSync(root, { recursive: true });
  const cur = readJson(file);
  const timeoutMax = key === "skills.reviewer.timeoutMs" ? 600000 : 120000;
  if (op === "set" && ["memory.reviewer.timeoutMs", "skills.reviewer.timeoutMs"].includes(key) &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 1000 || value > timeoutMax)) {
    throw new Error(`${key} must be an integer from 1000 to ${timeoutMax} ms`);
  }
  if (op === "set" && ["memory.reviewer.thinking", "skills.reviewer.thinking"].includes(key) &&
    (typeof value !== "string" || !["minimal", "low", "medium", "high", "xhigh"].includes(value))) {
    throw new Error(`${key} thinking must be minimal, low, medium, high or xhigh`);
  }
  if (op === "set" && key === "subagents.childMode" && value !== "rpc" && value !== "print") {
    throw new Error("subagents.childMode must be rpc or print");
  }
  if (op === "unset") {
    // Only the snapshot cap accepts unlimited. Other keys inherit after deletion.
    const global = key === "memory.snapshotCharCap"
      ? (scope === "global" ? cur : readJson(configFile(paths.globalRoot))) : {};
    if (Object.hasOwn(global, key)) cur[key] = "unlimited";
    else delete cur[key];
  } else cur[key] = value;
  const shadowed = scope === "global" && Object.hasOwn(readLayer(configFile(paths.projectRoot(cwd))).config, key);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  assertTestConfigPath(temp);
  try {
    writeFileSync(temp, JSON.stringify(cur, null, 2), { flag: "wx" });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  return { ok: true, op, key, value: cur[key], scope, file, ...(shadowed ? { shadowedBy: "local" } : {}) };
}

// ── doctor ──
export function controlDoctor(cwd: string, sessionId?: string, bundle?: LoadedBundle): { ok: boolean; lines: string[] } {
  const lines: string[] = ["## spider doctor 🕸", ""];
  if (bundle) lines.push(bundleDoctorLine(bundle));
  let ok = true;

  // 1. native deps load
  let vecOk = false;
  try {
    const g = openGlobal();
    lines.push(`- better-sqlite3: loaded (journal_mode=${String(g.pragma("journal_mode"))})`);
    lines.push(`- global DB migrations/schema: user_version=${String(g.pragma("user_version"))}`);
    try { g.loadVec(); vecOk = true; } catch (e) { ok = false; lines.push(`- sqlite-vec: FAILED (${(e as Error).message})`); }
    if (vecOk) lines.push("- sqlite-vec: loaded (vec0 vectors table ready)");
    g.close();
  } catch (e) {
    ok = false;
    lines.push(`- better-sqlite3: FAILED (${(e as Error).message})`);
  }

  // 2. project registry integrity
  try {
    const info = resolveProject(cwd, { sessionId, explicitCwd: false });
    lines.push(`- registry: project_key=${info.projectKey.slice(0, 24)}… db=${info.dbPath}`);
  } catch (e) {
    ok = false;
    lines.push(`- registry: FAILED (${(e as Error).message})`);
  }

  // Read diagnostics are separate from writes, which must never overwrite malformed JSON.
  try {
    for (const error of configReadErrors(cwd)) { ok = false; lines.push(`- config: FAILED (${error})`); }
  } catch (error) { ok = false; lines.push(`- config: FAILED (${String(error)})`); }

  // 3. embedding provider reachability — lazy, not exercised in Phase 0
  lines.push("- embeddings: fastembed (lazy; model download deferred to Phase 1)");

  return { ok, lines };
}
