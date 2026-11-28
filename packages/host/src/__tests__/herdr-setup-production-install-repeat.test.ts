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
