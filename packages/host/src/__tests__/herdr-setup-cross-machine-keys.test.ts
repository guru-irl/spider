// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal, digest, mergeKeys, validateFiles, prepareBackups, applyFiles } from '../../../herdr/src/setup/backup.js';
import type { InstallFile } from '../../../herdr/src/setup/installer.js';
import { basename, dirname, join } from 'node:path';
import { cleanup } from './herdr-setup-fixture.js';
import { changingAppVersion } from './herdr-setup-cross-machine-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture();

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
  expect(after['layout:Spider']['cmd-shift-w']).toEqual(before['layout:Spider']['cmd-shift-w']);
  const newJournal = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === keyPath)!;
  for (const key of ['cmd-t', 'cmd-d', 'cmd-shift-d']) expect(newJournal.keysBefore?.global[key]).toEqual(oldJournal.keysBefore?.global[key]);
  expect(newJournal.keysBefore?.['layout:Spider']['cmd-shift-w']).toEqual(oldJournal.keysBefore?.['layout:Spider']['cmd-shift-w']);
});

test.each([false, true])('a lost version updates independent keys without rebinding user-modified picker keys (overwrite=%s)', async overwrite => {
  const f = await changingAppVersion('0.1.13'), home = f.h.directories.app, app = join(f.h.root, 'app-selection.mjs');
  const stockKeys = JSON.parse(await readFile(join(home, 'keys.json'), 'utf8'));
  await setupHerdr(f.request, f.parts);
  const keyPath = join(home, 'keys.json'), keys = JSON.parse(await readFile(keyPath, 'utf8'));
  keys.global['cmd-t'] = 'tab.new'; keys['layout:Spider']['cmd-shift-w'] = 'custom.close';
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
  expect(current['layout:Spider']['cmd-shift-w']).toBe('custom.close');
  expect(current.terminal['cmd-shift-a']).toBe('send:\u001b[99;6u');
  const after = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === keyPath)!;
  expect(after.keys?.global['cmd-t']).toEqual(journal.keys?.global['cmd-t']);
  expect(after.keysBefore?.global['cmd-t']).toEqual(journal.keysBefore?.global['cmd-t']);
  expect(after.keysBefore?.['layout:Spider']['cmd-shift-w']).toEqual(journal.keysBefore?.['layout:Spider']['cmd-shift-w']);
  await writeFile(app, (await readFile(app, 'utf8')).replace('process.exit(1)', "console.log('herdr-app 0.1.13')"));
  const warnings: string[] = []; f.parts.warn = message => { warnings.push(message); };
  await rollbackHerdr(f.request, f.parts);
  expect(warnings.some(message => message.includes(keyPath) && message.includes('partially restored'))).toBe(true);
  const rolledBack = JSON.parse(await readFile(keyPath, 'utf8'));
  expect(rolledBack.global['cmd-t']).toBe('tab.new');
  expect(rolledBack['layout:Spider']['cmd-shift-w']).toBe('custom.close');
  expect(rolledBack.terminal['cmd-shift-a']).toEqual(overwrite ? 'send:\u001b[88;6u' : stockKeys.terminal?.['cmd-shift-a']);
});
