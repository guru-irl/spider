// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import * as fs from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, writeFile, stat, lstat, readdir, readlink, rm, chmod } from 'node:fs/promises';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal, digest, mergeKeys, validateFiles, prepareBackups, applyFiles } from '../../../herdr/src/setup/backup.js';
import type { InstallFile } from '../../../herdr/src/setup/installer.js';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { cleanup, fixture } from './herdr-setup-fixture.js';
import { releaseFixture } from './herdr-setup-release-fixture.js';
import { focusedSetupFixture, useStaticSetupApp } from './herdr-setup-focused-fixture.js';
import * as lookPatches from '@spider/herdr/look/patches';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link), mkdir: vi.fn(actual.mkdir) };
});
const realFs = await vi.importActual<typeof fs>('node:fs/promises');
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); for (const name of ['rename', 'link', 'mkdir'] as const) vi.mocked(fs[name]).mockImplementation(realFs[name] as never); });
type Release = Parameters<typeof releaseFixture>[0];
const fastRelease = async (version: Release, localOnly = true) =>
  useStaticSetupApp(await releaseFixture(version, { coreTransport: 'socket', localOnly }), version);
const changingAppVersion = async (version: Release, coreTransport: 'process' | 'socket' = 'socket') =>
  useStaticSetupApp(await releaseFixture(version, { coreTransport, localOnly: true }), null);
const bareFixture = () => fixture('fake', false, { startCores: false });
const fastFixture = () => focusedSetupFixture();

async function tree(root: string): Promise<string[]> {
  const rows: string[] = [];
  async function visit(path: string): Promise<void> {
    let info;
    try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { rows.push(`${relative(root, path)} missing`); return; } throw error; }
    const name = relative(root, path) || '.';
    if (info.isSymbolicLink()) { rows.push(`${name} link ${await readlink(path)}`); return; }
    if (info.isDirectory()) {
      rows.push(`${name} directory ${info.mode & 0o777}`);
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
    } else if (info.isFile()) rows.push(`${name} file ${info.mode & 0o777} ${digest(await readFile(path))}`);
    else rows.push(`${name} special ${info.mode}`);
  }
  await visit(root); return rows;
}


test('unreadable app version skips picker keys while install and doctor remain available', async () => {
  const f = await bareFixture(), home = f.h.directories.app;
  const request = { ...f.request, config: { ...f.request.config, app: { ...f.request.config.app, binary: join(f.h.root, 'missing-app') } } };
  const keyPath = join(home, 'keys.json'), before = JSON.parse(await readFile(keyPath, 'utf8'));
  Object.assign(before.global, { 'cmd-t': 'tab.new', 'cmd-d': 'pane.split:right', 'cmd-shift-d': 'pane.split:down' });
  await writeFile(keyPath, JSON.stringify(before));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const files = await f.parts.installFiles(request, f.context);
  expect(stderr.mock.calls.map(([text]) => String(text)).filter(text => /picker.*version/i.test(text))).toHaveLength(1);
  const keyPlan = files.find(file => file.path === keyPath)!;
  expect(keyPlan.keys?.global).not.toHaveProperty('cmd-t');
  expect(keyPlan.keys?.global).not.toHaveProperty('cmd-d');
  expect(keyPlan.keys?.global).not.toHaveProperty('cmd-shift-d');
  expect(keyPlan.keys?.['layout:spider-glass']).not.toHaveProperty('cmd-shift-w');
  const merged = mergeKeys(Buffer.from(JSON.stringify(before)), keyPlan.keys!, {}, false);
  await writeFile(keyPath, merged);
  const doctor = await f.ports.doctorParts(request), result = await doctor.inspect('keys', request);
  expect(result.failures).toEqual([]);
  expect(result.warnings?.filter(warning => warning.code === 'picker-version-unavailable')).toEqual([
    expect.objectContaining({ message: expect.stringMatching(/version.*picker|picker.*version/i) }),
  ]);
  expect(JSON.parse(await readFile(keyPath, 'utf8')).global).toMatchObject({ 'cmd-t': 'tab.new', 'cmd-d': 'pane.split:right', 'cmd-shift-d': 'pane.split:down' });
  await expect(f.parts.stageLook(request, f.context, 'export')).rejects.toMatchObject({ code: 'upstream-version-unavailable' });
});

