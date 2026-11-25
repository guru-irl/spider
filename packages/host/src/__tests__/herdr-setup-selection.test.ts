// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal, saveJournal } from '../../../herdr/src/setup/backup.js';
import { cleanup, fixture, type SetupFixture } from './herdr-setup-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => fixture('fake', false, { coreTransport: 'socket' });

async function interruptSelection(command: 'layout.switch' | 'app.theme', coreTransport: 'process' | 'socket' = 'socket') {
  const f = await fixture('fake', false, { coreTransport }), settings = join(f.request.config.app.home, 'settings.json');
  const original = await readFile(settings);
  const script = join(f.h.root, 'app-selection.mjs'), marker = join(f.h.root, 'interrupt-selection');
  const journal = join(f.request.journalRoot, 'journal.json'), interruptedJournal = join(f.h.root, 'interrupted-journal.json');
  await writeFile(marker, 'once');
  await writeFile(script, `import { existsSync as hasInterruption, unlinkSync as consumeInterruption, readFileSync as readIntent, writeFileSync as retainIntent } from 'node:fs';
if (process.argv[2] === 'do' && process.argv[3] === ${JSON.stringify(command)} && hasInterruption(${JSON.stringify(marker)})) {
  consumeInterruption(${JSON.stringify(marker)});
  retainIntent(${JSON.stringify(interruptedJournal)}, readIntent(${JSON.stringify(journal)}));
  console.error(JSON.stringify({ error: { kind: 'selection-interrupted', message: 'interrupted app selection' } })); process.exit(41);
}
` + await readFile(script, 'utf8'));
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'selection-interrupted' });
  // SIGKILL cannot run the installer's finally block. Restore its actual pre-acknowledgement journal.
  await writeFile(journal, await readFile(interruptedJournal));
  return { f, settings, original };
}

async function fingerprint(f: SetupFixture) {
  const journal = await readJournal(f.request.journalRoot);
  const paths = new Set([join(f.request.journalRoot, 'journal.json'), ...journal.entries.flatMap(entry => [entry.path, ...entry.backup ? [entry.backup] : []])]);
  return Promise.all([...paths].sort().map(async path => ({ path, bytes: (await readFile(path)).toString('base64'), mtime: (await stat(path)).mtimeMs })));
}

// Recording cutover as complete before both app commands succeed skips selection on retry.
test.each(['layout.switch', 'app.theme'] as const)('setup resumes an interruption at %s and preserves its original backup', async command => {
  const { f, settings, original } = await interruptSelection(command, 'process');
  const partial = JSON.parse(await readFile(settings, 'utf8'));
  expect(partial.theme).toBe('stock');
  expect(partial.layout).toBe(command === 'app.theme' ? 'spider-glass' : undefined);
  const backup = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === settings)!.backup!;
  expect(await readFile(backup)).toEqual(original);
  const backupMtime = (await stat(backup)).mtimeMs;

  const resumed = await setupHerdr(f.request, f.parts);
  expect(resumed.doctor.failures).toEqual([]);
  expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ zoom: 1.25, theme: 'spider-glass', layout: 'spider-glass', sounds: { enabled: false } });
  expect((await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === settings)!.backup).toBe(backup);
  expect(await readFile(backup)).toEqual(original);
  expect((await stat(backup)).mtimeMs).toBe(backupMtime);

  const installed = await readFile(settings), unchangedBefore = await fingerprint(f);
  const unchanged = await setupHerdr(f.request, f.parts);
  expect(unchanged.writes).toEqual([]);
  expect(await fingerprint(f)).toEqual(unchangedBefore);
  // Even an original value is a user edit once setup has verified the installation.
  const edited = JSON.stringify({ ...JSON.parse(installed.toString()), theme: 'stock' });
  await writeFile(settings, edited);
  const editedBefore = await fingerprint(f);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'managed-artifact-changed' });
  expect(await fingerprint(f)).toEqual(editedBefore);
  await writeFile(settings, installed);
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(settings)).toEqual(original);
}, 60_000);

