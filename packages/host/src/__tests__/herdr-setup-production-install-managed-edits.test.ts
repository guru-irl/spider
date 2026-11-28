// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { cleanup } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const processFixture = () => focusedSetupFixture({ coreTransport: 'process', localOnly: true });

test.each(['theme', 'notes', 'resume', 'keys'])('production refuses a user edit to the managed %s with repair advice', async kind => {
  const f = await (kind === 'theme' ? processFixture() : focusedSetupFixture()); await setupHerdr(f.request, f.parts);
  if (kind === 'theme') await writeFile(join(f.h.directories.agent, 'settings.json'), '{"theme":"user-theme"}');
  if (kind === 'notes') await writeFile(f.request.config.core.config, 'notes = true\n');
  if (kind === 'resume') await writeFile(f.request.config.shellRc, (await readFile(f.request.config.shellRc, 'utf8')).replace('. ', '. changed '));
  if (kind === 'keys') { const path = join(f.h.directories.app, 'keys.json'), keys = JSON.parse(await readFile(path, 'utf8')); keys.terminal['cmd-shift-o'] = 'user.action'; await writeFile(path, JSON.stringify(keys)); }
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'managed-artifact-changed', message: expect.stringContaining('Restore') });
});
