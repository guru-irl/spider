// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { loadPublishedSpacesARecipe, loadSpacesAFiles, replaySpacesARecipe } from '../../../herdr/src/__tests__/spaces-a-fixture.js';
import { cleanup } from './herdr-setup-fixture.js';
import { releaseFixture } from './herdr-setup-release-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

for (const version of ['0.1.13', '0.1.16'] as const) {
  test(`${version} production setup stages the complete A result and doctor checks its release`, async () => {
    const f = await releaseFixture(version), home = f.h.directories.app;
    const recipe = loadPublishedSpacesARecipe(version);
    const expected = replaySpacesARecipe(version, loadSpacesAFiles(version), recipe.aFragments, recipe);
    const stockToast = await readFile(join(home, 'mods/toast/main.js'));
    await setupHerdr(f.request, f.parts);
    for (const mod of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome', 'menu']) {
      const clone = mod === 'workspace-chrome' ? 'spider-chrome' : `spider-${mod}`;
      const manifest = JSON.parse(await readFile(join(home, 'mods', clone, 'mod.json'), 'utf8'));
      expect(manifest.clonedFrom).toEqual({ name: mod, version });
      if (mod !== 'agents') expect(await readFile(join(home, 'mods', clone, 'main.js'), 'utf8')).toBe(expected[mod]!['main.js']);
      else {
        const agents = await readFile(join(home, 'mods', clone, 'main.js'), 'utf8');
        expect(agents).toContain('spider-look:a-notification-arrival');
        expect(agents).toContain('spider-look:a-notification-import');
        expect(manifest.capabilities).toEqual({ clipboard: { write: true } });
      }
    }
    const layout = JSON.parse(await readFile(join(home, 'layouts/spider-glass.json'), 'utf8'));
    expect(layout.terminal_menu).toBe('spider-menu');
    expect(layout.toast).toBe(version === '0.1.16' ? 'spider-toast' : undefined);
    expect(layout.window_blur).toBe(version === '0.1.16' ? true : undefined);
    expect(await readFile(join(home, 'mods/toast/main.js'))).toEqual(stockToast);
    if (version === '0.1.16') expect(await readFile(join(home, 'mods/spider-toast/main.js'), 'utf8')).toBe(expected['spider-toast']!['main.js']);
    const doctor = await f.ports.doctorParts(f.request);
    for (const item of ['mods', 'clones', 'patch-version', 'layout-theme'] as const) expect((await doctor.inspect(item, f.request)).failures).toEqual([]);
    layout.window_blur = version !== '0.1.16';
    await writeFile(join(home, 'layouts/spider-glass.json'), JSON.stringify(layout));
    expect((await doctor.inspect('layout-theme', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'window-blur-mismatch' }));
    if (version === '0.1.16') layout.window_blur = true;
    else delete layout.window_blur;
    await writeFile(join(home, 'layouts/spider-glass.json'), JSON.stringify(layout, null, 2));
    const before = await readFile(join(home, 'mods/spider-menu/main.js'));
    await setupHerdr(f.request, f.parts);
    expect(await readFile(join(home, 'mods/spider-menu/main.js'))).toEqual(before);
    const off = { ...f.request, config: { ...f.request.config, look: { autoHideTabs: f.request.config.look?.autoHideTabs ?? true, windowBlur: false } } };
    await setupHerdr(off, await f.ports.setupParts(off));
    expect(JSON.parse(await readFile(join(home, 'layouts/spider-glass.json'), 'utf8'))).not.toHaveProperty('window_blur');
    expect((await (await f.ports.doctorParts(off)).inspect('layout-theme', off)).failures).toEqual([]);
    await writeFile(join(home, 'mods/spider-menu/main.js'), '// changed');
    expect((await doctor.inspect('clones', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'installed-artifact-changed' }));
  });

  test(`${version} stages additional records only after the verified A result and replays them in doctor`, async () => {
    const f = await releaseFixture(version), home = f.h.directories.app;
    const records = { [version]: {
      agents: [{ id: 'b-arrival-proof', anchor: 'this.spiderNotificationSound.observe(loaded);', replacement: 'this.spiderNotificationSound.observe(loaded); /* additional arrival */' }],
      picker: [{ id: 'b-picker-proof', anchor: 'export default Picker;', replacement: '/* "$&" */\nexport default Picker;' }],
      'new-menu': [{ id: 'b-new-menu-proof', anchor: 'export default class NewMenu extends View {', replacement: '/* additional menu */\nexport default class NewMenu extends View {' }],
    } };
    const ports = createProductionHerdrCliPorts(f.root, { ...f.h.localEnv, SPIDER_GLOBAL_ROOT: f.h.directories.global }, records);
    cleanup.push(() => ports.dispose());
    const parts = await ports.setupParts(f.request);
    expect((await parts.preflight(f.request)).fingerprint).not.toBe((await f.parts.preflight(f.request)).fingerprint);
    await setupHerdr(f.request, parts);
    expect(await readFile(join(home, 'mods/spider-agents/main.js'), 'utf8')).toContain('spider-look:b-arrival-proof');
    expect(await readFile(join(home, 'mods/spider-picker/main.js'), 'utf8')).toContain('/* "$&" */');
    expect(await readFile(join(home, 'mods/spider-new-menu/main.js'), 'utf8')).toContain('spider-look:b-new-menu-proof');
    expect(JSON.parse(await readFile(join(home, 'mods/spider-new-menu/mod.json'), 'utf8')).clonedFrom).toEqual({ name: 'new-menu', version });
    const doctor = await ports.doctorParts(f.request);
    for (const item of ['mods', 'clones', 'patch-version', 'layout-theme'] as const) expect((await doctor.inspect(item, f.request)).failures).toEqual([]);
    const before = await readFile(join(home, 'mods/spider-picker/main.js'));
    await setupHerdr(f.request, parts);
    expect(await readFile(join(home, 'mods/spider-picker/main.js'))).toEqual(before);
    await writeFile(join(home, 'mods/spider-new-menu/main.js'), '// changed');
    expect((await doctor.inspect('clones', f.request)).failures).not.toEqual([]);
  });

  test(`${version} native keys are an offer with refusal and idempotent edit-preserving acceptance`, async () => {
    const f = await releaseFixture(version), path = join(f.h.directories.app, 'keys.json');
    const keys = JSON.parse(await readFile(path, 'utf8'));
    keys.terminal['cmd-f'] = 'custom.find';
    delete keys.terminal['cmd-a']; delete keys.global['cmd-m'];
    await writeFile(path, JSON.stringify(keys));
    const before = await readFile(path), out: string[] = [], errors: string[] = [];
    const ports = { ...f.ports, stdout: (text: string) => out.push(text), stderr: (text: string) => errors.push(text) };
    expect(await runHerdrCli(['setup', '--dry-run', '--config', f.request.configPath], ports), errors.join('')).toBe(0);
    expect(out.join('')).toContain('--merge-native-keys');
    expect(await readFile(path)).toEqual(before);
    out.length = 0;
    expect(await runHerdrCli(['setup', '--dry-run', '--decline-native-keys', '--config', f.request.configPath], ports), errors.join('')).toBe(0);
    expect(out.join('')).not.toContain('Offer:');
    expect(await readFile(path)).toEqual(before);
    expect(await runHerdrCli(['setup', '--decline-native-keys', '--config', f.request.configPath], ports), errors.join('')).toBe(0);
    const refused = JSON.parse(await readFile(path, 'utf8'));
    expect(refused.terminal).not.toHaveProperty('cmd-a');
    expect(refused.global).not.toHaveProperty('cmd-m');
    expect(refused.terminal['cmd-f']).toBe('custom.find');
    expect(await runHerdrCli(['setup', '--merge-native-keys', '--decline-native-keys', '--config', f.request.configPath], ports)).toBe(2);
    errors.length = 0;
    expect(await runHerdrCli(['setup', '--merge-native-keys', '--config', f.request.configPath], ports), errors.join('')).toBe(0);
    const merged = JSON.parse(await readFile(path, 'utf8'));
    expect(merged.terminal['cmd-f']).toBe('custom.find');
    expect(merged.terminal['cmd-a']).toBe('terminal.select_all');
    expect(merged.global['cmd-m']).toBe('window.minimize');
    expect(merged.terminal['ctrl-v']).toBe(keys.terminal['ctrl-v']);
    expect(merged['layout:spider-glass']['cmd-shift-e']).toBe('spider-pane.park');
    for (const [key, command] of Object.entries(keys.terminal)) expect(merged.terminal[key]).toEqual(command);
    for (const [key, command] of Object.entries({ 'cmd-shift-a': 'send:\u001b[97;6u', 'cmd-shift-o': 'send:\u001b[111;6u', 'cmd-shift-u': 'send:\u001b[117;6u', 'cmd-shift-m': 'send:\u001b[109;6u', 'cmd-shift-k': 'send:\u001b[107;6u' })) expect(merged.terminal[key]).toBe(command);
    const once = await readFile(path);
    expect(await runHerdrCli(['setup', '--merge-native-keys', '--config', f.request.configPath], ports), errors.join('')).toBe(0);
    expect(await readFile(path)).toEqual(once);
    merged.terminal['cmd-a'] = 'custom.select'; await writeFile(path, JSON.stringify(merged));
    expect(await runHerdrCli(['setup', '--merge-native-keys', '--config', f.request.configPath], ports), errors.join('')).toBe(0);
    expect(JSON.parse(await readFile(path, 'utf8')).terminal['cmd-a']).toBe('custom.select');
  });

  test(`${version} additional records cannot bypass guards or write partial clones`, async () => {
    const f = await releaseFixture(version);
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

  test(`${version} all three absent native keys remain optional until accepted`, async () => {
    const f = await releaseFixture(version), path = join(f.h.directories.app, 'keys.json');
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
    expect(accepted.keys?.terminal).toMatchObject({ 'cmd-f': 'terminal.search', 'cmd-a': 'terminal.select_all' });
    expect(accepted.keys?.global).toMatchObject({ 'cmd-m': 'window.minimize' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(keys);
  });

  test(`${version} production refuses a missing built-in auxiliary asset before writing`, async () => {
    const f = await releaseFixture(version);
    await rm(join(f.h.directories.app, 'mods/pane/close.svg'));
    await expect(setupHerdr(f.request, f.parts)).rejects.toThrow();
    await expect(readFile(join(f.h.directories.app, 'mods/spider-menu/main.js'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
}
