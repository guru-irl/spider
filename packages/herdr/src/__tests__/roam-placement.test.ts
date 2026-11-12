// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createAppClient } from '../client/app.js';
import { createHcClient } from '../client/hc.js';
import { createTerminalRegistry } from '../sessions/registry.js';
import { createRoamPlacement, rememberRoamSlot } from '../roam-placement.js';
import { createClientFixture } from './testutil.js';
import type { AppClient, HcClient, Owner, SpaceId, TabId } from '../contracts.js';

const ready = (terminal: string) => ({ operationId: 'op', sessionId: 'session-1', epoch: 1, cwd: '/work', file: '/work/session.jsonl', core: 'remote-core', terminal });
const slot = { space: 's1' as SpaceId, tab: 'tb1' as TabId };
async function fixture() {
  const f = await createClientFixture();
  const stateRoot = join(f.root, 'herdr');
  const hc = createHcClient({ binary: f.hcBinary, env: f.localEnv });
  const app = createAppClient({ binary: f.appBinary, env: f.localEnv });
  const registry = createTerminalRegistry(stateRoot);
  const owner = { sessionId: 'session-1', generation: 'g1', terminal: { coreId: 'local-core', terminalId: 't1', address: 't1', socket: f.localSocket, sessionNamespace: f.namespace }, cwd: '/work', sessionFile: null, name: null } as Owner;
  await registry.record({ owner, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: f.root, extensionArguments: [] } });
  await writeFile(join(f.root, 'app.json'), JSON.stringify({ focusedPane: 'p1', spaces: [{ id: 's1', tabs: [{ id: 'tb1', terminals: [{ terminal: 't1', pane: 'p1' }] }] }] }));
  const create = (client: AppClient | null = app) => createRoamPlacement({ hc, app: client, registry, hcBinary: f.hcBinary, stateRoot });
  const close = async () => { await hc.dispose(); await f.close(); };
  const runs = async () => (await f.calls()).filter(call => call.argv[0] === 'run');
  return { f, hc, app, registry, stateRoot, create, close, runs };
}

test('closed app and core never auto-start', async () => {
  const h = await fixture();
  try {
    await h.f.stopCore();
    const placement = h.create(null);
    await expect(placement.reconcile([ready('box-1.invalid/t5')])).rejects.toMatchObject({ code: 'core-unavailable' });
    const startAppOrCoreCalls = await h.f.calls();
    expect(startAppOrCoreCalls).toEqual([]);
    expect(await readFile(join(h.f.root, 'app-calls.jsonl'), 'utf8')).toBe('');
  } finally { await h.close(); }
}, 5000);

