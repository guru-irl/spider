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

test('setup stages the tab strip and doctor accepts its resting size', async () => {
  const f = await focusedSetupFixture();
  await writeFile(join(f.h.directories.app, 'layouts/main.json'), await readFile(resolve('packages/herdr/src/__tests__/fixtures/herdr-0.1.12/layouts/main.json')));
  await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.app, 'layouts/spider-glass.json');
  const layout = JSON.parse(await readFile(path, 'utf8'));
  const nodes = (node: any): any[] => [node, ...(node.children ?? []).flatMap(nodes)];
  expect(nodes(layout).find(node => node.id === 'tabs')).toMatchObject({ size: { px: 6 }, window_drag: true, content: { props: { autoHideTabs: true } } });
  expect((await (await f.ports.doctorParts(f.request)).inspect('layout-theme', f.request)).failures).toEqual([]);
});

test('setup forwards the tab opt-out and doctor rejects the opposite setting', async () => {
  const f = await focusedSetupFixture();
  f.request.config.look = { autoHideTabs: false };
  await writeFile(join(f.h.directories.app, 'layouts/main.json'), await readFile(resolve('packages/herdr/src/__tests__/fixtures/herdr-0.1.12/layouts/main.json')));
  await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.app, 'layouts/spider-glass.json');
  const layout = JSON.parse(await readFile(path, 'utf8'));
  const nodes = (node: any): any[] => [node, ...(node.children ?? []).flatMap(nodes)];
  expect(nodes(layout).find(node => node.id === 'tabs')).toMatchObject({ size: { px: 42 }, content: { props: { autoHideTabs: false } } });
  expect((await (await f.ports.doctorParts(f.request)).inspect('layout-theme', f.request)).failures).toEqual([]);
  nodes(layout).find(node => node.id === 'tabs').content.props.autoHideTabs = true;
  await writeFile(path, JSON.stringify(layout));
  expect((await (await f.ports.doctorParts(f.request)).inspect('layout-theme', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'layout-props-mismatch' }));
});

test('production doctor rejects a missing sidebar agent block', async () => {
  const f = await focusedSetupFixture();
  await writeFile(join(f.h.directories.app, 'layouts/main.json'), await readFile(resolve('packages/herdr/src/__tests__/fixtures/herdr-0.1.12/layouts/main.json')));
  await setupHerdr(f.request, f.parts);
  const path = join(f.h.directories.app, 'layouts/spider-glass.json');
  const layout = JSON.parse(await readFile(path, 'utf8'));
  const visit = (node: any) => {
    if (!node.children) return;
    node.children = node.children.filter((child: any) => child.id !== 'agents');
    for (const child of node.children) visit(child);
  };
  visit(layout); await writeFile(path, JSON.stringify(layout));
  expect((await (await f.ports.doctorParts(f.request)).inspect('layout-theme', f.request)).failures)
    .toContainEqual(expect.objectContaining({ code: 'layout-mod-mismatch' }));
});
