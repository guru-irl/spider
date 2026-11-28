// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, writeFile, readdir, chmod, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { doctorHerdr } from '../../../herdr/src/setup/doctor.js';
import { createJobStore } from '../../../herdr/src/jobs/store.js';
import { monitorFixture, on, program } from '../../../herdr/src/__tests__/herdr-monitor-fixture.js';
import { cleanup, type SetupFixture } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { editUnrelated, claimCurrentHash } from './herdr-setup-production-helpers.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const offlineFixture = () => focusedSetupFixture({ startCores: false, localOnly: true });
const processFixture = () => focusedSetupFixture({ coreTransport: 'process', localOnly: true });

test.each(['layout-theme', 'keys', 'patch-version'] as const)('production doctor checks %s content even if its journal hash matches', async item => {
  const f = await focusedSetupFixture(); await setupHerdr(f.request, f.parts);
  const path = item === 'layout-theme' ? join(f.h.directories.app, 'layouts/Spider.json') : item === 'keys' ? join(f.h.directories.app, 'keys.json') : join(f.h.directories.app, 'mods/spider-agents/mod.json');
  const json = JSON.parse(await readFile(path, 'utf8'));
  if (item === 'layout-theme') json.theme = 'wrong';
  if (item === 'keys') json.terminal['cmd-shift-o'] = 'wrong';
  if (item === 'patch-version') json.clonedFrom.version = '0.0.0';
  await writeFile(path, JSON.stringify(json)); await claimCurrentHash(f, path);
  expect((await (await f.ports.doctorParts(f.request)).inspect(item, f.request)).failures.length).toBeGreaterThan(0);
});

test('production doctor accepts folded sidebar blocks', async () => {
  const f = await focusedSetupFixture();
  await writeFile(join(f.h.directories.app, 'layouts/main.json'), await readFile(resolve('packages/herdr/src/__tests__/fixtures/herdr-0.1.12/layouts/main.json')));
  await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.app, 'layouts/Spider.json');
  const layout = JSON.parse(await readFile(path, 'utf8'));
  const found: string[] = [];
  const visit = (node: any) => {
    if (['brand', 'agents', 'sidebar-footer'].includes(node.id)) { node.hidden = true; found.push(node.id); }
    for (const child of node.children ?? []) visit(child);
  };
  visit(layout);
  expect(found.sort()).toEqual(['agents', 'brand', 'sidebar-footer']);
  await writeFile(path, JSON.stringify(layout));
  expect((await (await f.ports.doctorParts(f.request)).inspect('layout-theme', f.request)).failures).toEqual([]);
});
