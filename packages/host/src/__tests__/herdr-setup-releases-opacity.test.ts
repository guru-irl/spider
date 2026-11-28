// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { cp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { runHerdrCli, type HerdrCliPorts } from '../../../herdr/src/setup/cli.js';
import * as upgradeCheckpoint from '../../../herdr/src/setup/checkpoint.js';
import type { DoctorItem } from '../../../herdr/src/setup/doctor.js';
import { setupHerdr, undoHerdrUpgrade, type SetupParts } from '../../../herdr/src/setup/installer.js';
import { applyFiles, prepareBackups, readJournal, snapshot } from '../../../herdr/src/setup/backup.js';
import { loadSpacesAFiles } from '../../../herdr/src/__tests__/spaces-a-fixture.js';
import { replaySpacesBRecipe } from '../../../herdr/src/__tests__/spaces-b-fixture.js';
import { cleanup } from './herdr-setup-fixture.js';
import { localRelease, fastRelease, lookRelease, verifyItem, nativeKeysFixture, seedUnboundNativeKeys } from './herdr-setup-release-speed-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

test.each([0, 0.42])('0.1.18 layout upgrade keeps a user cell background opacity of %s', async opacity => {
  const f = await lookRelease('0.1.18');
  const path = join(f.h.directories.app, 'layouts/Spider.json');
  const verify = verifyItem(f.ports, 'layout-theme');
  await setupHerdr(f.request, { ...f.parts, verify });
  const layout = JSON.parse(await readFile(path, 'utf8'));
  expect(layout.cell_background_opacity).toBe(0.6);

  // Simulate the old look with a user opacity edit in the installed layout.
  const edited = JSON.stringify({ ...layout, background: '#16161800', cell_background_opacity: opacity }, null, 2);
  await writeFile(path, edited);
  const preview = { ...f.request, dryRun: true };
  const plan = await setupHerdr(preview, await f.ports.setupParts(preview));
  expect(plan.plan?.files.find(file => file.path === path)).toMatchObject({ action: 'replace', refusal: { code: 'unowned-clone-collision' } });
  expect(await readFile(path, 'utf8')).toBe(edited);

  const upgrade = { ...f.request, replaceChanged: true };
  await setupHerdr(upgrade, { ...await f.ports.setupParts(upgrade), verify });
  const updated = JSON.parse(await readFile(path, 'utf8'));
  expect(updated.background).toEqual({ gradient: ['#18181ab3', '#22201eb3'], angle: 176 });
  expect(updated.cell_background_opacity).toBe(opacity);
});

test('0.1.18 composes the renamed layout from the previous look and can undo it', async () => {
  const f = await fastRelease('0.1.18'), home = f.h.directories.app;
  const spider = join(home, 'layouts/Spider.json'), legacy = join(home, 'layouts/spider-glass.json'), shared = join(home, 'shared.json');
  const verify = verifyItem(f.ports, 'layout-theme');
  await setupHerdr(f.request, { ...f.parts, verify });
  await rename(spider, legacy);
  const bytes = await readFile(legacy);
  const journal = await readJournal(f.request.journalRoot);
  journal.entries = journal.entries.filter(entry => entry.path !== shared && entry.path !== spider);
  await writeFile(legacy, '{"layout":"before setup"}');
  const oldInstall = [{ path: legacy, expected: (await snapshot(legacy)).hash, bytes }];
  await prepareBackups(f.request.journalRoot, oldInstall, journal);
  await applyFiles(f.request.journalRoot, oldInstall, journal);
  const priorLayout = JSON.parse(bytes.toString());
  const edited = Buffer.from(JSON.stringify({ ...priorLayout, background: '#16161800', cell_background_opacity: 0.42 }));
  await writeFile(legacy, edited);
  await writeFile(shared, '{"layout":"spider-glass","fixture.mod":"keep"}');
  const upgrade = { ...f.request, replaceChanged: true };
  const preview = { ...upgrade, dryRun: true };
  expect((await setupHerdr(preview, await f.ports.setupParts(preview))).plan?.files).toContainEqual({ path: legacy, action: 'remove' });
  expect(await readFile(legacy)).toEqual(edited);

  await setupHerdr(upgrade, { ...await f.ports.setupParts(upgrade), verify });
  await expect(readFile(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(spider, 'utf8'))).toMatchObject({ theme: 'spider-glass', cell_background_opacity: 0.42,
    background: { gradient: ['#18181ab3', '#22201eb3'], angle: 176 } });
  expect(JSON.parse(await readFile(shared, 'utf8'))).toEqual({ layout: 'Spider', 'fixture.mod': 'keep' });
  expect((await setupHerdr(f.request, { ...await f.ports.setupParts(f.request), verify })).writes).toEqual([]);
  await undoHerdrUpgrade(f.request, await f.ports.setupParts(f.request));
  expect(await readFile(legacy)).toEqual(edited);
  await expect(readFile(spider)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await readFile(shared, 'utf8')).layout).toBe('spider-glass');
}, 60_000);

test('0.1.18 refuses to replace a legacy layout edited after reading the user opacity', async () => {
  const f = await lookRelease('0.1.18');
  const path = join(f.h.directories.app, 'layouts/spider-glass.json');
  const journal = await readJournal(f.request.journalRoot);
  const oldInstall = [{ path, expected: null, bytes: Buffer.from('{"cell_background_opacity":0.2}') }];
  await prepareBackups(f.request.journalRoot, oldInstall, journal);
  await applyFiles(f.request.journalRoot, oldInstall, journal);
  const request = { ...f.request, dryRun: true, replaceChanged: true };
  const parts = await f.ports.setupParts(request);
  const edit = JSON.stringify({ cell_background_opacity: 0.4 });
  await expect(setupHerdr(request, {
    ...parts,
    finalizeLook: async (request, context, staged) => {
      await writeFile(path, edit);
      return await parts.finalizeLook?.(request, context, staged) ?? staged;
    },
  })).rejects.toMatchObject({ code: 'concurrent-settings-edit' });
  expect(await readFile(path, 'utf8')).toBe(edit);
});
