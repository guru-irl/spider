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
for (const version of ['0.1.13', '0.1.16'] as const) {
  test(`${version} stages additional records only after the verified A result and replays them in doctor`, async () => {
    const f = await lookRelease(version), home = f.h.directories.app;
    const records = { [version]: {
      agents: [{ id: 'b-arrival-proof', anchor: 'this.spiderNotificationSound.observe(loaded);', replacement: 'this.spiderNotificationSound.observe(loaded); /* additional arrival */' }],
      picker: [{ id: 'b-picker-proof', anchor: 'export default Picker;', replacement: '/* "$&" */\nexport default Picker;' }],
      'new-menu': [{ id: 'b-new-menu-proof', anchor: 'export default class NewMenu extends View {', replacement: '/* additional menu */\nexport default class NewMenu extends View {' }],
    } };
    const ports = createProductionHerdrCliPorts(f.root, { ...f.h.localEnv, SPIDER_GLOBAL_ROOT: f.h.directories.global }, records);
    cleanup.push(() => ports.dispose());
    const parts = { ...await ports.setupParts(f.request), verify: verifyItem(ports, 'clones') };
    const preflight = await parts.preflight(f.request);
    expect(preflight.fingerprint).not.toBe((await f.parts.preflight(f.request)).fingerprint);
    const names = preflight.mods.map(copy => basename(copy.directory));
    expect(names.filter(name => name === 'spider-menu')).toHaveLength(1);
    expect(names.filter(name => name === 'spider-new-menu')).toHaveLength(1);
    await setupHerdr(f.request, parts);
    expect(await readFile(join(home, 'mods/spider-agents/main.js'), 'utf8')).toContain('spider-look:b-arrival-proof');
    expect(await readFile(join(home, 'mods/spider-picker/main.js'), 'utf8')).toContain('/* "$&" */');
    expect(await readFile(join(home, 'mods/spider-new-menu/main.js'), 'utf8')).toContain('spider-look:b-new-menu-proof');
    expect(JSON.parse(await readFile(join(home, 'mods/spider-new-menu/mod.json'), 'utf8')).clonedFrom).toEqual({ name: 'new-menu', version });
    const doctor = await ports.doctorParts(f.request);
    for (const item of ['mods', 'clones', 'patch-version', 'layout-theme'] as const) expect((await doctor.inspect(item, f.request)).failures).toEqual([]);
    const warnings = (await doctor.inspect('clones', f.request)).warnings ?? [];
    for (const name of ['spider-menu', 'spider-new-menu', 'spider-picker']) expect(warnings).toContainEqual(expect.objectContaining({ code: 'inspection-unavailable', message: expect.stringContaining(name) }));
    const panel = join(home, 'mods/spider-panel/main.js'), originalPanel = await readFile(panel);
    await writeFile(panel, '// tampered panel');
    expect((await doctor.inspect('mods', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'installed-artifact-changed' }));
    await writeFile(panel, originalPanel);
    expect((await doctor.inspect('mods', f.request)).failures).toEqual([]);
    const before = await readFile(join(home, 'mods/spider-picker/main.js'));
    await setupHerdr(f.request, parts);
    expect(await readFile(join(home, 'mods/spider-picker/main.js'))).toEqual(before);
    await writeFile(join(home, 'mods/spider-new-menu/main.js'), '// changed');
    expect((await doctor.inspect('clones', f.request)).failures).not.toEqual([]);
  });

  test(`${version} missing native key map uses the setup guidance`, async () => {
    const f = await fastRelease(version), path = join(f.h.directories.app, 'keys.json');
    await rm(path);
    f.request.nativeKeys = 'accept';
    const files = await f.parts.installFiles(f.request, f.context);
    expect(files.find(file => file.path === path)?.expected).toBeNull();
    await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'keys-defaults-missing', message: expect.stringContaining('Open Herdr once') });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test(`${version} additional records cannot bypass guards or write partial clones`, async () => {
    const f = await fastRelease(version);
    for (const agents of [
      [{ id: 'b-empty', anchor: 'this.spiderNotificationSound.observe(loaded);', replacement: '' }],
      [{ id: 'b-missing', anchor: 'not-an-A-anchor', replacement: 'unused' }],
      [{ id: 'b-repeat', anchor: 'unused', replacement: 'unused' }, { id: 'b-repeat', anchor: 'unused', replacement: 'unused' }],
    ]) {
      const ports = createProductionHerdrCliPorts(f.root, { ...f.h.localEnv, SPIDER_GLOBAL_ROOT: f.h.directories.global }, { [version]: { agents } });
      try { await expect(setupHerdr(f.request, await ports.setupParts(f.request))).rejects.toMatchObject({ code: expect.stringMatching(/invalid-look-patches|patch-anchor-mismatch/) }); }
      finally { await ports.dispose(); }
      await expect(readFile(join(f.h.directories.app, 'mods/spider-agents/main.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  test(`${version} absent supported native keys remain optional until accepted`, async () => {
    const f = await localRelease(version, 'offline'), path = join(f.h.directories.app, 'keys.json');
    const keys = JSON.parse(await readFile(path, 'utf8'));
    delete keys.terminal['cmd-f']; delete keys.terminal['cmd-a']; delete keys.global['cmd-m'];
    await writeFile(path, JSON.stringify(keys));
    const files = await f.parts.installFiles(f.request, f.context);
    const offered = files.find(file => file.path === path)!;
    expect(offered.keys?.terminal).not.toHaveProperty('cmd-f');
    expect(offered.keys?.terminal).not.toHaveProperty('cmd-a');
    expect(offered.keys?.global).not.toHaveProperty('cmd-m');
    f.request.nativeKeys = 'accept';
    const accepted = (await f.parts.installFiles(f.request, f.context)).find(file => file.path === path)!;
    expect(accepted.keys?.terminal).toMatchObject({ 'cmd-f': 'terminal.search' });
    if (version === '0.1.16') expect(accepted.keys?.terminal).toHaveProperty('cmd-a', 'terminal.select_all');
    else expect(accepted.keys?.terminal).not.toHaveProperty('cmd-a');
    expect(accepted.keys?.global).toMatchObject({ 'cmd-m': 'window.minimize' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(keys);
  });

  test(`${version} production refuses a missing built-in auxiliary asset before writing`, async () => {
    const f = await fastRelease(version);
    await rm(join(f.h.directories.app, 'mods/pane/close.svg'));
    await expect(setupHerdr(f.request, f.parts)).rejects.toThrow();
    await expect(readFile(join(f.h.directories.app, 'mods/spider-menu/main.js'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test(`${version} reports a missing built-in directory before installing`, async () => {
    const f = await fastRelease(version);
    await rm(join(f.h.directories.app, 'mods/new-menu'), { recursive: true });
    await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'upstream-source-unknown', message: expect.stringContaining('new-menu') });
    await expect(readFile(join(f.h.directories.app, 'mods/spider-menu/main.js'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test(`${version} rejects changes to the stock new-menu before cloning it`, async () => {
    const f = await fastRelease(version), manifest = join(f.h.directories.app, 'mods/new-menu/mod.json');
    await writeFile(manifest, (await readFile(manifest, 'utf8')) + '\n');
    await expect(setupHerdr(f.request, f.parts)).rejects.toMatchObject({ code: 'upstream-source-unknown', message: expect.stringContaining('new-menu') });
    await expect(readFile(join(f.h.directories.app, 'mods/spider-menu/main.js'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
}
