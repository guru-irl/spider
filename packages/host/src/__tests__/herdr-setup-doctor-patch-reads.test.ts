// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { cleanup } from './herdr-setup-fixture.js';
import { releaseFixture } from './herdr-setup-release-fixture.js';

const tracker = vi.hoisted(() => ({ active: false, paths: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => {
    if (tracker.active && typeof args[0] === 'string') tracker.paths.push(args[0]);
    return actual.readFile(...args);
  } };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { tracker.active = false; tracker.paths.length = 0; for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

test('doctor reads each installed clone body once when verifying patch versions', async () => {
  const f = await releaseFixture('0.1.16');
  await setupHerdr(f.request, f.parts);
  const doctor = await f.ports.doctorParts(f.request);
  tracker.paths.length = 0; tracker.active = true;
  const result = await doctor.inspect('patch-version', f.request);
  tracker.active = false;
  expect(result.failures).toEqual([]);
  for (const name of ['agents', 'spaces', 'pane', 'tabs', 'chrome', 'menu', 'new-menu']) {
    const path = join(f.h.directories.app, 'mods', `spider-${name}`, 'main.js');
    expect(tracker.paths.filter(read => read === path), name).toEqual([path]);
  }
});
