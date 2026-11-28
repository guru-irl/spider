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
  const settings = join(f.h.directories.app, 'settings.json'), shared = join(f.h.directories.app, 'shared.json');
  const original = await readFile(settings), originalShared = await readFile(shared);
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ zoom: 1.25, theme: 'spider-glass', sounds: { enabled: false } });
  expect(JSON.parse(await readFile(shared, 'utf8'))).toEqual({ layout: 'Spider', 'fixture.mod': 'keep' });
  const journal = await readJournal(f.request.journalRoot);
  expect(await readFile(journal.entries.find(entry => entry.path === settings)!.backup!)).toEqual(original);
  expect(await readFile(journal.entries.find(entry => entry.path === shared)!.backup!)).toEqual(originalShared);
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(settings)).toEqual(original);
  expect(await readFile(shared)).toEqual(originalShared);
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

test.each([false, true])('replacement re-applies app selections without repeating session setup with running-in-place %s', async runningInPlace => {
  const f = await (runningInPlace ? focusedSetupFixture({ coreTransport: 'socket', localOnly: true }, true) : fullFixture(true)); await setupHerdr(f.request, f.parts);
  const settings = join(f.h.directories.app, 'settings.json');
  const choice = '{"zoom":1.5,"theme":"nord","layout":"personal"}'; await writeFile(settings, choice);
  const output: string[] = [], errors: string[] = [];
  const ports = { ...f.ports, stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
  expect(await runHerdrCli(['setup', '--config', f.request.configPath], ports)).toBe(1);
  expect(errors.join('')).toContain('--replace-changed');
  expect(errors.join('')).toContain('spider-glass');
  if (runningInPlace) {
    const preflight = f.parts.preflight;
    f.parts.preflight = async request => ({ ...await preflight(request), recoveredCutover: { terminals: [], identities: {} }, cutoverActions: [] });
  }
  f.parts.cutover = async () => { throw new Error('Selection repair must not repeat session setup'); };
  f.parts.reconcileCutover = f.parts.cutover;
  expect(await setupHerdr({ ...f.request, replaceChanged: true }, f.parts).then(result => result.doctor.failures)).toEqual([]);
  expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ zoom: 1.5, theme: 'spider-glass', layout: 'personal', sounds: { enabled: false } });
  const entry = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === settings)!;
  expect(await readFile(entry.backup!, 'utf8')).toBe(choice);
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(settings, 'utf8')).toBe(choice);
});
