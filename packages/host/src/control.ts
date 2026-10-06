// packages/host/src/control.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { bundleDoctorLine, type LoadedBundle } from "./build-id";
import { openGlobal, openDbReadOnlyAt, resolveProject, paths, assertTestConfigPath, isThinkingLevel, THINKING_LEVELS, type Db } from "@spider/db-core";
import { getVectorState, getVectorErrors, getEmbedDrainState, getEmbedderState, getEmbedLeaseState, safeReviewError } from "@spider/memory";
import { embeddingRepoPath, getEmbeddingRuntimeErrors } from "./embedding-runtime";

import { isAbsolutePathList } from "@spider/ui";
import { isUsageConfigKey, readUsageConfig, USAGE_DEFAULTS, usageConfigError } from "./usage/config.js";
import { usageDoctorLines } from "./usage/doctor.js";

export { controlMigrate } from "./control/migrate-cmd";

// ── config (plain JSON; precedence defaults < global < project) ──
export const DEFAULTS: Readonly<Record<string, unknown>> = {
  "ui.footer": true,
  ...USAGE_DEFAULTS,
  "embeddings.drain": true,
  "subagents.childMode": "rpc",
  "subagents.keepCacheWarm": true,
  "subagents.extensions": Object.freeze([]),
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
export function readLayer(file: string): { config: Record<string, unknown>; error?: string } {
  try { return { config: readJson(file) }; }
  catch (error) {
    if (!(error instanceof ConfigParseError)) throw error;
    return { config: {}, error: error.message };
  }
}

/** The runtime already resolved its DB path; do not spawn git on each config read. */
export function embeddingDrainEnabled(projectRoot: string): boolean {
  const global = readLayer(configFile(paths.globalRoot));
  const local = readLayer(configFile(projectRoot));
  return { ...DEFAULTS, ...global.config, ...local.config }["embeddings.drain"] !== false;
}

function configLayers(cwd: string, localRoot = paths.projectRoot(cwd)) {
  const globalFile = configFile(paths.globalRoot);
  const localFile = configFile(localRoot);
  const global = readLayer(globalFile);
  const local = readLayer(localFile);
  const errors = [global.error, local.error].filter((s): s is string => s !== undefined);
  for (const [layer, file] of [[global, globalFile], [local, localFile]] as const) {
    const value = layer.config["models.defaults"];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
      errors.push(`invalid models.defaults in ${file}: expected an object`);
    }
    if (Object.hasOwn(layer.config, "subagents.extensions")) {
      const extensions = layer.config["subagents.extensions"];
      if (!isAbsolutePathList(extensions)) {
        errors.push(`invalid subagents.extensions in ${file}: expected a JSON array of absolute file paths`);
      }
      if (layer === local) errors.push(`subagents.extensions in ${file} is ignored: global scope only`);
    }
    if (Object.hasOwn(layer.config, "exec.enforce") && typeof layer.config["exec.enforce"] !== "boolean") {
      errors.push(`invalid value for exec.enforce in ${file}: expected a boolean`);
    }
  }
  errors.push(...readUsageConfig(global.config, local.config).errors);
  const warnings = [...readUsageConfig({}, local.config).errors];
  return { global, local, globalFile, localFile, errors, warnings };
}

