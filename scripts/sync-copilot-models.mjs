#!/usr/bin/env node
// scripts/sync-copilot-models.mjs
// Additively surface GitHub Copilot models that pi-ai does NOT ship built-in into
// ~/.pi/agent/models.json, so pi can route to the latest copilot models (Amendment A8).
// Dry-run by default; pass --write to apply. Idempotent + additive: never edits
// modelOverrides or existing entries; skips ids pi-ai already provides (avoids clobbering built-ins).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import https from "node:https";

const HOME = homedir();
const AUTH_PATH = join(HOME, ".pi/agent/auth.json");
const MODELS_PATH = join(HOME, ".pi/agent/models.json");
const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};
const COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";
// Dated snapshot fallback of pi-ai's built-in copilot catalog (2026-07-02). Refresh if pi-ai updates.
const BUILTIN_SNAPSHOT = new Set([
  "claude-fable-5", "claude-haiku-4.5", "claude-opus-4.5", "claude-opus-4.6", "claude-opus-4.7", "claude-opus-4.8",
  "claude-sonnet-4", "claude-sonnet-4.5", "claude-sonnet-4.6", "gemini-2.5-pro", "gemini-3-flash-preview",
  "gemini-3.1-pro-preview", "gemini-3.5-flash", "gpt-4.1", "gpt-5-mini", "gpt-5.2", "gpt-5.2-codex",
  "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5",
]);
const WRITE = process.argv.includes("--write");

function fail(msg) { console.error("[sync-copilot-models] " + msg); process.exit(1); }
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

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

function searchBuiltinFile() {
  const roots = [join(HOME, ".volta"), "/usr/local/lib/node_modules", join(HOME, ".npm-global"), join(HOME, ".nvm")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const out = execSync(`find "${root}" -maxdepth 14 -path "*@earendil-works/pi-ai/dist/providers/github-copilot.models.js" -print 2>/dev/null | head -1`, { encoding: "utf8", timeout: 8000 }).trim();
      if (out) return out;
    } catch {}
  }
  return null;
}

async function resolveBuiltinIds() {
  const candidates = [];
  if (process.env.SPIDER_PIAI_MODELS) candidates.push(process.env.SPIDER_PIAI_MODELS);
  try { candidates.push(createRequire(import.meta.url).resolve("@earendil-works/pi-ai/dist/providers/github-copilot.models.js")); } catch {}
  const found = searchBuiltinFile(); if (found) candidates.push(found);
  for (const file of candidates) {
    try {
      if (!file || !existsSync(file)) continue;
      const mod = await import(pathToFileURL(file).href);
      const arr = mod.GITHUB_COPILOT_MODELS || mod.default || mod.models;
      if (Array.isArray(arr) && arr.length) {
        const ids = new Set(arr.map((m) => m.id).filter(Boolean));
        console.log("[sync-copilot-models] built-in catalog: " + file + " (" + ids.size + " ids)");
        return ids;
      }
    } catch {}
  }
  console.warn("[sync-copilot-models] built-in catalog: using dated SNAPSHOT (" + BUILTIN_SNAPSHOT.size + " ids); refresh if pi-ai updated.");
  return new Set(BUILTIN_SNAPSHOT);
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
  if (s.adaptive_thinking) entry.compat = { forceAdaptiveThinking: true };
  entry.reasoning = !!(s.adaptive_thinking || (Array.isArray(s.reasoning_effort) && s.reasoning_effort.length));
  if (Array.isArray(s.reasoning_effort) && s.reasoning_effort.includes("max")) entry.thinkingLevelMap = { minimal: "low", xhigh: "max" };
  entry.input = s.vision ? ["text", "image"] : ["text"];
  entry.contextWindow = lim.max_context_window_tokens || 128000;
  entry.maxTokens = lim.max_output_tokens || 16000;
  return entry;
}

async function main() {
  const { token, available } = loadAuth();
  if (available.size === 0) console.warn("[sync-copilot-models] WARNING: availableModelIds empty in auth.json — nothing will be considered usable.");
  const all = await fetchModels(token);
  const builtin = await resolveBuiltinIds();
  const mj = existsSync(MODELS_PATH) ? readJson(MODELS_PATH) : { providers: {} };
  mj.providers ||= {};
  mj.providers["github-copilot"] ||= {};
  const gh = mj.providers["github-copilot"];
  gh.models ||= [];
  const existing = new Set([...gh.models.map((m) => m.id), ...Object.keys(gh.modelOverrides || {})]);
  const candidates = all.filter((m) => m.capabilities?.type === "chat" && m.model_picker_enabled && available.has(m.id));
  const missing = candidates.filter((m) => !builtin.has(m.id) && !existing.has(m.id));

  console.log(`[sync-copilot-models] usable picker chat models: ${candidates.length}; built-in: ${builtin.size}; already in models.json: ${existing.size}`);
  if (missing.length === 0) { console.log("[sync-copilot-models] models.json is up to date (0 to add)."); return; }
  console.log(`[sync-copilot-models] ${missing.length} model(s) to add:`);
  const synthed = missing.map(synth);
  for (const e of synthed) console.log(`  + ${e.id.padEnd(28)} api=${e.api} ctx=${e.contextWindow} out=${e.maxTokens} reasoning=${e.reasoning} vision=${e.input.includes("image")}`);
  if (!WRITE) { console.log("[sync-copilot-models] dry-run (no changes). Re-run with --write to apply."); return; }
  gh.models.push(...synthed);
  writeFileSync(MODELS_PATH, JSON.stringify(mj, null, 2) + "\n", "utf8");
  console.log(`[sync-copilot-models] wrote ${synthed.length} entr${synthed.length === 1 ? "y" : "ies"} to ${MODELS_PATH}`);
}
main().catch((e) => fail(e.message || String(e)));
