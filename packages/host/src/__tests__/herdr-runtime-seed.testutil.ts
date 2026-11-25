// SPDX-License-Identifier: MIT
import { expect } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeInstallPath } from '../../../herdr/src/setup/installer.js';
import type { mountedFixture } from './herdr-wiring-fixture.js';

/** Seed the runtime without running setup when setup is not the contract. */
export async function seedMountedRuntime(f: Awaited<ReturnType<typeof mountedFixture>>): Promise<void> {
  const directory = f.config.machines[0].runtime.directory;
  const bytes = await readFile(join(f.h.root, 'dist/herdr/remote-runtime.mjs'));
  const path = runtimeInstallPath(directory, bytes);
  expect(path).toMatch(/spider-remote-runtime-[a-f0-9]{16}\.mjs$/);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, bytes);
  expect(await f.h.hc.fileRead('remote.invalid' as never, path)).toEqual(bytes);
}
