// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import * as fs from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { readJournal } from '../../../herdr/src/setup/backup.js';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { cleanup } from './herdr-setup-fixture.js';
import { fastRelease, tree } from './herdr-setup-cross-machine-fixture.js';
import * as lookPatches from '@spider/herdr/look/patches';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link), mkdir: vi.fn(actual.mkdir) };
});
const realFs = await vi.importActual<typeof fs>('node:fs/promises');
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); for (const name of ['rename', 'link', 'mkdir'] as const) vi.mocked(fs[name]).mockImplementation(realFs[name] as never); });

test('cross-machine helper digests affect the setup fingerprint', async () => {
  const f = await fastRelease('0.1.16'), path = join(f.root, 'packages/herdr/assets/look/cross-machine-patches.json');
  const first = await f.parts.preflight(f.request), manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.checks['0.1.16'].helperHashes['pane/actions.js'] = '0'.repeat(64);
  await writeFile(path, JSON.stringify(manifest));
  const changed = await f.parts.preflight(f.request);
  expect(changed.fingerprint).not.toBe(first.fingerprint);
});

test.each(['pane/actions.js', 'pane/machine.js', 'machines/actions.js', 'machines/picker.js'])('B refuses altered helper %s before staging', async helper => {
  const f = await fastRelease('0.1.16'), path = join(f.root, 'packages/herdr/assets', helper);
  await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('\n// altered helper\n')]));
  const context = { ...f.context, modProps: [...f.context.modProps, ...['picker', 'toast'].map(name => ({ directory: join(f.h.directories.app, 'mods', `spider-${name}`), props: { ...f.context.modProps[0]!.props, modId: `spider-${name}` } }))] };
  await expect(f.parts.stageLook(f.request, context, 'export')).rejects.toMatchObject({ code: 'cross-machine-helper-mismatch', message: expect.stringContaining(helper) });
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
});

test.each(['recipe', 'menu'] as const)('B refuses a missing A %s before staging', async missing => {
  const f = await fastRelease('0.1.16'), select = lookPatches.selectLookPatches;
  vi.spyOn(lookPatches, 'selectLookPatches').mockImplementation((manifest, version) => {
    const selected = select(manifest, version);
    if (missing === 'recipe') return { ...selected, recipe: undefined };
    return { ...selected, mods: { ...selected.mods, menu: undefined } };
  });
  await expect(f.parts.stageLook(f.request, f.context, 'export')).rejects.toMatchObject({ code: 'cross-machine-recipe-mismatch' });
  expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
});

for (const version of ['0.1.13', '0.1.16'] as const) {
  test(`${version} publishes complete mods before the layout can reference them`, async () => {
    const f = await fastRelease(version), mods = join(f.h.directories.app, 'mods');
    const layout = join(f.h.directories.app, 'layouts/spider-glass.json');
    const incomplete: string[] = [], published: string[] = [];
    const inspect = async (directory: string) => {
      const files = await readdir(directory).catch((): string[] => []);
      if (!files.includes('mod.json') || !files.includes('main.js')) { incomplete.push(basename(directory)); return; }
      const source = (await readFile(join(directory, 'main.js'), 'utf8')).replace(/^\s*\/\/[^\n]*$/gm, '');
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g))
        if (!await stat(resolve(directory, match[1]!)).then(info => info.isFile(), () => false)) incomplete.push(`${basename(directory)} imports ${match[1]}`);
    };
    for (const name of ['mkdir', 'rename', 'link'] as const) {
      const original = realFs[name] as (...args: any[]) => Promise<any>;
      vi.mocked(fs[name]).mockImplementation((async (...args: any[]) => {
        const result = await original(...args), destination = String(name === 'mkdir' ? args[0] : args[1]);
        if (dirname(destination) === mods && basename(destination).startsWith('spider-')) { published.push(basename(destination)); await inspect(destination); }
        if (destination === layout) for (const mod of ['spider-pane', 'spider-tabs', 'spider-menu', 'spider-new-menu']) await inspect(join(mods, mod));
        return result;
      }) as never);
    }
    const writes = (await setupHerdr(f.request, f.parts)).writes;
    const entries = writes.filter(path => /^spider-[^/]+\/main\.js$/.test(relative(mods, path)));
    expect(entries.length).toBeGreaterThan(5);
    expect(incomplete).toEqual([]);
    expect(published.sort()).toEqual(entries.map(entry => basename(dirname(entry))).sort());
    for (const entry of entries) {
      expect(writes).toContain(join(dirname(entry), 'mod.json'));
      const source = (await readFile(entry, 'utf8')).replace(/^\s*\/\/[^\n]*$/gm, '');
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)) expect(writes).toContain(resolve(dirname(entry), match[1]!));
    }
  });

  for (const change of ['changed-record', 'missing-record', 'missing-release', 'missing-asset', 'stale-input', 'changed-output', 'stale-stock'] as const) {
    test(`${version} refuses ${change} before installing B files or keys`, async () => {
      const f = await fastRelease(version);
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
      await mkdir(f.request.journalRoot, { recursive: true });
      const roots = [f.h.directories.app, f.h.directories.agent, f.h.directories.global, f.request.config.shellRc];
      const beforeTrees = await Promise.all(roots.map(tree));
      await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: expect.stringMatching(change === 'stale-stock' ? /^upstream-source-unknown$/ : /^cross-machine-/) });
      expect(await readFile(keys)).toEqual(before);
      expect(await Promise.all(roots.map(tree))).toEqual(beforeTrees);
      expect((await readJournal(f.request.journalRoot)).entries).toEqual([]);
      for (const name of ['spider-pane', 'spider-tabs', 'spider-menu', 'spider-new-menu', 'spider-agents', 'spider-machine-picker', 'spider-machine-picker-right', 'spider-machine-picker-down']) {
        await expect(readFile(join(f.h.directories.app, 'mods', name, 'main.js'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });
  }

  test(`${version} default production staging includes every B hook with its picker and keys`, async () => {
    const f = await fastRelease(version);
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
