// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture, type SetupFixture } from './herdr-setup-fixture.js';

export async function releaseFixture(version: '0.1.13' | '0.1.16'): Promise<SetupFixture> {
  const f = await fixture();
  const source = resolve(`packages/herdr/src/__tests__/fixtures/herdr-${version}`);
  await rm(join(f.h.directories.app, 'mods'), { recursive: true, force: true });
  await cp(join(source, 'mods'), join(f.h.directories.app, 'mods'), { recursive: true });
  await cp(join(source, 'layouts/main.json'), join(f.h.directories.app, 'layouts/main.json'));
  await cp(join(source, 'keys.json'), join(f.h.directories.app, 'keys.json'));
  const app = join(f.h.root, 'app-selection.mjs');
  await writeFile(app, (await readFile(app, 'utf8')).replace('herdr-app 0.1.12', `herdr-app ${version}`));
  return f;
}
