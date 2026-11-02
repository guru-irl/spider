import { expect, vi } from 'vitest';
import { cp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { configFixtureCwd } from './herdr-config-fixture.js';
import { createHerdrHarness, type HerdrHarness } from '../../../herdr/src/__tests__/testutil.js';
import { HerdrLabelContract } from '../../../herdr/src/contracts.js';
import type { SetupContext, SetupParts, SetupRequest } from '../../../herdr/src/setup/installer.js';
import { ModelRegistry } from '@earendil-works/pi-coding-agent';

// Shared by the production setup tests. Each test file must still mock `ps -U`,
// so an isolated fixture never inventories unrelated host sessions.
export const cleanup: (() => Promise<void>)[] = [];
export interface SetupFixture {
  h: HerdrHarness; root: string; ports: ReturnType<typeof createProductionHerdrCliPorts>; request: SetupRequest;
  parts: SetupParts; context: SetupContext; bootstraps: string[];
}
export async function fixture(mode: 'fake' | 'hc' = 'fake', requireAppBackup = false): Promise<SetupFixture> {
  const h = await createHerdrHarness(mode); cleanup.push(() => h.close()); await h.start();
  expect(h.localSocket).toContain(h.root); expect(h.remoteSocket).toContain(h.root);
  expect(h.localSocket).not.toContain('/default/default.sock'); expect(h.remoteSocket).not.toContain('/default/default.sock');
  await h.cli(['machine', 'rm', 'remote.invalid', '--json']);
  await h.cli(['machine', 'add', '--via', join(h.root, 'via'), '--name', 'remote.invalid', '--session', 'r', '--json']);
  cleanup.push(async () => { if ((await h.hc.machines()).some(m => m.name === 'remote.invalid')) await h.cli(['machine', 'rm', 'remote.invalid', '--json']); });
  const root = join(h.root, 'package');
  await mkdir(join(root, 'packages/herdr'), { recursive: true });
  await cp(resolve('packages/herdr/assets'), join(root, 'packages/herdr/assets'), { recursive: true });
  await mkdir(join(root, 'dist/herdr'), { recursive: true });
  await writeFile(join(root, 'dist/herdr/remote-runtime.mjs'), stripTypeScriptTypes(await readFile(resolve('packages/herdr/src/remote/runtime.ts'), 'utf8')));
  await mkdir(join(h.directories.agent, 'sessions'), { recursive: true });
  const patches = JSON.parse(await readFile(join(root, 'packages/herdr/assets/look/patches.json'), 'utf8'));
  for (const kind of ['agents', 'spaces', 'pane', 'tabs']) {
    await mkdir(join(h.directories.app, 'mods', kind), { recursive: true });
    await writeFile(join(h.directories.app, 'mods', kind, 'main.js'), patches.mods[kind].map((p: { anchor: string }) => p.anchor).join('\n'));
    await writeFile(join(h.directories.app, 'mods', kind, 'mod.json'), JSON.stringify({ name: kind, version: patches.upstreamVersion }));
  }
  await mkdir(join(h.directories.app, 'layouts'), { recursive: true });
  await writeFile(join(h.directories.app, 'layouts/main.json'), JSON.stringify({ children: [
    { id: 'sidebar', content: { mod: 'agents' } }, { id: 'spaces', content: { mod: 'spaces' } }, { id: 'tabs', content: { mod: 'tabs' } },
    { id: 'work-body', children: [ { id: 'main', content: { tab: 'active', pane: { header: { content: { mod: 'pane' } } } } },
      { id: 'panel', children: [{ id: 'panel-body', type: 'stack', children: [{ id: 'files' }, { id: 'changes' }] }] } ] },
  ] }));
  await writeFile(join(h.directories.app, 'settings.json'), '{"zoom":1.25,"theme":"stock"}\n');
  await writeFile(join(h.directories.agent, 'settings.json'), '{"theme":"stock","unrelated":true}\n');
  const configPath = join(h.root, 'config.json');
  const config = { app: { binary: h.appBinary, home: h.directories.app }, core: { binary: h.hcBinary, config: join(h.localEnv.XDG_CONFIG_HOME!, 'herdr-core/config.toml') }, agentDirectory: h.directories.agent, globalRoot: h.directories.global, shellRc: join(h.root, 'shellrc'), spaces: [], machines: [{ name: 'remote.invalid', nodePath: process.execPath, runtime: { directory: join(h.directories.remote, 'programs'), cwd: null, commands: {} } }] };
  // The real core is used without any app process. This CLI double only models selection persistence,
  // including a fresh app home where the first selection creates settings.json.
  const script = join(h.root, 'app-selection.mjs');
  await writeFile(script, `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2), p = process.env.HERDR_APP_HOME + '/settings.json';
if (a[0] === '--version') console.log('herdr-app 0.1.11');
else if (a[0] === 'do') { if (${requireAppBackup}) { const j = JSON.parse(readFileSync(${JSON.stringify(join(h.directories.global, 'herdr/setup/journal.json'))}, 'utf8')); const entry = j.entries.find(e => e.path === p); if (!entry?.backup || !readFileSync(entry.backup).length) throw new Error('App settings backup missing before selection'); } const s = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}; if (a[1] === 'layout.switch') s.layout = a[a.indexOf('--name') + 1]; if (a[1] === 'app.theme') s.theme = a[a.indexOf('--name') + 1]; writeFileSync(p, JSON.stringify(s)); console.log('{}'); }
else console.log(JSON.stringify({spaces:[]}));\n`);
  const app = join(h.root, 'app-selection'); await writeFile(app, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`); await chmod(app, 0o700); config.app.binary = app;
  await writeFile(configPath, JSON.stringify(config));
  vi.spyOn(ModelRegistry.prototype, 'getAvailable').mockImplementation(function (this: ModelRegistry) { return this.getAll(); });
  execFileSync('git', ['init', '-q', h.root]);
  const ports = configFixtureCwd(createProductionHerdrCliPorts(root, { ...h.localEnv, SPIDER_GLOBAL_ROOT: h.directories.global }), h.root); cleanup.push(() => ports.dispose());
  const request = await ports.request(configPath), parts = await ports.setupParts(request);
  const context: SetupContext = { labelContract: HerdrLabelContract, modProps: ['agents', 'spaces', 'pane', 'tabs', 'panel'].map(name => ({ directory: join(h.directories.app, 'mods', `spider-${name}`), props: { modId: `spider-${name}`, feedRoot: join(h.directories.global, 'herdr'), cliPath: join(root, 'dist/herdr/cli.mjs'), nodePath: process.execPath, configPath, labelContract: HerdrLabelContract } })), installed: {}, retiredTerminals: [], priorCutover: null, recordCutover: async () => {} };
  const bootstraps: string[] = [];
  const bootstrap = parts.bootstrapRuntime;
  const ensureRuntime = parts.ensureRuntime; let planned: Awaited<ReturnType<typeof ensureRuntime>> = [];
  parts.ensureRuntime = async (r, c) => { planned = await ensureRuntime(r, c); return planned; };
  parts.bootstrapRuntime = async (r, c) => { await bootstrap(r, c); for (const runtime of planned) { expect(await parts.hc.fileRead(runtime.machine, runtime.path)).toEqual(runtime.bytes); bootstraps.push(runtime.path); } };
  return { h, root, ports, request, parts, context, bootstraps };
}
