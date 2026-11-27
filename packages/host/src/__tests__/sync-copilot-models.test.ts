import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const scratchRoot = join(root, ".spider/scratch");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "sync-copilot-models-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let fixture: string;
let modelsPath: string;

beforeEach(() => {
  fixture = mkdtempSync(join(scratch, "fixture-"));
  const agent = join(fixture, ".pi/agent");
  mkdirSync(agent, { recursive: true });
  modelsPath = join(agent, "models.json");
  writeFileSync(join(fixture, "builtins.mjs"), 'export const GITHUB_COPILOT_MODELS = [{ id: "fixture-builtin" }];\n');
  // Replace only home discovery, HTTP catalog retrieval and global catalog search.
  // All additive filtering and models.json reads/writes run in the real script.
  writeFileSync(join(fixture, "boundary.mjs"), `
import os from 'node:os';
import https from 'node:https';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import { EventEmitter } from 'node:events';
const originalRead = fs.readFileSync;
const originalExists = fs.existsSync;
const originalCreateRequire = module.createRequire;
fs.existsSync = (path) => String(path) === process.env.FIXTURE_HOME + '/.pi/agent/auth.json' || originalExists(path);
fs.readFileSync = (path, ...args) => {
  if (String(path).endsWith('/auth.json')) {
    if (String(path) !== process.env.FIXTURE_HOME + '/.pi/agent/auth.json') throw new Error('unexpected credential read');
    const models = JSON.parse(originalRead(process.env.FIXTURE_HOME + '/catalog.json', 'utf8')).data;
    return JSON.stringify({ 'github-copilot': { access: 'fixture', availableModelIds: models.map(m => m.id) } });
  }
  return originalRead(path, ...args);
};
module.createRequire = (url) => {
  const require = originalCreateRequire(url);
  if (String(url).endsWith('/scripts/sync-copilot-models.mjs')) {
    require.resolve = () => { throw new Error('package catalog disabled in fixture'); };
  }
  return require;
};
if (process.env.FIXTURE_NATIVE_HOME === '1') {
  // Refuse to read auth/config if fixture home isolation is missing.
  if (process.env.HOME !== process.env.FIXTURE_HOME || process.env.USERPROFILE !== process.env.FIXTURE_HOME) {
    throw new Error('fixture HOME and USERPROFILE must be isolated');
  }
} else os.homedir = () => process.env.FIXTURE_HOME;
childProcess.execSync = () => { throw new Error('global catalog search disabled in fixture'); };
https.request = (url, options, callback) => {
  if (url !== 'https://api.githubcopilot.com/models' || options.method !== 'GET') throw new Error('unexpected catalog request');
  const req = new EventEmitter();
  req.end = () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    callback(res);
    res.emit('data', originalRead(process.env.FIXTURE_HOME + '/catalog.json', 'utf8'));
    res.emit('end');
  };
  return req;
};
module.syncBuiltinESMExports();
`);
});

function invoke(write = true, nativeHome = false) {
  return spawnSync(process.execPath, ["--import", join(fixture, "boundary.mjs"), join(root, "scripts/sync-copilot-models.mjs"), ...(write ? ["--write"] : [])], {
    cwd: fixture, encoding: "utf8",
    env: { ...process.env, HOME: fixture, USERPROFILE: fixture, FIXTURE_HOME: fixture, PI_CODING_AGENT_DIR: undefined,
      FIXTURE_NATIVE_HOME: nativeHome ? "1" : "0", SPIDER_PIAI_MODELS: join(fixture, "builtins.mjs") },
  });
}
function run(models: object[], config: object, write = true, nativeHome = false) {
  writeFileSync(join(fixture, "catalog.json"), JSON.stringify({ data: models }));
  writeFileSync(modelsPath, JSON.stringify(config));
  return invoke(write, nativeHome);
}
const model = (id: string, vendor: string) => ({
  id, vendor, model_picker_enabled: true,
  capabilities: { type: "chat", supports: { adaptive_thinking: true }, limits: { max_context_window_tokens: 200000 } },
});
const config = () => ({ providers: { "github-copilot": { models: [] } } });
function saved() { return JSON.parse(readFileSync(modelsPath, "utf8")); }

