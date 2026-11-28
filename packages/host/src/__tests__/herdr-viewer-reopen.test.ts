// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { setGlobalDbPathForTests } from '@spider/db-core';
import { mountedViewerFixture } from './herdr-viewer-layout-fixture.testutil.js';
import { createViewerFeedSource } from '../../../herdr/src/viewers/program.js';
import type { RunId } from '../../../herdr/src/contracts.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as paneModule from '../../../herdr/src/jobs/placement.js';
import * as hostPorts from '../herdr/ports.js';
import { createSessionIpcClient } from '../../../herdr/src/feed/ipc-client.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setGlobalDbPathForTests(null); });

it.each([{ gated: false }, { gated: true }])('reload does not move a viewer from the tab the user kept it in (gated=$gated)', async ({ gated }) => {
  let release!: () => void, settled!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const oldOpenerSettled = new Promise<void>(resolve => { settled = resolve; });
  let tracked = false, held = false, heldOwner: string | undefined;
  if (gated) {
    const createPanes = paneModule.createAuxiliaryPanes;
    vi.spyOn(paneModule, 'createAuxiliaryPanes').mockImplementation(options => {
      const actor = createPanes({ ...options, app: { ...options.app, ownerPlacement: async address => {
        if (!held && address === heldOwner) { held = true; await gate; }
        return options.app.ownerPlacement(address);
      } } });
      return { ...actor, acquire: async (...args: Parameters<typeof actor.acquire>) => {
        const oldAutomatic = !tracked && Boolean(args[3].automatic);
        if (oldAutomatic) { tracked = true; heldOwner = args[2].terminal.address; }
        try { return await actor.acquire(...args); }
        finally { if (oldAutomatic) settled(); }
      } };
    });
  }
  const f = await mountedViewerFixture('fake', gated, gated, true); let reloaded: ReturnType<typeof createSessionIpcClient> | undefined;
  try {
    const id = f.activeRun ?? f.store.create({ sessionId: f.feed.sessionId, agent: 'worker' }).id;
    if (!f.activeRun) f.store.start(id);
    if (gated) await expect.poll(() => held, { timeout: 5000 }).toBe(true);
    const first = await f.ipc.openRun(id as RunId);
    if (!first.ok || first.op !== 'openRun') throw new Error('Viewer not opened');
    await f.app.command('terminal.park', { terminal: first.viewer });
    await f.app.command('terminal.keep', { terminal: first.viewer, place: 'tab' });
    const placement = await f.app.ownerPlacement(first.viewer);
    let shutdownFinished = false;
    const shutdown = f.emit('session_shutdown', { reason: 'reload' }).then(() => { shutdownFinished = true; });
    if (gated) {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(shutdownFinished).toBe(false);
    }
    release();
    await shutdown;
    if (gated) await oldOpenerSettled;
    await f.emit('session_start');
    const feed = await createViewerFeedSource(f.feedRoot, f.feed.sessionId).read();
    if (!feed?.ipc) throw new Error('Reload did not publish its endpoint');
    reloaded = createSessionIpcClient({ version: 1, sessionId: feed.sessionId, generation: feed.generation, ...feed.ipc });
    expect(await reloaded.openRun(id as RunId)).toMatchObject({ ok: true, op: 'openRun', viewer: first.viewer });
    expect(await f.app.ownerPlacement(first.viewer)).toEqual(placement);
    expect((await f.h.hc.get(first.viewer)).labels['herdr.tab']).toBe(placement.tab);
    expect(f.errors).toEqual([]);
  } finally { release(); reloaded?.dispose(); await f.close(); }
}, 30000);

it('shutdown during an explicit reopen never hides or kills the already displayed viewer', async () => {
  const f = await mountedViewerFixture('fake', false, false, true);
  try {
    const { id } = f.store.create({ sessionId: f.feed.sessionId, agent: 'worker' }); f.store.start(id);
    const first = await f.ipc.openRun(id as RunId);
    if (!first.ok || first.op !== 'openRun') throw new Error('Viewer not opened');
    const placement = await f.app.ownerPlacement(first.viewer);
    const callsFile = join(f.h.directories.local, 'app-calls.jsonl');
    const count = async () => (await readFile(callsFile, 'utf8')).split('\n').filter(line => line.includes('pane.focus')).length;
    const before = await count();
    await f.h.scenario({ appSteps: [{ argvPrefix: ['do', 'pane.focus'], delayMs: 500 }] });
    const opening = f.ipc.openRun(id as RunId).catch(() => null);
    await expect.poll(count, { timeout: 3000 }).toBeGreaterThan(before);
    await f.emit('session_shutdown', { reason: 'reload' }); await opening;
    expect(await f.app.ownerPlacement(first.viewer)).toEqual(placement);
    expect((await f.h.hc.get(first.viewer)).state).toBe('live');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it.each([false, true])('mounted automatic viewers follow automaticSubagentPanes=%s and user opens reuse them', async automaticSubagentPanes => {
  const createPanes = paneModule.createAuxiliaryPanes, openRunView = hostPorts.openRunView;
  let viewer: import('../../../herdr/src/contracts.js').TerminalAddress | undefined, settled = false;
  vi.spyOn(hostPorts, 'openRunView').mockImplementation(async input => {
    try { return await openRunView(input); }
    finally { if (input.automatic) settled = true; }
  });
  vi.spyOn(paneModule, 'createAuxiliaryPanes').mockImplementation(options =>
    createPanes({ ...options, subagentViewer: async (...args) => { viewer = await options.subagentViewer(...args); return viewer; } }));
  const f = await mountedViewerFixture('fake', true, automaticSubagentPanes, true);
  try {
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 10000 });
    const owner = await f.app.ownerPlacement(f.h.owner!.terminal.address);
    if (automaticSubagentPanes) {
      if (!viewer) throw new Error('Automatic run did not launch its viewer');
      expect(await f.app.ownerPlacement(viewer)).toMatchObject({ space: owner.space, tab: owner.tab });
    } else {
      expect(viewer).toBeUndefined();
      expect((await f.h.calls()).filter(call => call.argv[0] === 'run' && call.argv.includes('spider.kind=subagent-viewer'))).toEqual([]);
    }
    const reply = await f.ipc.openRun(f.activeRun!);
    expect(reply).toMatchObject({ ok: true, op: 'openRun', viewer });
    if (!reply.ok || reply.op !== 'openRun' || !viewer) throw new Error('Viewer not opened');
    const terminal = await f.h.hc.get(viewer);
    expect(terminal).toMatchObject({ state: 'live', parent: f.h.owner!.terminal.address, labels: { 'spider.kind': 'subagent-viewer', 'spider.run': f.activeRun } });
    const opened = await f.app.ownerPlacement(viewer);
    expect(opened.space).toBe(owner.space);
    if (automaticSubagentPanes) expect(opened.tab).toBe(owner.tab);
    else { expect(opened.tab).toBe(owner.tab); expect(opened.pane).not.toBe(owner.pane); }
    const ordered = (await f.app.tabPanes(owner)).map(pane => pane.terminal);
    expect(ordered).toContain(f.h.owner!.terminal.address);
    expect(ordered.indexOf(viewer)).toBe(ordered.indexOf(f.h.owner!.terminal.address) + 1);
    expect(await f.ipc.openRun(f.activeRun!)).toMatchObject({ ok: true, op: 'openRun', viewer });
    expect((await f.h.calls()).filter(call => call.argv[0] === 'run' && call.argv.includes('spider.kind=subagent-viewer'))).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);
