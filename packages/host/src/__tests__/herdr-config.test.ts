import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { paths } from '@spider/db-core';
import { globalConfigFixture, type GlobalConfigFixture } from '../../../db-core/src/__tests__/global-config.testutil.js';
import { configValues, controlConfig } from '../control.js';
import { applyConfigEdit } from '../control/config-cmd.js';
import { effectiveHerdrConfigPath } from '../herdr/mount.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { parseHerdrConfig } from '@spider/herdr/config';
import { setupHerdr, type SetupParts } from '@spider/herdr/setup/installer';

let root: string, cwd: string, globalRoot: string;
let globalConfig: GlobalConfigFixture;
const savedGlobalRoot = paths.globalRoot;
beforeEach(async () => {
  await mkdir(resolve('.spider/scratch'), { recursive: true });
  root = await mkdtemp(resolve('.spider/scratch/herdr-config-'));
  cwd = join(root, 'repo'); globalRoot = join(root, 'global');
  await mkdir(join(cwd, '.spider'), { recursive: true }); await mkdir(globalRoot);
  execFileSync('git', ['init', '-q', cwd]);
  globalConfig = globalConfigFixture(globalRoot);
  paths.globalRoot = globalRoot; vi.stubEnv('SPIDER_GLOBAL_ROOT', globalRoot);
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});
afterEach(async () => { globalConfig.restore(); paths.globalRoot = savedGlobalRoot; vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

function configAt(global = globalRoot) {
  return { enabled: 'auto', globalRoot: global, agentDirectory: join(root, 'agent'), shellRc: join(root, 'shellrc'),
    app: { binary: join(root, 'herdr-app'), home: join(root, 'app') }, core: { binary: join(root, 'hc'), config: join(root, 'core.toml') }, spaces: [], machines: [] };
}
async function local(config: Record<string, unknown>) { await writeFile(join(cwd, '.spider/config.json'), JSON.stringify(config)); }
async function global(config: Record<string, unknown>) { for (const [key, value] of Object.entries(config)) globalConfig.set(key, value); }
async function installedConfig() {
  const file = join(root, 'user-herdr.json'); await writeFile(file, JSON.stringify(configAt()));
  // Exercise the installer's real global config link. No machines or app are launched.
  const parts: SetupParts = {
    globalRoot, preflight: async () => ({ fingerprint: 'config-fixture', coreIdentity: { coreId: 'fixture', socket: join(root, 'core.sock'), sessionNamespace: 'fixture' } as never, mods: [], targets: [], retiredTerminals: [], layoutExport: true }),
    stageLook: async () => [], installFiles: async () => [], generateTemplates: async () => [], installResume: async () => [],
    ensureRuntime: async () => [], bootstrapRuntime: async () => {}, probeMachineNode: async () => { throw new Error('No machines'); },
    hc: { fileRead: async () => { throw new Error('No machines'); }, fileWrite: async () => { throw new Error('No machines'); } },
    cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }), rollback: async () => {}, warn: message => { throw new Error(message); },
  };
  await setupHerdr({ config: parseHerdrConfig(configAt()), configPath: file, packageRoot: root, journalRoot: join(globalRoot, 'herdr/setup') }, parts);
  expect(JSON.parse(await readFile(join(globalRoot, 'config.json'), 'utf8'))['herdr.config']).toBe(file);
  return file;
}

test('session and command-line lookup ignore a repository-selected core binary', async () => {
  const file = await installedConfig();
  const malicious = join(cwd, 'untrusted.json'); await writeFile(malicious, JSON.stringify({ ...configAt(), core: { binary: join(cwd, 'untrusted-hc'), config: join(root, 'core.toml') } }));
  await local({ 'herdr.config': './untrusted.json' });
  expect(effectiveHerdrConfigPath(cwd)).toBe(file);
  const ports = createProductionHerdrCliPorts(root);
  try { expect((await ports.request()).config.core.binary).toBe(join(root, 'hc')); } finally { await ports.dispose(); }
});

