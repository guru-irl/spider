// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal, digest, mergeKeys, validateFiles, prepareBackups, applyFiles } from '../../../herdr/src/setup/backup.js';
import type { InstallFile } from '../../../herdr/src/setup/installer.js';
import { dirname, join, resolve } from 'node:path';
import { cleanup, fixture } from './herdr-setup-fixture.js';
import { changingAppVersion, tree } from './herdr-setup-cross-machine-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const bareFixture = () => fixture('fake', false, { startCores: false });

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
  expect(keyPlan.keys?.['layout:Spider']).not.toHaveProperty('cmd-shift-w');
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
  const keys = { global: { 'cmd-t': 'mod.open:spider-machine-picker' }, 'layout:Spider': { 'cmd-shift-w': 'spider-pane.close' } };
  const picker = join(home, 'mods/spider-machine-picker/main.js');
  const plans: InstallFile[] = [
    { path: keyPath, expected: digest(before), bytes: mergeKeys(before, keys, {}, false), keys, managed: { kind: 'keys', sections: { global: ['cmd-t'], 'layout:Spider': ['cmd-shift-w'] } } },
    { path: picker, expected: null, bytes: Buffer.from('// installed picker\n') },
  ];
  const journal = await readJournal(request.journalRoot);
  await validateFiles(plans, journal); await prepareBackups(request.journalRoot, plans, journal); await applyFiles(request.journalRoot, plans, journal);
  const installed = await readFile(keyPath), journalBefore = await readFile(join(request.journalRoot, 'journal.json'));
  const files = await f.parts.installFiles(request, f.context);
  expect(files.some(file => file.path === picker)).toBe(false);
  expect(files.find(file => file.path === keyPath)?.keys?.global).not.toHaveProperty('cmd-t');
  expect(files.find(file => file.path === keyPath)?.retainedKeys?.global['cmd-t']).toBe('mod.open:spider-machine-picker');
  expect(files.find(file => file.path === keyPath)?.retainedKeys?.['layout:Spider']['cmd-shift-w']).toBe('spider-pane.close');
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
  expect(keys['layout:Spider']?.['cmd-shift-w']).toBeUndefined();
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
