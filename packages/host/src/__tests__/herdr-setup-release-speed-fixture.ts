// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import type { HerdrCliPorts } from '../../../herdr/src/setup/cli.js';
import * as upgradeCheckpoint from '../../../herdr/src/setup/checkpoint.js';
import type { DoctorItem } from '../../../herdr/src/setup/doctor.js';
import type { SetupParts } from '../../../herdr/src/setup/installer.js';
import type { SetupFixture } from './herdr-setup-fixture.js';
import { releaseFixture } from './herdr-setup-release-fixture.js';

export type Release = Parameters<typeof releaseFixture>[0];
type CoreTransport = 'process' | 'socket' | 'offline';

export async function localRelease(version: Release, coreTransport: CoreTransport): Promise<SetupFixture> {
  // Release selection does not require a configured remote runtime.
  const f = await releaseFixture(version, coreTransport === 'offline'
    ? { startCores: false, localOnly: true }
    : { coreTransport, localOnly: true });
  const binary = f.request.config.app.binary;
  const wrapper = await readFile(binary, 'utf8');
  // Static read-only replies keep the subprocess boundary without starting Node.
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

export const fastRelease = (version: Release): Promise<SetupFixture> => localRelease(version, 'socket');

export function lookRelease(version: Release): Promise<SetupFixture> {
  // The separate upgrade-undo snapshots are covered in setup-checkpoint.test.ts.
  vi.spyOn(upgradeCheckpoint, 'beginRunCheckpoint').mockResolvedValue(undefined);
  return fastRelease(version);
}

export function verifyItem(ports: HerdrCliPorts, item: DoctorItem): SetupParts['verify'] {
  return async request => {
    const { failures, warnings = [] } = await (await ports.doctorParts(request)).inspect(item, request);
    return { failures, warnings, probes: [] };
  };
}

export async function nativeKeysFixture(version: Release, coreTransport: CoreTransport = version === '0.1.13' ? 'process' : 'socket'): Promise<{
  path: string; out: string[]; errors: string[]; ports: HerdrCliPorts; configPath: string;
}> {
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
      // A/B cases cover publication and verification of the look files.
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

export async function seedUnboundNativeKeys(path: string): Promise<any> {
  const keys = JSON.parse(await readFile(path, 'utf8'));
  keys.terminal['cmd-f'] = 'custom.find';
  delete keys.terminal['cmd-a']; delete keys.global['cmd-m'];
  await writeFile(path, JSON.stringify(keys));
  return keys;
}