test('placement reconciles each new terminal once', async () => {
  const h = await fixture();
  try {
    const p = h.create();
    expect(await p.reconcile([ready('box-1.invalid/t5')])).toEqual({ pending: [] });
    expect(await p.reconcile([ready('box-1.invalid/t5')])).toEqual({ pending: [] });
    const first = await h.runs();
    expect(first).toHaveLength(1);
    const args = first[0].argv;
    expect(args).toContain('--bg');
    expect(args).not.toContain('--on');
    expect(args.slice(args.indexOf('--') + 1)).toEqual([h.f.hcBinary, 'attach', '--history', '100', 'box-1.invalid/t5']);
    expect(args).toEqual(expect.arrayContaining(['spider.kind=roam-proxy', 'spider.session=session-1', 'spider.owner-terminal=box-1.invalid/t5', 'herdr.space=s1', 'herdr.tab=tb1']));
    expect(await h.app.ownerPlacement(h.f.address('t2'))).toMatchObject(slot);
    const layout = JSON.parse(await readFile(join(h.f.root, 'app.json'), 'utf8'));
    expect(layout.focusedPane).toBe('p1');
    const appCalls = (await readFile(join(h.f.root, 'app-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(appCalls.every(call => call[0] !== 'do')).toBe(true);
    await h.hc.rm(h.f.address('t2'));
    await p.reconcile([ready('box-1.invalid/t5')]);
    expect(await h.runs()).toHaveLength(1);
    const newTerminal = 'box-1.invalid/t6';
    await h.create().reconcile([ready(newTerminal)]);
    const placements = (await h.runs()).slice(1).map(call => call.argv.at(-1));
    expect(placements).toEqual([newTerminal]);
    expect((await h.f.calls()).filter(call => ['kill', 'rm', 'label'].includes(call.argv[0]) && call.argv[1].includes('/'))).toEqual([]);
    expect((await stat(join(h.stateRoot, 'roam-placement.json'))).mode & 0o777).toBe(0o600);
  } finally { await h.close(); }
}, 5000);

test('pending placement survives app closure', async () => {
  const h = await fixture();
  try {
    const unplacedTerminal = 'box-1.invalid/t5';
    const p = h.create(null);
    const { pending } = await p.reconcile([ready(unplacedTerminal)]);
    expect(pending).toEqual([unplacedTerminal]);
    expect(await h.runs()).toHaveLength(0);
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    expect(await h.create(null).reconcile([ready(unplacedTerminal)])).toEqual({ pending: [] });
    expect(await h.runs()).toHaveLength(1);
    expect(await h.create().reconcile([ready(unplacedTerminal)])).toEqual({ pending: [] });
    expect(await h.runs()).toHaveLength(1);
  } finally { await h.close(); }
}, 5000);


test('lost launch reply recovers the labelled proxy without another launch', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    const lostReply: HcClient = { ...h.hc, run: async request => { await h.hc.run(request); throw new Error('reply lost'); } };
    const registry = createTerminalRegistry(h.stateRoot);
    const p = createRoamPlacement({ hc: lostReply, app: null, registry, hcBinary: h.f.hcBinary, stateRoot: h.stateRoot });
    await expect(p.reconcile([ready('box-1.invalid/t5')])).rejects.toThrow('reply lost');
    expect(await h.create(null).reconcile([ready('box-1.invalid/t5')])).toEqual({ pending: [] });
    expect(await h.runs()).toHaveLength(1);
  } finally { await h.close(); }
}, 5000);

test('concurrent reconciliations start only one proxy', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    await Promise.all([h.create(null).reconcile([ready('box-1.invalid/t5')]), h.create(null).reconcile([ready('box-1.invalid/t5')])]);
    expect(await h.runs()).toHaveLength(1);
  } finally { await h.close(); }
}, 5000);

test('a moved proxy teaches the slot for the next terminal', async () => {
  const h = await fixture();
  try {
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    const layout = JSON.parse(await readFile(join(h.f.root, 'app.json'), 'utf8'));
    const oldTab = layout.spaces[0].tabs[0];
    oldTab.terminals = oldTab.terminals.filter((row: { terminal: string }) => row.terminal !== 't2');
    layout.spaces.push({ id: 's2', tabs: [{ id: 'tb2', terminals: [{ terminal: 't2', pane: 'p2' }] }] });
    await h.hc.setLabels(h.f.address('t2'), { 'herdr.space': 's2', 'herdr.tab': 'tb2' });
    await writeFile(join(h.f.root, 'app.json'), JSON.stringify(layout));
    await h.create().reconcile([ready('box-1.invalid/t6')]);
    const args = (await h.runs())[1].argv;
    expect(args).toEqual(expect.arrayContaining(['herdr.space=s2', 'herdr.tab=tb2']));
    expect(await h.app.ownerPlacement(h.f.address('t3'))).toMatchObject({ space: 's2', tab: 'tb2' });
  } finally { await h.close(); }
}, 5000);

