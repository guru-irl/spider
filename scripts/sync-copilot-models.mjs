#!/usr/bin/env node
// scripts/sync-copilot-models.mjs
// Add Copilot models absent from the active pi catalog and migrate shadowing
// entries to modelOverrides without silently dropping differing fields. Existing
// override keys are preserved; conflicts and unsupported fields stop migration.
// A dated snapshot permits additions but never migration. Dry-run by default;
// --write backs up models.json before migration and is idempotent.
import { readFileSync, writeFileSync, existsSync, copyFileSync, constants, accessSync, realpathSync, statSync, openSync, closeSync, fchmodSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import https from "node:https";
import { isDeepStrictEqual } from "node:util";
import { piAgentDir } from "./pi-agent-dir.mjs";

const AUTH_PATH = join(piAgentDir(), "auth.json");
const MODELS_PATH = join(piAgentDir(), "models.json");
const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};
const COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";
/** Auto-compaction threshold, chosen by context window.
 *
 *  A 1M-token model holds so much that letting it fill to the default before compacting
 *  means summarising an enormous history in one pass, so those compact early (30). Smaller
 *  models have nothing to gain from that and just lose usable context, so they keep the
 *  regular 100. Threshold is on the ACTUAL contextWindow, not the model name -- ids like
 *  gemini-3.8-flash (1048576) and gpt-5.6-sol-fast (1050000) are "1M" without saying so. */
const COMPACT_LARGE_CTX = 30;
const COMPACT_DEFAULT = 100;
const LARGE_CTX_TOKENS = 1_000_000;
const compactFor = (ctx) => (ctx >= LARGE_CTX_TOKENS ? COMPACT_LARGE_CTX : COMPACT_DEFAULT);
// Dated snapshot fallback of pi-ai's built-in copilot catalog (2026-07-02). Refresh if pi-ai updates.
const BUILTIN_SNAPSHOT = new Set([
  "claude-fable-5", "claude-haiku-4.5", "claude-opus-4.5", "claude-opus-4.6", "claude-opus-4.7", "claude-opus-4.8",
  "claude-sonnet-4", "claude-sonnet-4.5", "claude-sonnet-4.6", "gemini-2.5-pro", "gemini-3-flash-preview",
  "gemini-3.1-pro-preview", "gemini-3.5-flash", "gpt-4.1", "gpt-5-mini", "gpt-5.2", "gpt-5.2-codex",
  "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5",
]);
const WRITE = process.argv.includes("--write");
const INHERITED_FIELDS = new Set(["api", "contextWindow", "maxTokens"]);
// Pi applies these in applyModelOverride and rawModelHeaders. Spider reads
// compactAtPercent from modelOverrides itself.
const KNOWN_OVERRIDE_FIELDS = new Set([
  "name", "reasoning", "thinkingLevelMap", "input", "inputLimits", "cost", "promptCache",
  "samplingParams", "samplingParamsByThinkingLevel", "headers", "compat", "compactAtPercent",
]);

function fail(msg) { console.error("[sync-copilot-models] " + msg); process.exit(1); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

function readModels() {
  if (!existsSync(MODELS_PATH)) return { providers: {} };
  const content = readFileSync(MODELS_PATH, "utf8");
  try { return JSON.parse(content); }
  catch { fail(`${MODELS_PATH} is not strict JSON; remove comments or migrate by hand. No changes were written.`); }
}

function loadAuth() {
  if (!existsSync(AUTH_PATH)) fail("auth.json not found at " + AUTH_PATH + " — sign in to GitHub Copilot in pi first.");
  const c = (readJson(AUTH_PATH) || {})["github-copilot"] || {};
  if (!c.access) fail("no github-copilot access token in auth.json — sign in to Copilot in pi.");
  if (c.expires && c.expires < Date.now()) console.warn("[sync-copilot-models] WARNING: copilot token expired; request may 401. Re-auth in pi if so.");
  return { token: c.access, available: new Set(c.availableModelIds || []) };
}

function fetchModels(token) {
  return new Promise((resolve, reject) => {
    const req = https.request("https://api.githubcopilot.com/models",
      { method: "GET", headers: { Authorization: "Bearer " + token, ...COPILOT_HEADERS } },
      (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode + ": " + b.slice(0, 300)));
        try { const j = JSON.parse(b); resolve(j.data || j.models || []); } catch (e) { reject(e); }
      }); });
    req.on("error", reject); req.end();
  });
}

function piPackage(dir) {
  try {
    const pkg = readJson(join(dir, "package.json"));
    if (pkg.name === "@earendil-works/pi-coding-agent") return { root: dir, version: pkg.version };
  } catch {}
  return null;
}

