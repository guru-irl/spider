// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal, digest, mergeKeys, validateFiles, prepareBackups, applyFiles } from '../../../herdr/src/setup/backup.js';
import type { InstallFile } from '../../../herdr/src/setup/installer.js';
import { basename, dirname, join } from 'node:path';
import { cleanup } from './herdr-setup-fixture.js';
import { changingAppVersion } from './herdr-setup-cross-machine-fixture.js';
import { installFastAppVersion } from './herdr-setup-version-shell.testutil.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture();

test('a lost version preserves a relocated picker binding while updating other keys', async () => {
  const f = await changingAppVersion('0.1.13'), home = f.h.directories.app, app = join(f.h.root, 'app-selection.mjs');
  await installFastAppVersion(f.request.config.app.binary, app, '0.1.13');
  await setupHerdr(f.request, f.parts);
  const keyPath = join(home, 'keys.json'), keys = JSON.parse(await readFile(keyPath, 'utf8'));
  keys.terminal['cmd-shift-a'] = { command: 'mod.open', args: { name: 'spider-machine-picker-right' } };
  await writeFile(keyPath, JSON.stringify(keys));
  const asset = join(f.root, 'packages/herdr/assets/keys.json'), desired = JSON.parse(await readFile(asset, 'utf8'));
  desired.terminal['cmd-shift-o'] = 'send:\u001b[99;6u'; await writeFile(asset, JSON.stringify(desired));
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => {
    const files = await stage(...args);
    await writeFile(app, (await readFile(app, 'utf8')).replace("console.log('herdr-app 0.1.13')", 'process.exit(1)'));
    return files;
  };
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  const current = JSON.parse(await readFile(keyPath, 'utf8'));
  expect(current.terminal['cmd-shift-a']).toEqual(keys.terminal['cmd-shift-a']);
  expect(current.terminal['cmd-shift-o']).toBe('send:\u001b[99;6u');
});
