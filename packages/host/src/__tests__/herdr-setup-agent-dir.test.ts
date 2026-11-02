import { afterEach, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { configFixtureCwd } from './herdr-config-fixture.js';
import { createHerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { runtimeInstallPath } from '../../../herdr/src/setup/installer.js';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';

let root = '';
afterEach(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });
function files(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) { result[relative(dir, file) + '/'] = '<directory>'; walk(file); }
      else if (entry.isFile()) result[relative(dir, file)] = readFileSync(file).toString('base64');
    }
  };
  walk(dir); return result;
}

it('refuses mismatched agent directories before writes and installs to the matching directory', async () => {
  const scratch = resolve('.spider/scratch/tmp'); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, 'setup-agent-dir-'));
  execFileSync('git', ['init', '-q', root]);
  const home = join(root, 'home'), actual = join(home, 'pi-agent'), configured = join(root, 'configured'), global = join(root, 'global');
  for (const dir of [home, actual, configured, global]) mkdirSync(dir, { recursive: true });
  vi.stubEnv('HOME', home); vi.stubEnv('PI_CODING_AGENT_DIR', '~/pi-agent'); vi.stubEnv('SPIDER_GLOBAL_ROOT', global);
  const configPath = join(root, 'config.json'), shellRc = join(root, 'rc');
  const config = { enabled: true, app: { binary: '/nonexistent/app', home: join(root, 'app') }, core: { binary: '/nonexistent/hc', config: join(root, 'core.toml') }, agentDirectory: configured, globalRoot: global, shellRc, spaces: [], machines: [] };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(shellRc, 'untouched\n');
  writeFileSync(join(actual, 'settings.json'), '{"actual":true}\n');
  writeFileSync(join(configured, 'settings.json'), '{"configured":true}\n');
  const before = files(root), messages: string[] = [];
  const ports = configFixtureCwd(createProductionHerdrCliPorts(root), root);
  try {
    const commands = [
      ['setup', '--config', configPath],
      ['rollback', '--config', configPath],
    ];
    for (const args of commands) {
      let error = '';
      const code = await runHerdrCli(args, { ...ports, stdout() {}, stderr: text => { error += text; } });
      messages.push(`${code}:${error}`);
    }
    for (const message of messages) {
      expect(message).toContain('agent-directory-mismatch');
      expect(message).toContain(configured);
      expect(message).toContain(actual);
      expect(message).toMatch(/agentDirectory/);
    }
    expect(files(root)).toEqual(before);
  } finally { await ports.dispose(); }

  // Real setup writes pi's settings and packaged theme; only app cutover and
  // verification are replaced, so no app window or user's core is involved.
  vi.unstubAllEnvs();
  const h = await createHerdrHarness('fake');
  let production: ReturnType<typeof createProductionHerdrCliPorts> | undefined;
  try {
    await h.start();
    for (const [key, value] of Object.entries(h.localEnv)) if (value !== undefined && (key.startsWith('HC_') || key.startsWith('XDG_') || key.startsWith('HERDR_') || key === 'PATH')) vi.stubEnv(key, value);
    vi.stubEnv('PI_CODING_AGENT_DIR', h.directories.agent); vi.stubEnv('SPIDER_GLOBAL_ROOT', h.directories.global);
    const assets = join(h.root, 'packages/herdr/assets');
    mkdirSync(join(h.root, 'packages/herdr'), { recursive: true });
    cpSync(resolve('packages/herdr/assets'), assets, { recursive: true });
    mkdirSync(join(h.root, 'dist/herdr'), { recursive: true });
    cpSync(resolve('dist/herdr/remote-runtime.mjs'), join(h.root, 'dist/herdr/remote-runtime.mjs'));
    const matched = { enabled: true, app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.root, 'core.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'rc'), spaces: [], machines: [{ name: 'remote.invalid', aliases: [], runtime: { cwd: h.directories.remote, directory: join(h.directories.remote, 'programs'), commands: {} }, nodePath: process.execPath }] };
    const matchedPath = join(h.directories.global, 'herdr/config.json'); mkdirSync(join(h.directories.global, 'herdr'), { recursive: true });
    writeFileSync(matchedPath, JSON.stringify(matched));
    writeFileSync(matched.core.config, 'notes = true\n');
    writeFileSync(join(h.directories.app, 'settings.json'), '{}');
    writeFileSync(join(h.directories.app, 'keys.json'), '{}');
    writeFileSync(join(h.directories.agent, 'settings.json'), '{"unrelated":true}');
    execFileSync('git', ['init', '-q', h.directories.local]);
    const livePorts = configFixtureCwd(createProductionHerdrCliPorts(h.root, h.localEnv), h.directories.local);
    production = livePorts;
    let error = '';
    const code = await runHerdrCli(['setup', '--config', matchedPath], { ...livePorts,
      setupParts: async request => ({ ...await livePorts.setupParts(request),
        preflight: async () => ({ fingerprint: 'fixture', coreIdentity: await h.hc.identity(), mods: ['panel', 'machines'].map(name => ({ directory: join(h.directories.app, 'mods', `spider-${name}`) })), targets: [{ machine: 'remote.invalid' as never, nodePath: process.execPath, coreStartedAt: 'fixture' }], retiredTerminals: [], layoutExport: true }),
        stageLook: async () => [], generateTemplates: async () => [], installResume: async () => [],
        cutover: async () => ({ terminals: [], identities: {} }), verify: async () => ({ failures: [], warnings: [], probes: [] }),
      }), stdout() {}, stderr: text => { error += text; },
    });
    expect(code, error).toBe(0);
    expect(JSON.parse(readFileSync(join(h.directories.agent, 'settings.json'), 'utf8'))).toMatchObject({ unrelated: true, theme: 'dracula-plus-glass' });
    expect(readFileSync(join(h.directories.agent, 'themes/dracula-plus-glass.json'))).toEqual(readFileSync(join(assets, 'themes/dracula-plus-glass.json')));
    const runtime = readFileSync(join(h.root, 'dist/herdr/remote-runtime.mjs'));
    const runtimePath = runtimeInstallPath(matched.machines[0].runtime.directory, runtime);
    expect((await h.hc.fileRead('remote.invalid' as never, runtimePath)).equals(runtime)).toBe(true);
    expect(existsSync(join(h.directories.app, 'mods/spider-panel/main.js'))).toBe(true);
  } finally {
    await production?.dispose(); vi.unstubAllEnvs(); await h.close();
    expect(await h.remainingOwnedResources()).toEqual([]);
  }
}, 60000);