/** Read a user-controlled global value without honoring repository overrides. */
export function globalConfigValue(cwd: string, key: string): { value: unknown; file: string } {
  const { global, globalFile } = configLayers(cwd);
  return { value: Object.hasOwn(global.config, key) ? global.config[key] : DEFAULTS[key], file: globalFile };
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
export function configValues(cwd: string, localRoot?: string): {
  config: Record<string, unknown>; sources: Record<string, ConfigSource>; errors: string[]; warnings: string[]; globalFile: string;
} {
  const layers = configLayers(cwd, localRoot);
  const g = layers.global.config;
  const p = layers.local.config;
  const all = { ...DEFAULTS, ...g, ...p };
  const sources: Record<string, ConfigSource> = Object.fromEntries(Object.keys(all).map(key =>
    [key, Object.hasOwn(p, key) ? "local" : Object.hasOwn(g, key) ? "global" : "default"]));
  all["subagents.extensions"] = Object.hasOwn(g, "subagents.extensions") ? g["subagents.extensions"] : DEFAULTS["subagents.extensions"];
  sources["subagents.extensions"] = Object.hasOwn(g, "subagents.extensions") ? "global" : "default";
  const usage = readUsageConfig(g, p).value;
  for (const [key, value] of Object.entries({
    "usage.calibration": usage.calibration, "usage.footer": usage.footer, "usage.counter.poll": usage.counterPoll,
    "usage.alerts.sessionCredits": usage.alertsSessionCredits, "usage.alerts.runCredits": usage.alertsRunCredits,
  })) {
    all[key] = value;
    sources[key] = Object.hasOwn(g, key) && !usageConfigError(key, g[key]) ? "global" : "default";
  }
  if ("models.defaults" in g || "models.defaults" in p) {
    const global = roleMap(g["models.defaults"]);
    const local = roleMap(p["models.defaults"]);
    all["models.defaults"] = { ...global, ...local };
    sources["models.defaults"] = Object.fromEntries(Object.keys({ ...global, ...local }).map(role =>
      [role, Object.hasOwn(local, role) ? "local" : "global"]));
  }
  return { config: all, sources, errors: layers.errors, warnings: layers.warnings, globalFile: layers.globalFile };
}

export interface ConfigWriteResult {
  ok: true; op: "set" | "unset"; key: string; value: unknown;
  scope: "local" | "global"; file: string; shadowedBy?: "local"; notice?: string;
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
  if (op === "set" && key === "subagents.extensions" && scope !== "global") {
    throw new Error('subagents.extensions is global-only; use scope:"global"');
  }
  if (isUsageConfigKey(key)) {
    if (op === "set" && scope !== "global") throw new Error(`${key} is global-only; use scope:"global"`);
    const error = op === "set" ? usageConfigError(key, value) : undefined;
    if (error) throw new Error(error);
  }
  // Ordinary edits stay local unless the caller explicitly chooses global.
  const root = scope === "global" ? paths.globalRoot : paths.projectRoot(cwd);
  const file = configFile(root);
  assertTestConfigPath(file);
  mkdirSync(root, { recursive: true });
  const cur = readJson(file);
  const existed = Object.hasOwn(cur, key);
  const timeoutMax = key === "skills.reviewer.timeoutMs" ? 600000 : 120000;
  if (op === "set" && ["memory.reviewer.timeoutMs", "skills.reviewer.timeoutMs"].includes(key) &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 1000 || value > timeoutMax)) {
    throw new Error(`${key} must be an integer from 1000 to ${timeoutMax} ms`);
  }
  if (op === "set" && ["memory.reviewer.thinking", "skills.reviewer.thinking"].includes(key) &&
    !isThinkingLevel(value)) {
    throw new Error(`${key} thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  if (op === "set" && key === "subagents.extensions" &&
    !isAbsolutePathList(value)) {
    throw new Error("subagents.extensions must be a JSON array of absolute file paths");
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
  const shadowed = !isUsageConfigKey(key) && key !== "subagents.extensions" && scope === "global" && Object.hasOwn(readLayer(configFile(paths.projectRoot(cwd))).config, key);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  assertTestConfigPath(temp);
  try {
    writeFileSync(temp, JSON.stringify(cur, null, 2), { flag: "wx" });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  const notice = op === "unset" && scope === "local" && isUsageConfigKey(key)
    ? existed
      ? `removed the ignored local value; the global value is unchanged: ${JSON.stringify(controlConfig("get", cwd, key))}`
      : "no local value to remove; usage keys are global-only, use --global to reset the global value"
    : undefined;
  return { ok: true, op, key, value: cur[key], scope, file, ...(shadowed ? { shadowedBy: "local" } : {}), ...(notice ? { notice } : {}) };
}

// ── doctor ──
export function controlDoctor(cwd: string, sessionId?: string, bundle?: LoadedBundle, usage?: ReturnType<typeof usageDoctorLines>): { ok: boolean; lines: string[] } {
  const lines: string[] = ["## spider doctor 🕸", ""];
  if (bundle) lines.push(bundleDoctorLine(bundle));
  let ok = true;
  let drainEnabled: boolean | undefined;
  let usageConfig = readUsageConfig({}, {}).value;
  try {
    const values = configValues(cwd);
    for (const error of values.errors) {
      if (values.warnings.includes(error)) lines.push(`- config: ${error}`);
      else { ok = false; lines.push(`- config: FAILED (${error})`); }
    }
    drainEnabled = values.config["embeddings.drain"] !== false;
    usageConfig = readUsageConfig(values.config, {}).value;
  } catch (error) { ok = false; lines.push(`- config: FAILED (${String(error)})`); }
  if (drainEnabled === false) lines.push("- embeddings: drain disabled; queue age is informational");

  const checkVectors = (db: Db, scope: string): void => {
    try {
      const state = getVectorState(db);
      const drain = getEmbedDrainState(db);
      const at = (ts?: number) => ts === undefined ? "never" : new Date(ts).toISOString();
      lines.push(`- vector recall (${scope}): mapped=${state.mapped} indexed=${state.indexed} missing=${state.missing} pending=${state.pending} retried=${state.retried} dead=${state.dead} oldest_queued=${at(drain.oldestQueuedAt)} ${process.env.PI_SUBAGENT_CHILD === "1" ? "runtime history unavailable in child sessions" : `last_attempt=${at(drain.lastAttemptAt)} last_drain=${at(drain.lastDrainAt)}`} last_error=${drain.lastError ?? "none"} drain_errors=${drain.errors} (drain history: this runtime)`);
      if (state.dead > 0) lines.push(`- vector recall (${scope}): warning: ${state.dead} dead rows are skipped after five failures; re-index or replace the owner to retry`);
      const lease = getEmbedLeaseState(db.raw.name);
      if (lease) lines.push(`- embedding lease (${scope}): pid=${lease.pid ?? "unknown"} age_ms=${Math.round(lease.ageMs)} stale=${lease.stale}`);
      if (state.missing > 0 || state.retried > 0
        || ((state.pending + state.retried > 0 || state.dead === 0) && (drain.lastErrorAt ?? 0) > (drain.lastDrainAt ?? 0))
        || (drainEnabled !== false && drain.oldestQueuedAt !== undefined && Date.now() - drain.oldestQueuedAt > 10 * 60 * 1000)) ok = false;
    } catch (error) {
      ok = false;
      lines.push(`- vector recall (${scope}): FAILED (${safeReviewError(error)})`);
    }
  };

  // 1. native deps load
  let vecOk = false;
  try {
    const g = openGlobal();
    try {
      lines.push(`- better-sqlite3: loaded (journal_mode=${String(g.pragma("journal_mode"))})`);
      lines.push(`- global DB migrations/schema: user_version=${String(g.pragma("user_version"))}`);
      try { g.loadVec(); vecOk = true; } catch (e) { ok = false; lines.push(`- sqlite-vec: FAILED (${(e as Error).message})`); }
      if (vecOk) {
        lines.push("- sqlite-vec: loaded (vec0 vectors table ready)");
        lines.push("- vector recall (global): lexical only; no background inference");
      }
    } finally { g.close(); }
  } catch (e) {
    ok = false;
    lines.push(`- better-sqlite3: FAILED (${(e as Error).message})`);
  }

  // 2. project registry integrity
  try {
    const info = resolveProject(cwd, { sessionId, explicitCwd: false });
    lines.push(`- registry: project_key=${info.projectKey.slice(0, 24)}… db=${info.dbPath}`);
    const inspect = (db: Db | undefined, scope: string): void => {
      if (!db) { lines.push(`- vector recall (${scope}): DB absent (no queue/index yet)`); return; }
      try { checkVectors(db, scope); } finally { db.close(); }
    };
    inspect(openDbReadOnlyAt(info.dbPath), "worktree");
    inspect(openDbReadOnlyAt(embeddingRepoPath(info)), "repo");
  } catch (e) {
    ok = false;
    lines.push(`- registry: FAILED (${(e as Error).message})`);
  }

  const errors = getVectorErrors();
  lines.push(`- vector errors (this process): insert=${errors.insert} knn=${errors.knn} repair=${errors.repair}${errors.lastError ? ` last=${errors.lastError}` : ""}`);
  // Historical counters are informational; persisted gaps and current drain health drive ok.
  const workerErrors = getEmbeddingRuntimeErrors();
  if (workerErrors.errors > 0) {
    if ((workerErrors.lastErrorAt ?? 0) > (workerErrors.lastDrainAt ?? 0)) ok = false;
    lines.push(`- embedding worker: errors=${workerErrors.errors} last_error=${workerErrors.lastError}`);
  }

  // 3. embedding provider reachability — lazy, not exercised in Phase 0
  const provider = getEmbedderState();
  lines.push(`- embeddings: fastembed worker state=${provider.state} drain=${drainEnabled === undefined ? "unavailable" : drainEnabled ? "enabled" : "disabled"}${provider.lastError ? ` last_error=${provider.lastError}` : ""}`);
  if (provider.state === "unavailable") ok = false;

  const usageReport = usage ?? usageDoctorLines({ health: null, counter: null, backfill: "pending", reconciliation: null, errorCode: null }, usageConfig);
  ok &&= usageReport.ok;
  lines.push(...usageReport.lines);
  return { ok, lines };
}