test('unreadable app version leaves existing picker files and bindings alone', async () => {
  const f = await bareFixture(), home = f.h.directories.app;
  const request = { ...f.request, config: { ...f.request.config, app: { ...f.request.config.app, binary: join(f.h.root, 'missing-app') } } };
  const keyPath = join(home, 'keys.json'), before = await readFile(keyPath);
  const keys = { global: { 'cmd-t': 'mod.open:spider-machine-picker' }, 'layout:spider-glass': { 'cmd-shift-w': 'spider-pane.close' } };
  const picker = join(home, 'mods/spider-machine-picker/main.js');
  const plans: InstallFile[] = [
    { path: keyPath, expected: digest(before), bytes: mergeKeys(before, keys, {}, false), keys, managed: { kind: 'keys', sections: { global: ['cmd-t'], 'layout:spider-glass': ['cmd-shift-w'] } } },
    { path: picker, expected: null, bytes: Buffer.from('// installed picker\n') },
  ];
  const journal = await readJournal(request.journalRoot);
  await validateFiles(plans, journal); await prepareBackups(request.journalRoot, plans, journal); await applyFiles(request.journalRoot, plans, journal);
  const installed = await readFile(keyPath), journalBefore = await readFile(join(request.journalRoot, 'journal.json'));
  const files = await f.parts.installFiles(request, f.context);
  expect(files.some(file => file.path === picker)).toBe(false);
  expect(files.find(file => file.path === keyPath)?.keys?.global).not.toHaveProperty('cmd-t');
  expect(files.find(file => file.path === keyPath)?.retainedKeys?.global['cmd-t']).toBe('mod.open:spider-machine-picker');
  expect(files.find(file => file.path === keyPath)?.retainedKeys?.['layout:spider-glass']['cmd-shift-w']).toBe('spider-pane.close');
  expect(await readFile(keyPath)).toEqual(installed);
  expect(await readFile(picker, 'utf8')).toBe('// installed picker\n');
  expect(await readFile(join(request.journalRoot, 'journal.json'))).toEqual(journalBefore);
  const result = await (await f.ports.doctorParts(request)).inspect('keys', request);
  expect(result.warnings?.filter(warning => warning.code === 'picker-version-unavailable')).toEqual([
    expect.objectContaining({ message: expect.stringMatching(/version.*picker|picker.*version/i) }),
  ]);
  expect(result.warnings?.find(warning => warning.code === 'picker-version-unavailable')?.message).toMatch(/existing.*left in place/i);
  expect(result.failures.some(failure => failure.message.includes('cmd-shift-w'))).toBe(false);
  expect(result.failures.some(failure => failure.code === 'legacy-picker-binding')).toBe(false);
});

