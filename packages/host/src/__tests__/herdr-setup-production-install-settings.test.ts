// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { readJournal } from '../../../herdr/src/setup/backup.js';
import { cleanup } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fullFixture = (requireAppBackup = false) => focusedSetupFixture({ coreTransport: 'process' }, requireAppBackup);

test('app selections are backed up before commands and restored by rollback', async () => {
  const f = await fullFixture(true);
  const settings = join(f.h.directories.app, 'settings.json');
  const original = await readFile(settings);
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ zoom: 1.25, theme: 'spider-glass', layout: 'spider-glass', sounds: { enabled: false } });
  const entry = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === settings)!;
  expect(await readFile(entry.backup!)).toEqual(original);
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(settings)).toEqual(original);
});

test('setup without --config reads the standard file and records no extra path', async () => {
  const f = await focusedSetupFixture(); const standard = join(f.h.directories.global, 'herdr/config.json');
  await mkdir(dirname(standard), { recursive: true }); await writeFile(standard, await readFile(f.request.configPath));
  const request = await f.ports.request();
  expect(request.configPath).toBe(standard);
  expect(await runHerdrCli(['setup'], { ...f.ports, setupParts: r => f.ports.setupParts(r), stdout() {}, stderr() {} })).toBe(0);
  expect(JSON.parse(await readFile(join(f.h.directories.global, 'config.json'), 'utf8'))['herdr.config']).toBeUndefined();
  expect((await readJournal(request.journalRoot)).entries.some(e => e.path === join(f.h.directories.global, 'config.json'))).toBe(false);
});

test('custom configuration paths are backed up as an owned global key without copying', async () => {
  const f = await focusedSetupFixture(); const global = join(f.h.directories.global, 'config.json');
  const original = await readFile(global);
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(global, 'utf8'))['herdr.config']).toBe(f.request.configPath);
  const entry = (await readJournal(f.request.journalRoot)).entries.find(e => e.path === global)!;
  expect(await readFile(entry.backup!)).toEqual(original);
  expect(await readFile(join(f.h.directories.global, 'herdr/config.json')).then(() => true, () => false)).toBe(false);
  await writeFile(global, JSON.stringify({ ...JSON.parse(await readFile(global, 'utf8')), userChoice: 'keep' }));
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(global, 'utf8')).userChoice).toBe('keep');
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
});