test('a repository-only Herdr path cannot replace the absent global installation', async () => {
  await local({ 'herdr.config': './untrusted.json' });
  expect(effectiveHerdrConfigPath(cwd)).toBeNull();
});

test('relative Herdr paths resolve from the global config directory in sessions and commands', async () => {
  const file = join(globalRoot, 'user-herdr.json'); await writeFile(file, JSON.stringify(configAt()));
  await global({ 'herdr.config': './user-herdr.json' });
  expect(effectiveHerdrConfigPath(cwd)).toBe(file);
  const ports = createProductionHerdrCliPorts(root);
  try { expect((await ports.request()).configPath).toBe(file); } finally { await ports.dispose(); }
});

test('global activation wins over a repository override in session and command-line lookup', async () => {
  await installedConfig(); await global({ ...JSON.parse(await readFile(join(globalRoot, 'config.json'), 'utf8')), 'herdr.enabled': false });
  await local({ 'herdr.enabled': true });
  expect(controlConfig('get', cwd, 'herdr.enabled')).toBe(false);
  const ports = createProductionHerdrCliPorts(root);
  try { expect((await ports.request()).config.enabled).toBe(false); } finally { await ports.dispose(); }
});

test.each(['herdr.config', 'herdr.enabled'])('%s is global-only on writes and reports one named repository warning', async key => {
  const value = key === 'herdr.config' ? './untrusted.json' : true;
  await local({ [key]: value });
  const warnings = configValues(cwd).warnings.filter(message => message.includes(key));
  expect(warnings).toHaveLength(1); expect(warnings[0]).toMatch(/ignored.*global/);
  expect(() => controlConfig('set', cwd, key, value)).toThrow(/global-only/);
  expect(applyConfigEdit(cwd, key, String(value), 'global')).toMatchObject({ ok: false, error: expect.stringContaining('protected') });
});

test('commands share the session global root without SPIDER_GLOBAL_ROOT even with a custom pi directory', async () => {
  const home = join(root, 'home'), expected = join(home, '.pi/agent/spider');
  await mkdir(join(expected, 'herdr'), { recursive: true });
  await writeFile(join(expected, 'herdr/config.json'), JSON.stringify(configAt(expected)));
  const source = join(root, 'root-check.ts');
  await writeFile(source, `import { paths } from '@spider/db-core';
import { effectiveHerdrConfigPath } from ${JSON.stringify(fileURLToPath(new URL('../herdr/mount.ts', import.meta.url)))};
import { createProductionHerdrCliPorts } from ${JSON.stringify(fileURLToPath(new URL('../herdr/ports.ts', import.meta.url)))};
const ports = createProductionHerdrCliPorts(${JSON.stringify(root)});
try { const sessionRoot = paths.globalRoot, sessionConfig = effectiveHerdrConfigPath(${JSON.stringify(cwd)}); try { const request = await ports.request(); const parts = await ports.setupParts(request); console.log(JSON.stringify({ sessionRoot, sessionConfig, cliRoot: parts.globalRoot, cliConfig: request.configPath })); } catch (error) { console.log(JSON.stringify({ sessionRoot, sessionConfig, cliError: error.code, cliPath: error.path })); } } finally { await ports.dispose(); }
`);
  await build({ configFile: fileURLToPath(new URL('../../../../vite.config.mjs', import.meta.url)), root: fileURLToPath(new URL('../../../../', import.meta.url)), logLevel: 'silent', build: { ssr: source, outDir: root, emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'root-check.mjs' } } } });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(root, 'custom-agent'), TMPDIR: root };
  delete env.SPIDER_GLOBAL_ROOT; delete env.VITEST;
  const result = JSON.parse(execFileSync(process.execPath, [join(root, 'root-check.mjs')], { cwd, env, encoding: 'utf8', timeout: 20_000 }));
  expect(result).toEqual({ sessionRoot: expected, sessionConfig: join(expected, 'herdr/config.json'), cliRoot: expected, cliConfig: join(expected, 'herdr/config.json') });
});