test.each(['0.1.13', '0.1.16'] as const)('a lost version after staging installs A without picker files or bindings on %s', async version => {
  const f = await changingAppVersion(version, version === '0.1.13' ? 'process' : 'socket'), home = f.h.directories.app, app = join(f.h.root, 'app-selection.mjs');
  const stockKeys = JSON.parse(await readFile(join(home, 'keys.json'), 'utf8'));
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => {
    const files = await stage(...args);
    await writeFile(app, (await readFile(app, 'utf8')).replace(`console.log('herdr-app ${version}')`, 'process.exit(1)'));
    return files;
  };
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(result.doctor.warnings.filter(warning => warning.code === 'picker-version-unavailable')).toHaveLength(1);
  expect(stderr.mock.calls.map(([text]) => String(text)).filter(text => /picker.*version/i.test(text))).toHaveLength(1);
  expect(await readFile(join(home, 'mods/spider-pane/main.js'), 'utf8')).not.toContain('spider-look:b-pane-entry-imports');
  for (const name of ['spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down']) await expect(stat(join(home, 'mods', name))).rejects.toMatchObject({ code: 'ENOENT' });
  for (const path of ['spider-menu/actions.js', 'spider-menu/machine.js', 'spider-menu/machines/actions.js', 'spider-pane/machines/actions.js', 'spider-tabs/machines/actions.js']) await expect(stat(join(home, 'mods', path))).rejects.toMatchObject({ code: 'ENOENT' });
  for (const path of result.writes.filter(path => path.startsWith(join(home, 'mods') + '/') && path.endsWith('.js'))) {
    const source = (await readFile(path, 'utf8')).replace(/^\s*\/\/[^\n]*$/gm, '');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)) expect((await stat(resolve(dirname(path), match[1]!))).isFile(), `${path}: ${match[1]}`).toBe(true);
  }
  const keys = JSON.parse(await readFile(join(home, 'keys.json'), 'utf8'));
  for (const key of ['cmd-t', 'cmd-d', 'cmd-shift-d']) expect(keys.global[key]).toEqual(stockKeys.global[key]);
  expect(keys['layout:spider-glass']?.['cmd-shift-w']).toBeUndefined();
  const parkAsset = join(f.root, 'packages/herdr/assets/pane/park.js'), updatedPark = Buffer.concat([await readFile(parkAsset), Buffer.from('\n// updated pane asset\n')]);
  await writeFile(parkAsset, updatedPark);
  await writeFile(app, (await readFile(app, 'utf8')).replace('process.exit(1)', `console.log('herdr-app ${version}')`));
  await setupHerdr(f.request, f.parts);
  expect(await readFile(join(home, 'mods/spider-pane/park.js'))).toEqual(updatedPark);
  f.parts.stageLook = stage;
  await writeFile(app, (await readFile(app, 'utf8')).replace('process.exit(1)', `console.log('herdr-app ${version}')`));
  const recovered = await setupHerdr(f.request, f.parts);
  expect(recovered.doctor.failures).toEqual([]);
  expect((await stat(join(home, 'mods/spider-machine-picker/main.js'))).isFile()).toBe(true);
  expect(JSON.parse(await readFile(join(home, 'keys.json'), 'utf8')).global['cmd-t']).toBe('mod.open:spider-machine-picker');
});

