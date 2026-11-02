// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHerdrHarness } from './testutil.js';
import { createViewerLauncher } from '../viewers/register.js';
import type { RunId, TerminalAddress } from '../contracts.js';

it.each([false, true])('discards an unclaimed viewer but preserves one reused by another opener (reused=%s)', async reused => {
  const h = await createHerdrHarness('fake');
  try {
    await h.start();
    const executable = join(h.root, 'viewer-fixture.mjs');
    await writeFile(executable, 'setInterval(() => {}, 1000);');
    const owner = h.owner!, runId = '10000000-0000-4000-8000-000000000001' as RunId;
    const launcher = createViewerLauncher({ hc: h.hc, owner: () => owner, viewerExecutable: executable, feedRoot: h.directories.global,
      ipcDescriptor: () => ({ version: 1, sessionId: owner.sessionId, generation: owner.generation, address: join(h.root, 'ipc'), capabilityFile: join(h.root, 'capability') }) });
    const first = await launcher(runId, owner);
    if (reused) expect(await launcher(runId, owner)).toBe(first);
    await launcher.discard(runId, owner, first);
    if (reused) expect((await h.hc.get(first)).state).toBe('live');
    else await expect(h.hc.get(first)).rejects.toMatchObject({ code: 'not_found' });
  } finally {
    await h.close();
    expect(await h.remainingOwnedResources()).toEqual([]);
  }
}, 15000);

it('waits for discard to finish before a new opener can claim the viewer', async () => {
  const h = await createHerdrHarness('fake');
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), killing = new Promise<void>(resolve => { entered = resolve; });
  let discarding: Promise<void> | undefined, reopening: Promise<TerminalAddress> | undefined;
  try {
    await h.start();
    const executable = join(h.root, 'viewer-fixture.mjs');
    await writeFile(executable, 'setInterval(() => {}, 1000);');
    const owner = h.owner!, runId = '10000000-0000-4000-8000-000000000002' as RunId;
    let held: Awaited<ReturnType<typeof h.hc.get>> | undefined;
    const hc = { ...h.hc, get: async (address: TerminalAddress) => held?.address === address ? held : h.hc.get(address),
      kill: async (address: TerminalAddress) => { entered(); await gate; await h.hc.kill(address); } };
    const launcher = createViewerLauncher({ hc, owner: () => owner, viewerExecutable: executable, feedRoot: h.directories.global,
      ipcDescriptor: () => ({ version: 1, sessionId: owner.sessionId, generation: owner.generation, address: join(h.root, 'ipc'), capabilityFile: join(h.root, 'capability') }) });
    const first = await launcher(runId, owner); held = await h.hc.get(first);
    discarding = launcher.discard(runId, owner, first); await killing;
    reopening = launcher(runId, owner);
    let opened = false; void reopening.then(() => { opened = true; }, () => {});
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(opened).toBe(false);
    release(); await discarding;
    const replacement = await reopening;
    expect(replacement).not.toBe(first);
    expect((await h.hc.get(replacement)).state).toBe('live');
    await expect(h.hc.get(first)).rejects.toMatchObject({ code: 'not_found' });
  } finally {
    release(); await Promise.allSettled([discarding, reopening]); await h.close();
    expect(await h.remainingOwnedResources()).toEqual([]);
  }
}, 15000);
