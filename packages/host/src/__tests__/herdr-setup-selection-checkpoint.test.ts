// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal, saveJournal } from '../../../herdr/src/setup/backup.js';
import { cleanup, type SetupFixture } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { fingerprint, interruptSelection } from './herdr-setup-selection-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture();

test.each([false, true])('setup repairs an older unverified completed-cutover checkpoint (partial: %s)', async partial => {
  const f = await fastFixture(), settings = join(f.request.config.app.home, 'settings.json');
  const original = await readFile(settings);
  await setupHerdr(f.request, f.parts);
  // Older setup recorded cutover completion before selecting the app look.
  const journal = await readJournal(f.request.journalRoot);
  journal.verified = false;
  await saveJournal(f.request.journalRoot, journal);
  await writeFile(settings, partial ? JSON.stringify({ ...JSON.parse(original.toString()), layout: 'spider-glass' }) : original);
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(JSON.parse((await readFile(settings)).toString())).toEqual({ zoom: 1.25, theme: 'spider-glass', layout: 'spider-glass', sounds: { enabled: false } });
}, 60_000);

test('partial-transition recovery never applies to other setup-managed fields', async () => {
  const { f } = await interruptSelection('app.theme');
  const keysPath = join(f.request.config.app.home, 'keys.json');
  const keys = JSON.parse((await readFile(keysPath)).toString());
  const managed = Object.keys(keys.terminal);
  expect(managed.length).toBeGreaterThan(1);
  delete keys.terminal[managed[0]];
  await writeFile(keysPath, JSON.stringify(keys));
  const before = await fingerprint(f);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'managed-artifact-changed' });
  expect(await fingerprint(f)).toEqual(before);
}, 60_000);