test.each(['0.1.13', '0.1.16'] as const)('a lost version after staging preserves an installed picker and its rollback ownership on %s', async version => {
  const f = await changingAppVersion(version, version === '0.1.13' ? 'process' : 'socket'), home = f.h.directories.app, app = join(f.h.root, 'app-selection.mjs');
  const stockKeys = await readFile(join(home, 'keys.json'));
  await setupHerdr(f.request, f.parts);
  const pickerRoots = ['spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down', 'spider-pane', 'spider-tabs', 'spider-menu', 'spider-new-menu', 'spider-agents'].map(name => join(home, 'mods', name));
  const before = await Promise.all(pickerRoots.map(tree));
  const keyPath = join(home, 'keys.json'), keyBytes = await readFile(keyPath), oldKeys = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === keyPath)!;
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => {
    const files = await stage(...args);
    await writeFile(app, (await readFile(app, 'utf8')).replace(`console.log('herdr-app ${version}')`, 'process.exit(1)'));
    return files;
  };
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(result.doctor.warnings.filter(warning => warning.code === 'picker-version-unavailable')).toHaveLength(1);
  expect(await Promise.all(pickerRoots.map(tree))).toEqual(before);
  expect(await readFile(keyPath)).toEqual(keyBytes);
  const newKeys = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === keyPath)!;
  expect(newKeys.keys).toEqual(oldKeys.keys);
  expect(newKeys.keysBefore).toEqual(oldKeys.keysBefore);
  expect(newKeys.keySectionsBefore).toEqual(oldKeys.keySectionsBefore);
  await writeFile(app, (await readFile(app, 'utf8')).replace('process.exit(1)', `console.log('herdr-app ${version}')`));
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(keyPath)).toEqual(stockKeys);
  await expect(stat(join(home, 'mods/spider-machine-picker'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a lost version updates independent keys without rebinding an installed picker', async () => {
  const f = await changingAppVersion('0.1.13'), home = f.h.directories.app, app = join(f.h.root, 'app-selection.mjs');
  await setupHerdr(f.request, f.parts);
  const keyPath = join(home, 'keys.json'), before = JSON.parse(await readFile(keyPath, 'utf8'));
  const oldJournal = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === keyPath)!;
  const keysAsset = join(f.root, 'packages/herdr/assets/keys.json'), desired = JSON.parse(await readFile(keysAsset, 'utf8'));
  desired.terminal['cmd-shift-a'] = 'send:\u001b[99;6u'; await writeFile(keysAsset, JSON.stringify(desired));
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => {
    const files = await stage(...args);
    await writeFile(app, (await readFile(app, 'utf8')).replace("console.log('herdr-app 0.1.13')", 'process.exit(1)'));
    return files;
  };
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  const after = JSON.parse(await readFile(keyPath, 'utf8'));
  expect(after.terminal['cmd-shift-a']).toBe('send:\u001b[99;6u');
  for (const key of ['cmd-t', 'cmd-d', 'cmd-shift-d']) expect(after.global[key]).toEqual(before.global[key]);
  expect(after['layout:spider-glass']['cmd-shift-w']).toEqual(before['layout:spider-glass']['cmd-shift-w']);
  const newJournal = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === keyPath)!;
  for (const key of ['cmd-t', 'cmd-d', 'cmd-shift-d']) expect(newJournal.keysBefore?.global[key]).toEqual(oldJournal.keysBefore?.global[key]);
  expect(newJournal.keysBefore?.['layout:spider-glass']['cmd-shift-w']).toEqual(oldJournal.keysBefore?.['layout:spider-glass']['cmd-shift-w']);
});

test.each([false, true])('a lost version updates independent keys without rebinding user-modified picker keys (overwrite=%s)', async overwrite => {
  const f = await changingAppVersion('0.1.13'), home = f.h.directories.app, app = join(f.h.root, 'app-selection.mjs');
  const stockKeys = JSON.parse(await readFile(join(home, 'keys.json'), 'utf8'));
  await setupHerdr(f.request, f.parts);
  const keyPath = join(home, 'keys.json'), keys = JSON.parse(await readFile(keyPath, 'utf8'));
  keys.global['cmd-t'] = 'tab.new'; keys['layout:spider-glass']['cmd-shift-w'] = 'custom.close';
  if (overwrite) keys.terminal['cmd-shift-a'] = 'send:\u001b[88;6u';
  await writeFile(keyPath, JSON.stringify(keys));
  const journal = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === keyPath)!;
  const asset = join(f.root, 'packages/herdr/assets/keys.json'), desired = JSON.parse(await readFile(asset, 'utf8'));
  desired.terminal['cmd-shift-a'] = 'send:\u001b[99;6u'; await writeFile(asset, JSON.stringify(desired));
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => {
    const files = await stage(...args);
    await writeFile(app, (await readFile(app, 'utf8')).replace("console.log('herdr-app 0.1.13')", 'process.exit(1)'));
    return files;
  };
  const result = await setupHerdr({ ...f.request, overwriteUnownedKeys: overwrite }, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(result.doctor.warnings.filter(warning => warning.code === 'picker-version-unavailable')).toHaveLength(1);
  const current = JSON.parse(await readFile(keyPath, 'utf8'));
  expect(current.global['cmd-t']).toBe('tab.new');
  expect(current['layout:spider-glass']['cmd-shift-w']).toBe('custom.close');
  expect(current.terminal['cmd-shift-a']).toBe('send:\u001b[99;6u');
  const after = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === keyPath)!;
  expect(after.keys?.global['cmd-t']).toEqual(journal.keys?.global['cmd-t']);
  expect(after.keysBefore?.global['cmd-t']).toEqual(journal.keysBefore?.global['cmd-t']);
  expect(after.keysBefore?.['layout:spider-glass']['cmd-shift-w']).toEqual(journal.keysBefore?.['layout:spider-glass']['cmd-shift-w']);
  await writeFile(app, (await readFile(app, 'utf8')).replace('process.exit(1)', "console.log('herdr-app 0.1.13')"));
  const warnings: string[] = []; f.parts.warn = message => { warnings.push(message); };
  await rollbackHerdr(f.request, f.parts);
  expect(warnings.some(message => message.includes(keyPath) && message.includes('partially restored'))).toBe(true);
  const rolledBack = JSON.parse(await readFile(keyPath, 'utf8'));
  expect(rolledBack.global['cmd-t']).toBe('tab.new');
  expect(rolledBack['layout:spider-glass']['cmd-shift-w']).toBe('custom.close');
  expect(rolledBack.terminal['cmd-shift-a']).toEqual(overwrite ? 'send:\u001b[88;6u' : stockKeys.terminal?.['cmd-shift-a']);
});