test.each(['theme', 'layout'])('interrupted setup refuses a foreign %s value before any installation write', async field => {
  const { f, settings, original } = await interruptSelection('app.theme');
  const edited = JSON.stringify({ ...JSON.parse((await readFile(settings)).toString()), [field]: 'foreign-selection' });
  await writeFile(settings, edited);
  const before = await fingerprint(f);
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'managed-artifact-changed' });
  expect(await fingerprint(f)).toEqual(before);
  const backup = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === settings)!.backup!;
  expect(await readFile(backup)).toEqual(original);
}, 60_000);

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

test('unrelated app settings edits survive interrupted setup recovery and rollback', async () => {
  const { f, settings } = await interruptSelection('app.theme');
  await writeFile(settings, JSON.stringify({ ...JSON.parse((await readFile(settings)).toString()), zoom: 2, custom: { keep: true } }));
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(JSON.parse((await readFile(settings)).toString())).toEqual({ theme: 'spider-glass', layout: 'spider-glass', zoom: 2, custom: { keep: true }, sounds: { enabled: false } });
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse((await readFile(settings)).toString())).toEqual({ theme: 'stock', zoom: 2, custom: { keep: true } });
}, 60_000);

test('rollback from a partial app selection restores the original settings bytes exactly', async () => {
  const { f, settings, original } = await interruptSelection('app.theme');
  expect(JSON.parse((await readFile(settings)).toString())).toEqual({ zoom: 1.25, theme: 'stock', layout: 'spider-glass' });
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(settings)).toEqual(original);
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
}, 60_000);


test('rollback releases a verified user theme and restores the other owned paths', async () => {
  const f = await fastFixture(), settings = join(f.request.config.app.home, 'settings.json');
  await setupHerdr(f.request, f.parts);
  const edited = JSON.stringify({ ...JSON.parse((await readFile(settings)).toString()), theme: 'stock' });
  await writeFile(settings, edited);
  const warn = vi.spyOn(f.parts, 'warn');
  await rollbackHerdr(f.request, f.parts);
  const expected = '{"zoom":1.25,"theme":"stock"}';
  expect(await readFile(settings, 'utf8')).toBe(expected);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/theme.*released|released.*theme/));
  expect((await readJournal(f.request.journalRoot)).entries.some(entry => entry.path === settings)).toBe(false);
  expect(await rollbackHerdr(f.request, f.parts)).toEqual([]);
  expect(await readFile(settings, 'utf8')).toBe(expected);
}, 60_000);

test('writes native sound after app selection even when the app saves stale settings', async () => {
  const f = await fixture(), settings = join(f.request.config.app.home, 'settings.json');
  const original = await readFile(settings), script = join(f.h.root, 'app-selection.mjs'), seen = join(f.h.root, 'selection-sounds');
  await writeFile(script, `import { readFileSync as readSettings, writeFileSync as saveSettings, appendFileSync as recordSettings } from 'node:fs';
const args = process.argv.slice(2), path = process.env.HERDR_APP_HOME + '/settings.json';
if (args[0] === 'do' && (args[1] === 'layout.switch' || args[1] === 'app.theme')) {
  const settings = JSON.parse(readSettings(path, 'utf8'));
  recordSettings(${JSON.stringify(seen)}, JSON.stringify(settings.sounds ?? null) + '\\n');
  delete settings.sounds;
  settings[args[1] === 'layout.switch' ? 'layout' : 'theme'] = args[args.indexOf('--name') + 1];
  saveSettings(path, JSON.stringify(settings)); console.log('{}'); process.exit(0);
}
` + await readFile(script, 'utf8'));
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(await readFile(seen, 'utf8')).toBe('null\nnull\n');
  expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ zoom: 1.25, theme: 'spider-glass', layout: 'spider-glass', sounds: { enabled: false } });
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
