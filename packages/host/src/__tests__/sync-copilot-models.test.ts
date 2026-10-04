import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
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
    res.emit('data', readFileSync(process.env.FIXTURE_HOME + '/catalog.json', 'utf8'));
    res.emit('end');
  };
  return req;
};
syncBuiltinESMExports();
`);
});

function run(models: object[], config: object, write = true, nativeHome = false) {
  writeFileSync(join(fixture, "catalog.json"), JSON.stringify({ data: models }));
  writeFileSync(join(fixture, ".pi/agent/auth.json"), JSON.stringify({
    "github-copilot": { access: "fixture-token", availableModelIds: models.map(m => (m as { id: string }).id) },
  }));
  writeFileSync(modelsPath, JSON.stringify(config));
  return spawnSync(process.execPath, ["--import", join(fixture, "boundary.mjs"), join(root, "scripts/sync-copilot-models.mjs"), ...(write ? ["--write"] : [])], {
    cwd: fixture, encoding: "utf8",
    env: { ...process.env, HOME: fixture, USERPROFILE: fixture, FIXTURE_HOME: fixture,
      FIXTURE_NATIVE_HOME: nativeHome ? "1" : "0", SPIDER_PIAI_MODELS: join(fixture, "builtins.mjs") },
  });
}
const model = (id: string, vendor: string) => ({
  id, vendor, model_picker_enabled: true,
  capabilities: { type: "chat", supports: { adaptive_thinking: true }, limits: { max_context_window_tokens: 200000 } },
});
const config = () => ({ providers: { "github-copilot": { models: [] } } });
function saved() { return JSON.parse(readFileSync(modelsPath, "utf8")); }

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