test('a lost version preserves a relocated picker binding while updating other keys', async () => {
  const f = await changingAppVersion('0.1.13'), home = f.h.directories.app, app = join(f.h.root, 'app-selection.mjs');
  await setupHerdr(f.request, f.parts);
  const keyPath = join(home, 'keys.json'), keys = JSON.parse(await readFile(keyPath, 'utf8'));
  keys.terminal['cmd-shift-a'] = { command: 'mod.open', args: { name: 'spider-machine-picker-right' } };
  await writeFile(keyPath, JSON.stringify(keys));
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
  const current = JSON.parse(await readFile(keyPath, 'utf8'));
  expect(current.terminal['cmd-shift-a']).toEqual(keys.terminal['cmd-shift-a']);
  expect(current.terminal['cmd-shift-o']).toBe('send:\u001b[99;6u');
});

test('a lost version does not recreate a removed picker key section', async () => {
  const f = await changingAppVersion('0.1.13'), home = f.h.directories.app, app = join(f.h.root, 'app-selection.mjs');
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

test.each(['0.1.12', '0.1.99'])('setup refuses a change to %s after staging without writing files', async version => {
  const f = await changingAppVersion('0.1.13'), app = join(f.h.root, 'app-selection.mjs');
  const roots = [f.h.directories.app, f.h.directories.agent], before = await Promise.all(roots.map(tree));
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => {
    const files = await stage(...args);
    await writeFile(app, (await readFile(app, 'utf8')).replace('herdr-app 0.1.13', `herdr-app ${version}`));
    return files;
  };
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'upstream-version-mismatch', message: expect.stringMatching(/Herdr version changed during setup.*rerun/i) });
  expect(await Promise.all(roots.map(tree))).toEqual(before);
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
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

test('doctor names the insecure machine-picker config and chmod repair', async () => {
  const f = await fastRelease('0.1.13');
  await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.app, 'mods/spider-machine-picker-right/config.json');
  await chmod(path, 0o644);
  const doctor = await f.ports.doctorParts(f.request);
  expect((await doctor.inspect('mods', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'picker-config-insecure', message: expect.stringContaining(`chmod 600 '${path}'`) }));
  expect((await stat(path)).mode & 0o777).toBe(0o644);
});

test('cross-machine helper digests affect the setup fingerprint', async () => {
  const f = await fastRelease('0.1.16'), path = join(f.root, 'packages/herdr/assets/look/cross-machine-patches.json');
  const first = await f.parts.preflight(f.request), manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.checks['0.1.16'].helperHashes['pane/actions.js'] = '0'.repeat(64);
  await writeFile(path, JSON.stringify(manifest));
  const changed = await f.parts.preflight(f.request);
  expect(changed.fingerprint).not.toBe(first.fingerprint);
});

test.each(['pane/actions.js', 'pane/machine.js', 'machines/actions.js', 'machines/picker.js'])('B refuses altered helper %s before staging', async helper => {
  const f = await fastRelease('0.1.16'), path = join(f.root, 'packages/herdr/assets', helper);
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('\n// altered helper\n')]));
  const context = { ...f.context, modProps: [...f.context.modProps, ...['picker', 'toast'].map(name => ({ directory: join(f.h.directories.app, 'mods', `spider-${name}`), props: { ...f.context.modProps[0]!.props, modId: `spider-${name}` } }))] };
  await expect(f.parts.stageLook(f.request, context, 'export')).rejects.toMatchObject({ code: 'cross-machine-helper-mismatch', message: expect.stringContaining(helper) });
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
});

