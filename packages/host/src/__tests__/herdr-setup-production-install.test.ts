import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { readJournal, digest } from '../../../herdr/src/setup/backup.js';
import { cleanup } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { editUnrelated } from './herdr-setup-production-helpers.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const offlineFixture = () => focusedSetupFixture({ startCores: false, localOnly: true });
const fullFixture = (requireAppBackup = false) => focusedSetupFixture({ coreTransport: 'process' }, requireAppBackup);

test('production CLI plan lists assets without changing files or launching probes', async () => {
  const f = await fullFixture(), output: string[] = [], errors: string[] = [];
  const processes = join(f.h.directories.global, 'herdr/processes'); await mkdir(processes, { recursive: true });
  const selected = join(f.h.root, 'selected.jsonl'); await writeFile(selected, JSON.stringify({ type: 'session', id: 'selected', cwd: f.h.root }) + '\n');
  const config = JSON.parse(await readFile(f.request.configPath, 'utf8')); config.spaces = [{ name: 'Example', sessions: [{ file: selected }] }]; await writeFile(f.request.configPath, JSON.stringify(config));
  await writeFile(join(processes, 'stale.json'), JSON.stringify({ version: 1, pid: 999999, startIdentity: 'missing', sessionId: 'stale', sessionFile: selected, sessionName: null, kind: 'top-level', mode: 'tui', extensionArguments: [], hcAddress: null }), { mode: 0o600 });
  const fingerprint = async () => {
    const rows: string[] = [];
    const visit = async (directory: string): Promise<void> => { rows.push(directory + '/'); for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); else if (entry.isFile()) rows.push(`${path} ${digest(await readFile(path))}`); } };
    for (const directory of [f.h.directories.app, f.h.directories.agent, f.h.directories.global]) await visit(directory);
    return rows.sort();
  };
  const before = await fingerprint(), calls = await f.h.calls();
  expect(await runHerdrCli(['setup', '--dry-run', '--config', f.request.configPath], { ...f.ports, stdout: text => output.push(text), stderr: text => errors.push(text) })).toBe(0);
  expect(errors).toEqual([]);
  expect(output.join('')).toContain(`write ${join(f.h.directories.app, 'mods/spider-panel/main.js')}`);
  expect(output.join('')).toContain('Plan only');
  expect(await fingerprint()).toEqual(before);
  expect((await f.h.calls()).slice(calls.length).filter(call => call.argv[0] !== 'get' && !(call.argv[0] === 'server' && call.argv[1] === 'status'))).toEqual([]);
});

test('production installs each theme where its consumer reads it', async () => {
  const f = await offlineFixture();
  const files = await f.parts.installFiles(f.request, f.context);
  expect(files.find(file => file.path === join(f.h.directories.agent, 'themes/dracula-plus-glass.json'))?.bytes).toEqual(await readFile(join(f.root, 'packages/herdr/assets/themes/dracula-plus-glass.json')));
  expect(files.find(file => file.path === join(f.h.directories.app, 'themes/spider-glass.json'))?.bytes).toEqual(await readFile(join(f.root, 'packages/herdr/assets/themes/spider-glass.json')));
  expect(files.some(file => file.path === join(f.h.directories.agent, 'themes/spider-glass.json'))).toBe(false);
  expect(files.some(file => file.path === join(f.h.directories.app, 'themes/dracula-plus-glass.json'))).toBe(false);
});

test('production layout passes selected font families and retention to the consuming mods', async () => {
  const f = await focusedSetupFixture();
  const fonts = join(f.root, 'packages/herdr/assets/fonts');
  const config = JSON.parse(await readFile(f.request.configPath, 'utf8'));
  config.fonts = {
    label: { path: join(fonts, 'GoogleSansFlex.ttf'), license: join(fonts, 'GoogleSansFlex-OFL.txt') },
    paths: { path: join(fonts, 'GlassLabel-Bold.ttf'), license: join(fonts, 'GoogleSansFlex-OFL.txt') },
  };
  config.limits = { completedRows: 7, completedHours: 3 };
  await writeFile(f.request.configPath, JSON.stringify(config));
  const request = await f.ports.request(f.request.configPath);
  await setupHerdr(request, f.parts);
  const layout = JSON.parse(await readFile(join(f.h.directories.app, 'layouts/spider-glass.json'), 'utf8'));
  const contents: any[] = [];
  const visit = (node: any) => { if (node?.content?.mod) contents.push(node.content); if (node?.content?.pane?.header) visit(node.content.pane.header); for (const child of node?.children ?? []) visit(child); };
  visit(layout);
  expect(contents.find(c => c.mod === 'spider-agents')?.props).toMatchObject({ labelFont: 'Google Sans Flex', retention: { completedRows: 7, completedHours: 3 }, notifications: { sound: true } });
  expect(contents.find(c => c.mod === 'spider-panel')?.props).toMatchObject({ retention: { completedRows: 7, completedHours: 3 } });
  expect(contents.find(c => c.mod === 'spider-spaces')?.props).toMatchObject({ labelFont: 'Google Sans Flex' });
  expect(contents.find(c => c.mod === 'spider-pane')?.props).toMatchObject({ pathFont: 'Glass Label' });
});

test('production refuses an unowned same-named mod before any backup', async () => {
  const f = await fullFixture();
  const path = join(f.h.directories.app, 'mods/spider-panel/main.js'); await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'user owned');
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'unowned-clone-collision' });
  expect(await readFile(path, 'utf8')).toBe('user owned');
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
});

