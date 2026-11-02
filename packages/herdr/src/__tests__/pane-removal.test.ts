// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClientFixture, terminal } from './testutil.js';
import { createHcClient } from '../client/hc.js';
import { createAppClient } from '../client/app.js';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { HerdrError } from '../client/parse.js';
import type { AppClient, JobId, Owner, OwnerPlacement, PaneReservation } from '../contracts.js';

async function fixture() {
  const f = await createClientFixture();
  const viewer = f.address('t2');
  await f.configure({ terminals: [terminal('t1'), { ...terminal('t2'), keep: true, labels: { 'spider.kind': 'remote-observer', 'spider.job': 'job' } }] });
  const owner = { sessionId: 'session', generation: 'generation', terminal: { address: f.address('t1'), terminalId: 't1', coreId: 'local-core', socket: f.localSocket, sessionNamespace: f.namespace }, cwd: f.root, name: null, sessionFile: null } as Owner;
  const placement = { space: 's1', tab: 'tb1', pane: 'p1' } as OwnerPlacement;
  await writeFile(join(f.root, 'app.json'), JSON.stringify({ spaces: [{ id: 's1', tabs: [{ id: 'tb1', terminals: [{ terminal: 't1', pane: 'p1' }] }] }] }));
  const hc = createHcClient({ binary: f.hcBinary, env: f.localEnv });
  const app = createAppClient({ binary: f.appBinary, env: f.localEnv });
  return { ...f, hc, app, owner, placement, viewer };
}

test('native fake app parking resolves after observed layout removal with a frozen placement clock', async () => {
  const f = await fixture();
  const panes = createAuxiliaryPanes({ hc: f.hc, discardSubagentViewer: async (_id, _owner, viewer) => { await f.hc.kill(viewer); await f.hc.rm(viewer); }, app: f.app, subagentViewer: async () => f.viewer, clock: () => 0 });
  try {
    const slot = await panes.reserveRemote('job' as JobId, f.owner, { timeoutMs: 1000 });
    const reservation = await panes.display(slot, f.viewer, { timeoutMs: 1000 });
    await expect(panes.release(reservation)).resolves.toBeUndefined();
    await expect(f.app.ownerPlacement(f.viewer)).rejects.toMatchObject({ code: 'owner-unplaced' });
    expect(await f.app.ownerPlacement(f.owner.terminal.address)).toEqual(f.placement);
    expect((await f.hc.get(f.viewer)).state).toBe('live');
  } finally { await panes.dispose(); await f.hc.dispose(); await f.close(); }
});

test.each(['missing-removal', 'stalled-layout', 'stalled-command'] as const)('%s has a hard removal deadline and can be retried after late completion', async stage => {
  const f = await fixture();
  let removed = false, blocked = false, lateReply: (() => void) | undefined, signal: AbortSignal | undefined;
  const pending = () => new Promise<void>(resolve => { lateReply = resolve; });
  const app: AppClient = {
    ownerPlacement: async address => {
      if (address === f.owner.terminal.address) return f.placement;
      if (blocked && stage === 'stalled-layout') await pending();
      if (removed) throw new HerdrError('owner-unplaced', 'Pane removed');
      return { ...f.placement, pane: 'p2' as OwnerPlacement['pane'] };
    },
    awaitPane: async () => 'p2' as OwnerPlacement['pane'],
    command: async () => {
      if (blocked && stage === 'stalled-command') await pending();
      return { pending: true, terminal: f.viewer };
    },
  };
  const panes = createAuxiliaryPanes({ hc: f.hc, discardSubagentViewer: async (_id, _owner, viewer) => { await f.hc.kill(viewer); await f.hc.rm(viewer); }, app, subagentViewer: async () => f.viewer, appForSignal: value => { signal = value; return app; }, clock: () => 0, paneRemovalTimeoutMs: 300 });
  let reservation: PaneReservation | undefined;
  // Old code eventually finishes rather than leaving a never-ending failed test behind.
  const late = setTimeout(() => { removed = true; lateReply?.(); }, 1500);
  try {
    const slot = await panes.reserveRemote('job' as JobId, f.owner, { timeoutMs: 1000 });
    reservation = await panes.display(slot, f.viewer, { timeoutMs: 1000 }); blocked = true;
    await expect(panes.release(reservation)).rejects.toMatchObject({ code: 'pane-removal-timeout', message: expect.stringContaining('terminal.park did not remove t2') });
    if (stage !== 'missing-removal') expect(signal?.aborted).toBe(true);
    removed = true; blocked = false; lateReply?.();
    await expect(panes.release(reservation)).resolves.toBeUndefined();
    expect((await f.hc.get(f.viewer)).state).toBe('live');
  } finally {
    clearTimeout(late); removed = true; blocked = false; lateReply?.();
    if (reservation) await panes.release(reservation).catch(() => {});
    await panes.dispose(); await f.hc.dispose(); await f.close();
  }
}, 5000);
