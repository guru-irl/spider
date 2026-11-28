// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal, digest, mergeKeys, validateFiles, prepareBackups, applyFiles } from '../../../herdr/src/setup/backup.js';
import type { InstallFile } from '../../../herdr/src/setup/installer.js';
import { basename, dirname, join } from 'node:path';
import { cleanup } from './herdr-setup-fixture.js';
import { changingAppVersion } from './herdr-setup-cross-machine-fixture.js';
import { installFastAppVersion } from './herdr-setup-version-shell.testutil.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture();

test('fast app-version replies preserve success, failure, and command delegation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'herdr version '));
  try {
    const binary = join(root, "app's"), script = join(root, "app's.mjs");
    const marker = "console.log('herdr-app 0.1.13')";
    await writeFile(binary, '#!/bin/sh\ncase "$1" in\n  ls|commands) exit 0 ;;\nesac\nprintf delegated\n');
    await chmod(binary, 0o700); await writeFile(script, marker);
    await installFastAppVersion(binary, script, '0.1.13');
    const invoke = (args: string[]) => { const { status, stdout, stderr } = spawnSync(binary, args, { encoding: 'utf8' }); return { status, stdout, stderr }; };
    expect(invoke(['--version'])).toEqual({ status: 0, stdout: 'herdr-app 0.1.13\n', stderr: '' });
    expect(invoke(['do'])).toEqual({ status: 0, stdout: 'delegated', stderr: '' });
    await writeFile(script, 'process.exit(1)');
    expect(invoke(['--version'])).toEqual({ status: 1, stdout: '', stderr: '' });
    await writeFile(script, marker);
    expect(invoke(['--version'])).toEqual({ status: 0, stdout: 'herdr-app 0.1.13\n', stderr: '' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a lost version does not recreate a removed picker key section', async () => {
  const f = await changingAppVersion('0.1.13'), home = f.h.directories.app, app = join(f.h.root, 'app-selection.mjs');
  await installFastAppVersion(f.request.config.app.binary, app, '0.1.13');
  await setupHerdr(f.request, f.parts);
  const keyPath = join(home, 'keys.json'), before = await readFile(keyPath), journal = await readJournal(f.request.journalRoot);
  const prior = journal.entries.find(entry => entry.path === keyPath)!.keys!;
  const extra = { custom: { 'ctrl-p': 'mod.open:spider-machine-picker' } }, owned = { ...prior, ...extra };
  const plans: InstallFile[] = [{ path: keyPath, expected: digest(before), bytes: mergeKeys(before, extra, prior, false), keys: owned, managed: { kind: 'keys', sections: Object.fromEntries(Object.entries(owned).map(([section, bindings]) => [section, Object.keys(bindings)])) } }];
  await validateFiles(plans, journal); await prepareBackups(f.request.journalRoot, plans, journal); await applyFiles(f.request.journalRoot, plans, journal);
  const current = JSON.parse(await readFile(keyPath, 'utf8')); delete current.custom; await writeFile(keyPath, JSON.stringify(current));
  const asset = join(f.root, 'packages/herdr/assets/keys.json'), desired = JSON.parse(await readFile(asset, 'utf8'));
  desired.terminal['cmd-shift-o'] = 'send:\u001b[99;6u'; await writeFile(asset, JSON.stringify(desired));
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => {
    const files = await stage(...args);
    await writeFile(app, (await readFile(app, 'utf8')).replace("console.log('herdr-app 0.1.13')", 'process.exit(1)'));
    return files;
  };
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  const updated = JSON.parse(await readFile(keyPath, 'utf8'));
  expect(updated).not.toHaveProperty('custom');
  expect(updated.terminal['cmd-shift-o']).toBe('send:\u001b[99;6u');
  expect((await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === keyPath)?.keys?.custom['ctrl-p']).toBe('mod.open:spider-machine-picker');
});

test('a lost version preserves a lone picker helper and still installs the A pane', async () => {
  const f = await changingAppVersion('0.1.13'), home = f.h.directories.app, app = join(f.h.root, 'app-selection.mjs');
  await installFastAppVersion(f.request.config.app.binary, app, '0.1.13');
  const helper = join(home, 'mods/spider-pane/machine.js');
  await mkdir(dirname(helper), { recursive: true }); await writeFile(helper, '// existing picker helper\n');
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => {
    const files = await stage(...args);
    await writeFile(app, (await readFile(app, 'utf8')).replace("console.log('herdr-app 0.1.13')", 'process.exit(1)'));
    return files;
  };
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(await readFile(helper, 'utf8')).toBe('// existing picker helper\n');
  expect((await stat(join(home, 'mods/spider-pane/main.js'))).isFile()).toBe(true);
  await expect(stat(join(home, 'mods/spider-machine-picker'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('0.1.12 preserves native creation keys and does not install machine pickers', async () => {
  const f = await fastFixture(), home = f.h.directories.app, path = join(home, 'keys.json');
  const before = JSON.parse(await readFile(path, 'utf8'));
  Object.assign(before.global, { 'cmd-t': 'tab.new', 'cmd-d': 'pane.split:right', 'cmd-shift-d': 'pane.split:down' });
  await writeFile(path, JSON.stringify(before));
  const preflight = await f.parts.preflight(f.request);
  expect(preflight.mods.map(mod => basename(mod.directory))).not.toEqual(expect.arrayContaining(['spider-machine-picker']));
  await setupHerdr(f.request, f.parts);
  const keys = JSON.parse(await readFile(path, 'utf8'));
  for (const key of ['cmd-t', 'cmd-d', 'cmd-shift-d']) expect(keys.global[key]).toBe(before.global[key]);
  expect(keys['layout:spider-glass']?.['cmd-shift-w']).toBeUndefined();
  for (const name of ['spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down']) {
    await expect(stat(join(home, 'mods', name))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  const doctor = await f.ports.doctorParts(f.request);
  expect((await doctor.inspect('mods', f.request)).failures).toEqual([]);
  expect((await doctor.inspect('keys', f.request)).failures).toEqual([]);
});

test('0.1.12 refuses previously owned pickers until rollback restores stock keys', async () => {
  const f = await fastFixture(), home = f.h.directories.app, path = join(home, 'keys.json');
  const stock = JSON.parse(await readFile(path, 'utf8'));
  Object.assign(stock.global, { 'cmd-t': 'tab.new', 'cmd-d': 'pane.split:right', 'cmd-shift-d': 'pane.split:down' });
  const baseline = Buffer.from(JSON.stringify(stock)); await writeFile(path, baseline);
  const keys = { global: { 'cmd-t': 'mod.open:spider-machine-picker', 'cmd-d': 'mod.open:spider-machine-picker-right', 'cmd-shift-d': 'mod.open:spider-machine-picker-down' }, 'layout:spider-glass': { 'cmd-shift-w': 'spider-pane.close' } };
  const picker = join(home, 'mods/spider-machine-picker/main.js');
  const plans: InstallFile[] = [
    { path, expected: digest(baseline), bytes: mergeKeys(baseline, keys, {}, false), keys, managed: { kind: 'keys', sections: { global: ['cmd-t', 'cmd-d', 'cmd-shift-d'], 'layout:spider-glass': ['cmd-shift-w'] } } },
    { path: picker, expected: null, bytes: Buffer.from('// old owned picker\n') },
  ];
  const journal = await readJournal(f.request.journalRoot);
  await validateFiles(plans, journal); await prepareBackups(f.request.journalRoot, plans, journal); await applyFiles(f.request.journalRoot, plans, journal);
  const settings = join(home, 'settings.json'), before = await readFile(settings), installedKeys = await readFile(path);
  const command = [process.execPath, join(f.root, 'dist/herdr/cli.mjs'), 'rollback', '--config', f.request.configPath].map(value => `'${value.replace(/'/g, "'\\\\''")}'`).join(' ');
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'legacy-picker-binding', message: expect.stringContaining(command) });
  expect(await readFile(settings)).toEqual(before);
  expect(await readFile(path)).toEqual(installedKeys);
  expect(await readFile(picker, 'utf8')).toBe('// old owned picker\n');
  const doctor = await f.ports.doctorParts(f.request);
  expect((await doctor.inspect('keys', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'legacy-picker-binding', message: expect.stringContaining('cmd-t'), repair: expect.stringContaining(command) }));
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(stock);
  await expect(stat(picker)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('0.1.12 refuses an unowned stale picker binding without changing it', async () => {
  const f = await fastFixture(), path = join(f.h.directories.app, 'keys.json');
  const keys = JSON.parse(await readFile(path, 'utf8'));
  keys.global['cmd-d'] = 'mod.open:spider-machine-picker-right';
  await writeFile(path, JSON.stringify(keys));
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'legacy-picker-binding', message: expect.stringContaining('global.cmd-d') });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(keys);
  expect((await (await f.ports.doctorParts(f.request)).inspect('keys', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'legacy-picker-binding', repair: expect.stringContaining('stock') }));
});

test('0.1.12 refuses a structured picker binding outside the default section', async () => {
  const f = await fastFixture(), path = join(f.h.directories.app, 'keys.json');
  const keys = JSON.parse(await readFile(path, 'utf8'));
  keys.terminal['ctrl-p'] = { command: 'mod.open', args: { name: 'spider-machine-picker-right' } };
  await writeFile(path, JSON.stringify(keys));
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'legacy-picker-binding', message: expect.stringContaining('terminal.ctrl-p') });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(keys);
  expect((await (await f.ports.doctorParts(f.request)).inspect('keys', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'legacy-picker-binding', message: expect.stringContaining('terminal.ctrl-p') }));
});

test('0.1.12 refuses an owned picker file even after its shortcuts are restored', async () => {
  const f = await fastFixture(), path = join(f.h.directories.app, 'mods/spider-machine-picker/main.js');
  const journal = await readJournal(f.request.journalRoot), plans: InstallFile[] = [{ path, expected: null, bytes: Buffer.from('// old owned picker\n') }];
  await prepareBackups(f.request.journalRoot, plans, journal); await applyFiles(f.request.journalRoot, plans, journal);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'legacy-picker-binding', message: expect.stringContaining(path) });
  expect((await (await f.ports.doctorParts(f.request)).inspect('keys', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'legacy-picker-binding', message: expect.stringContaining(path) }));
  await rollbackHerdr(f.request, f.parts);
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
