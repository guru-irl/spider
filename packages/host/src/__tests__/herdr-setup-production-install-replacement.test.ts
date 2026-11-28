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

test.each([false, true])('replacement re-applies app selections without repeating session setup with running-in-place %s', async runningInPlace => {
  const f = await focusedSetupFixture({ coreTransport: 'socket', localOnly: runningInPlace }, true); await setupHerdr(f.request, f.parts);
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
  expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ zoom: 1.5, theme: 'spider-glass', layout: 'spider-glass', sounds: { enabled: false } });
  const entry = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === settings)!;
  expect(await readFile(entry.backup!, 'utf8')).toBe(choice);
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(settings, 'utf8')).toBe(choice);
});
