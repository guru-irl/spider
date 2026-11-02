// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHerdrHarness } from './testutil.js';
import { createViewerLauncher } from '../viewers/register.js';
import type { Generation, Owner, RunId, TerminalId } from '../contracts.js';

test.each([false, true])('same-session resume reuses a viewer only when the original owner is gone (gone=%s)', async gone => {
  const h = await createHerdrHarness('fake');
  try {
    await h.start();
    const executable = join(h.root, 'viewer-fixture.mjs'); await writeFile(executable, 'setInterval(() => {}, 1000);');
    let owner = h.owner!;
    const runId = '10000000-0000-4000-8000-000000000001' as RunId;
    const launcher = () => createViewerLauncher({ hc: h.hc, owner: () => owner, viewerExecutable: executable, feedRoot: h.directories.global,
      ipcDescriptor: () => ({ version: 1, sessionId: owner.sessionId, generation: owner.generation, address: join(h.root, 'ipc'), capabilityFile: join(h.root, 'capability') }) });
    const old = owner, first = await launcher()(runId, owner);
    const next = await h.hc.run({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: h.root, labels: {}, parent: null, outliveParent: true, background: true, noNotify: true });
    if (gone) { await h.hc.kill(old.terminal.address); await h.hc.rm(old.terminal.address); }
    owner = { ...old, generation: 'replacement' as Generation, terminal: { ...old.terminal, address: next.address, terminalId: next.address as unknown as TerminalId } } satisfies Owner;
    const resumed = await launcher()(runId, owner);
    if (gone) {
      expect(resumed).toBe(first);
      expect((await h.hc.get(resumed)).labels['spider.owner-terminal']).toBe(next.address);
      expect(await launcher()(runId, owner)).toBe(first);
    } else expect(resumed).not.toBe(first);
    expect((await h.hc.get(first)).state).toBe('live');
  } finally { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); }
}, 15000);