test('only exited proxies with matching ownership are removed', async () => {
  const h = await fixture();
  try {
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    const state = JSON.parse(await readFile(join(h.f.root, 'core.json'), 'utf8'));
    const proxy = state.terminals.find((item: { address: string }) => item.address === 't2');
    proxy.state = 'finished'; proxy.exit_code = 0; proxy.reason = 'exited'; proxy.finished_ms = 1234;
    proxy.labels['spider.session'] = 'another-session';
    await h.f.configure({ terminals: state.terminals });
    await h.create(null).reconcile([ready('box-1.invalid/t6')]);
    expect((await h.hc.get(h.f.address('t2'))).state).toBe('finished');
    const state2 = JSON.parse(await readFile(join(h.f.root, 'core.json'), 'utf8'));
    const second = state2.terminals.find((item: { address: string }) => item.address === 't3');
    second.state = 'finished'; second.exit_code = 0; second.reason = 'exited'; second.finished_ms = 1234;
    await h.f.configure({ terminals: state2.terminals });
    await h.create(null).reconcile([ready('box-1.invalid/t7')]);
    await expect(h.hc.get(h.f.address('t3'))).rejects.toMatchObject({ code: 'not_found' });
    expect((await h.hc.get(h.f.address('t2'))).labels['spider.session']).toBe('another-session');
  } finally { await h.close(); }
}, 5000);


test('closing a pane without removing its terminal does not reopen it', async () => {
  const h = await fixture();
  try {
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    const layout = JSON.parse(await readFile(join(h.f.root, 'app.json'), 'utf8'));
    layout.spaces[0].tabs[0].terminals = layout.spaces[0].tabs[0].terminals.filter((row: { terminal: string }) => row.terminal !== 't2');
    await h.hc.setLabels(h.f.address('t2'), { 'herdr.space': null, 'herdr.tab': null });
    await writeFile(join(h.f.root, 'app.json'), JSON.stringify(layout));
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    await expect(h.app.ownerPlacement(h.f.address('t2'))).rejects.toMatchObject({ code: 'owner-unplaced' });
    expect(await h.runs()).toHaveLength(1);
    expect((await h.hc.get(h.f.address('t2'))).state).toBe('live');
  } finally { await h.close(); }
}, 5000);

test('resolves an unqualified terminal by its connected core identity', async () => {
  const h = await fixture();
  try {
    await h.f.configure({ machines: [{ id: 'remote-core', name: 'box-1.invalid', host: 'box-1.invalid', target: 'box-1.invalid', state: 'connected', session: 'remote' }] });
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    expect(await h.create(null).reconcile([ready('t5')])).toEqual({ pending: [] });
    expect((await h.runs())[0].argv.at(-1)).toBe('box-1.invalid/t5');
  } finally { await h.close(); }
}, 5000);

test('an unresolved core remains pending without a launch', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    expect(await h.create(null).reconcile([ready('t5')])).toEqual({ pending: ['t5'] });
    expect(await h.runs()).toHaveLength(0);
  } finally { await h.close(); }
}, 5000);


test('a leading-dash machine alias stays a positional attach address', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    await h.create(null).reconcile([ready('-box.invalid/t5')]);
    const args = (await h.runs())[0].argv;
    expect(args.slice(args.indexOf('--') + 1)).toEqual([h.f.hcBinary, 'attach', '--history', '100', '--', '-box.invalid/t5']);
  } finally { await h.close(); }
}, 5000);


test('one remote terminal cannot acquire proxies for two sessions', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    await rememberRoamSlot(h.stateRoot, 'session-2', slot);
    const terminal = 'box-1.invalid/t5';
    const result = await h.create(null).reconcile([ready(terminal), { ...ready(terminal), sessionId: 'session-2' }]);
    expect(result.pending).toEqual([terminal]);
    expect(await h.runs()).toHaveLength(1);
  } finally { await h.close(); }
}, 5000);


test('cleanup leaves a terminal with a different remote core label alone', async () => {
  const h = await fixture();
  try {
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    const state = JSON.parse(await readFile(join(h.f.root, 'core.json'), 'utf8'));
    const proxy = state.terminals.find((item: { address: string }) => item.address === 't2');
    proxy.state = 'finished'; proxy.exit_code = 0; proxy.reason = 'exited'; proxy.finished_ms = 1234;
    proxy.labels['spider.owner-core'] = 'another-core';
    await h.f.configure({ terminals: state.terminals });
    await h.create(null).reconcile([ready('box-1.invalid/t6')]);
    expect((await h.hc.get(h.f.address('t2'))).state).toBe('finished');
  } finally { await h.close(); }
}, 5000);


