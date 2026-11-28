// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { cleanup } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { replay, runs } from './herdr-setup-probe-checks.js';

export type ProbeChange = 'runtime' | 'node path' | 'root' | 'machine' | 'missing entry' | 'corrupt entry' | 'invalid result';

export async function changedProbe(change: ProbeChange, runtimePath: string): Promise<void> {
  const f = await focusedSetupFixture({ coreTransport: 'socket' }); await setupHerdr(f.request, await f.ports.setupParts(f.request));
  // The unchanged-setup case checks replay before any edit. Check it again
  // below, after this specific change has produced a new verified journal.
  const config = JSON.parse(await readFile(f.request.configPath, 'utf8'));
  if (change === 'runtime') {
    const runtime = join(f.root, runtimePath);
    await writeFile(runtime, (await readFile(runtime, 'utf8')) + '\n// new runtime bytes\n');
  } else if (change === 'node path') {
    const node = join(f.h.root, 'other-node');
    await writeFile(node, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`); await chmod(node, 0o700);
    config.machines[0].nodePath = node;
  } else if (change === 'root') config.machines[0].runtime.directory = join(f.h.directories.remote, 'other-root');
  else if (change === 'machine') {
    await f.h.cli(['machine', 'add', '--via', join(f.h.root, 'via'), '--name', 'next.invalid', '--session', 'r', '--json']);
    cleanup.push(async () => { if ((await f.h.hc.machines()).some(machine => machine.name === 'next.invalid')) await f.h.cli(['machine', 'rm', 'next.invalid', '--json']); });
    config.machines[0].name = 'next.invalid';
  } else {
    const path = join(f.request.journalRoot, 'journal.json'), journal = JSON.parse(await readFile(path, 'utf8'));
    if (change === 'missing entry') delete journal.runtimeRootProbes;
    else if (change === 'corrupt entry') journal.runtimeRootProbes = [{ broken: true }];
    else journal.runtimeRootProbes[0].result.mode = 0o755;
    await writeFile(path, JSON.stringify(journal));
  }
  await writeFile(f.request.configPath, JSON.stringify(config));
  f.request = await f.ports.request(f.request.configPath);
  const before = (await runs(f)).length;
  await setupHerdr(f.request, await f.ports.setupParts(f.request));
  expect((await runs(f)).slice(before).some(call => call.argv.includes('--probe'))).toBe(true);
  await replay(f);
}