test.each(['recipe', 'menu'] as const)('B refuses a missing A %s before staging', async missing => {
  const f = await fastRelease('0.1.16'), select = lookPatches.selectLookPatches;
  vi.spyOn(lookPatches, 'selectLookPatches').mockImplementation((manifest, version) => {
    const selected = select(manifest, version);
    if (missing === 'recipe') return { ...selected, recipe: undefined };
    return { ...selected, mods: { ...selected.mods, menu: undefined } };
  });
  await expect(f.parts.stageLook(f.request, f.context, 'export')).rejects.toMatchObject({ code: 'cross-machine-recipe-mismatch' });
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
});

for (const version of ['0.1.13', '0.1.16'] as const) {
  test(`${version} publishes complete mods before the layout can reference them`, async () => {
    const f = await fastRelease(version), mods = join(f.h.directories.app, 'mods');
    const layout = join(f.h.directories.app, 'layouts/spider-glass.json');
    const incomplete: string[] = [], published: string[] = [];
    const inspect = async (directory: string) => {
      const files = await readdir(directory).catch((): string[] => []);
      if (!files.includes('mod.json') || !files.includes('main.js')) { incomplete.push(basename(directory)); return; }
      const source = (await readFile(join(directory, 'main.js'), 'utf8')).replace(/^\s*\/\/[^\n]*$/gm, '');
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g))
        if (!await stat(resolve(directory, match[1]!)).then(info => info.isFile(), () => false)) incomplete.push(`${basename(directory)} imports ${match[1]}`);
    };
    for (const name of ['mkdir', 'rename', 'link'] as const) {
      const original = realFs[name] as (...args: any[]) => Promise<any>;
      vi.mocked(fs[name]).mockImplementation((async (...args: any[]) => {
        const result = await original(...args), destination = String(name === 'mkdir' ? args[0] : args[1]);
        if (dirname(destination) === mods && basename(destination).startsWith('spider-')) { published.push(basename(destination)); await inspect(destination); }
        if (destination === layout) for (const mod of ['spider-pane', 'spider-tabs', 'spider-menu', 'spider-new-menu']) await inspect(join(mods, mod));
        return result;
      }) as never);
    }
    const writes = (await setupHerdr(f.request, f.parts)).writes;
    const entries = writes.filter(path => /^spider-[^/]+\/main\.js$/.test(relative(mods, path)));
    expect(entries.length).toBeGreaterThan(5);
    expect(incomplete).toEqual([]);
    expect(published.sort()).toEqual(entries.map(entry => basename(dirname(entry))).sort());
    for (const entry of entries) {
      expect(writes).toContain(join(dirname(entry), 'mod.json'));
      const source = (await readFile(entry, 'utf8')).replace(/^\s*\/\/[^\n]*$/gm, '');
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)) expect(writes).toContain(resolve(dirname(entry), match[1]!));
    }
  });

  test(`${version} rollback removes created mod directories but preserves existing and populated directories`, async () => {
    const f = await fastRelease(version, false), mods = join(f.h.directories.app, 'mods');
    const keys = join(f.h.directories.app, 'keys.json');
    const originalKeys = version === '0.1.13' ? await readFile(keys) : undefined;
    if (version === '0.1.13') {
      expect(JSON.parse(originalKeys!.toString('utf8')).global).not.toHaveProperty('cmd-m');
      f.request.nativeKeys = 'accept';
    }
    const existing = join(mods, 'spider-new-menu'), shared = join(existing, 'shared');
    await mkdir(shared, { recursive: true });
    await setupHerdr(f.request, f.parts);
    if (version === '0.1.13') expect(JSON.parse(await readFile(keys, 'utf8')).global['cmd-m']).toBe('window.minimize');
    const userFile = join(mods, 'spider-machine-picker-down', 'user.txt');
    await writeFile(userFile, 'keep this');
    await rollbackHerdr(f.request, f.parts);
    if (version === '0.1.13') expect(await readFile(keys)).toEqual(originalKeys);
    for (const name of ['spider-machine-picker', 'spider-machine-picker-right', 'spider-pane-waiting']) await expect(stat(join(mods, name))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(existing, 'machines'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(existing)).isDirectory()).toBe(true);
    expect((await stat(shared)).isDirectory()).toBe(true);
    expect(await readFile(userFile, 'utf8')).toBe('keep this');
  });

  test(`${version} installs B as one owned set and repeats and rolls back without changing stock`, async () => {
    const f = await releaseFixture(version), home = f.h.directories.app;
    const keys = join(home, 'keys.json'), beforeKeys = await readFile(keys);
    const stock = await readFile(join(home, 'mods/new-menu/main.js'));
    await setupHerdr(f.request, f.parts);
    const journal = await readJournal(f.request.journalRoot);
    const newFiles = journal.entries.filter(entry => /\/mods\/spider-(?:new-menu|machine-picker(?:-right|-down)?|menu)\//.test(entry.path));
    const requiredFiles = ['spider-new-menu/main.js', 'spider-new-menu/mod.json', 'spider-menu/actions.js', 'spider-menu/machine.js',
      ...['spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down'].flatMap(name => ['main.js', 'picker.js', 'actions.js', 'mod.json', 'config.json'].map(file => `${name}/${file}`))];
    expect(newFiles.map(entry => entry.path)).toEqual(expect.arrayContaining(requiredFiles.map(file => join(home, 'mods', file))));
    for (const entry of newFiles) {
      expect(entry.before, entry.path).toBeNull();
      expect(digest(await readFile(entry.path)), entry.path).toBe(entry.after);
    }
    for (const name of ['spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down']) expect((await stat(join(home, 'mods', name, 'config.json'))).mode & 0o777).toBe(0o600);
    const doctor = await f.ports.doctorParts(f.request);
    for (const item of ['mods', 'clones', 'patch-version', 'layout-theme'] as const) expect((await doctor.inspect(item, f.request)).failures).toEqual([]);
    const savedJournal = await readFile(join(f.request.journalRoot, 'journal.json'));
    expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
    expect(await readFile(join(f.request.journalRoot, 'journal.json'))).toEqual(savedJournal);
    const body = join(home, 'mods/spider-new-menu/main.js'), original = await readFile(body);
    await writeFile(body, '// changed installed B body\n');
    expect((await doctor.inspect('clones', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'installed-artifact-changed' }));
    await writeFile(body, original);
    await rollbackHerdr(f.request, f.parts);
    for (const entry of newFiles) await expect(readFile(entry.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(keys)).toEqual(beforeKeys);
    expect(await readFile(join(home, 'mods/new-menu/main.js'))).toEqual(stock);
    expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
  });

  test(`${version} an unowned B file refuses unless replaced and rollback restores its original bytes`, async () => {
    const f = await fastRelease(version), home = f.h.directories.app;
    const directory = join(home, 'mods/spider-new-menu'); await mkdir(directory);
    const path = join(directory, 'main.js'), original = '// existing custom menu\n';
    await writeFile(path, original, { mode: 0o640 });
    const keys = join(home, 'keys.json'), beforeKeys = await readFile(keys);
    await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'unowned-clone-collision' });
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readFile(keys)).toEqual(beforeKeys);
    await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
    expect(await readFile(path, 'utf8')).toContain('spider-look:b-new-menu-terminal-entry');
    await rollbackHerdr(f.request, f.parts);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(await readFile(keys)).toEqual(beforeKeys);
  });

  for (const change of ['changed-record', 'missing-record', 'missing-release', 'missing-asset', 'stale-input', 'changed-output', 'stale-stock'] as const) {
    test(`${version} refuses ${change} before installing B files or keys`, async () => {
      const f = await fastRelease(version);
      const path = join(f.root, 'packages/herdr/assets/look/cross-machine-patches.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      if (change === 'changed-record') manifest.versions[version].tabs[0].replacement += '\n// changed\n';
      if (change === 'missing-record') manifest.versions[version].tabs.pop();
      if (change === 'missing-release') delete manifest.versions[version];
      if (change === 'stale-input' || change === 'changed-output') {
        const checks = (manifest.checks ??= {})[version] ??= {};
        (checks[change === 'stale-input' ? 'inputHashes' : 'outputHashes'] ??= {})['pane/main.js'] = '0'.repeat(64);
      }
      await writeFile(path, JSON.stringify(manifest));
      if (change === 'missing-asset') await rm(path);
      if (change === 'stale-stock') await writeFile(join(f.h.directories.app, 'mods/pane/main.js'), '// stale source\n');
      const keys = join(f.h.directories.app, 'keys.json'), before = await readFile(keys);
      await mkdir(f.request.journalRoot, { recursive: true });
      const roots = [f.h.directories.app, f.h.directories.agent, f.h.directories.global, f.request.config.shellRc];
      const beforeTrees = await Promise.all(roots.map(tree));
      await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: expect.stringMatching(change === 'stale-stock' ? /^upstream-source-unknown$/ : /^cross-machine-/) });
      expect(await readFile(keys)).toEqual(before);
      expect(await Promise.all(roots.map(tree))).toEqual(beforeTrees);
      expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
      for (const name of ['spider-pane', 'spider-tabs', 'spider-menu', 'spider-new-menu', 'spider-agents', 'spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down']) {
        await expect(readFile(join(f.h.directories.app, 'mods', name, 'main.js'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });
  }

  test(`${version} default production staging includes every B hook with its picker and keys`, async () => {
    const f = await fastRelease(version);
    const preflight = await f.parts.preflight(f.request);
    const context = { ...f.context, modProps: preflight.mods.map(copy => ({ directory: copy.directory, props: { ...f.context.modProps[0]!.props, modId: basename(copy.directory) } })) };
    const files = await f.parts.stageLook(f.request, context, 'export');
    expect(await f.parts.stageLook(f.request, context, 'export')).toEqual(files);
    const records = JSON.parse(await readFile(join(f.root, 'packages/herdr/assets/look/cross-machine-patches.json'), 'utf8')).versions[version] as Record<string, { id: string }[]>;
    for (const [mod, patches] of Object.entries(records)) {
      const body = files.find(file => file.path === join(f.h.directories.app, 'mods', `spider-${mod}`, 'main.js'))?.bytes.toString('utf8') ?? '';
      for (const patch of patches) expect.soft(body, `${version} ${mod}/${patch.id}`).toContain(`/* spider-look:${patch.id} */`);
    }
    const agents = files.find(file => file.path.endsWith('/spider-agents/main.js'))!.bytes.toString('utf8');
    expect(agents).toContain('spider-look:a-notification-import');
    expect(agents).toContain('spider-look:a-notification-arrival');
    const keyFile = (await f.parts.installFiles(f.request, context)).find(file => file.path.endsWith('/keys.json'))!;
    for (const [key, name] of [['cmd-t', 'spider-machine-picker'], ['cmd-d', 'spider-machine-picker-right'], ['cmd-shift-d', 'spider-machine-picker-down']] as const) {
      expect(keyFile.keys?.global?.[key]).toBe(`mod.open:${name}`);
      for (const file of ['main.js', 'picker.js', 'mod.json', 'config.json']) expect(files.some(entry => entry.path === join(f.h.directories.app, 'mods', name, file))).toBe(true);
    }
  });
}