test('requires the resolved absolute hc binary', async () => {
  const h = await fixture();
  try {
    const registry = createTerminalRegistry(h.stateRoot);
    expect(() => createRoamPlacement({ hc: h.hc, app: null, registry, hcBinary: 'hc', stateRoot: h.stateRoot })).toThrow();
    expect(await h.f.calls()).toEqual([]);
  } finally { await h.close(); }
}, 5000);


test('lost replies remain recoverable after the event stream is already open', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    const lostReply: HcClient = { ...h.hc, run: async request => { await h.hc.run(request); throw new Error('reply lost'); } };
    const p = createRoamPlacement({ hc: lostReply, app: null, registry: createTerminalRegistry(h.stateRoot), hcBinary: h.f.hcBinary, stateRoot: h.stateRoot });
    await expect(p.reconcile([ready('box-1.invalid/t5')])).rejects.toThrow('reply lost');
    expect(await h.create(null).reconcile([ready('box-1.invalid/t5')])).toEqual({ pending: [] });
    let unsubscribe = () => {};
    const created = new Promise<void>(resolve => { unsubscribe = h.hc.events().subscribe(event => { if (event.type === 'created' && event.terminal === 't3') resolve(); }); });
    await expect(p.reconcile([ready('box-1.invalid/t6')])).rejects.toThrow('reply lost');
    await created; unsubscribe();
    expect(await h.create(null).reconcile([ready('box-1.invalid/t6')])).toEqual({ pending: [] });
    expect(await h.runs()).toHaveLength(2);
  } finally { await h.close(); }
}, 5000);


test('an uncertain launch with no observable proxy remains pending without retrying', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    const failed: HcClient = { ...h.hc, run: async () => { throw new Error('unknown outcome'); } };
    const p = createRoamPlacement({ hc: failed, app: null, registry: createTerminalRegistry(h.stateRoot), hcBinary: h.f.hcBinary, stateRoot: h.stateRoot });
    await expect(p.reconcile([ready('box-1.invalid/t5')])).rejects.toThrow('unknown outcome');
    expect(await h.create(null).reconcile([ready('box-1.invalid/t5')])).toEqual({ pending: ['box-1.invalid/t5'] });
    expect(await h.runs()).toEqual([]);
  } finally { await h.close(); }
}, 5000);


test('refuses a nonprivate state directory before writing lock files', async () => {
  const h = await fixture();
  try {
    await chmod(h.stateRoot, 0o755);
    await expect(rememberRoamSlot(h.stateRoot, 'session-1', slot)).rejects.toMatchObject({ code: 'unsafe-state-path' });
    expect(await readdir(h.stateRoot)).not.toContain('locks');
  } finally { await h.close(); }
}, 5000);


test('refuses a nonprivate existing lock directory before writing into it', async () => {
  const h = await fixture();
  try {
    const locks = join(h.stateRoot, 'locks');
    await mkdir(locks, { mode: 0o700 }); await chmod(locks, 0o755);
    await expect(rememberRoamSlot(h.stateRoot, 'session-1', slot)).rejects.toMatchObject({ code: 'unsafe-state-path' });
    expect(await readdir(locks)).toEqual([]);
  } finally { await h.close(); }
}, 5000);


test('closing a moved proxy keeps its last slot for the next terminal', async () => {
  const h = await fixture();
  try {
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    const layout = JSON.parse(await readFile(join(h.f.root, 'app.json'), 'utf8'));
    layout.spaces[0].tabs[0].terminals = layout.spaces[0].tabs[0].terminals.filter((row: { terminal: string }) => row.terminal !== 't2');
    layout.spaces.push({ id: 's2', tabs: [{ id: 'tb2', terminals: [{ terminal: 't2', pane: 'p2' }] }] });
    await h.hc.setLabels(h.f.address('t2'), { 'herdr.space': 's2', 'herdr.tab': 'tb2' });
    await writeFile(join(h.f.root, 'app.json'), JSON.stringify(layout));
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    layout.spaces[1].tabs[0].terminals = [];
    await h.hc.setLabels(h.f.address('t2'), { 'herdr.space': null, 'herdr.tab': null });
    await writeFile(join(h.f.root, 'app.json'), JSON.stringify(layout));
    await h.create().reconcile([ready('box-1.invalid/t6')]);
    expect((await h.runs())[1].argv).toEqual(expect.arrayContaining(['herdr.space=s2', 'herdr.tab=tb2']));
  } finally { await h.close(); }
}, 5000);


