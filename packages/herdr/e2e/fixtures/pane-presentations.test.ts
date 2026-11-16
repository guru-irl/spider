// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createPresentationApp, presentationRows, requirePaneHeadless, stableTerminal, paneHeaderFunctions, paneActionFunctions, paneNavigation, type PaneFixture, type PresentationDocument } from './pane-presentations.js';

describe('cross-machine presentation fixtures', () => {
  it('reserves an explicit mod slot without launching an execution terminal', async () => {
    const calls: readonly string[][] = [];
    const app = createPresentationApp(async args => { (calls as string[][]).push([...args]); return { address: 't1' }; });
    const space = await app('space.new', { name: 'Work', folder: '/home/example', argv: ['/bin/cat'] });
    const slot = await app('tab.new', { space: space.space, mod: 'spider-pane-waiting', props: { operationId: 'open-1' } });
    const world = await app('ls', {});
    expect(world.spaces[0].tabs[1].panes).toEqual([{ id: slot.pane, mod: 'spider-pane-waiting', props: { operationId: 'open-1' } }]);
    expect(world.spaces[0].tabs[1].terminals).toEqual([]);
    expect(calls.filter(args => args[0] === 'run')).toHaveLength(1);
  });
  it('adopts one local proxy beside the captured anchor and refuses a remote app pane', async () => {
    const app = createPresentationApp(async args => args[0] === 'run' ? { address: 't1' } : { state: 'live', address: args[1] });
    const created = await app('space.new', { name: 'Work', argv: ['/bin/cat'] });
    const split = await app('pane.split', { pane: created.pane, direction: 'down', mod: 'spider-pane-waiting', props: { operationId: 'split-1' } });
    await app('pane.focus', { pane: split.pane });
    await app('terminal.keep', { terminal: 'proxy-1', place: 'right' });
    await app('terminal.keep', { terminal: 'proxy-1', place: 'right' });
    expect(presentationRows(await app('ls', {}) as PresentationDocument).filter(row => row.terminal === 'proxy-1')).toHaveLength(1);
    expect((await app('status', {})).tab).toBe(created.tab);
    await expect(app('terminal.keep', { terminal: 'box-1.invalid/t1', place: 'right' })).rejects.toThrow('local');
  });
  it('navigates only between owned adjacent panes and reconnects neighbors after removal', async () => {
    const app = createPresentationApp(async args => args[0] === 'run' ? { address: 't1' } : { state: 'live', address: args[1] });
    const owner = await app('space.new', { argv: ['/bin/cat'] });
    const waiting = await app('pane.split', { pane: owner.pane, direction: 'down', mod: 'spider-pane-waiting' });
    const viewer = await app('terminal.keep', { terminal: 'viewer-1', place: 'down' });
    await app('pane.focus', { pane: owner.pane });
    await app('pane.go', { direction: 'down' });
    expect((await app('status', {})).focused_pane).toBe(waiting.pane);
    await app('pane.go', { direction: 'down' });
    expect((await app('status', {})).focused_pane).toBe(viewer.pane);
    await app('pane.close', { pane: waiting.pane });
    await app('pane.go', { direction: 'up' });
    expect((await app('status', {})).focused_pane).toBe(owner.pane);
    await app('pane.go', { direction: 'left' });
    expect((await app('status', {})).focused_pane).toBe(owner.pane);
  });
  it('adopts a live labelled local display into an owned fallback tab without stealing focus', async () => {
    let records: Record<string, any>[] = [];
    const app = createPresentationApp(async args => args[0] === 'run' ? { address: 't1' } : args[0] === 'ls' ? { terminals: records.map(({ address, state }) => ({ address, state })) } : records.find(row => row.address === args[1])!);
    const owner = await app('space.new', { argv: ['/bin/cat'] });
    const target = await app('tab.new', { space: owner.space, mod: 'pane' });
    await app('pane.focus', { pane: owner.pane });
    const labels = { 'herdr.space': owner.space, 'herdr.tab': target.tab };
    records = [{ address: 't2', state: 'live', labels }, { address: 'box-1.invalid/t3', state: 'live', labels }, { address: 't4', state: 'finished', labels }, { address: 't5', state: 'live', labels: { ...labels, 'herdr.space': 'foreign-space' } }];
    const rows = presentationRows(await app('ls', {}) as PresentationDocument);
    expect(rows.filter(row => row.tab === target.tab)).toEqual([{ space: owner.space, tab: target.tab, pane: expect.any(String), terminal: 't2' }]);
    expect(rows.find(row => row.terminal === 't2')!.pane).not.toBe(target.pane);
    expect((await app('status', {})).focused_pane).toBe(owner.pane);
    expect(presentationRows(await app('ls', {}) as PresentationDocument)).toEqual(rows);
  });
  it('moves an owned fallback tab by its one-based index while retaining pane focus', async () => {
    const app = createPresentationApp(async () => ({ address: 't1' }));
    const owner = await app('space.new', { argv: ['/bin/cat'] });
    const middle = await app('tab.new', { space: owner.space, mod: 'spider-pane-waiting' });
    const target = await app('tab.new', { space: owner.space, mod: 'spider-pane-waiting' });
    await app('tab.move', { id: target.tab, index: 2 });
    expect((await app('ls', {})).spaces[0].tabs.map((tab: { id: string }) => tab.id)).toEqual([owner.tab, target.tab, middle.tab]);
    expect((await app('status', {})).focused_pane).toBe(target.pane);
  });
  it('Send back removes a display without killing its execution program', async () => {
    const calls: string[][] = [];
    const app = createPresentationApp(async args => { calls.push([...args]); return { address: 't1', state: 'live' }; });
    await app('space.new', { name: 'Work', argv: ['/bin/cat'] });
    await app('terminal.park', { terminal: 't1' });
    expect(presentationRows(await app('ls', {}) as PresentationDocument)).toEqual([]);
    expect(calls.some(args => args[0] === 'kill')).toBe(false);
  });
  it('closes only the requested owned space and its display terminals', async () => {
    const calls: string[][] = []; let next = 0;
    const app = createPresentationApp(async args => { calls.push([...args]); return args[0] === 'run' ? { address: `t${++next}` } : { state: 'live', address: args[1] }; });
    const first = await app('space.new', { name: 'Keep', argv: ['/bin/cat'] });
    const second = await app('space.new', { name: 'Close', argv: ['/bin/cat'] });
    await app('space.close', { id: second.space, confirmed: true });
    expect((await app('ls', {})).spaces.map((space: { id: string }) => space.id)).toEqual([first.space]);
    expect(calls.filter(args => args[0] === 'kill')).toEqual([['kill', second.terminal, '--json']]);
    expect(presentationRows(await app('ls', {}) as PresentationDocument)).toEqual([{ space: first.space, tab: first.tab, pane: first.pane, terminal: first.terminal }]);
  });
  it('rejects unknown app operations instead of inventing a successful result', async () => {
    const app = createPresentationApp(async () => ({}));
    await expect(app('pane.swap', {})).rejects.toThrow('unsupported');
    const commands = await app('commands', {});
    expect(commands.commands.find((row: { name: string }) => row.name === 'pane.swap')).toBeUndefined();
  });
  it('compares terminal incarnation and process identity without transient status fields', () => {
    const before = { address: 't7', state: 'live', created_ms: 10, pid: 70, labels: { name: 'unrelated' }, foreground: { pid: 70, cwd: '/home/example' }, status: null, cols: 80, rows: 24 };
    expect(stableTerminal({ ...before, status: { state: 'working' } })).toEqual(stableTerminal(before));
    expect(stableTerminal({ ...before, created_ms: 11 })).not.toEqual(stableTerminal(before));
    expect(stableTerminal({ ...before, pid: 71 })).not.toEqual(stableTerminal(before));
    expect(stableTerminal({ ...before, state: 'finished' })).not.toEqual(stableTerminal(before));
  });
  it('loads the installed pane rules without substituting native rendering', async () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const headers = await paneHeaderFunctions(root), actions = await paneActionFunctions(root);
    expect(headers.paneMachineFact({ address: 't1', programIsAgent: true, labels: {} }, [])).toEqual({ label: 'This computer', known: true });
    expect(headers.paneMachineFact({ address: 't1', programIsAgent: false, labels: {} }, [])).toBeNull();
    expect(headers.paneMachineFact({ address: 'proxy-1', programIsAgent: true, labels: { 'spider.kind': 'pane-proxy' } }, [])).toEqual({ label: 'Machine unavailable', known: false });
    const effects: string[] = [];
    await actions.handlePaneCommand('close', { pane: { pane: 'p1' }, header: { labels: {} }, presentation: null }, { nativeClose: () => { effects.push('native-close'); }, notify: () => { throw new Error('native close was refused'); } });
    expect(effects).toEqual(['native-close']);
  });
  it('projects a disabled non-terminal owner with the installed navigation rules', async () => {
    const app = createPresentationApp(async () => ({ address: 't1', state: 'live' }));
    const anchor = await app('space.new', { name: 'Work', argv: ['/bin/cat'] });
    const fixture = { packageRoot: fileURLToPath(new URL('../../../../', import.meta.url)), app, anchor, suite: { cores: { local: { coreId: 'core-local' } } }, snapshot: async () => ({ version: 1, kind: 'snapshot', complete: true, omittedRows: 0, revision: 1, machines: [], targetFacts: {}, presentations: [], rows: [{ sessionId: 'unhosted', generation: null, name: 'Unhosted', owner: null, target: null, status: 'unknown', updatedAt: Date.now(), machineKey: 'box-1.invalid', unavailableReason: 'not-in-hc', children: [], consoles: [] }] }) } as unknown as PaneFixture;
    const rows = await paneNavigation(fixture);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Unhosted', action: null, disabledReason: 'Not in an hc terminal' });
  });
  it('blocks native interaction before launching or focusing an app', () => {
    expect(() => requirePaneHeadless('app')).toThrow('missing-prerequisite');
    expect(() => requirePaneHeadless('headless')).not.toThrow();
  });
});