describe("Copilot model sync catalog", () => {
  // Treating the keyed catalog as a snapshot adds a model already built in.
  it("recognizes built-in models in an object keyed by ID", () => {
    writeFileSync(join(fixture, "builtins.mjs"), 'export const GITHUB_COPILOT_MODELS = { "model-a": { id: "model-a" } };\n');
    const result = run([model("model-a", "Example")], config());
    expect(result.status, result.stderr).toBe(0);
    expect(saved().providers["github-copilot"].models).toEqual([]);
    expect(result.stdout).toContain("built-in catalog:");
    expect(result.stdout).not.toContain("SNAPSHOT");
  });

  it("recognizes built-in models in an array", () => {
    writeFileSync(join(fixture, "builtins.mjs"), 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a" }];\n');
    const result = run([model("model-a", "Example")], config());
    expect(result.status, result.stderr).toBe(0);
    expect(saved().providers["github-copilot"].models).toEqual([]);
    expect(result.stdout).not.toContain("SNAPSHOT");
  });

  // A shadow must become a narrow override even if it is not in the live picker.
  it("previews migration and keeps the file untouched during a dry run", () => {
    writeFileSync(join(fixture, "builtins.mjs"), 'export const GITHUB_COPILOT_MODELS = { "model-a": { id: "model-a" } };\n');
    const before = { providers: { "github-copilot": {
      models: [{ id: "model-a", compactAtPercent: 30, thinkingLevelMap: { xhigh: "max" }, contextWindow: 123 }],
      modelOverrides: { "model-a": { compactAtPercent: 70, name: "custom" } },
    } } };
    const result = run([], before, false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("model-a");
    expect(result.stdout).toContain('"compactAtPercent":70');
    expect(result.stdout).toContain('"thinkingLevelMap":{"xhigh":"max"}');
    expect(result.stdout).toMatch(/existing override/i);
    expect(readFileSync(modelsPath, "utf8")).toBe(JSON.stringify(before));
    expect(readdirSync(join(fixture, ".pi/agent"))).toEqual(["models.json"]);
  });

  // Copying all model fields, dropping thinking or overwriting hand tuning changes behavior.
  it("backs up and migrates only deliberate differences, preserving existing overrides", () => {
    writeFileSync(join(fixture, "builtins.mjs"), `export const GITHUB_COPILOT_MODELS = {
      "model-a": { id: "model-a", promptCache: { short: 60 }, thinkingLevelMap: { xhigh: "high" }, compat: { forceAdaptiveThinking: false } },
      "model-b": { id: "model-b", promptCache: { long: 10, short: 5 }, compat: { forceAdaptiveThinking: true } }
    };\n`);
    const before = { providers: {
      "github-copilot": {
        extra: "keep",
        models: [
          { id: "model-a", name: "old", api: "example", baseUrl: "example", headers: { a: "b" }, input: ["text"], contextWindow: 123, maxTokens: 45, reasoning: true, cost: { input: 5 }, compactAtPercent: 30, promptCache: { short: 300 }, thinkingLevelMap: { minimal: "low", xhigh: "max" }, compat: { forceAdaptiveThinking: true } },
          { id: "model-b", promptCache: { short: 5, long: 10 }, compat: { forceAdaptiveThinking: true } },
          { id: "model-c", contextWindow: 100 },
        ],
        modelOverrides: { "model-a": { compactAtPercent: 70, name: "custom", compat: { custom: true } }, "model-d": { name: "keep" } },
      },
      other: { models: [{ id: "model-a", contextWindow: 5 }] },
    } };
    const result = run([], before);
    expect(result.status, result.stderr).toBe(0);
    const after = saved();
    expect(after.providers.other).toEqual(before.providers.other);
    expect(after.providers["github-copilot"].extra).toBe("keep");
    expect(after.providers["github-copilot"].models).toEqual([{ id: "model-c", contextWindow: 100 }]);
    expect(after.providers["github-copilot"].modelOverrides).toEqual({
      "model-a": { compactAtPercent: 70, name: "custom", compat: { custom: true }, promptCache: { short: 300 }, thinkingLevelMap: { minimal: "low", xhigh: "max" } },
      "model-b": {},
      "model-d": { name: "keep" },
    });
    const backups = readdirSync(join(fixture, ".pi/agent")).filter(name => /^models\.json\.bak-\d+$/.test(name));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(fixture, ".pi/agent", backups[0]), "utf8")).toBe(JSON.stringify(before));
    const once = readFileSync(modelsPath, "utf8");
    const mtime = statSync(modelsPath).mtimeMs;
    const again = invoke();
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/0 to add/);
    expect(again.stdout).toMatch(/0 to migrate/);
    expect(readFileSync(modelsPath, "utf8")).toBe(once);
    expect(statSync(modelsPath).mtimeMs).toBe(mtime);
    expect(readdirSync(join(fixture, ".pi/agent")).filter(name => name.startsWith("models.json.bak-"))).toEqual(backups);
  });

  // A dated snapshot cannot identify safe migrations, but additions still work.
  it("does not migrate on snapshot fallback and still adds missing models", () => {
    writeFileSync(join(fixture, "builtins.mjs"), 'export const GITHUB_COPILOT_MODELS = {};\n');
    const entry = { id: "model-a", compactAtPercent: 30 };
    const result = run([model("model-b", "Example")], { providers: { "github-copilot": { models: [entry] } } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/snapshot/i);
    expect(result.stderr).toMatch(/migrat/i);
    expect(saved().providers["github-copilot"].models[0]).toEqual(entry);
    expect(saved().providers["github-copilot"].models[1].id).toBe("model-b");
    expect(saved().providers["github-copilot"].modelOverrides).toBeUndefined();
    expect(readdirSync(join(fixture, ".pi/agent")).filter(name => name.startsWith("models.json.bak-"))).toEqual([]);
  });
});

