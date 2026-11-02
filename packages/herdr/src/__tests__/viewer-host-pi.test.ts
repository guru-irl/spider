// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHerdrHarness } from './testutil.js';
import { createViewerLauncher } from '../viewers/register.js';
import type { RunId } from '../contracts.js';

test('the launcher passes the session run database to the viewer process', async () => {
  const h = await createHerdrHarness('fake'); await h.start();
  const executable = join(h.root, 'viewer-fixture.mjs'), dbPath = join(h.root, 'runs.db');
  writeFileSync(executable, 'setInterval(() => {}, 1000);');
  try {
    const launcher = createViewerLauncher({ owner: () => h.owner, hc: h.hc, viewerExecutable: executable, feedRoot: join(h.directories.global, 'herdr'),
      runInfo: () => ({ status: 'running', dbPath }),
      ipcDescriptor: () => ({ version: 1, sessionId: h.owner!.sessionId, generation: h.owner!.generation, address: join(h.root, 'v.sock'), capabilityFile: join(h.root, 'v.cap') }) });
    await launcher('10000000-0000-4000-8000-000000000001' as RunId, h.owner!, undefined, 'automatic');
    const calls = (await h.calls()).filter(call => call.argv[0] === 'run' && call.argv.includes('spider.kind=subagent-viewer'));
    expect(calls).toHaveLength(1);
    expect(calls[0].argv.slice(calls[0].argv.indexOf('--run-db'), calls[0].argv.indexOf('--run-db') + 2)).toEqual(['--run-db', dbPath]);
  } finally { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
});

test('the launcher passes its owning pi install to the viewer process', async () => {
  const h = await createHerdrHarness('fake'); await h.start();
  const executable = join(h.root, 'viewer-fixture.mjs');
  writeFileSync(executable, 'console.log(process.argv[process.argv.indexOf("--pi-root") + 1] || "MISSING_HOST_PI");');
  try {
    const launcher = createViewerLauncher({ owner: () => h.owner, hc: h.hc, viewerExecutable: executable, feedRoot: join(h.directories.global, 'herdr'), piPackageRoot: '/fixture/host-pi',
      ipcDescriptor: () => ({ version: 1, sessionId: h.owner!.sessionId, generation: h.owner!.generation, address: join(h.root, 'v.sock'), capabilityFile: join(h.root, 'v.cap') }) });
    const address = await launcher('10000000-0000-4000-8000-000000000001' as RunId, h.owner!);
    await expect.poll(() => h.hc.read(address, { lines: 20 })).toContain('/fixture/host-pi');
  } finally { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
});
