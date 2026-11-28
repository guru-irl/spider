// SPDX-License-Identifier: MIT
import { expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunId } from '../../../herdr/src/contracts.js';
import { mountedViewerFixture } from './herdr-viewer-layout-fixture.testutil.js';

export async function assertViewerRemainsPlaced(reason: 'quit' | 'reload' | 'new' | 'resume' | 'fork'): Promise<void> {
  return assertViewerRemainsPlacedWithTransport(reason, false);
}

export async function assertViewerRemainsPlacedWithTransport(reason: 'quit' | 'reload' | 'new' | 'resume' | 'fork', fastCore: boolean): Promise<void> {
  // Catches pane-actor disposal parking; registration stop is tested separately.
  // Actor teardown runs first here, so later reservation release would be a no-op.
  const f = await mountedViewerFixture('fake', false, false, fastCore);
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
}