function resolvePiPackage() {
  const hint = "Cannot resolve pi on PATH; use --pi-root <dir> to select the pi installation.";
  const flag = process.argv.indexOf("--pi-root");
  if (flag !== -1) {
    const value = process.argv[flag + 1];
    if (!value || value.startsWith("--")) fail(hint);
    try {
      const pkg = piPackage(realpathSync(resolve(value)));
      if (pkg) return pkg;
    } catch {}
    fail("Invalid pi installation. " + hint);
  }
  let executable;
  for (const dir of process.env.PATH === undefined ? [] : process.env.PATH.split(delimiter)) {
    const candidate = resolve(dir || ".", "pi");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) { executable = realpathSync(candidate); break; }
    } catch {}
  }
  if (!executable) fail(hint);
  for (let dir = dirname(executable); ; dir = dirname(dir)) {
    const pkg = piPackage(dir);
    if (pkg) return pkg;
    if (dirname(dir) === dir) break;
  }
  fail(hint);
}

async function resolveOverrideFields(root) {
  const fields = new Set(["compactAtPercent"]);
  try {
    const file = join(root, "dist/core/model-config.js");
    const config = await import(pathToFileURL(file).href);
    const properties = config.ModelsJsonSchemas?.modelOverride?.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw new Error("missing schema");
    for (const key of KNOWN_OVERRIDE_FIELDS) if (Object.hasOwn(properties, key)) fields.add(key);
  } catch {
    console.warn("[sync-copilot-models] override support unavailable for the active pi; differing fields cannot be verified.");
  }
  return fields;
}

async function resolveBuiltinIds() {
  const pi = resolvePiPackage();
  const file = join(pi.root, "node_modules/@earendil-works/pi-ai/dist/providers/github-copilot.models.js");
  console.log("[sync-copilot-models] pi " + pi.version + " at " + pi.root);
  try {
    const mod = await import(pathToFileURL(file).href);
    const catalog = mod.GITHUB_COPILOT_MODELS || mod.default || mod.models;
    const entries = Array.isArray(catalog)
      ? catalog.map((model) => [model?.id, model])
      : catalog && typeof catalog === "object" ? Object.entries(catalog) : [];
    if (entries.length && entries.every(([id, model]) => typeof id === "string" && id && model && typeof model === "object")) {
      const models = new Map(entries);
      console.log("[sync-copilot-models] built-in catalog: " + file + " (" + models.size + " ids)");
      return { models, snapshot: false, overrideFields: await resolveOverrideFields(pi.root) };
    }
  } catch {}
  console.warn("[sync-copilot-models] built-in catalog: using dated SNAPSHOT (" + BUILTIN_SNAPSHOT.size + " ids); migration skipped because the real catalog could not be read.");
  return { models: new Map([...BUILTIN_SNAPSHOT].map((id) => [id, undefined])), snapshot: true, overrideFields: new Set() };
}

function familyApi(vendor) {
  const v = String(vendor || "").toLowerCase();
  if (v.includes("anthropic")) return "anthropic-messages";
  if (v.includes("google")) return "openai-completions";
  return "openai-responses"; // OpenAI, Microsoft (mai-code), xAI, others
}

function synth(m) {
  const s = m.capabilities?.supports || {};
  const lim = m.capabilities?.limits || {};
  const entry = { id: m.id, name: m.name || m.id, api: familyApi(m.vendor), baseUrl: COPILOT_BASE_URL, headers: { ...COPILOT_HEADERS } };
  if (/^claude(?:-|$)/i.test(m.id) && entry.api === "anthropic-messages") entry.promptCache = { short: 300 };
  if (s.adaptive_thinking) entry.compat = { forceAdaptiveThinking: true };
  entry.reasoning = !!(s.adaptive_thinking || (Array.isArray(s.reasoning_effort) && s.reasoning_effort.length));
  if (Array.isArray(s.reasoning_effort) && s.reasoning_effort.includes("max")) entry.thinkingLevelMap = { minimal: "low", xhigh: "max" };
  entry.input = s.vision ? ["text", "image"] : ["text"];
  entry.contextWindow = lim.max_context_window_tokens || 128000;
  entry.maxTokens = lim.max_output_tokens || 16000;
  // Auto-compaction threshold. Without this pi falls back to its built-in default, so every
  // sync used to add models that compacted on a different schedule to the hand-tuned ones --
  // silently, because a missing key looks identical to an intentional one. Scaled by context
  // window: only 1M-token models compact early.
  entry.compactAtPercent = compactFor(entry.contextWindow);
  return entry;
}