it('validates pi’s directory in the environment supplied to production ports', async () => {
  const scratch = resolve('.spider/scratch/tmp'); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, 'setup-agent-env-'));
  execFileSync('git', ['init', '-q', root]);
  const home = join(root, 'home'), global = join(root, 'global');
  mkdirSync(home); mkdirSync(global);
  const configPath = join(root, 'config.json');
  const config = { enabled: true, app: { binary: '/nonexistent/app', home: join(root, 'app') }, core: { binary: '/nonexistent/hc', config: join(root, 'core.toml') }, agentDirectory: '', globalRoot: global, shellRc: join(root, 'rc'), spaces: [], machines: [] };
  const cases = [
    { value: undefined, expected: join(home, '.pi/agent') },
    { value: '~/pi-agent', expected: join(home, 'pi-agent') },
    { value: pathToFileURL(join(root, 'pi-agent')).href, expected: join(root, 'pi-agent') },
  ];
  for (const { value, expected } of cases) {
    config.agentDirectory = expected; writeFileSync(configPath, JSON.stringify(config));
    const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: value, SPIDER_GLOBAL_ROOT: global };
    const ports = configFixtureCwd(createProductionHerdrCliPorts(root, env), root);
    let error = '';
    try {
      await runHerdrCli(['setup', '--config', configPath], { ...ports, setupParts: async () => { throw new Error('matched-setup-boundary'); }, stdout() {}, stderr: text => { error += text; } });
      expect(error, `agent directory ${String(value)}`).toContain('matched-setup-boundary');
    } finally { await ports.dispose(); }
  }
});
