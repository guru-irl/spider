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

test('doctor reports mod loading not verified with fenced headless commands', async () => {
  const f = await fastFixture(); await setupHerdr(f.request, f.parts);
  const parts = await f.ports.doctorParts(f.request);
  for (const item of ['mods', 'clones'] as const) {
    const report = await parts.inspect(item, f.request);
    expect(report.failures).toEqual([]);
    const names = item === 'mods'
      ? ['spider-panel', 'spider-picker', 'spider-pane-waiting']
      : ['spider-agents', 'spider-spaces', 'spider-pane', 'spider-tabs', 'spider-chrome', 'spider-picker'];
    expect(report.warnings?.map(warning => warning.message).sort()).toEqual(names.map(name => `${name} source content matches; mod loading is not verified`).sort());
    if (item === 'mods') expect(report.warnings?.[1]?.message).toContain('spider-picker');
    else expect(report.warnings?.some(warning => warning.message.includes('spider-picker'))).toBe(true);
    for (const warning of report.warnings ?? []) {
      expect(warning.message).toContain('not verified');
      expect(warning.code).toBe('inspection-unavailable');
      expect(warning.repair).toContain(`HERDR_APP_HOME='${join(f.request.journalRoot, 'headless-app-check')}'`);
      expect(warning.repair).toContain(`'${f.request.config.app.binary}' check '${join(f.request.config.app.home, 'mods')}/spider-`);
      expect(warning.repair).not.toContain(`HERDR_APP_HOME='${f.request.config.app.home}'`);
    }
  }
});

test('unrelated multiline TOML edits survive a complete production rerun', async () => {
  const f = await focusedSetupFixture({ coreTransport: 'socket' }); await setupHerdr(f.request, f.parts);
  const current = await readFile(f.request.config.core.config, 'utf8');
  const edited = `description = '''
notes = true
[not_a_table]
'''
choices = [
  [1, 2],
  [3, 4]
]
` + current;
  await writeFile(f.request.config.core.config, edited);
  expect((await setupHerdr(f.request, f.parts)).probes).toEqual([]);
  expect(await readFile(f.request.config.core.config, 'utf8')).toBe(edited);
});

test('production setup stages every relative import target in every installed mod', async () => {
  const f = await fastFixture(); await setupHerdr(f.request, f.parts);
  const missing: string[] = [];
  for (const mod of ['agents', 'spaces', 'pane', 'tabs', 'panel', 'chrome']) {
    const files = await installedModFiles(join(f.h.directories.app, 'mods', `spider-${mod}`));
    for (const file of files.filter(file => file.endsWith('.js'))) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
        if (!files.includes(resolve(dirname(file), match[1]))) missing.push(`${mod}: ${match[1]}`);
      }
    }
  }
  expect(missing).toEqual([]);
  const parts = await f.ports.doctorParts(f.request);
  expect((await parts.inspect('clones', f.request)).failures).toEqual([]);
  await unlink(join(f.h.directories.app, 'mods/spider-agents/spider-children.js'));
  expect((await parts.inspect('clones', f.request)).failures.length).toBeGreaterThan(0);
});

test('production setup refuses a split global root before writes and doctor names the repair', async () => {
  const f = await fastFixture();
  const wrongRoot = join(f.h.root, 'wrong-global');
  const request = { ...f.request, config: { ...f.request.config, globalRoot: wrongRoot }, journalRoot: join(wrongRoot, 'herdr/setup') };
  const parts = await f.ports.setupParts(request);
  const calls = await f.h.calls();
  await expect(setupHerdr(request, parts)).rejects.toMatchObject({ code: 'global-root-mismatch', message: expect.stringContaining(f.h.directories.global) });
  expect(await readFile(join(request.journalRoot, 'journal.json')).then(() => true, () => false)).toBe(false);
  expect(await readdir(wrongRoot).then(() => true, () => false)).toBe(false);
  const report = await doctorHerdr(request, await f.ports.doctorParts(request));
  expect(report.failures).toContainEqual(expect.objectContaining({ code: 'global-root-mismatch', repair: expect.stringContaining(f.h.directories.global) }));
  expect(await f.h.calls()).toEqual(calls);
});
