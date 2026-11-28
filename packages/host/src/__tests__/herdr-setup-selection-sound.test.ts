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

test('writes native sound after app selection even when the app saves stale settings', async () => {
  const f = await focusedSetupFixture({ coreTransport: 'process', localOnly: true }), settings = join(f.request.config.app.home, 'settings.json');
  const original = await readFile(settings), script = join(f.h.root, 'app-selection.mjs'), seen = join(f.h.root, 'selection-sounds');
  await writeFile(script, `import { readFileSync as readSettings, writeFileSync as saveSettings, appendFileSync as recordSettings } from 'node:fs';
const args = process.argv.slice(2), path = process.env.HERDR_APP_HOME + '/settings.json';
if (args[0] === 'do' && (args[1] === 'layout.switch' || args[1] === 'app.theme')) {
  const settings = JSON.parse(readSettings(path, 'utf8'));
  recordSettings(${JSON.stringify(seen)}, JSON.stringify(settings.sounds ?? null) + '\\n');
  delete settings.sounds;
  const choice = args[args.indexOf('--name') + 1];
  if (args[1] === 'layout.switch') {
    const shared = process.env.HERDR_APP_HOME + '/shared.json';
    saveSettings(shared, JSON.stringify({ ...JSON.parse(readSettings(shared, 'utf8')), layout: choice }));
  } else settings.theme = choice;
  saveSettings(path, JSON.stringify(settings)); console.log('{}'); process.exit(0);
}
` + await readFile(script, 'utf8'));
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(await readFile(seen, 'utf8')).toBe('null\nnull\n');
  expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ zoom: 1.25, theme: 'spider-glass', sounds: { enabled: false } });
  expect((await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === settings)?.soundApplied).toBe(true);
  expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(settings)).toEqual(original);
}, 60_000);

test('saves the partial selection journal without hiding a selection error', async () => {
  const f = await fastFixture(), settings = join(f.request.config.app.home, 'settings.json');
  const script = join(f.h.root, 'app-selection.mjs');
  await writeFile(script, `import { readFileSync as readSettings, writeFileSync as saveSettings } from 'node:fs';
const args = process.argv.slice(2), path = process.env.HERDR_APP_HOME + '/settings.json';
if (args[0] === 'do' && args[1] === 'app.theme') {
  const settings = JSON.parse(readSettings(path, 'utf8')); delete settings.sounds; saveSettings(path, JSON.stringify(settings));
  console.error(JSON.stringify({ error: { kind: 'selection-interrupted', message: 'interrupted app selection' } })); process.exit(41);
}
` + await readFile(script, 'utf8'));
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'selection-interrupted' });
  const entry = (await readJournal(f.request.journalRoot)).entries.find(item => item.path === settings)!;
  const current = await readFile(settings);
  const { digest, managedProjection } = await import('../../../herdr/src/setup/backup.js');
  expect(entry.after).toBe(digest(current));
  expect(entry.managedAfter).toBe(managedProjection(current, entry.managed!));
  expect(JSON.parse(current.toString()).sounds).toBeUndefined();
}, 60_000);

test('does not claim a sound edit during interrupted selection before its own write', async () => {
  const f = await fastFixture(), settings = join(f.request.config.app.home, 'settings.json');
  const initial = JSON.parse(await readFile(settings, 'utf8'));
  await writeFile(settings, JSON.stringify({ ...initial, sounds: { enabled: true } }));
  const script = join(f.h.root, 'app-selection.mjs');
  await writeFile(script, `import { readFileSync as readSettings, writeFileSync as saveSettings } from 'node:fs';
const args = process.argv.slice(2), path = process.env.HERDR_APP_HOME + '/settings.json';
if (args[0] === 'do' && args[1] === 'app.theme') {
  const settings = JSON.parse(readSettings(path, 'utf8')); settings.sounds.enabled = false; saveSettings(path, JSON.stringify(settings));
  console.error(JSON.stringify({ error: { kind: 'selection-interrupted', message: 'interrupted app selection' } })); process.exit(41);
}
` + await readFile(script, 'utf8'));
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'selection-interrupted' });
  await expect(setupHerdr({ ...f.request, replaceChanged: true }, f.parts)).rejects.toMatchObject({ code: 'managed-artifact-changed' });
  const warn = vi.spyOn(f.parts, 'warn');
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(settings, 'utf8')).sounds.enabled).toBe(false);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sounds\.enabled.*released/i));
}, 60_000);
