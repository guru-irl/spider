// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { setGlobalDbPathForTests } from '@spider/db-core';
import { mountedViewerFixture } from './herdr-viewer-layout-fixture.testutil.js';
import { createViewerFeedSource } from '../../../herdr/src/viewers/program.js';
import type { RunId } from '../../../herdr/src/contracts.js';
import { access, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setGlobalDbPathForTests(null); });

it.each(['quit', 'reload', 'new', 'resume', 'fork'] as const)('mounted %s leaves a displayed viewer in its exact pane', async reason => {
  // Catches pane-actor disposal parking; registration stop is tested separately.
  // Actor teardown runs first here, so later reservation release would be a no-op.
  const f = await mountedViewerFixture('fake');
  try {
    const { id } = f.store.create({ sessionId: f.feed.sessionId, agent: 'worker' }); f.store.start(id);
    const reply = await f.ipc.openRun(id as RunId);
    expect(reply).toMatchObject({ ok: true, op: 'openRun' });
    if (!reply.ok || reply.op !== 'openRun') throw new Error('Viewer not opened');
    const placed = await f.app.ownerPlacement(reply.viewer);
    await f.emit('session_shutdown', { reason });
    expect(await f.app.ownerPlacement(reply.viewer)).toEqual(placed);
    expect((await f.h.hc.get(reply.viewer)).state).toBe('live');
    const calls = (await readFile(join(f.h.directories.local, 'app-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(args => args[1] === 'terminal.park')).toEqual([]);
    if (reason !== 'quit') {
      if (reason !== 'reload') f.h.owner = { ...f.h.owner!, sessionId: randomUUID() as typeof f.feed.sessionId };
      await f.emit('session_start');
      expect(await f.app.ownerPlacement(reply.viewer)).toEqual(placed);
    }
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

const binary = process.env.SPIDER_HERDR_HC_BINARY || join(homedir(), '.local/bin/hc');
const real = process.env.SPIDER_HERDR_E2E === '1' && await access(binary).then(() => true, () => false);
if (!real) console.info('SKIP mounted viewer real proof: requires hc and SPIDER_HERDR_E2E=1; app is a recording double, no window');
it.skipIf(!real)('real hc: the mounted viewer stays displayed and read-only after quit and owner removal', async () => {
  const f = await mountedViewerFixture('hc');
  try {
    const { id } = f.store.create({ sessionId: f.feed.sessionId, agent: 'worker' }); f.store.start(id);
    const reply = await f.ipc.openRun(id as RunId);
    expect(reply).toMatchObject({ ok: true, op: 'openRun' });
    if (!reply.ok || reply.op !== 'openRun') throw new Error('Viewer not opened');
    const placed = await f.app.ownerPlacement(reply.viewer);
    await f.emit('session_shutdown', { reason: 'quit' });
    expect(await f.app.ownerPlacement(reply.viewer)).toEqual(placed);
    await f.h.hc.kill(f.h.owner!.terminal.address); await f.h.hc.rm(f.h.owner!.terminal.address);
    expect((await f.h.hc.get(reply.viewer)).state).toBe('live');
    await expect.poll(() => f.h.hc.read(reply.viewer, { lines: 50 }), { timeout: 5000 }).toContain('Saved log is read-only');
    expect(await f.app.ownerPlacement(reply.viewer)).toEqual(placed);
    const feed = await createViewerFeedSource(f.feedRoot, f.feed.sessionId).read();
    expect(feed?.lifecycle).toBe('closed');
    await writeFile(resolve('.spider/scratch/fx5-viewer-real-evidence.json'), JSON.stringify({ localSocket: f.h.localSocket, remoteSocket: f.h.remoteSocket, localCore: f.h.localCoreId, remoteCore: f.h.remoteCoreId, viewer: reply.viewer, placement: placed, state: 'live', ownerRemoved: true, readOnly: true }, null, 2));
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 45000);
