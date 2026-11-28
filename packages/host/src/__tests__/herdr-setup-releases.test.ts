// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createProductionHerdrCliPorts } from '../herdr/ports.js';
import { runHerdrCli, type HerdrCliPorts } from '../../../herdr/src/setup/cli.js';
import * as upgradeCheckpoint from '../../../herdr/src/setup/checkpoint.js';
import type { DoctorItem } from '../../../herdr/src/setup/doctor.js';
import { setupHerdr, type SetupParts } from '../../../herdr/src/setup/installer.js';
import { loadSpacesAFiles } from '../../../herdr/src/__tests__/spaces-a-fixture.js';
import { replaySpacesBRecipe } from '../../../herdr/src/__tests__/spaces-b-fixture.js';
import { cleanup } from './herdr-setup-fixture.js';
import { releaseFixture } from './herdr-setup-release-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});
type Release = Parameters<typeof releaseFixture>[0];

async function localRelease(version: Release, coreTransport: 'process' | 'socket') {
  // Release selection does not require a configured remote runtime.
  const f = await releaseFixture(version, { coreTransport, localOnly: true });
  const binary = f.request.config.app.binary;
  const wrapper = await readFile(binary, 'utf8');
  // These read-only fixture replies are static. Keep the subprocess boundary
  // without starting another Node runtime for each version or layout query.
  const patched = wrapper.replace('#!/bin/sh\n', `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' 'herdr-app ${version}'; exit 0 ;;
  ls|commands) printf '%s\\n' '{"spaces":[]}'; exit 0 ;;
esac
`);
  expect(patched).not.toBe(wrapper);
  await writeFile(binary, patched);
  return f;
}
const fastRelease = (version: Release) => localRelease(version, 'socket');

function lookRelease(version: Release) {
  // Keep the installed files and ordinary setup journal real. The separate
  // upgrade-undo snapshots are covered in setup-checkpoint.test.ts.
  vi.spyOn(upgradeCheckpoint, 'beginRunCheckpoint').mockResolvedValue(undefined);
  return fastRelease(version);
}

function verifyItem(ports: HerdrCliPorts, item: DoctorItem): SetupParts['verify'] {
  return async request => {
    const { failures, warnings = [] } = await (await ports.doctorParts(request)).inspect(item, request);
    return { failures, warnings, probes: [] };
  };
}

async function nativeKeysFixture(version: Release, coreTransport: 'process' | 'socket' = 'process', fullSetup = false) {
  const f = await localRelease(version, coreTransport);
  vi.stubEnv('PI_CODING_AGENT_DIR', f.h.directories.agent);
  const path = join(f.h.directories.app, 'keys.json');
  const out: string[] = [], errors: string[] = [];
  const ports: HerdrCliPorts = {
    ...f.ports,
    stdout: text => out.push(text),
    stderr: text => errors.push(text),
    setupParts: async request => {
      const parts = await f.ports.setupParts(request);
      if (fullSetup) return parts;
      // Keep production release detection, key planning, merge and rollback.
      // The A/B cases below cover publication and verification of the look files.
      const isKeyMap = (file: { path: string }) => file.path === path;
      return {
        ...parts,
        finalizeLook: async (request, context, staged) =>
          (await parts.finalizeLook?.(request, context, staged) ?? staged).filter(isKeyMap),
        installFiles: async (request, context) => (await parts.installFiles(request, context)).filter(isKeyMap),
        verify: verifyItem(f.ports, 'keys'),
      };
    },
  };
  return { path, out, errors, ports, configPath: f.request.configPath };
}

async function seedUnboundNativeKeys(path: string) {
  const keys = JSON.parse(await readFile(path, 'utf8'));
  keys.terminal['cmd-f'] = 'custom.find';
  delete keys.terminal['cmd-a']; delete keys.global['cmd-m'];
  await writeFile(path, JSON.stringify(keys));
  return keys;
}

