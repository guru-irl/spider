// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { cleanup, fixture } from './herdr-setup-fixture.js';
import { releaseFixture } from './herdr-setup-release-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

test.each(['0.1.13', '0.1.16'] as const)('%s production setup wires arrival sounds and selects the supported toast', async version => {
  const f = await releaseFixture(version);
  try { await setupHerdr(f.request, f.parts); } catch (error: any) { throw new Error(JSON.stringify(error.details ?? error.message)); }
  const layout = JSON.parse(await readFile(join(f.h.directories.app, 'layouts/spider-glass.json'), 'utf8'));
  expect(layout.toast).toBe(version === '0.1.16' ? 'spider-toast' : undefined);
  const agents = await readFile(join(f.h.directories.app, 'mods/spider-agents/main.js'), 'utf8');
  expect(agents).toContain('spider-look:a-notification-arrival');
  const sound = await readFile(join(f.h.directories.app, 'mods/spider-agents/sound.js'), 'utf8');
  expect(sound).toContain('createNotificationSound');
  expect(sound).toContain('observeNotificationSounds');
  const result = await (await f.ports.doctorParts(f.request)).inspect('layout-theme', f.request);
  expect(result.failures).toEqual([]);
  const agentsPath = join(f.h.directories.app, 'mods/spider-agents/main.js');
  await writeFile(agentsPath, agents.replace('spider-look:a-notification-arrival', 'spider-look:changed'));
  const patchReport = await (await f.ports.doctorParts(f.request)).inspect('patch-version', f.request);
  expect(patchReport.failures).toContainEqual(expect.objectContaining({ code: 'patch-marker-mismatch' }));
});

test('setup forwards an explicit sound opt-out to Agents and the panel', async () => {
  const f = await fixture(); f.request.config.notifications = { sound: false };
  await setupHerdr(f.request, f.parts);
  const layout = JSON.parse(await readFile(join(f.h.directories.app, 'layouts/spider-glass.json'), 'utf8'));
  const contents: any[] = [];
  const visit = (node: any) => { if (node?.content?.mod) contents.push(node.content); for (const child of node?.children ?? []) visit(child); };
  visit(layout);
  expect(contents.find(item => item.mod === 'spider-agents')?.props.notifications).toEqual({ sound: false });
  expect(contents.find(item => item.mod === 'spider-panel')?.props.notifications).toEqual({ sound: false });
  expect((await (await f.ports.doctorParts(f.request)).inspect('layout-theme', f.request)).failures).toEqual([]);
});
