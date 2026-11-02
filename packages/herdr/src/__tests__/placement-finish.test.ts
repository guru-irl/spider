// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createHerdrHarness } from './testutil.js';
import { createViewerLauncher, registerHerdrViewers } from '../viewers/register.js';
import { createAuxiliaryPanes } from '../jobs/placement.js';
import { createViewerPorts } from '../../../host/src/herdr/ports.js';
import { HerdrError } from '../client/parse.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AppClient, HcRunRequest, OwnerPlacement, RunId, RunSummary, TerminalAddress } from '../contracts.js';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const h = await createHerdrHarness('fake'); await h.start(); const owner = h.owner!;
  const executable = join(h.root, 'viewer.mjs'); await writeFile(executable, 'setInterval(() => {}, 1000);');
  const placement = { space: 'space', tab: 'owner-tab', pane: 'owner-pane' } as OwnerPlacement;
  const layout = new Map<TerminalAddress, OwnerPlacement>([[owner.terminal.address, placement]]);
  const launches: HcRunRequest[] = [], removed: TerminalAddress[] = [], errors: unknown[] = [];
  const entered = barrier(), release = barrier(); let hold = false;
  let status: RunSummary['status'] = 'running';
  let focusFailure: { viewer: TerminalAddress; code: string; entered: ReturnType<typeof barrier>; release: ReturnType<typeof barrier> } | undefined;
  const hc = { ...h.hc, run: async (request: HcRunRequest) => {
    launches.push(request); if (hold) { entered.resolve(); await release.promise; } return h.hc.run(request);
  }, rm: async (address: TerminalAddress) => { await h.hc.rm(address); removed.push(address); } };
  const app: AppClient = {
    ownerPlacement: async address => { const p = layout.get(address); if (!p) throw new HerdrError('owner-unplaced', 'Pane absent'); return p; },
    awaitPane: async (address, p) => { const pane = `pane-${address}` as OwnerPlacement['pane']; layout.set(address, { ...p, pane }); return pane; },
    command: async (name, args) => {
      if (name === 'pane.focus' && args.terminal === focusFailure?.viewer) {
        const failure = focusFailure!; focusFailure = undefined;
        failure.entered.resolve(); await failure.release.promise;
        throw new HerdrError(failure.code, 'Viewer exited during app focus');
      }
      if (name === 'terminal.park') layout.delete(args.terminal as TerminalAddress); return {};
    },
  };
  const makeLauncher = () => createViewerLauncher({ hc, owner: () => owner, viewerExecutable: executable, feedRoot: h.root,
    runInfo: () => ({ status }),
    ipcDescriptor: () => ({ version: 1, sessionId: owner.sessionId, generation: owner.generation, address: join(h.root, 'ipc.sock'), capabilityFile: join(h.root, 'ipc.cap') }) });
  const launcher = makeLauncher();
  const panes = createAuxiliaryPanes({ hc, app, subagentViewer: launcher, discardSubagentViewer: launcher.discard, limit: 1, clock: Date.now, reportError: error => errors.push(error) });
  return { h, owner, launcher, makeLauncher, panes, launches, removed, layout, placement, errors, entered, release,
    setStatus(value: RunSummary['status']) { status = value; }, hold() { hold = true; },
    failFocus(viewer: TerminalAddress, code: string) { focusFailure = { viewer, code, entered: barrier(), release: barrier() }; return focusFailure; },
    async close() { release.resolve(); await panes.dispose(); await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); },
  };
}
const id = '10000000-0000-4000-8000-000000000001' as RunId;

