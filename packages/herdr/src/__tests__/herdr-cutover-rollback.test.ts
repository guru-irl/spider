import { afterEach, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createProductionHerdrCliPorts } from '../../../host/src/herdr/ports.js';
import { configFixtureCwd } from '../../../host/src/__tests__/herdr-config-fixture.js';
import { setupHerdr, rollbackHerdr } from '../setup/installer.js';
import { readJournal } from '../setup/backup.js';
import { HerdrError } from '../client/parse.js';

let root = '';
afterEach(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });

it('reports the exact rollback command and restores managed parts without losing user edits after cutover fails', async () => {
  const scratch = resolve('.spider/scratch/tmp'); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, 'cutover-rollback-'));
  execFileSync('git', ['init', '-q', root]);
  const agent = join(root, 'agent'), app = join(root, 'app'), global = join(root, 'global'), packageRoot = join(root, 'package');
  for (const dir of [agent, app, global, join(packageRoot, 'packages/herdr'), join(packageRoot, 'dist/herdr')]) mkdirSync(dir, { recursive: true });
  cpSync(resolve('packages/herdr/assets'), join(packageRoot, 'packages/herdr/assets'), { recursive: true });
  cpSync(resolve('dist/herdr/remote-runtime.mjs'), join(packageRoot, 'dist/herdr/remote-runtime.mjs'));
  vi.stubEnv('PI_CODING_AGENT_DIR', agent); vi.stubEnv('SPIDER_GLOBAL_ROOT', global); vi.stubEnv('HC_SOCKET', join(root, 'fixture.sock'));
  const configPath = join(root, "config 'quoted $name'.json"), core = join(root, 'core.toml'), shellRc = join(root, 'shellrc');
  const config = { enabled: true, app: { binary: '/nonexistent/app', home: app }, core: { binary: '/nonexistent/hc', config: core }, agentDirectory: agent, globalRoot: global, shellRc, spaces: [], machines: [] };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(core, 'notes = true\n');
  writeFileSync(shellRc, '# user shell\n');
  writeFileSync(join(agent, 'settings.json'), '{"theme":"stock","unrelated":"before"}\n');
  writeFileSync(join(app, 'settings.json'), '{"zoom":1}\n');
  writeFileSync(join(app, 'keys.json'), '{"global":{"ctrl-q":"user.action"}}\n');
  const ports = configFixtureCwd(createProductionHerdrCliPorts(packageRoot), root);
  try {
    const request = await ports.request(configPath), originalParts = await ports.setupParts(request);
    const parts = { ...originalParts,
      preflight: async () => ({ fingerprint: 'fixture', coreIdentity: { coreId: 'fixture' as never, socket: join(root, 'fixture.sock'), sessionNamespace: 'fixture' }, mods: ['panel', 'machines'].map(name => ({ directory: join(app, 'mods', `spider-${name}`) })), targets: [], retiredTerminals: [], layoutExport: true, cutoverProvedAbsent: true }),
      stageLook: async () => [], generateTemplates: async () => [],
      cutover: async () => {
        const settings = JSON.parse(readFileSync(join(agent, 'settings.json'), 'utf8')); settings.unrelated = 'edited during cutover';
        writeFileSync(join(agent, 'settings.json'), JSON.stringify(settings));
        writeFileSync(shellRc, readFileSync(shellRc, 'utf8') + 'export USER_CHOICE=kept\n');
        writeFileSync(core, readFileSync(core, 'utf8') + '\n[custom]\nvalue = 42\n');
        throw new HerdrError('fixture-cutover-failure', 'The fixture cutover failed');
      },
    };
    let failure: unknown;
    try { await setupHerdr(request, parts); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(HerdrError);
    expect((failure as HerdrError).code).toBe('fixture-cutover-failure');
    const message = (failure as Error).message;
    const command = message.split('\n').find(line => line.startsWith('Rollback: '))?.slice('Rollback: '.length);
    expect(command, message).toBeTruthy();
    const argv = execFileSync('/bin/sh', ['-c', `set -- ${command}; printf '%s\\0' "$@"`], { encoding: 'utf8' }).split('\0').slice(0, -1);
    expect(argv).toEqual([process.execPath, join(packageRoot, 'dist/herdr/cli.mjs'), 'rollback', '--config', configPath]);
    expect((await readJournal(request.journalRoot)).cutoverPending).toBe(true);
    await rollbackHerdr(request, parts);
    expect(JSON.parse(readFileSync(join(agent, 'settings.json'), 'utf8'))).toEqual({ theme: 'stock', unrelated: 'edited during cutover' });
    expect(readFileSync(shellRc, 'utf8')).toBe('# user shell\nexport USER_CHOICE=kept\n');
    expect(readFileSync(core, 'utf8')).toContain('notes = true');
    expect(readFileSync(core, 'utf8')).toContain('value = 42');
    expect(existsSync(join(agent, 'themes/dracula-plus-glass.json'))).toBe(false);
    expect(existsSync(join(app, 'mods/spider-panel/main.js'))).toBe(false);
    expect((await readJournal(request.journalRoot)).cutoverPending).toBe(false);
  } finally { await ports.dispose(); }
});