test('production carries saved mod state when layout props change', async () => {
  const f = await focusedSetupFixture(); await setupHerdr(f.request, f.parts);
  const { modStoreFileName } = await import('../../../herdr/src/setup/mod-storage.js');
  const layoutPath = join(f.h.directories.app, 'layouts/spider-glass.json');
  const layout = JSON.parse(await readFile(layoutPath, 'utf8'));
  const props: unknown[] = [];
  const visit = (value: any) => { if (!value || typeof value !== 'object') return; if (value.mod === 'spider-agents') props.push(value.props); for (const [key, child] of Object.entries(value)) if (key !== 'props') { if (Array.isArray(child)) child.forEach(visit); else visit(child); } };
  visit(layout);
  const data = join(f.h.directories.app, 'data/spider-agents'); await mkdir(data, { recursive: true });
  const previous = join(data, modStoreFileName(props[0])); await writeFile(previous, JSON.stringify({ folded: '["example"]', timer: '42' }));
  f.request.config.limits.completedRows = 7;
  const result = await setupHerdr(f.request, f.parts);
  const migrated = result.writes.filter(path => path.startsWith(data + '/'));
  expect(migrated).toHaveLength(1);
  expect(await readFile(migrated[0], 'utf8')).toBe(await readFile(previous, 'utf8'));
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
  await writeFile(migrated[0], '{"timer":"99"}');
  const errors: string[] = [];
  expect(await runHerdrCli(['rollback', '--config', f.request.configPath], { ...f.ports, stdout() {}, stderr: text => errors.push(text) })).toBe(0);
  expect(errors).toEqual([]);
  expect(await readFile(migrated[0], 'utf8')).toBe('{"timer":"99"}');
  expect(await readFile(previous, 'utf8')).toBe('{"folded":"[\\"example\\"]","timer":"42"}');
});

test('production reuses Node observations on an unchanged second setup', async () => {
  const f = await fullFixture();
  const first = await setupHerdr(f.request, f.parts);
  expect(first.probes).toHaveLength(1);
  const before = (await f.h.calls()).filter(call => call.argv[0] === 'run').length;
  const journal = await readFile(join(f.request.journalRoot, 'journal.json'));
  const second = await setupHerdr(f.request, f.parts);
  expect(second.writes).toEqual([]);
  // Root-loss repair needs one live root probe per machine; doctor reuses it and the cached Node version.
  const added = (await f.h.calls()).filter(call => call.argv[0] === 'run').slice(before);
  expect(added).toHaveLength(f.request.config.machines.length);
  for (const call of added) { expect(call.argv).toContain('--probe'); expect(call.argv).not.toContain('--version'); }
  expect(await readFile(join(f.request.journalRoot, 'journal.json'))).toEqual(journal);
  expect(f.bootstraps).toHaveLength(1);
});

test('production keeps unrelated edits in all shared settings files', async () => {
  const f = await fullFixture(); await setupHerdr(f.request, f.parts); await editUnrelated(f);
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(join(f.h.directories.agent, 'settings.json'), 'utf8')).unrelated).toBe('edited');
  expect(await readFile(f.request.config.shellRc, 'utf8')).toContain('export USER_CHOICE=kept');
  expect(await readFile(f.request.config.core.config, 'utf8')).toContain('value = 42');
  const keys = JSON.parse(await readFile(join(f.h.directories.app, 'keys.json'), 'utf8'));
  expect(keys.global).toEqual({
    'cmd-p': 'mod.open:spider-picker', 'cmd-n': { command: 'space.new', args: { machine: '' } },
    'cmd-shift-w': 'pane.close', 'ctrl-q': 'user.action',
  });
  expect(keys['layout:spider-glass']).toEqual({ 'cmd-shift-e': 'spider-pane.park' });
  expect(f.bootstraps).toHaveLength(1);
});

test('production upgrades changed mods themes and runtime without a patch-set change', async () => {
  const f = await fullFixture(); await setupHerdr(f.request, f.parts);
  const patchBytes = await readFile(join(f.root, 'packages/herdr/assets/look/patches.json'));
  const source = join(f.root, 'packages/herdr/assets/mods/spider/main.js'); await writeFile(source, (await readFile(source, 'utf8')) + '\n// upgraded\n');
  const theme = join(f.root, 'packages/herdr/assets/themes/spider-glass.json'); const data = JSON.parse(await readFile(theme, 'utf8')); data.background = '#121214'; await writeFile(theme, JSON.stringify(data));
  await writeFile(join(f.root, 'dist/herdr/remote-runtime.mjs'), (await readFile(join(f.root, 'dist/herdr/remote-runtime.mjs'), 'utf8')) + '\n// runtime update\n');
  const result = await setupHerdr(f.request, f.parts);
  expect(result.writes).toContain(join(f.h.directories.app, 'mods/spider-panel/main.js'));
  expect(result.writes).toContain(join(f.h.directories.app, 'themes/spider-glass.json'));
  expect(await readFile(join(f.h.directories.app, 'mods/spider-panel/main.js'))).toEqual(await readFile(source));
  expect(await readFile(join(f.h.directories.app, 'themes/spider-glass.json'))).toEqual(await readFile(theme));
  expect(result.probes).toHaveLength(1);
  expect(new Set(f.bootstraps).size).toBe(2);
  expect(await readFile(join(f.root, 'packages/herdr/assets/look/patches.json'))).toEqual(patchBytes);
});

test('production template planning skips malformed global role values like the normal parser', async () => {
  const f = await offlineFixture();
  await writeFile(join(f.h.directories.global, 'config.json'), JSON.stringify({ 'models.defaults': { worker: 42 } }));
  const files = await f.parts.generateTemplates(f.request, f.context);
  expect(files).toHaveLength(6);
  for (const file of files) expect(file.bytes.length).toBeGreaterThan(0);
});

if (process.env.SPIDER_HERDR_E2E !== '1') console.info('SKIP production setup with real isolated cores: require SPIDER_HERDR_E2E=1; no app window is used');
