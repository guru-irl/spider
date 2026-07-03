// packages/host/src/control.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openGlobal, resolveProject, paths } from "@spider/db-core";

// ── config (plain JSON; precedence defaults < global < project) ──
const DEFAULTS: Record<string, unknown> = {
  "ui.footer": true,
  "ui.grid_hotkey": "ctrl+shift+g",
  "organism.enabled": true,
  "embeddings.provider": "fastembed",
  "embeddings.model": "BGE-small-en-v1.5",
  "embeddings.dim": 384,
};

function configFile(scopeRoot: string): string {
  return join(scopeRoot, "config.json");
}
function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>; } catch { return {}; }
}
function merged(cwd: string): Record<string, unknown> {
  const g = readJson(configFile(paths.globalRoot));
  const p = readJson(configFile(paths.projectRoot(cwd)));
  return { ...DEFAULTS, ...g, ...p };
}

export function controlConfig(op: "get" | "set", cwd: string, key?: string, value?: unknown): unknown {
  if (op === "get") {
    const all = merged(cwd);
    return key === undefined ? all : all[key];
  }
  // set → write to the PROJECT config (project overrides global)
  const root = paths.projectRoot(cwd);
  mkdirSync(root, { recursive: true });
  const file = configFile(root);
  const cur = readJson(file);
  if (key === undefined) throw new Error("control config set: key required");
  cur[key] = value;
  writeFileSync(file, JSON.stringify(cur, null, 2));
  return { ok: true, key, value };
}

// ── doctor ──
export function controlDoctor(cwd: string): { ok: boolean; lines: string[] } {
  const lines: string[] = ["## spider doctor 🕸", ""];
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
    const info = resolveProject(cwd);
    lines.push(`- registry: project_key=${info.projectKey.slice(0, 24)}… db=${info.dbPath}`);
  } catch (e) {
    ok = false;
    lines.push(`- registry: FAILED (${(e as Error).message})`);
  }

  // 3. embedding provider reachability — lazy, not exercised in Phase 0
  lines.push("- embeddings: fastembed (lazy; model download deferred to Phase 1)");

  return { ok, lines };
}
