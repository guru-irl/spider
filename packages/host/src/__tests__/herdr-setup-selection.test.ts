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

async function interruptSelection(command: 'layout.switch' | 'app.theme') {
  const f = await fixture(), settings = join(f.request.config.app.home, 'settings.json');
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
  const { f, settings, original } = await interruptSelection(command);
  const partial = JSON.parse(await readFile(settings, 'utf8'));
  expect(partial.theme).toBe('stock');
  expect(partial.layout).toBe(command === 'app.theme' ? 'spider-glass' : undefined);
  const backup = (await readJournal(f.request.journalRoot)).entries.find(entry => entry.path === settings)!.backup!;
  expect(await readFile(backup)).toEqual(original);
  const backupMtime = (await stat(backup)).mtimeMs;

  const resumed = await setupHerdr(f.request, f.parts);
  expect(resumed.doctor.failures).toEqual([]);
  expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ zoom: 1.25, theme: 'spider-glass', layout: 'spider-glass' });
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
  const f = await fixture(), settings = join(f.request.config.app.home, 'settings.json');
  const original = await readFile(settings);
  await setupHerdr(f.request, f.parts);
  // Older setup recorded cutover completion before selecting the app look.
  const journal = await readJournal(f.request.journalRoot);
  journal.verified = false;
  await saveJournal(f.request.journalRoot, journal);
  await writeFile(settings, partial ? JSON.stringify({ ...JSON.parse(original.toString()), layout: 'spider-glass' }) : original);
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(JSON.parse((await readFile(settings)).toString())).toEqual({ zoom: 1.25, theme: 'spider-glass', layout: 'spider-glass' });
}, 60_000);

test('unrelated app settings edits survive interrupted setup recovery and rollback', async () => {
  const { f, settings } = await interruptSelection('app.theme');
  await writeFile(settings, JSON.stringify({ ...JSON.parse((await readFile(settings)).toString()), zoom: 2, custom: { keep: true } }));
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(JSON.parse((await readFile(settings)).toString())).toEqual({ theme: 'spider-glass', layout: 'spider-glass', zoom: 2, custom: { keep: true } });
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


test('rollback does not grant partial-transition recovery to a verified install', async () => {
  const f = await fixture(), settings = join(f.request.config.app.home, 'settings.json');
  await setupHerdr(f.request, f.parts);
  const edited = JSON.stringify({ ...JSON.parse((await readFile(settings)).toString()), theme: 'stock' });
  await writeFile(settings, edited);
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(settings, 'utf8')).toBe(edited);
  expect((await readJournal(f.request.journalRoot)).entries.some(entry => entry.path === settings)).toBe(true);
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
