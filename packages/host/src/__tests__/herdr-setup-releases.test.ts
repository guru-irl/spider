// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { runHerdrCli, type HerdrCliPorts } from '../../../herdr/src/setup/cli.js';
import * as upgradeCheckpoint from '../../../herdr/src/setup/checkpoint.js';
import type { DoctorItem } from '../../../herdr/src/setup/doctor.js';
import { setupHerdr, type SetupParts } from '../../../herdr/src/setup/installer.js';
import { loadSpacesAFiles } from '../../../herdr/src/__tests__/spaces-a-fixture.js';
import { replaySpacesBRecipe } from '../../../herdr/src/__tests__/spaces-b-fixture.js';
import { cleanup } from './herdr-setup-fixture.js';
import { localRelease, fastRelease, lookRelease, verifyItem, nativeKeysFixture, seedUnboundNativeKeys } from './herdr-setup-release-speed-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});
test('0.1.18 upgrades owned 0.1.13 clones and backs up the old tabs bytes', async () => {
  const f = await fastRelease('0.1.13'), home = f.h.directories.app;
  const verify = verifyItem(f.ports, 'clones');
  await setupHerdr(f.request, { ...f.parts, verify });
  const tabSource = join(home, 'mods/spider-tabs/main.js');
  const previous = await readFile(tabSource);
  const checkpointPath = join(f.request.journalRoot, 'checkpoint.json');
  const before = await readFile(checkpointPath);

  // Simulate an app update: stock files change, but Spider's installed copies do not.
  await cp(new URL('../../../herdr/src/__tests__/fixtures/herdr-0.1.18/mods/', import.meta.url), join(home, 'mods'), { recursive: true });
  const binary = f.request.config.app.binary;
  await writeFile(binary, (await readFile(binary, 'utf8')).replace('herdr-app 0.1.13', 'herdr-app 0.1.18'));

  const preview = { ...f.request, dryRun: true };
  const plan = await setupHerdr(preview, await f.ports.setupParts(preview));
  expect(plan.plan?.files).toContainEqual({ path: tabSource, action: 'write' });
  expect(plan.plan?.files.filter(file => file.refusal)).toEqual([]);
  expect(plan.writes).toEqual([]);
  expect(await readFile(tabSource)).toEqual(previous);
  expect(await readFile(checkpointPath)).toEqual(before);

  await setupHerdr(f.request, { ...await f.ports.setupParts(f.request), verify });
  expect(JSON.parse(await readFile(join(home, 'mods/spider-tabs/mod.json'), 'utf8')).clonedFrom).toEqual({ name: 'tabs', version: '0.1.18' });
  expect(await readFile(tabSource)).not.toEqual(previous);
  const checkpoint = await upgradeCheckpoint.readCheckpoint(f.request.journalRoot);
  expect(checkpoint?.state).toBe('complete');
  const saved = upgradeCheckpoint.checkpointBaseline(checkpoint!).find(entry => entry.path === tabSource);
  expect(saved).toBeDefined();
  expect(await upgradeCheckpoint.checkpointBytes(f.request.journalRoot, saved!)).toEqual(previous);
});