function writeModelsAtomically(content) {
  const mode = existsSync(MODELS_PATH) ? statSync(MODELS_PATH).mode & 0o7777 : undefined;
  const temp = `${MODELS_PATH}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temp, "wx", mode ?? 0o666);
  try {
    try {
      writeFileSync(fd, content, "utf8");
      if (mode !== undefined) fchmodSync(fd, mode);
    } finally { closeSync(fd); }
    renameSync(temp, MODELS_PATH);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

function previewOverride(override) {
  const preview = {};
  const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  for (const [key, value] of Object.entries(override)) {
    if (key === "compactAtPercent" && typeof value === "number") preview[key] = value;
    else if (key === "reasoning" && typeof value === "boolean") preview[key] = value;
    else if (key === "input" && Array.isArray(value) && value.every((v) => v === "text" || v === "image")) preview[key] = value;
    else if (key === "thinkingLevelMap" && value && typeof value === "object" && !Array.isArray(value) &&
      Object.entries(value).every(([k, v]) => levels.has(k) && (v === null || levels.has(v)))) preview[key] = value;
    else preview[key] = "[redacted]";
  }
  return JSON.stringify(preview);
}

function headerDifferences(shadow, prior, overlappingOnly) {
  if (!shadow || typeof shadow !== "object" || Array.isArray(shadow) ||
      !prior || typeof prior !== "object" || Array.isArray(prior)) return null;
  return Object.keys(shadow).filter((key) => {
    if (!Object.hasOwn(prior, key)) return !overlappingOnly;
    return !isDeepStrictEqual(shadow[key], prior[key]);
  });
}

// Match pi's mergeCompat ordering when comparing effective compatibility.
const NESTED_COMPAT = ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"];
function mergeCompat(base, override) {
  if (!override) return base;
  const merged = { ...base, ...override };
  for (const key of NESTED_COMPAT) {
    const a = base?.[key], b = override[key];
    if ((typeof a === "object" && a !== null) || (typeof b === "object" && b !== null)) merged[key] = { ...a, ...b };
  }
  return merged;
}

function providerCompatDifferences(shadow, builtin, provider, prior) {
  if (!provider || typeof provider !== "object") return [];
  const before = mergeCompat(mergeCompat(provider, shadow), prior);
  const after = mergeCompat(mergeCompat(builtin, provider), prior);
  const changed = [];
  for (const [key, value] of Object.entries(provider)) {
    if (NESTED_COMPAT.includes(key) && value && typeof value === "object") {
      for (const child of Object.keys(value)) {
        if (!isDeepStrictEqual(before?.[key]?.[child], after?.[key]?.[child])) changed.push(`${key}.${child}`);
      }
    } else if (!isDeepStrictEqual(before?.[key], after?.[key])) changed.push(key);
  }
  return changed;
}

async function main() {
  const { models: builtin, snapshot, overrideFields } = await resolveBuiltinIds();
  const mj = readModels();
  mj.providers ||= {};
  mj.providers["github-copilot"] ||= {};
  const gh = mj.providers["github-copilot"];
  gh.models ||= [];
  const positions = new Map();
  for (const [index, entry] of gh.models.entries()) {
    if (positions.has(entry.id)) {
      fail(`duplicate model ID ${entry.id}: models[${positions.get(entry.id)}] and models[${index}]; no changes were written.`);
    }
    positions.set(entry.id, index);
  }
  const { token, available } = loadAuth();
  if (available.size === 0) console.warn("[sync-copilot-models] WARNING: availableModelIds empty in auth.json — nothing will be considered usable.");
  const all = await fetchModels(token);
  const existing = new Set([...gh.models.map((m) => m.id), ...Object.keys(gh.modelOverrides || {})]);
  const candidates = all.filter((m) => m.capabilities?.type === "chat" && m.model_picker_enabled && available.has(m.id));
  const missing = candidates.filter((m) => !builtin.has(m.id) && !existing.has(m.id));

  const migrations = snapshot ? [] : gh.models.filter((entry) => builtin.has(entry.id)).map((entry) => {
    const differences = {};
    const inherited = [];
    const unsupported = [];
    const conflicts = [];
    const hasOverride = Object.hasOwn(gh.modelOverrides || {}, entry.id);
    const prior = hasOverride ? gh.modelOverrides[entry.id] : {};
    if (!prior || typeof prior !== "object" || Array.isArray(prior)) unsupported.push("modelOverrides");
    else for (const [key, value] of Object.entries(entry)) {
      if (key === "id") continue;
      const equalsBuiltin = isDeepStrictEqual(value, builtin.get(entry.id)[key]);
      if (key === "headers" && Object.hasOwn(prior, key)) {
        // Model entry headers take precedence before migration, even if they
        // equal the built-in. Detect conflicting header names in that case too.
        const names = headerDifferences(value, prior[key], equalsBuiltin);
        if (names === null ? !isDeepStrictEqual(value, prior[key]) : names.length > 0) {
          conflicts.push({ key, names });
        }
      }
      if (equalsBuiltin && key === "baseUrl" && value != null && gh.oauth !== "radius" &&
          gh.baseUrl != null && !isDeepStrictEqual(value, gh.baseUrl)) {
        conflicts.push({ key, names: ["baseUrl"], provider: true });
      }
      if (equalsBuiltin && key === "headers" && gh.headers) {
        const before = { ...gh.headers, ...prior.headers, ...value };
        const after = { ...builtin.get(entry.id).headers, ...gh.headers, ...prior.headers };
        const names = Object.keys(gh.headers).filter((name) => !isDeepStrictEqual(before[name], after[name]));
        if (names.length) conflicts.push({ key, names, provider: true });
      }
      if (equalsBuiltin && key === "compat" && gh.compat) {
        const names = providerCompatDifferences(value, builtin.get(entry.id).compat, gh.compat, prior.compat);
        if (names.length) conflicts.push({ key, names, provider: true });
      }
      if (equalsBuiltin) continue;
      if (INHERITED_FIELDS.has(key)) inherited.push(key);
      else if (!overrideFields.has(key)) unsupported.push(key);
      else if (!Object.hasOwn(prior, key)) differences[key] = value;
      else if (key !== "headers" && !isDeepStrictEqual(value, prior[key])) conflicts.push({ key });
    }
    return { id: entry.id, override: { ...differences, ...prior }, hasOverride, inherited, unsupported, conflicts };
  });

  for (const m of migrations) {
    if (m.inherited.length) {
      const existingLimits = m.inherited.filter((key) => Object.hasOwn(m.override, key));
      console.log(`  ~ ${m.id}: shadow fields inherit from pi: ${m.inherited.join(", ")}${existingLimits.length ? `; existing overrides remain: ${existingLimits.join(", ")}` : ""}`);
    }
  }
  if (migrations.some((m) => m.unsupported.length || m.conflicts.length)) {
    for (const m of migrations) {
      if (m.unsupported.length) console.error(`[sync-copilot-models] ${m.id}: unsupported fields ${m.unsupported.join(", ")}`);
      for (const conflict of m.conflicts) {
        console.error(`[sync-copilot-models] ${m.id}: conflicting field ${conflict.key}${conflict.names?.length ? ` (${conflict.provider ? "provider keys: " : ""}${conflict.names.join(", ")})` : ""}`);
      }
    }
    fail("cannot migrate conflicting or unsupported fields; no changes were written.");
  }
  console.log(`[sync-copilot-models] usable picker chat models: ${candidates.length}; built-in: ${builtin.size}; already in models.json: ${existing.size}`);
  console.log(`[sync-copilot-models] ${missing.length} to add; ${migrations.length} to migrate.`);
  if (!missing.length && !migrations.length) return;
  const synthed = missing.map(synth);
  for (const e of synthed) console.log(`  + ${e.id.padEnd(28)} api=${e.api} ctx=${e.contextWindow} out=${e.maxTokens} reasoning=${e.reasoning} vision=${e.input.includes("image")}`);
  for (const m of migrations) console.log(`  ~ ${m.id} -> ${previewOverride(m.override)}${m.hasOverride ? " (existing override keys kept)" : ""}`);
  if (!WRITE) { console.log("[sync-copilot-models] dry-run (no changes). Re-run with --write to apply."); return; }
  if (migrations.length) {
    const backup = MODELS_PATH + ".bak-" + Date.now();
    copyFileSync(MODELS_PATH, backup, constants.COPYFILE_EXCL);
    console.log(`[sync-copilot-models] backup: ${backup}`);
    gh.models = gh.models.filter((entry) => !builtin.has(entry.id));
    for (const m of migrations) gh.modelOverrides = { ...gh.modelOverrides, [m.id]: m.override };
  }
  gh.models.push(...synthed);
  writeModelsAtomically(JSON.stringify(mj, null, 2) + "\n");
  console.log(`[sync-copilot-models] wrote ${synthed.length} addition(s) and ${migrations.length} migration(s) to ${MODELS_PATH}`);
}
main().catch((e) => fail(e.message || String(e)));
