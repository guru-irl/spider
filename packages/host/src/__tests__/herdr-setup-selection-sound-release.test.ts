// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal } from '../../../herdr/src/setup/backup.js';
import { cleanup } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture();

test('leaves a verified user sound opt-in on rerun and rollback', async () => {
  const f = await fastFixture(), settings = join(f.request.config.app.home, 'settings.json');
  await setupHerdr(f.request, f.parts);
  const edited = JSON.parse(await readFile(settings, 'utf8'));
  edited.sounds.enabled = true;
  await writeFile(settings, JSON.stringify(edited));
  const warn = vi.spyOn(f.parts, 'warn');
  const plan = await setupHerdr({ ...f.request, dryRun: true }, f.parts);
  expect(plan.plan!.files.find(file => file.path === settings)?.refusal).toBeUndefined();
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(JSON.parse(await readFile(settings, 'utf8')).sounds.enabled).toBe(true);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sounds\.enabled.*released/i));
  const info = await (await f.ports.doctorParts(f.request)).inspect('layout-theme', f.request);
  expect(info.failures).toEqual([]);
  expect(info.information).toContainEqual(expect.objectContaining({ code: 'native-sound-policy', message: expect.stringMatching(/enabled/i) }));
  await setupHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(settings, 'utf8')).sounds.enabled).toBe(true);
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(settings, 'utf8')).sounds.enabled).toBe(true);
}, 60_000);

test('keeps a released sound preference when a rerun is interrupted', async () => {
  const f = await fastFixture(), settings = join(f.request.config.app.home, 'settings.json');
  await setupHerdr(f.request, f.parts);
  const current = JSON.parse(await readFile(settings, 'utf8'));
  current.sounds.enabled = true;
  await writeFile(settings, JSON.stringify(current));
  const verify = vi.spyOn(f.parts, 'verify').mockRejectedValueOnce(new Error('verification-interrupted'));
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ message: expect.stringContaining('verification-interrupted') });
  expect((await readJournal(f.request.journalRoot)).verified).toBe(false);
  verify.mockRestore();
  expect((await setupHerdr(f.request, f.parts)).doctor.failures).toEqual([]);
  expect(JSON.parse(await readFile(settings, 'utf8')).sounds.enabled).toBe(true);
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(settings, 'utf8')).sounds.enabled).toBe(true);
}, 60_000);
