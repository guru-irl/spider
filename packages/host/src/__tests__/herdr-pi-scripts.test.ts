import { afterEach, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const scratch = resolve('.spider/scratch/tmp'); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, 'pi-scripts-'));
}
function pathsFor(mode: 'unset' | 'absolute' | 'tilde') {
  const base = join(root, mode), home = join(base, 'home'), alternate = join(base, 'alternate');
  mkdirSync(home, { recursive: true });
  const defaultAgent = join(home, '.pi', 'agent');
  const agent = mode === 'unset' ? defaultAgent : mode === 'tilde' ? join(home, 'chosen-agent') : alternate;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: '' };
  delete env.PI_CODING_AGENT_DIR;
  if (mode === 'absolute') env.PI_CODING_AGENT_DIR = alternate;
  if (mode === 'tilde') env.PI_CODING_AGENT_DIR = '~/chosen-agent';
  return { home, agent, defaultAgent, env };
}
function run(script: string, env: NodeJS.ProcessEnv, prefix: string[] = []) {
  return spawnSync(process.execPath, [...prefix, resolve('scripts', script)], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10000 });
}

for (const [script, shim] of [['link.mjs', 'spider.ts'], ['dev-link.mjs', 'spider-dev.ts']] as const) {
  it(`${script} installs its shim at pi's default and configured paths`, () => {
    fixture();
    for (const mode of ['unset', 'absolute', 'tilde'] as const) {
      const { agent, defaultAgent, env } = pathsFor(mode);
      const result = run(script, env);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(agent, 'extensions', shim)), `${mode}: expected shim in pi agent directory`).toBe(true);
      if (mode !== 'unset') expect(existsSync(join(defaultAgent, 'extensions', shim))).toBe(false);
    }
  });
}

it('sync-copilot-models.mjs reads auth and writes models at pi’s default and configured paths', () => {
  fixture();
  const mock = join(root, 'offline-copilot.mjs');
  writeFileSync(mock, `import https from 'node:https'; import { EventEmitter } from 'node:events';
https.request = (_url, options, callback) => {
  const req = new EventEmitter();
  req.end = () => queueMicrotask(() => {
    if (options.headers.Authorization !== 'Bearer fixture-token') { req.emit('error', new Error('unexpected auth source')); return; }
    const response = new EventEmitter(); response.statusCode = 200; callback(response);
    response.emit('data', JSON.stringify({ data: [{ id: 'fixture-only-picker', model_picker_enabled: true, capabilities: { type: 'chat', supports: {}, limits: {} } }] })); response.emit('end');
  }); return req;
};\n`);
  const fakeBin = join(root, 'bin');
  const piRoot = join(root, 'pi-install');
  const executable = join(piRoot, 'dist', 'bundle', 'cli.js');
  const catalogDir = join(piRoot, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers');
  mkdirSync(fakeBin);
  mkdirSync(join(piRoot, 'dist', 'bundle'), { recursive: true });
  mkdirSync(join(piRoot, 'dist', 'core'), { recursive: true });
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(join(piRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0', type: 'module' }));
  writeFileSync(join(piRoot, 'dist', 'core', 'model-config.js'), 'export const ModelsJsonSchemas = { modelOverride: { properties: { name: {} } } };\n');
  writeFileSync(executable, '#!/usr/bin/env node\n');
  chmodSync(executable, 0o755);
  writeFileSync(join(catalogDir, 'github-copilot.models.js'), 'export const GITHUB_COPILOT_MODELS = [{ id: "fixture-builtin" }];\n');
  symlinkSync(executable, join(fakeBin, 'pi'));
  for (const mode of ['unset', 'absolute', 'tilde'] as const) {
    const { agent, defaultAgent, env } = pathsFor(mode);
    env.PATH = fakeBin;
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, 'auth.json'), JSON.stringify({ 'github-copilot': { access: 'fixture-token', availableModelIds: ['fixture-only-picker'] } }));
    const original = JSON.stringify({ providers: {}, marker: mode });
    writeFileSync(join(agent, 'models.json'), original);
    if (mode !== 'unset') { mkdirSync(defaultAgent, { recursive: true }); writeFileSync(join(defaultAgent, 'models.json'), 'do not alter'); }
    const result = run('sync-copilot-models.mjs', env, ['--import', mock, '--']);
    // The --write argument is passed after the script name below in the dedicated invocation.
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('override support unavailable');
    expect(readFileSync(join(agent, 'models.json'), 'utf8')).toBe(original);
    const write = spawnSync(process.execPath, ['--import', mock, resolve('scripts/sync-copilot-models.mjs'), '--write'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10000 });
    expect(write.status, write.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(agent, 'models.json'), 'utf8')).providers['github-copilot'].models[0].id).toBe('fixture-only-picker');
    if (mode !== 'unset') expect(readFileSync(join(defaultAgent, 'models.json'), 'utf8')).toBe('do not alter');
  }
});