// A final run must not get a fresh automatic process, but user opens still work.
test.each(['done', 'failed', 'cancelled'] as const)('placement skips an already-%s automatic run but permits an explicit saved view', async status => {
  const f = await fixture();
  try {
    f.setStatus(status);
    expect(await f.panes.acquire('subagent', id, f.owner, { automatic: true, timeoutMs: 1000 })).toBeNull();
    expect(f.launches).toHaveLength(0); expect([...f.layout.keys()]).toEqual([f.owner.terminal.address]);
    const opened = await f.panes.acquire('subagent', id, f.owner, { timeoutMs: 1000 });
    expect(opened).not.toBeNull(); expect(f.launches).toHaveLength(1);
    expect(createViewerPorts(f.launches[0].argv.slice(2), { stdin: new PassThrough(), stdout: new PassThrough() })?.intent).toBe('explicit');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 15000);

test('an automatic launch racing finish carries its intent and frees its slot and core record on exit', async () => {
  const f = await fixture(); let opening: ReturnType<typeof f.panes.acquire> | undefined;
  try {
    f.hold(); opening = f.panes.acquire('subagent', id, f.owner, { automatic: true, timeoutMs: 1000 });
    await f.entered.promise; f.setStatus('done'); f.release.resolve();
    const opened = (await opening)!;
    expect(createViewerPorts(f.launches[0].argv.slice(2), { stdin: new PassThrough(), stdout: new PassThrough() })?.intent).toBe('automatic');
    expect(f.layout.has(opened.viewer)).toBe(true);
    // Native Herdr removes the app pane as the viewer exits, before core cleanup.
    f.layout.delete(opened.viewer); await f.h.hc.kill(opened.viewer);
    await expect.poll(() => f.removed).toContain(opened.viewer);
    await expect(f.h.hc.get(opened.viewer)).rejects.toMatchObject({ code: 'not_found' });
    f.setStatus('running');
    const next = await f.panes.acquire('subagent', '10000000-0000-4000-8000-000000000002' as RunId, f.owner, { automatic: true, timeoutMs: 1000 });
    expect(next).not.toBeNull(); expect(f.layout.get(f.owner.terminal.address)).toEqual(f.placement);
    expect(f.errors).toEqual([]);
  } finally { f.release.resolve(); await Promise.allSettled([opening]); await f.close(); }
}, 15000);

test('an explicit open reuses a live automatic viewer without changing its lifetime or discard claim', async () => {
  const f = await fixture();
  try {
    const automatic = (await f.panes.acquire('subagent', id, f.owner, { automatic: true, timeoutMs: 1000 }))!;
    const explicit = await f.panes.acquire('subagent', id, f.owner, { timeoutMs: 1000 });
    expect(explicit?.viewer).toBe(automatic.viewer); expect(f.launches).toHaveLength(1);
    expect(createViewerPorts(f.launches[0].argv.slice(2), { stdin: new PassThrough(), stdout: new PassThrough() })?.intent).toBe('automatic');
    await f.launcher.discard(id, f.owner, automatic.viewer);
    expect((await f.h.hc.get(automatic.viewer)).state).toBe('live');
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 15000);

// S31 disproved this premise: a live viewer is not necessarily a saved viewer.
test.each(['automatic', 'explicit'] as const)('a saved open waits for an unfinished %s viewer to exit rather than returning its dying pane', async intent => {
  const f = await fixture(); let opening: ReturnType<typeof f.panes.acquire> | undefined;
  try {
    const live = (await f.panes.acquire('subagent', id, f.owner, { automatic: intent === 'automatic', timeoutMs: 1000 }))!;
    f.setStatus('failed');
    let opened = false;
    opening = f.panes.acquire('subagent', id, f.owner, { timeoutMs: 1000 }).then(result => { opened = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(opened).toBe(false); expect(f.launches).toHaveLength(1);
    f.layout.delete(live.viewer); await f.h.hc.kill(live.viewer);
    const saved = await opening;
    expect(saved).not.toBeNull(); expect(saved!.viewer).not.toBe(live.viewer);
    expect((await f.h.hc.get(saved!.viewer)).state).toBe('live');
    expect(await f.launcher(id, f.owner)).toBe(saved!.viewer);
    expect(f.launches).toHaveLength(2); expect(f.errors).toEqual([]);
  } finally {
    // The failed baseline can leave a newly-created viewer or the original live.
    f.release.resolve(); await Promise.allSettled([opening]); await f.close();
  }
}, 15000);

test('a reloaded launcher waits for the final live viewer before opening a saved view', async () => {
  const f = await fixture(); let opening: Promise<TerminalAddress> | undefined;
  try {
    const live = (await f.panes.acquire('subagent', id, f.owner, { automatic: true, timeoutMs: 1000 }))!;
    f.setStatus('cancelled'); const reloaded = f.makeLauncher(); let opened = false;
    opening = reloaded(id, f.owner).then(address => { opened = true; return address; });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(opened).toBe(false); expect(f.launches).toHaveLength(1);
    f.layout.delete(live.viewer); await f.h.hc.kill(live.viewer);
    const saved = await opening;
    expect(saved).not.toBe(live.viewer); expect((await f.h.hc.get(saved)).state).toBe('live');
    expect(await f.makeLauncher()(id, f.owner)).toBe(saved);
    expect(f.launches).toHaveLength(2); expect(f.errors).toEqual([]);
  } finally { await Promise.allSettled([opening]); await f.close(); }
}, 15000);

test.each(['app-error', 'cli-exit'])('an explicit open retries a viewer that exits during app focus (%s)', async code => {
  const f = await fixture(); let opening: ReturnType<typeof f.panes.acquire> | undefined, failure: ReturnType<typeof f.failFocus> | undefined;
  try {
    const automatic = (await f.panes.acquire('subagent', id, f.owner, { automatic: true, timeoutMs: 1000 }))!;
    failure = f.failFocus(automatic.viewer, code);
    opening = f.panes.acquire('subagent', id, f.owner, { timeoutMs: 1000 }); void opening.catch(() => {});
    await failure.entered.promise; f.setStatus('failed');
    f.layout.delete(automatic.viewer); await f.h.hc.kill(automatic.viewer);
    await expect.poll(() => f.removed).toContain(automatic.viewer);
    failure.release.resolve();
    const saved = await opening;
    expect(saved).not.toBeNull(); expect(saved!.viewer).not.toBe(automatic.viewer);
    expect((await f.h.hc.get(saved!.viewer)).state).toBe('live');
    expect(f.layout.get(f.owner.terminal.address)).toEqual(f.placement);
    expect(createViewerPorts(f.launches[1].argv.slice(2), { stdin: new PassThrough(), stdout: new PassThrough() })?.intent).toBe('explicit');
    expect(f.errors).toEqual([]);
  } finally { failure?.release.resolve(); await Promise.allSettled([opening]); await f.close(); }
}, 15000);

test('a raw app failure for a still-live viewer is not mistaken for completion', async () => {
  const f = await fixture(); let opening: ReturnType<typeof f.panes.acquire> | undefined, failure: ReturnType<typeof f.failFocus> | undefined;
  try {
    const automatic = (await f.panes.acquire('subagent', id, f.owner, { automatic: true, timeoutMs: 1000 }))!;
    failure = f.failFocus(automatic.viewer, 'cli-exit');
    opening = f.panes.acquire('subagent', id, f.owner, { timeoutMs: 1000 }); void opening.catch(() => {});
    await failure.entered.promise; failure.release.resolve();
    await expect(opening).rejects.toMatchObject({ code: 'cli-exit' });
    expect((await f.h.hc.get(automatic.viewer)).state).toBe('live');
    expect(f.launches).toHaveLength(1); expect(f.layout.get(f.owner.terminal.address)).toEqual(f.placement);
  } finally { failure?.release.resolve(); await Promise.allSettled([opening]); await f.close(); }
}, 15000);

test('automatic registration does not relaunch a final run after placement declines it', async () => {
  const f = await fixture();
  const handlers = new Map<string, () => Promise<void>>();
  const pi = { on: (event: string, handler: () => Promise<void>) => { handlers.set(event, handler); } } as unknown as ExtensionAPI;
  const registered = registerHerdrViewers(pi, { owner: () => f.owner, hc: f.h.hc, panes: f.panes, viewerLauncher: f.launcher,
    viewerExecutable: '/fixture/viewer.mjs', feedRoot: f.h.root, ipcDescriptor: () => null,
    ownedRunEvents: { list: async () => [id], subscribe: () => () => {} }, reportError: error => f.errors.push(error) });
  try {
    f.setStatus('done'); await handlers.get('session_start')!();
    // Joining the pending automatic open must still allow the explicit saved open.
    expect(await registered.peek(id)).not.toBeNull();
    expect(f.launches).toHaveLength(1);
    expect(createViewerPorts(f.launches[0].argv.slice(2), { stdin: new PassThrough(), stdout: new PassThrough() })?.intent).toBe('explicit');
    expect(f.errors).toEqual([]);
  } finally { await registered.dispose(); await f.close(); }
}, 15000);
