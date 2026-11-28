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

test('upgrades may add owned keys without treating a new key as a user edit', async () => {
  const f = await focusedSetupFixture(); await setupHerdr(f.request, f.parts);
  const source = join(f.root, 'packages/herdr/assets/keys.json'), keys = JSON.parse(await readFile(source, 'utf8'));
  keys.terminal['ctrl-shift-z'] = 'new.action'; await writeFile(source, JSON.stringify(keys));
  const result = await setupHerdr(f.request, f.parts);
  expect(result.writes).toContain(join(f.h.directories.app, 'keys.json'));
  expect(JSON.parse(await readFile(join(f.h.directories.app, 'keys.json'), 'utf8')).terminal['ctrl-shift-z']).toBe('new.action');
});

test('damaged managed resume markers explain how to repair them', async () => {
  const f = await focusedSetupFixture(); await setupHerdr(f.request, f.parts);
  await writeFile(f.request.config.shellRc, (await readFile(f.request.config.shellRc, 'utf8')) + '# spider:resume:start\n');
  await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'managed-artifact-changed', message: expect.stringContaining('Restore') });
});

test('overwriting a newly managed terminal key backs up and restores the user binding', async () => {
  const f = await focusedSetupFixture(); await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.app, 'keys.json'), keys = JSON.parse(await readFile(path, 'utf8'));
  keys.terminal['ctrl-b'] = 'personal.action'; await writeFile(path, JSON.stringify(keys));
  const asset = join(f.root, 'packages/herdr/assets/keys.json'), desired = JSON.parse(await readFile(asset, 'utf8'));
  desired.terminal['ctrl-b'] = 'spider.action'; await writeFile(asset, JSON.stringify(desired));
  await setupHerdr({ ...f.request, overwriteUnownedKeys: true }, f.parts);
  expect(JSON.parse(await readFile(path, 'utf8')).terminal['ctrl-b']).toBe('spider.action');
  await rollbackHerdr(f.request, f.parts);
  expect(JSON.parse(await readFile(path, 'utf8')).terminal['ctrl-b']).toBe('personal.action');
});
