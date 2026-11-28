// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { doctorHerdr } from '../../../herdr/src/setup/doctor.js';
import { digest } from '../../../herdr/src/setup/backup.js';
import { cleanup } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { editUnrelated, installedModFiles } from './herdr-setup-production-helpers.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture();

test.each(['resume', 'mods', 'launcher'] as const)('doctor checks the pinned %s Node path with an explicit repair', async source => {
  const f = await fastFixture(); await setupHerdr(f.request, f.parts);
  const missing = join(f.h.root, 'removed-node');
  if (source === 'resume') await writeFile(f.request.config.shellRc, (await readFile(f.request.config.shellRc, 'utf8')).split(process.execPath).join(missing));
  else if (source === 'mods') {
    const path = join(f.h.directories.app, 'layouts/Spider.json');
    await writeFile(path, (await readFile(path, 'utf8')).split(process.execPath).join(missing));
  } else {
    const path = join(f.request.journalRoot, 'journal.json');
    const journal = JSON.parse(await readFile(path, 'utf8')); journal.launcherNodePath = missing; await writeFile(path, JSON.stringify(journal));
  }
  const report = await doctorHerdr(f.request, await f.ports.doctorParts(f.request));
  expect(report.failures).toContainEqual(expect.objectContaining({ item: 'local-node', code: 'pinned-node-unavailable', message: expect.stringContaining(missing), repair: expect.stringContaining('Node') }));
  expect(report.failures.find(f => f.code === 'pinned-node-unavailable')?.repair).toContain('setup');
});