test('a newly observed local session terminal can update the remembered slot', async () => {
  const h = await fixture();
  try {
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    const core = JSON.parse(await readFile(join(h.f.root, 'core.json'), 'utf8'));
    core.terminals = core.terminals.filter((item: { address: string }) => item.address !== 't2');
    core.terminals.push({ address: 't4', parent: null, pid: process.pid, labels: {}, state: 'live', status: null, exit_code: null, reason: null, signal: null, finished_ms: null });
    await h.f.configure({ terminals: core.terminals });
    const owner = { sessionId: 'session-1', generation: 'g2', terminal: { coreId: 'local-core', terminalId: 't4', address: 't4', socket: h.f.localSocket, sessionNamespace: h.f.namespace }, cwd: '/work', sessionFile: null, name: null } as Owner;
    await h.registry.record({ owner, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: h.f.root, extensionArguments: [] } });
    const layout = JSON.parse(await readFile(join(h.f.root, 'app.json'), 'utf8'));
    layout.spaces[0].tabs[0].terminals = layout.spaces[0].tabs[0].terminals.filter((row: { terminal: string }) => row.terminal !== 't2');
    layout.spaces.push({ id: 's3', tabs: [{ id: 'tb3', terminals: [{ terminal: 't4', pane: 'p4' }] }] });
    await writeFile(join(h.f.root, 'app.json'), JSON.stringify(layout));
    await h.create().reconcile([ready('box-1.invalid/t6')]);
    expect((await h.runs())[1].argv).toEqual(expect.arrayContaining(['herdr.space=s3', 'herdr.tab=tb3']));
  } finally { await h.close(); }
}, 5000);


test('changing a routing alias does not reopen the same core terminal', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    await h.create(null).reconcile([ready('box-1.invalid/t5')]);
    await h.create(null).reconcile([ready('alias.invalid/t5')]);
    expect(await h.runs()).toHaveLength(1);
  } finally { await h.close(); }
}, 5000);


test('a restarted remote core can reuse a terminal ID', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    await h.create(null).reconcile([ready('box-1.invalid/t5')]);
    await h.create(null).reconcile([{ ...ready('box-1.invalid/t5'), core: 'new-remote-core' }]);
    expect(await h.runs()).toHaveLength(2);
  } finally { await h.close(); }
}, 5000);


test('a closed app adopts the labelled local proxy when it returns', async () => {
  const h = await fixture();
  try {
    await rememberRoamSlot(h.stateRoot, 'session-1', slot);
    await writeFile(join(h.f.root, 'scenario.json'), JSON.stringify({ appSteps: [{ argvPrefix: ['ls'], reply: { error: 'closed' } }] }));
    expect(await h.create().reconcile([ready('box-1.invalid/t5')])).toEqual({ pending: [] });
    expect(await h.runs()).toHaveLength(1);
    await writeFile(join(h.f.root, 'scenario.json'), '{}');
    expect(await h.app.ownerPlacement(h.f.address('t2'))).toMatchObject(slot);
    await h.create().reconcile([ready('box-1.invalid/t5')]);
    expect(await h.runs()).toHaveLength(1);
  } finally { await h.close(); }
}, 5000);


test('refuses symlinked state without changing the target', async () => {
  const h = await fixture();
  try {
    const target = join(h.f.root, 'outside.json');
    await writeFile(target, 'untouched', { mode: 0o600 });
    await symlink(target, join(h.stateRoot, 'roam-placement.json'));
    await expect(rememberRoamSlot(h.stateRoot, 'session-1', slot)).rejects.toMatchObject({ code: 'unsafe-state-path' });
    expect(await readFile(target, 'utf8')).toBe('untouched');
  } finally { await h.close(); }
}, 5000);
