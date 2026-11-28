// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { runHerdrCli, type HerdrCliPorts } from '../../../herdr/src/setup/cli.js';
import * as upgradeCheckpoint from '../../../herdr/src/setup/checkpoint.js';
import type { DoctorItem } from '../../../herdr/src/setup/doctor.js';
import { setupHerdr, type SetupParts } from '../../../herdr/src/setup/installer.js';
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
  const path = join(f.h.directories.app, 'layouts/spider-glass.json');
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

test('0.1.18 refuses to replace a layout edited after reading the user opacity', async () => {
  const f = await lookRelease('0.1.18');
  const path = join(f.h.directories.app, 'layouts/spider-glass.json');
  await writeFile(path, JSON.stringify({ cell_background_opacity: 0.2 }));
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
