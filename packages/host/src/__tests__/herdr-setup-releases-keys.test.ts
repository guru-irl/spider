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
    const { ports, configPath } = await nativeKeysFixture(version, 'offline');
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
    const { path, out, errors, ports, configPath } = await nativeKeysFixture(version);
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
}
