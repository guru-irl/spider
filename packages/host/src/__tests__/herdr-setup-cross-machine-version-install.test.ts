// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal, digest, mergeKeys, validateFiles, prepareBackups, applyFiles } from '../../../herdr/src/setup/backup.js';
import type { InstallFile } from '../../../herdr/src/setup/installer.js';
import { dirname, join, resolve } from 'node:path';
import { cleanup, fixture } from './herdr-setup-fixture.js';
import { changingAppVersion, tree } from './herdr-setup-cross-machine-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const bareFixture = () => fixture('fake', false, { startCores: false });

test.each(['0.1.13', '0.1.16'] as const)('a lost version after staging installs A without picker files or bindings on %s', async version => {
  const f = await changingAppVersion(version, version === '0.1.13' ? 'process' : 'socket'), home = f.h.directories.app, app = join(f.h.root, 'app-selection.mjs');
  const stockKeys = JSON.parse(await readFile(join(home, 'keys.json'), 'utf8'));
  const stage = f.parts.stageLook;
  f.parts.stageLook = async (...args) => {
    const files = await stage(...args);
    await writeFile(app, (await readFile(app, 'utf8')).replace(`console.log('herdr-app ${version}')`, 'process.exit(1)'));
    return files;
  };
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const result = await setupHerdr(f.request, f.parts);
  expect(result.doctor.failures).toEqual([]);
  expect(result.doctor.warnings.filter(warning => warning.code === 'picker-version-unavailable')).toHaveLength(1);
  expect(stderr.mock.calls.map(([text]) => String(text)).filter(text => /picker.*version/i.test(text))).toHaveLength(1);
  expect(await readFile(join(home, 'mods/spider-pane/main.js'), 'utf8')).not.toContain('spider-look:b-pane-entry-imports');
  for (const name of ['spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down']) await expect(stat(join(home, 'mods', name))).rejects.toMatchObject({ code: 'ENOENT' });
  for (const path of ['spider-menu/actions.js', 'spider-menu/machine.js', 'spider-menu/machines/actions.js', 'spider-pane/machines/actions.js', 'spider-tabs/machines/actions.js']) await expect(stat(join(home, 'mods', path))).rejects.toMatchObject({ code: 'ENOENT' });
  for (const path of result.writes.filter(path => path.startsWith(join(home, 'mods') + '/') && path.endsWith('.js'))) {
    const source = (await readFile(path, 'utf8')).replace(/^\s*\/\/[^\n]*$/gm, '');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)) expect((await stat(resolve(dirname(path), match[1]!))).isFile(), `${path}: ${match[1]}`).toBe(true);
  }
  const keys = JSON.parse(await readFile(join(home, 'keys.json'), 'utf8'));
  for (const key of ['cmd-t', 'cmd-d', 'cmd-shift-d']) expect(keys.global[key]).toEqual(stockKeys.global[key]);
  expect(keys['layout:spider-glass']?.['cmd-shift-w']).toBeUndefined();
  const parkAsset = join(f.root, 'packages/herdr/assets/pane/park.js'), updatedPark = Buffer.concat([await readFile(parkAsset), Buffer.from('\n// updated pane asset\n')]);
  await writeFile(parkAsset, updatedPark);
  await writeFile(app, (await readFile(app, 'utf8')).replace('process.exit(1)', `console.log('herdr-app ${version}')`));
  await setupHerdr(f.request, f.parts);
  expect(await readFile(join(home, 'mods/spider-pane/park.js'))).toEqual(updatedPark);
  f.parts.stageLook = stage;
  await writeFile(app, (await readFile(app, 'utf8')).replace('process.exit(1)', `console.log('herdr-app ${version}')`));
  const recovered = await setupHerdr(f.request, f.parts);
  expect(recovered.doctor.failures).toEqual([]);
  expect((await stat(join(home, 'mods/spider-machine-picker/main.js'))).isFile()).toBe(true);
  expect(JSON.parse(await readFile(join(home, 'keys.json'), 'utf8')).global['cmd-t']).toBe('mod.open:spider-machine-picker');
});
