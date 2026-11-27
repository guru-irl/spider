import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
let builtinPath: string;
let fakePath: string;

function installPi(name: string, catalog: string, version = "1.0.0") {
  const piRoot = join(fixture, name);
  const executable = join(piRoot, "dist/bundle/cli.js");
  const catalogPath = join(piRoot, "node_modules/@earendil-works/pi-ai/dist/providers/github-copilot.models.js");
  mkdirSync(join(piRoot, "dist/bundle"), { recursive: true });
  mkdirSync(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/providers"), { recursive: true });
  writeFileSync(join(piRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, type: "module" }));
  writeFileSync(executable, "#!/usr/bin/env node\n");
  chmodSync(executable, 0o755);
  writeFileSync(catalogPath, catalog);
  return { piRoot, executable, catalogPath };
}

beforeEach(() => {
  fixture = mkdtempSync(join(scratch, "fixture-"));
  const agent = join(fixture, ".pi/agent");
  mkdirSync(agent, { recursive: true });
  modelsPath = join(agent, "models.json");
  const pi = installPi("pi-active", 'export const GITHUB_COPILOT_MODELS = [{ id: "fixture-builtin" }];\n');
  builtinPath = pi.catalogPath;
  fakePath = join(fixture, "bin");
  mkdirSync(fakePath);
  symlinkSync(pi.executable, join(fakePath, "pi"));
  // Isolate home, credentials, catalog discovery, and the HTTP request.
  // The script still reads and writes the fixture's real models.json.
  writeFileSync(join(fixture, "boundary.mjs"), `
import os from 'node:os';
import https from 'node:https';
import fs from 'node:fs';
import module from 'node:module';
import { EventEmitter } from 'node:events';
const originalRead = fs.readFileSync;
const originalExists = fs.existsSync;
const originalWrite = fs.writeFileSync;
if (process.env.FIXTURE_FAIL_BACKUP === '1') fs.copyFileSync = () => { throw new Error('fixture backup failed'); };
if (process.env.FIXTURE_FAIL_RENAME === '1') fs.renameSync = () => { throw new Error('fixture rename failed'); };
if (process.env.FIXTURE_FAIL_WRITE === '1') fs.writeFileSync = (path, data, ...args) => {
  if (String(path).startsWith(process.env.FIXTURE_HOME + '/.pi/agent/models.json')) {
    originalWrite(path, 'partial fixture', ...args);
    throw new Error('fixture write failed');
  }
  return originalWrite(path, data, ...args);
};
fs.existsSync = (path) => String(path) === process.env.FIXTURE_HOME + '/.pi/agent/auth.json' || originalExists(path);
fs.readFileSync = (path, ...args) => {
  if (String(path).endsWith('/auth.json')) {
    if (String(path) !== process.env.FIXTURE_HOME + '/.pi/agent/auth.json') throw new Error('unexpected credential read');
    const models = JSON.parse(originalRead(process.env.FIXTURE_HOME + '/catalog.json', 'utf8')).data;
    return JSON.stringify({ 'github-copilot': { access: 'fixture', availableModelIds: models.map(m => m.id) } });
  }
  return originalRead(path, ...args);
};
if (process.env.FIXTURE_NATIVE_HOME === '1') {
  // Refuse to read auth/config if fixture home isolation is missing.
  if (process.env.HOME !== process.env.FIXTURE_HOME || process.env.USERPROFILE !== process.env.FIXTURE_HOME) {
    throw new Error('fixture HOME and USERPROFILE must be isolated');
  }
} else os.homedir = () => process.env.FIXTURE_HOME;
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

function invoke(write = true, nativeHome = false, failBackup = false, script = join(root, "scripts/sync-copilot-models.mjs"), extraEnv: NodeJS.ProcessEnv = {}, cliArgs: string[] = []) {
  return spawnSync(process.execPath, ["--import", join(fixture, "boundary.mjs"), script, ...(write ? ["--write"] : []), ...cliArgs], {
    cwd: fixture, encoding: "utf8",
    env: { ...process.env, HOME: fixture, USERPROFILE: fixture, FIXTURE_HOME: fixture, PI_CODING_AGENT_DIR: undefined,
      PATH: fakePath, FIXTURE_NATIVE_HOME: nativeHome ? "1" : "0", FIXTURE_FAIL_BACKUP: failBackup ? "1" : "0",
      FIXTURE_FAIL_RENAME: undefined, FIXTURE_FAIL_WRITE: undefined, SPIDER_PIAI_MODELS: undefined, ...extraEnv },
  });
}
function run(models: object[], config: object, write = true, nativeHome = false, failBackup = false) {
  writeFileSync(join(fixture, "catalog.json"), JSON.stringify({ data: models }));
  writeFileSync(modelsPath, JSON.stringify(config));
  return invoke(write, nativeHome, failBackup);
}
const model = (id: string, vendor: string) => ({
  id, vendor, model_picker_enabled: true,
  capabilities: { type: "chat", supports: { adaptive_thinking: true }, limits: { max_context_window_tokens: 200000 } },
});
const config = () => ({ providers: { "github-copilot": { models: [] } } });
function saved() { return JSON.parse(readFileSync(modelsPath, "utf8")); }

describe("Copilot model sync catalog", () => {
  // Choosing a different installation moves an entry pi does not know into an ignored override.
  it("uses the catalog belonging to the pi executable on PATH", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a" }];\n');
    const other = installPi("pi-inactive", 'export const GITHUB_COPILOT_MODELS = [{ id: "model-b" }];\n', "2.0.0");
    const before = { providers: { "github-copilot": { models: [
      { id: "model-a", compactAtPercent: 30 }, { id: "model-b", compactAtPercent: 60 },
    ] } } };
    writeFileSync(join(fixture, "catalog.json"), JSON.stringify({ data: [] }));
    writeFileSync(modelsPath, JSON.stringify(before));
    const result = invoke(true, false, false, undefined, { SPIDER_PIAI_MODELS: other.catalogPath });
    expect(result.status, result.stderr).toBe(0);
    expect(saved().providers["github-copilot"].models).toEqual([{ id: "model-b", compactAtPercent: 60 }]);
    expect(saved().providers["github-copilot"].modelOverrides).toEqual({ "model-a": { compactAtPercent: 30 } });
    expect(result.stdout).toContain("1.0.0");
  });

  // A stale snapshot cannot identify the installation that will read this file.
  it("refuses without writing when pi is absent from PATH", () => {
    const emptyPath = join(fixture, "empty-bin");
    mkdirSync(emptyPath);
    const before = config();
    writeFileSync(join(fixture, "catalog.json"), JSON.stringify({ data: [model("model-c", "Example")] }));
    writeFileSync(modelsPath, JSON.stringify(before));
    const result = invoke(true, false, false, undefined, { PATH: emptyPath, SPIDER_PIAI_MODELS: undefined });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--pi-root <dir>");
    expect(readFileSync(modelsPath, "utf8")).toBe(JSON.stringify(before));
    expect(readdirSync(join(fixture, ".pi/agent"))).toEqual(["models.json"]);
  });

  // The documented override must select an installation without a pi on PATH.
  it("accepts an explicit pi root when pi is absent from PATH", () => {
    const other = installPi("pi-override", 'export const GITHUB_COPILOT_MODELS = [{ id: "model-c" }];\n', "2.0.0");
    const emptyPath = join(fixture, "empty-bin");
    mkdirSync(emptyPath);
    writeFileSync(join(fixture, "catalog.json"), JSON.stringify({ data: [] }));
    writeFileSync(modelsPath, JSON.stringify({ providers: { "github-copilot": { models: [{ id: "model-c", compactAtPercent: 70 }] } } }));
    const result = invoke(true, false, false, undefined, { PATH: emptyPath, SPIDER_PIAI_MODELS: undefined }, ["--pi-root", other.piRoot]);
    expect(result.status, result.stderr).toBe(0);
    expect(saved().providers["github-copilot"].models).toEqual([]);
    expect(saved().providers["github-copilot"].modelOverrides).toEqual({ "model-c": { compactAtPercent: 70 } });
    expect(result.stdout).toContain("2.0.0");
  });

  // Treating the keyed catalog as a snapshot adds a model already built in.
  it("recognizes built-in models in an object keyed by ID", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = { "model-a": { id: "model-a" } };\n');
    const result = run([model("model-a", "Example")], config());
    expect(result.status, result.stderr).toBe(0);
    expect(saved().providers["github-copilot"].models).toEqual([]);
    expect(result.stdout).toContain("built-in catalog:");
    expect(result.stdout).not.toContain("SNAPSHOT");
  });

  it("recognizes built-in models in an array", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a" }];\n');
    const result = run([model("model-a", "Example")], config());
    expect(result.status, result.stderr).toBe(0);
    expect(saved().providers["github-copilot"].models).toEqual([]);
    expect(result.stdout).not.toContain("SNAPSHOT");
  });

  // A shadow must become a narrow override even if it is not in the live picker.
  it("previews migration and keeps the file untouched during a dry run", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = { "model-a": { id: "model-a" } };\n');
    const before = { providers: { "github-copilot": {
      models: [{ id: "model-a", compactAtPercent: 70, thinkingLevelMap: { xhigh: "max" }, contextWindow: 123 }],
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

  // Supported fields such as false reasoning and model headers must survive migration.
  it("preserves supported differing fields and reports inherited limits without exposing headers", () => {
    writeFileSync(builtinPath, `export const GITHUB_COPILOT_MODELS = { "model-a": {
      id: "model-a", name: "Built in", reasoning: true, input: ["text", "image"],
      api: "current-api", baseUrl: "shared-url", contextWindow: 64000, maxTokens: 2000,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
    } };\n`);
    const secret = "fixture-sensitive-value";
    const carried = {
      name: "Custom name", reasoning: false, input: ["text"],
      inputLimits: { images: { maxPerRequest: 2 } },
      cost: { input: 5, output: 6, cacheRead: 1, cacheWrite: 2 },
      samplingParams: { temperature: 0.2 },
      samplingParamsByThinkingLevel: { high: { temperature: 0.4 } },
      headers: { Authorization: secret }, compactAtPercent: 60,
    };
    const before = { providers: { "github-copilot": { models: [{
      id: "model-a", ...carried, api: "old-api", baseUrl: "shared-url", contextWindow: 50000, maxTokens: 1000,
    }] } } };
    const result = run([], before);
    expect(result.status, result.stderr).toBe(0);
    expect(saved().providers["github-copilot"].modelOverrides).toEqual({ "model-a": carried });
    const inherited = result.stdout.split("\n").filter(line => line.includes("model-a") && /inherit/i.test(line));
    expect(inherited).toHaveLength(1);
    for (const field of ["api", "contextWindow", "maxTokens"]) expect(inherited[0]).toContain(field);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain("old-api");
  });

  // An unsupported field must not vanish when any entry is migrated.
  it("refuses unsupported differing fields before any write without revealing their values", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a", baseUrl: "built-in-url" }, { id: "model-b" }];\n');
    const secret = "fixture-sensitive-value";
    const before = { providers: { "github-copilot": { models: [
      { id: "model-a", baseUrl: "custom-url", arbitraryField: secret, headers: { Authorization: secret } },
      { id: "model-b", anotherField: secret, compactAtPercent: 50 },
    ] } } };
    for (const write of [false, true]) {
      const result = run([], before, write);
      expect(result.status).not.toBe(0);
      for (const name of ["model-a", "baseUrl", "arbitraryField", "model-b", "anotherField"]) {
        expect(result.stderr).toContain(name);
      }
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(result.stdout + result.stderr).not.toContain("custom-url");
      expect(readFileSync(modelsPath, "utf8")).toBe(JSON.stringify(before));
      expect(readdirSync(join(fixture, ".pi/agent"))).toEqual(["models.json"]);
    }
  });

  // A conflicting user override must be left intact, including header values.
  it("refuses conflicting carried fields and names header conflicts", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a", name: "Built in", contextWindow: 64000, maxTokens: 2000 }];\n');
    const existing = { name: "Existing name", compactAtPercent: 70, compat: { custom: true },
      headers: { Authorization: "fixture-existing-header" }, contextWindow: 48000, maxTokens: 900 };
    const before = { providers: { "github-copilot": { models: [{ id: "model-a", name: "Shadow name",
      compactAtPercent: 30, compat: { forceAdaptiveThinking: true }, headers: { Authorization: "fixture-shadow-header" },
      contextWindow: 50000, maxTokens: 1000, promptCache: { short: 300 } }],
      modelOverrides: { "model-a": existing } } } };
    const result = run([], before);
    expect(result.status).not.toBe(0);
    for (const name of ["model-a", "name", "compactAtPercent", "compat", "headers", "Authorization"]) {
      expect(result.stderr).toContain(name);
    }
    expect(result.stdout + result.stderr).not.toContain("fixture-shadow-header");
    expect(result.stdout + result.stderr).not.toContain("fixture-existing-header");
    expect(readFileSync(modelsPath, "utf8")).toBe(JSON.stringify(before));
    expect(readdirSync(join(fixture, ".pi/agent"))).toEqual(["models.json"]);
  });

  // Existing explicit limits remain in place even though shadow limits are discarded.
  it("keeps existing inherited-field overrides and reports discarded shadow fields", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a", api: "current-api", contextWindow: 64000, maxTokens: 2000 }];\n');
    const existing = { api: "existing-api", contextWindow: 48000, maxTokens: 900 };
    const before = { providers: { "github-copilot": { models: [{ id: "model-a", api: "shadow-api",
      contextWindow: 50000, maxTokens: 1000, promptCache: { short: 300 } }],
      modelOverrides: { "model-a": existing } } } };
    const result = run([], before);
    expect(result.status, result.stderr).toBe(0);
    expect(saved().providers["github-copilot"].modelOverrides["model-a"]).toEqual({ ...existing, promptCache: { short: 300 } });
    const lines = result.stdout.split("\n").filter(line => line.includes("model-a") && /inherit/i.test(line));
    expect(lines).toHaveLength(1);
    for (const field of ["api", "contextWindow", "maxTokens"]) expect(lines[0]).toContain(field);
    expect(result.stdout + result.stderr).not.toContain("shadow-api");
    expect(result.stdout + result.stderr).not.toContain("existing-api");
  });

  // Pi gives a model entry's headers precedence even when they equal the built-in.
  it("refuses an existing header conflict when the shadow matches the built-in", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a", headers: { "X-Mode": "shared" } }];\n');
    const before = { providers: { "github-copilot": { models: [{ id: "model-a", headers: { "X-Mode": "shared" } }],
      modelOverrides: { "model-a": { headers: { "X-Mode": "fixture-existing-header" } } } } } };
    const result = run([], before);
    expect(result.status).not.toBe(0);
    for (const name of ["model-a", "headers", "X-Mode"]) expect(result.stderr).toContain(name);
    expect(result.stdout + result.stderr).not.toContain("fixture-existing-header");
    expect(readFileSync(modelsPath, "utf8")).toBe(JSON.stringify(before));
    expect(readdirSync(join(fixture, ".pi/agent"))).toEqual(["models.json"]);
  });

  // Provider headers outrank built-in headers after the shadow is removed.
  it("refuses equal shadow headers that conflict with provider headers", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a", headers: { "X-Mode": "fixture-builtin" } }];\n');
    const before = { providers: { "github-copilot": { headers: { "X-Mode": "fixture-provider" },
      models: [{ id: "model-a", headers: { "X-Mode": "fixture-builtin" } }] } } };
    const result = run([], before);
    expect(result.status).not.toBe(0);
    for (const name of ["model-a", "headers", "X-Mode"]) expect(result.stderr).toContain(name);
    expect(result.stdout + result.stderr).not.toContain("fixture-builtin");
    expect(result.stdout + result.stderr).not.toContain("fixture-provider");
    expect(readFileSync(modelsPath, "utf8")).toBe(JSON.stringify(before));
    expect(readdirSync(join(fixture, ".pi/agent"))).toEqual(["models.json"]);
  });

  // Provider compatibility also changes merge order when the shadow is removed.
  it("refuses equal shadow compatibility that conflicts with provider compatibility", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a", compat: { supportsStore: true } }];\n');
    const before = { providers: { "github-copilot": { compat: { supportsStore: false },
      models: [{ id: "model-a", compat: { supportsStore: true } }] } } };
    const result = run([], before);
    expect(result.status).not.toBe(0);
    for (const name of ["model-a", "compat", "supportsStore"]) expect(result.stderr).toContain(name);
    expect(readFileSync(modelsPath, "utf8")).toBe(JSON.stringify(before));
    expect(readdirSync(join(fixture, ".pi/agent"))).toEqual(["models.json"]);
  });

  // Pi merges the routing compatibility maps by their nested keys.
  it("identifies a nested provider compatibility key that would change", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a", compat: { openRouterRouting: { order: ["a"] } } }];\n');
    const before = { providers: { "github-copilot": { compat: { openRouterRouting: { order: ["b"] } },
      models: [{ id: "model-a", compat: { openRouterRouting: { order: ["a"] } } }] } } };
    const result = run([], before);
    expect(result.status).not.toBe(0);
    for (const name of ["model-a", "compat", "openRouterRouting", "order"]) expect(result.stderr).toContain(name);
    expect(readFileSync(modelsPath, "utf8")).toBe(JSON.stringify(before));
    expect(readdirSync(join(fixture, ".pi/agent"))).toEqual(["models.json"]);
  });

  // An existing override can already mask a provider setting on both sides.
  it("allows equal shadow fields when existing overrides preserve their effective values", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a", headers: { "X-Mode": "same" }, compat: { supportsStore: true } }];\n');
    const existing = { headers: { "X-Mode": "same" }, compat: { supportsStore: false } };
    const before = { providers: { "github-copilot": { headers: { "X-Mode": "provider" }, compat: { supportsStore: false },
      models: [{ id: "model-a", headers: { "X-Mode": "same" }, compat: { supportsStore: true } }],
      modelOverrides: { "model-a": existing } } } };
    const result = run([], before);
    expect(result.status, result.stderr).toBe(0);
    expect(saved().providers["github-copilot"].modelOverrides["model-a"]).toEqual(existing);
  });

  // Copying all model fields, dropping thinking or overwriting hand tuning changes behavior.
  it("backs up migrations, drops equal fields, and preserves existing overrides", () => {
    writeFileSync(builtinPath, `export const GITHUB_COPILOT_MODELS = {
      "model-a": { id: "model-a", name: "old", baseUrl: "example", headers: { a: "b" }, input: ["text"], reasoning: true, cost: { input: 5 }, promptCache: { short: 60 }, thinkingLevelMap: { xhigh: "high" }, compat: { forceAdaptiveThinking: false } },
      "model-b": { id: "model-b", promptCache: { long: 10, short: 5 }, compat: { forceAdaptiveThinking: true } },
      "model-e": { id: "model-e", compat: { forceAdaptiveThinking: false } }
    };\n`);
    const before = { providers: {
      "github-copilot": {
        extra: "keep",
        models: [
          { id: "model-a", name: "old", api: "example", baseUrl: "example", headers: { a: "b" }, input: ["text"], contextWindow: 123, maxTokens: 45, reasoning: true, cost: { input: 5 }, compactAtPercent: 70, promptCache: { short: 300 }, thinkingLevelMap: { minimal: "low", xhigh: "max" }, compat: { custom: true } },
          { id: "model-b", promptCache: { short: 5, long: 10 }, compat: { forceAdaptiveThinking: true } },
          { id: "model-e", compat: { forceAdaptiveThinking: true } },
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
      "model-e": { compat: { forceAdaptiveThinking: true } },
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

  it("adds new models in the same write as a migration", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a" }];\n');
    const before = { providers: { "github-copilot": { models: [{ id: "model-a", compactAtPercent: 30 }] } } };
    const result = run([model("model-b", "Example")], before);
    expect(result.status, result.stderr).toBe(0);
    expect(saved().providers["github-copilot"].models.map((entry: { id: string }) => entry.id)).toEqual(["model-b"]);
    expect(saved().providers["github-copilot"].modelOverrides).toEqual({ "model-a": { compactAtPercent: 30 } });
    const backup = readdirSync(join(fixture, ".pi/agent")).find(name => name.startsWith("models.json.bak-"));
    expect(backup).toBeDefined();
    expect(readFileSync(join(fixture, ".pi/agent", backup!), "utf8")).toBe(JSON.stringify(before));
  });

  // A failed partial write must not truncate the original configuration.
  it("keeps the original and its mode when the replacement write fails", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a" }];\n');
    const before = { providers: { "github-copilot": { models: [{ id: "model-a", compactAtPercent: 30 }] } } };
    writeFileSync(join(fixture, "catalog.json"), JSON.stringify({ data: [] }));
    writeFileSync(modelsPath, JSON.stringify(before));
    chmodSync(modelsPath, 0o764);
    const result = invoke(true, false, false, undefined, { FIXTURE_FAIL_WRITE: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fixture write failed");
    expect(readFileSync(modelsPath, "utf8")).toBe(JSON.stringify(before));
    expect(statSync(modelsPath).mode & 0o777).toBe(0o764);
    const files = readdirSync(join(fixture, ".pi/agent"));
    expect(files.filter(name => name.startsWith("models.json.bak-"))).toHaveLength(1);
    expect(files.filter(name => name.startsWith("models.json.tmp-"))).toEqual([]);
  });

  // A failed rename happens after the backup and leaves the original intact.
  it("keeps the original when rename fails and preserves mode on retry", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a" }];\n');
    const before = { providers: { "github-copilot": { models: [{ id: "model-a", compactAtPercent: 30 }] } } };
    writeFileSync(join(fixture, "catalog.json"), JSON.stringify({ data: [] }));
    writeFileSync(modelsPath, JSON.stringify(before));
    chmodSync(modelsPath, 0o764);
    const result = invoke(true, false, false, undefined, { FIXTURE_FAIL_RENAME: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fixture rename failed");
    expect(readFileSync(modelsPath, "utf8")).toBe(JSON.stringify(before));
    expect(statSync(modelsPath).mode & 0o777).toBe(0o764);
    const files = readdirSync(join(fixture, ".pi/agent"));
    const backups = files.filter(name => name.startsWith("models.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(fixture, ".pi/agent", backups[0]), "utf8")).toBe(JSON.stringify(before));
    expect(files.filter(name => name.startsWith("models.json.tmp-"))).toEqual([]);
    const retry = invoke();
    expect(retry.status, retry.stderr).toBe(0);
    expect(saved().providers["github-copilot"].modelOverrides).toEqual({ "model-a": { compactAtPercent: 30 } });
    expect(statSync(modelsPath).mode & 0o777).toBe(0o764);
  });

  // A failed backup must abort before either a migration or an addition is written.
  it("does not write any changes if the backup fails", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = [{ id: "model-a" }];\n');
    const before = { providers: { "github-copilot": { models: [{ id: "model-a", compactAtPercent: 30 }] } } };
    const result = run([model("model-b", "Example")], before, true, false, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fixture backup failed");
    expect(readFileSync(modelsPath, "utf8")).toBe(JSON.stringify(before));
    expect(readdirSync(join(fixture, ".pi/agent"))).toEqual(["models.json"]);
  });

  // Even an ID in the stale snapshot is not proof that the real catalog has it.
  it("does not migrate a snapshot-listed entry when the real catalog is unavailable", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = {};\n');
    const source = readFileSync(join(root, "scripts/sync-copilot-models.mjs"), "utf8");
    const synthetic = source.replace(/const BUILTIN_SNAPSHOT = new Set\(\[[\s\S]*?\]\);/, 'const BUILTIN_SNAPSHOT = new Set(["model-a"]);');
    expect(synthetic).not.toBe(source);
    const scripts = join(fixture, "scripts");
    mkdirSync(scripts);
    writeFileSync(join(scripts, "sync-copilot-models.mjs"), synthetic);
    writeFileSync(join(scripts, "pi-agent-dir.mjs"), readFileSync(join(root, "scripts/pi-agent-dir.mjs"), "utf8"));
    writeFileSync(join(fixture, "catalog.json"), JSON.stringify({ data: [] }));
    const before = { providers: { "github-copilot": { models: [{ id: "model-a", compactAtPercent: 30 }] } } };
    writeFileSync(modelsPath, JSON.stringify(before));
    const result = invoke(true, false, false, join(scripts, "sync-copilot-models.mjs"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/snapshot.*migration skipped/i);
    expect(result.stdout).toMatch(/0 to migrate/);
    expect(readFileSync(modelsPath, "utf8")).toBe(JSON.stringify(before));
    expect(readdirSync(join(fixture, ".pi/agent"))).toEqual(["models.json"]);
  });

  // A dated snapshot cannot identify safe migrations, but additions still work.
  it("does not migrate on snapshot fallback and still adds missing models", () => {
    writeFileSync(builtinPath, 'export const GITHUB_COPILOT_MODELS = {};\n');
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