describe("Copilot model sync cache metadata", () => {
  // Removing cache synthesis must stop the newly added Claude from being warmable.
  it("declares the short cache lifetime on a newly added Claude model", () => {
    const result = run([model("claude-fixture", "Anthropic")], config());
    expect(result.status, result.stderr).toBe(0);
    expect(saved().providers["github-copilot"].models[0]).toMatchObject({
      id: "claude-fixture", api: "anthropic-messages", promptCache: { short: 300 },
    });
  });

  it("uses fixture HOME without a homedir monkeypatch", () => {
    const result = run([model("claude-fixture", "Anthropic")], config(), true, true);
    expect(result.status, result.stderr).toBe(0);
    expect(saved().providers["github-copilot"].models[0]).toMatchObject({
      id: "claude-fixture", promptCache: { short: 300 },
    });
  });

  it("never updates existing models or overrides while adding a new Claude", () => {
    const existing = [
      { id: "claude-existing", api: "anthropic-messages", custom: "keep" },
      { id: "claude-cached", promptCache: { short: 42, long: 3600 } },
    ];
    const overrides = { "claude-override": { promptCache: { short: 17 } }, "claude-uncached-override": { name: "keep" } };
    const result = run([
      ...["claude-existing", "claude-cached", "claude-override", "claude-uncached-override", "claude-new"].map(id => model(id, "Anthropic")),
    ], { providers: { "github-copilot": { models: existing, modelOverrides: overrides } } });
    expect(result.status, result.stderr).toBe(0);
    const gh = saved().providers["github-copilot"];
    expect(gh.models.slice(0, 2)).toEqual(existing);
    expect(gh.modelOverrides).toEqual(overrides);
    expect(gh.models).toHaveLength(3);
    expect(gh.models[2].promptCache).toEqual({ short: 300 });
  });

  it.each([
    ["gpt-fixture", "OpenAI"], ["gemini-fixture", "Google"],
    ["other-fixture", "Anthropic"], ["claude-other-api", "OpenAI"],
  ])("does not declare cache metadata for %s from %s", (id, vendor) => {
    const result = run([model(id, vendor)], config());
    expect(result.status, result.stderr).toBe(0);
    expect(saved().providers["github-copilot"].models[0]).not.toHaveProperty("promptCache");
  });

  it("does not write models.json during a dry run", () => {
    const before = config();
    const result = run([model("claude-fixture", "Anthropic")], before, false);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(modelsPath, "utf8")).toBe(JSON.stringify(before));
  });
});
