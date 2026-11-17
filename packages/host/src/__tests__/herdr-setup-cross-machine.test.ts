// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal, digest } from '../../../herdr/src/setup/backup.js';
import { basename, join } from 'node:path';
import { cleanup } from './herdr-setup-fixture.js';
import { releaseFixture } from './herdr-setup-release-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

for (const version of ['0.1.13', '0.1.16'] as const) {
  test(`${version} installs B as one owned set and repeats and rolls back without changing stock`, async () => {
    const f = await releaseFixture(version), home = f.h.directories.app;
    const keys = join(home, 'keys.json'), beforeKeys = await readFile(keys);
    const stock = await readFile(join(home, 'mods/new-menu/main.js'));
    await setupHerdr(f.request, f.parts);
    const journal = await readJournal(f.request.journalRoot);
    const newFiles = journal.entries.filter(entry => /\/mods\/spider-(?:new-menu|machine-picker(?:-right|-down)?|menu)\//.test(entry.path));
    const requiredFiles = ['spider-new-menu/main.js', 'spider-new-menu/mod.json', 'spider-menu/actions.js', 'spider-menu/machine.js',
      ...['spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down'].flatMap(name => ['main.js', 'picker.js', 'actions.js', 'mod.json', 'config.json'].map(file => `${name}/${file}`))];
    expect(newFiles.map(entry => entry.path)).toEqual(expect.arrayContaining(requiredFiles.map(file => join(home, 'mods', file))));
    for (const entry of newFiles) {
      expect(entry.before, entry.path).toBeNull();
      expect(digest(await readFile(entry.path)), entry.path).toBe(entry.after);
    }
    for (const name of ['spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down']) expect((await stat(join(home, 'mods', name, 'config.json'))).mode & 0o777).toBe(0o600);
    const doctor = await f.ports.doctorParts(f.request);
    for (const item of ['mods', 'clones', 'patch-version', 'layout-theme'] as const) expect((await doctor.inspect(item, f.request)).failures).toEqual([]);
    const savedJournal = await readFile(join(f.request.journalRoot, 'journal.json'));
    expect((await setupHerdr(f.request, f.parts)).writes).toEqual([]);
    expect(await readFile(join(f.request.journalRoot, 'journal.json'))).toEqual(savedJournal);
    const body = join(home, 'mods/spider-new-menu/main.js'), original = await readFile(body);
    await writeFile(body, '// changed installed B body\n');
    expect((await doctor.inspect('clones', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'installed-artifact-changed' }));
    await writeFile(body, original);
    await rollbackHerdr(f.request, f.parts);
    for (const entry of newFiles) await expect(readFile(entry.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(keys)).toEqual(beforeKeys);
    expect(await readFile(join(home, 'mods/new-menu/main.js'))).toEqual(stock);
    expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
  });

  test(`${version} an unowned B file refuses unless replaced and rollback restores its original bytes`, async () => {
    const f = await releaseFixture(version), home = f.h.directories.app;
    const directory = join(home, 'mods/spider-new-menu'); await mkdir(directory);
    const path = join(directory, 'main.js'), original = '// existing custom menu\n';
    await writeFile(path, original, { mode: 0o640 });
    const keys = join(home, 'keys.json'), beforeKeys = await readFile(keys);
    await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'unowned-clone-collision' });
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readFile(keys)).toEqual(beforeKeys);
    await setupHerdr({ ...f.request, replaceChanged: true }, f.parts);
    expect(await readFile(path, 'utf8')).toContain('spider-look:b-new-menu-terminal-entry');
    await rollbackHerdr(f.request, f.parts);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(await readFile(keys)).toEqual(beforeKeys);
  });

  for (const change of ['changed-record', 'missing-record', 'missing-release', 'missing-asset', 'stale-input', 'changed-output', 'stale-stock'] as const) {
    test(`${version} refuses ${change} before installing B files or keys`, async () => {
      const f = await releaseFixture(version);
      const path = join(f.root, 'packages/herdr/assets/look/cross-machine-patches.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      if (change === 'changed-record') manifest.versions[version].tabs[0].replacement += '\n// changed\n';
      if (change === 'missing-record') manifest.versions[version].tabs.pop();
      if (change === 'missing-release') delete manifest.versions[version];
      if (change === 'stale-input' || change === 'changed-output') {
        const checks = (manifest.checks ??= {})[version] ??= {};
        (checks[change === 'stale-input' ? 'inputHashes' : 'outputHashes'] ??= {})['pane/main.js'] = '0'.repeat(64);
      }
      await writeFile(path, JSON.stringify(manifest));
      if (change === 'missing-asset') await rm(path);
      if (change === 'stale-stock') await writeFile(join(f.h.directories.app, 'mods/pane/main.js'), '// stale source\n');
      const keys = join(f.h.directories.app, 'keys.json'), before = await readFile(keys);
      await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: expect.stringMatching(change === 'stale-stock' ? /^upstream-source-unknown$/ : /^cross-machine-/) });
      expect(await readFile(keys)).toEqual(before);
      for (const name of ['spider-pane', 'spider-tabs', 'spider-menu', 'spider-new-menu', 'spider-agents', 'spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down']) {
        await expect(readFile(join(f.h.directories.app, 'mods', name, 'main.js'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });
  }

  test(`${version} default production staging includes every B hook with its picker and keys`, async () => {
    const f = await releaseFixture(version);
    const preflight = await f.parts.preflight(f.request);
    const context = { ...f.context, modProps: preflight.mods.map(copy => ({ directory: copy.directory, props: { ...f.context.modProps[0]!.props, modId: basename(copy.directory) } })) };
    const files = await f.parts.stageLook(f.request, context, 'export');
    expect(await f.parts.stageLook(f.request, context, 'export')).toEqual(files);
    const records = JSON.parse(await readFile(join(f.root, 'packages/herdr/assets/look/cross-machine-patches.json'), 'utf8')).versions[version] as Record<string, { id: string }[]>;
    for (const [mod, patches] of Object.entries(records)) {
      const body = files.find(file => file.path === join(f.h.directories.app, 'mods', `spider-${mod}`, 'main.js'))?.bytes.toString('utf8') ?? '';
      for (const patch of patches) expect.soft(body, `${version} ${mod}/${patch.id}`).toContain(`/* spider-look:${patch.id} */`);
    }
    const agents = files.find(file => file.path.endsWith('/spider-agents/main.js'))!.bytes.toString('utf8');
    expect(agents).toContain('spider-look:a-notification-import');
    expect(agents).toContain('spider-look:a-notification-arrival');
    const keyFile = (await f.parts.installFiles(f.request, context)).find(file => file.path.endsWith('/keys.json'))!;
    for (const [key, name] of [['cmd-t', 'spider-machine-picker'], ['cmd-d', 'spider-machine-picker-right'], ['cmd-shift-d', 'spider-machine-picker-down']] as const) {
      expect(keyFile.keys?.global?.[key]).toBe(`mod.open:${name}`);
      for (const file of ['main.js', 'picker.js', 'mod.json', 'config.json']) expect(files.some(entry => entry.path === join(f.h.directories.app, 'mods', name, file))).toBe(true);
    }
  });
}