for (const version of ['0.1.13', '0.1.16'] as const) {
  test(`${version} production setup stages the complete A and B result and doctor checks its release`, async () => {
    const f = await lookRelease(version), home = f.h.directories.app;
    const records = JSON.parse(await readFile(join(f.root, 'packages/herdr/assets/look/cross-machine-patches.json'), 'utf8')).versions[version];
    const expected = replaySpacesBRecipe(version, loadSpacesAFiles(version), records);
    const stockToast = await readFile(join(home, 'mods/toast/main.js'));
    const names = (await f.parts.preflight(f.request)).mods.map(copy => basename(copy.directory));
    expect(names.filter(name => name === 'spider-menu')).toHaveLength(1);
    expect(names.filter(name => name === 'spider-new-menu')).toHaveLength(1);
    await setupHerdr(f.request, { ...f.parts, verify: verifyItem(f.ports, 'clones') });
    expect(await readFile(join(home, 'mods/spider-new-menu/main.js'), 'utf8')).toBe(expected['new-menu']!['main.js']);
    for (const mod of ['agents', 'spaces', 'pane', 'tabs', 'workspace-chrome', 'menu', 'new-menu']) {
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
    const off = { ...f.request, config: { ...f.request.config, look: { autoHideTabs: f.request.config.look?.autoHideTabs ?? true, windowBlur: false } } };
    await setupHerdr(off, { ...await f.ports.setupParts(off), verify: verifyItem(f.ports, 'layout-theme') });
    // Identical-repeat idempotency is covered by the B setup case in herdr-setup-cross-machine.test.ts.
    expect(await readFile(join(home, 'mods/spider-menu/main.js'))).toEqual(before);
    expect(JSON.parse(await readFile(join(home, 'layouts/spider-glass.json'), 'utf8'))).not.toHaveProperty('window_blur');
    expect((await (await f.ports.doctorParts(off)).inspect('layout-theme', off)).failures).toEqual([]);
    await writeFile(join(home, 'mods/spider-menu/main.js'), '// changed');
    expect((await doctor.inspect('clones', f.request)).failures).toContainEqual(expect.objectContaining({ code: 'installed-artifact-changed' }));
  });

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

  test(`${version} offers native keys without writing and a dry-run decline hides the offer`, async () => {
    const { path, out, errors, ports, configPath } = await nativeKeysFixture(version);
    await seedUnboundNativeKeys(path);
    const before = await readFile(path);
    expect(await runHerdrCli(['setup', '--dry-run', '--config', configPath], ports), errors.join('')).toBe(0);
    expect(out.join('')).toContain('--merge-native-keys');
    expect(await readFile(path)).toEqual(before);
    out.length = 0;
    expect(await runHerdrCli(['setup', '--dry-run', '--decline-native-keys', '--config', configPath], ports), errors.join('')).toBe(0);
    expect(out.join('')).not.toContain('Offer:');
    expect(await readFile(path)).toEqual(before);
  });

  test(`${version} rejects conflicting native-key flags`, async () => {
    const { ports, configPath } = await nativeKeysFixture(version);
    expect(await runHerdrCli(['setup', '--merge-native-keys', '--decline-native-keys', '--config', configPath], ports)).toBe(2);
  });

  test(`${version} can decline and then merge native keys without changing existing bindings`, async () => {
    const { path, errors, ports, configPath } = await nativeKeysFixture(version);
    const keys = await seedUnboundNativeKeys(path);
    expect(await runHerdrCli(['setup', '--decline-native-keys', '--config', configPath], ports), errors.join('')).toBe(0);
    const refused = JSON.parse(await readFile(path, 'utf8'));
    expect(refused.terminal).not.toHaveProperty('cmd-a');
    expect(refused.global).not.toHaveProperty('cmd-m');
    expect(refused.terminal['cmd-f']).toBe('custom.find');
    expect(await runHerdrCli(['setup', '--merge-native-keys', '--config', configPath], ports), errors.join('')).toBe(0);
    const merged = JSON.parse(await readFile(path, 'utf8'));
    expect(merged.terminal['cmd-f']).toBe('custom.find');
    if (version === '0.1.16') expect(merged.terminal['cmd-a']).toBe('terminal.select_all');
    else expect(merged.terminal).not.toHaveProperty('cmd-a');
    expect(merged.global['cmd-m']).toBe('window.minimize');
    expect(merged.terminal['ctrl-v']).toBe(keys.terminal['ctrl-v']);
    expect(merged['layout:spider-glass']['cmd-shift-e']).toBe('spider-pane.park');
    for (const [key, command] of Object.entries(keys.terminal)) expect(merged.terminal[key]).toEqual(command);
    for (const [key, command] of Object.entries({ 'cmd-shift-a': 'send:\u001b[97;6u', 'cmd-shift-o': 'send:\u001b[111;6u', 'cmd-shift-u': 'send:\u001b[117;6u', 'cmd-shift-m': 'send:\u001b[109;6u', 'cmd-shift-k': 'send:\u001b[107;6u' })) expect(merged.terminal[key]).toBe(command);
  });

  test(`${version} re-accepts native keys without rewriting the map or clobbering later edits`, async () => {
    const { path, errors, ports, configPath } = await nativeKeysFixture(version);
    await seedUnboundNativeKeys(path);
    expect(await runHerdrCli(['setup', '--merge-native-keys', '--config', configPath], ports), errors.join('')).toBe(0);
    const once = await readFile(path);
    expect(JSON.parse(once.toString('utf8')).global['cmd-m']).toBe('window.minimize');
    expect(await runHerdrCli(['setup', '--merge-native-keys', '--config', configPath], ports), errors.join('')).toBe(0);
    expect(await readFile(path)).toEqual(once);
    const merged = JSON.parse(once.toString('utf8'));
    merged.terminal['cmd-a'] = 'custom.select'; await writeFile(path, JSON.stringify(merged));
    expect(await runHerdrCli(['setup', '--merge-native-keys', '--config', configPath], ports), errors.join('')).toBe(0);
    expect(JSON.parse(await readFile(path, 'utf8')).terminal['cmd-a']).toBe('custom.select');
  });

  test(`${version} offers only supported native keys missing from the stock map`, async () => {
    const { out, errors, ports, configPath } = await nativeKeysFixture(version, 'socket');
    expect(await runHerdrCli(['setup', '--dry-run', '--config', configPath], ports), errors.join('')).toBe(0);
    if (version === '0.1.13') {
      expect(out.join('')).toContain('Cmd-M');
      expect(out.join('')).not.toContain('Cmd-F');
      expect(out.join('')).not.toContain('Cmd-A');
    } else expect(out.join('')).not.toContain('Offer:');
  });

  for (const section of ['terminal', 'layout:custom'] as const) test(`${version} does not shadow native bindings in ${section} or global`, async () => {
    const { path, out, errors, ports, configPath } = await nativeKeysFixture(version, 'socket');
    const keys = JSON.parse(await readFile(path, 'utf8'));
    delete keys.terminal['cmd-f']; delete keys.terminal['cmd-a']; delete keys.global['cmd-m'];
    keys.global['cmd-f'] = 'custom.find'; keys.global['cmd-a'] = 'custom.select';
    (keys[section] ??= {})['cmd-m'] = 'custom.minimize';
    await writeFile(path, JSON.stringify(keys));
    expect(await runHerdrCli(['setup', '--dry-run', '--config', configPath], ports), errors.join('')).toBe(0);
    expect(out.join('')).not.toContain('Offer:');
    expect(await runHerdrCli(['setup', '--merge-native-keys', '--config', configPath], ports), errors.join('')).toBe(0);
    const result = JSON.parse(await readFile(path, 'utf8'));
    expect(result.global['cmd-f']).toBe('custom.find');
    expect(result.global['cmd-a']).toBe('custom.select');
    expect(result[section]['cmd-m']).toBe('custom.minimize');
    expect(result.terminal).not.toHaveProperty('cmd-f');
    expect(result.terminal).not.toHaveProperty('cmd-a');
    expect(result.global).not.toHaveProperty('cmd-m');
  });

  if (version === '0.1.13') test('accepted native keys are not reoffered or removed by decline', async () => {
    const { path, out, errors, ports, configPath } = await nativeKeysFixture(version, 'process', true);
    const original = await readFile(path);
    expect(await runHerdrCli(['setup', '--merge-native-keys', '--config', configPath], ports), errors.join('')).toBe(0);
    expect(JSON.parse(await readFile(path, 'utf8')).global['cmd-m']).toBe('window.minimize');
    out.length = 0;
    expect(await runHerdrCli(['setup', '--dry-run', '--config', configPath], ports), errors.join('')).toBe(0);
    expect(out.join('')).not.toContain('Offer:');
    expect(await runHerdrCli(['setup', '--decline-native-keys', '--config', configPath], ports), errors.join('')).toBe(0);
    expect(JSON.parse(await readFile(path, 'utf8')).global['cmd-m']).toBe('window.minimize');
    expect(await runHerdrCli(['rollback', '--config', configPath], ports), errors.join('')).toBe(0);
    expect(await readFile(path)).toEqual(original);
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
    const f = await fastRelease(version), path = join(f.h.directories.app, 'keys.json');
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