for (const version of ['0.1.13', '0.1.16', '0.1.18'] as const) {
  test(`${version} production setup stages the complete A and B result and doctor checks its release`, async () => {
    const f = await lookRelease(version), home = f.h.directories.app;
    const names = (await f.parts.preflight(f.request)).mods.map(copy => basename(copy.directory));
    const records = JSON.parse(await readFile(join(f.root, 'packages/herdr/assets/look/cross-machine-patches.json'), 'utf8')).versions[version];
    const expected = replaySpacesBRecipe(version, loadSpacesAFiles(version), records);
    const stockToast = await readFile(join(home, 'mods/toast/main.js'));
    expect(names.filter(name => name === 'spider-menu')).toHaveLength(1);
    expect(names.filter(name => name === 'spider-new-menu')).toHaveLength(1);
    await setupHerdr(f.request, { ...f.parts, verify: verifyItem(f.ports, 'clones') });
    expect(await readFile(join(home, 'mods/spider-new-menu/main.js'), 'utf8')).toBe(expected['new-menu']!['main.js']);
    for (const mod of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome', 'menu', 'new-menu']) {
      const clone = mod === 'workspace-chrome' ? 'spider-chrome' : `spider-${mod}`;
      const manifest = JSON.parse(await readFile(join(home, 'mods', clone, 'mod.json'), 'utf8'));
      expect(manifest.clonedFrom).toEqual({ name: mod, version });
      const main = await readFile(join(home, 'mods', clone, 'main.js'), 'utf8');
      expect(manifest.patchState.version).toBe(1);
      expect(Object.keys(manifest.patchState.files).sort()).toEqual(Object.keys(expected[mod]!).sort());
      for (const [file, hash] of Object.entries(manifest.patchState.files)) {
        // The serialized manifest also carries clone metadata, so hash the recipe manifest instead.
        const bytes = file === 'mod.json' ? expected[mod]![file]! : await readFile(join(home, 'mods', clone, file));
        expect(hash, `${mod}/${file}`).toBe(createHash('sha256').update(bytes).digest('hex'));
      }
      if (mod !== 'agents') expect(main).toBe(expected[mod]!['main.js']);
      else {
        expect(main).toContain('spider-look:a-notification-arrival');
        expect(main).toContain('spider-look:a-notification-import');
        expect(manifest.capabilities).toEqual({ clipboard: { write: true } });
      }
    }
    const layout = JSON.parse(await readFile(join(home, 'layouts/spider-glass.json'), 'utf8'));
    expect(layout.terminal_menu).toBe('spider-menu');
    const hasNativeToast = version !== '0.1.13';
    expect(layout.toast).toBe(hasNativeToast ? 'spider-toast' : undefined);
    expect(layout.window_blur).toBe(hasNativeToast ? true : undefined);
    const work = layout.children.find((node: { id: string }) => node.id === 'work');
    const workBody = work.children.find((node: { id: string }) => node.id === 'work-body');
    const pane = workBody.children.find((node: { content?: { tab?: string } }) => node.content?.tab === 'active').content.pane;
    expect(pane.border).toMatchObject({ width: 1, color: '#38383a' });
    expect(pane.focus).toMatchObject({ width: 1, color: 'accent' });
    expect(await readFile(join(home, 'mods/toast/main.js'))).toEqual(stockToast);
    if (hasNativeToast) expect(await readFile(join(home, 'mods/spider-toast/main.js'), 'utf8')).toBe(expected['spider-toast']!['main.js']);
    const doctor = await f.ports.doctorParts(f.request);
    for (const item of ['mods', 'clones', 'patch-version', 'layout-theme'] as const) expect((await doctor.inspect(item, f.request)).failures).toEqual([]);
    layout.window_blur = !hasNativeToast;
    await writeFile(join(home, 'layouts/spider-glass.json'), JSON.stringify(layout));
    expect((await doctor.inspect('layout-theme', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'window-blur-mismatch' }));
    if (hasNativeToast) layout.window_blur = true;
    else delete layout.window_blur;
    await writeFile(join(home, 'layouts/spider-glass.json'), JSON.stringify(layout, null, 2));
    const before = await readFile(join(home, 'mods/spider-menu/main.js'));
    const off = { ...f.request, config: { ...f.request.config, look: { autoHideTabs: f.request.config.look?.autoHideTabs ?? true, windowBlur: false } } };
    await setupHerdr(off, { ...await f.ports.setupParts(off), verify: verifyItem(f.ports, 'layout-theme') });
    // Identical-repeat idempotency is covered by the B setup case in herdr-setup-cross-machine.test.ts.
    expect(await readFile(join(home, 'mods/spider-menu/main.js'))).toEqual(before);
    expect(JSON.parse(await readFile(join(home, 'layouts/spider-glass.json'), 'utf8'))).not.toHaveProperty('window_blur');
    expect((await (await f.ports.doctorParts(off)).inspect('layout-theme', off)).failures).toEqual([]);
    await writeFile(join(home, 'mods/spider-menu/main.js'), '// changed');
    expect((await doctor.inspect('clones', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'installed-artifact-changed' }));
  });

}
