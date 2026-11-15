// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { closeAgentConsoles, registerAgentConsoleLifecycle } from '../remote/console.js';
import { createJobHandoff } from '../jobs/handoff.js';
import { createJobStore } from '../jobs/store.js';
import type { HcClient, HcEvent, MachineName, RunId } from '../contracts.js';

const harnesses: HerdrHarness[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) { await h.close(); expect(await h.remainingOwnedResources()).toEqual([]); } });

it('rechecks a console when the run finishes during an earlier liveness check', async () => {
  const h = await createHerdrHarness('fake'); harnesses.push(h); await h.start();
  const callbacks = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => { callbacks.set(name, handler); return () => callbacks.delete(name); } } as unknown as ExtensionAPI;
  let notifyRunEnd: (run: RunId) => void = () => {};
  let releaseCheck!: () => void, checkStarted!: () => void, observedSnapshot!: () => void;
  const held = new Promise<void>(resolve => { releaseCheck = resolve; });
  const checking = new Promise<void>(resolve => { checkStarted = resolve; });
  const snapshot = new Promise<void>(resolve => { observedSnapshot = resolve; });
  let running = true, calls = 0, watchSnapshot = false;
  const hc: HcClient = { ...h.hc, events() {
    const source = h.hc.events();
    return { ...source, subscribe: listener => source.subscribe(event => { listener(event); if (watchSnapshot && event.type === 'snapshot') observedSnapshot(); }) };
  } };
  const life = registerAgentConsoleLifecycle(pi, { hc, env: h.localEnv, currentOwner: () => h.owner, ownerIsLive: async () => true,
    runIsLive: async () => { const result = running; if (++calls === 1) { checkStarted(); await held; } return result; },
    subscribeRunEnds: (_owner, listener) => { notifyRunEnd = listener; return () => {}; },
  });
  try {
    await callbacks.get('session_start')!({ reason: 'startup' }, {} as ExtensionContext);
    const run = 'race-run' as RunId, owner = h.owner!;
    const terminal = await h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as MachineName,
      labels: { 'spider.kind': 'remote-console', 'spider.session': owner.sessionId, 'spider.machine': 'remote.invalid', 'spider.owner-core': owner.terminal.coreId, 'spider.owner-terminal': owner.terminal.terminalId, 'spider.run': run }, noNotify: true, background: true, outliveParent: true });
    await checking;
    running = false; watchSnapshot = true; notifyRunEnd(run); await snapshot; releaseCheck();
    await expect.poll(async () => { try { await h.hc.get(terminal.address); return false; } catch (error) { if ((error as { code?: string }).code === 'not_found') return true; throw error; } }, { timeout: 8000 }).toBe(true);
  } finally { releaseCheck(); life.dispose(); }
}, 30000);

it('retries closing an ended run console after the machine reconnects without closing other terminals', async () => {
  const h = await createHerdrHarness('fake'); harnesses.push(h); await h.start();
  const callbacks = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => { callbacks.set(name, handler); return () => callbacks.delete(name); } } as unknown as ExtensionAPI;
  let notifyRunEnd: (run: RunId) => void = () => {};
  let online = false, running = true, deliver: (event: HcEvent) => void = () => {};
  let subscriptions = 0;
  const errors: unknown[] = [];
  const hc: HcClient = { ...h.hc,
    events: () => { const stream = h.hc.events(); return { ...stream, subscribe: listener => { if (++subscriptions === 1) deliver = listener; return stream.subscribe(listener); } }; },
    machines: async () => (await h.hc.machines()).map(machine => online ? machine : { ...machine, state: 'disconnected' }),
    get: async address => {
      if (!online && address.startsWith('remote.invalid/')) throw Object.assign(new Error('machine unavailable'), { code: 'not_found' });
      return h.hc.get(address);
    },
  };
  const life = registerAgentConsoleLifecycle(pi, { hc, env: h.localEnv, currentOwner: () => h.owner, ownerIsLive: async () => true,
    runIsLive: async () => running, subscribeRunEnds: (_owner, listener) => { notifyRunEnd = listener; return () => {}; }, reportCleanupError: error => errors.push(error),
  });
  try {
    await callbacks.get('session_start')!({ reason: 'startup' }, {} as ExtensionContext);
    const run = 'retry-run' as RunId, owner = h.owner!;
    const launch = (kind: string) => h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as MachineName,
      labels: { 'spider.kind': kind, 'spider.session': owner.sessionId, 'spider.machine': 'remote.invalid', 'spider.owner-core': owner.terminal.coreId, 'spider.owner-terminal': owner.terminal.terminalId, 'spider.run': run }, noNotify: true, background: true, outliveParent: true });
    const console = await launch('remote-console'), unrelated = await launch('exec');
    running = false; notifyRunEnd(run);
    await expect.poll(() => errors.length, { timeout: 8000 }).toBeGreaterThan(0);
    expect((await h.hc.get(console.address)).state).toBe('live');
    online = true; deliver({ type: 'missed', seq: 100, terminals: [] });
    await expect.poll(async () => { try { await h.hc.get(console.address); return false; } catch (error) { if ((error as { code?: string }).code === 'not_found') return true; throw error; } }, { timeout: 3500, interval: 50 }).toBe(true);
    expect((await h.hc.get(unrelated.address)).state).toBe('live');
  } finally { life.dispose(); }
}, 10000);

it.each(['unavailable', 'not_found'] as const)('the journal handoff retries a real ended-run close after %s', async failure => {
  const h = await createHerdrHarness('fake'); harnesses.push(h); await h.start();
  const owner = h.owner!, run = 'handoff-retry-run' as RunId;
  const launch = (kind: string) => h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as MachineName,
    labels: { 'spider.kind': kind, 'spider.session': owner.sessionId, 'spider.machine': 'remote.invalid', 'spider.run': run }, noNotify: true, background: true, outliveParent: true });
  const console = await launch('remote-console'), unrelated = await launch('exec');
  const store = createJobStore(h.root, owner.sessionId, run), journal = await store.read();
  journal.child = { id: run, pid: process.pid, startIdentity: 'ended', ended: true, settled: false };
  await store.write(journal);
  let online = false; const errors: unknown[] = [];
  const hc: HcClient = { ...h.hc,
    machines: async () => (await h.hc.machines()).map(machine => online ? machine : { ...machine, state: 'disconnected' }),
    get: async address => { if (!online && address === console.address) throw Object.assign(new Error('machine unavailable'), failure === 'not_found' ? { code: 'not_found' } : {}); return h.hc.get(address); },
  };
  const handoff = createJobHandoff({ root: h.root, owner, hc, adopt: async () => { throw new Error('A settled run must not be adopted'); }, reportError: error => errors.push(error) });
  try {
    await handoff.reconcile();
    expect(errors).toHaveLength(1);
    expect((await h.hc.get(console.address)).state).toBe('live');
    expect((await store.read()).child?.settled).toBe(false);
    online = true; await handoff.reconcile();
    await expect(h.hc.get(console.address)).rejects.toMatchObject({ code: 'not_found' });
    expect((await store.read()).child?.settled).toBe(true);
    expect((await h.hc.get(unrelated.address)).state).toBe('live');
  } finally { await handoff.shutdown('reload'); }
}, 30000);

it('confirms a missing console after the machine reconnects', async () => {
  const h = await createHerdrHarness('fake'); harnesses.push(h); await h.start();
  const owner = h.owner!, run = 'vanished-retry-run' as RunId;
  const console = await h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as MachineName,
    labels: { 'spider.kind': 'remote-console', 'spider.session': owner.sessionId, 'spider.machine': 'remote.invalid', 'spider.run': run }, noNotify: true, background: true, outliveParent: true });
  const store = createJobStore(h.root, owner.sessionId, run), journal = await store.read();
  journal.child = { id: run, pid: process.pid, startIdentity: 'ended', ended: true, settled: false }; await store.write(journal);
  const lastKnown = await h.hc.get(console.address);
  let online = false;
  const hc: HcClient = { ...h.hc,
    events: () => { const stream = h.hc.events(); return { ...stream, subscribe: listener => stream.subscribe(event => listener(online && (event.type === 'snapshot' || event.type === 'missed') ? { ...event, terminals: [...event.terminals, lastKnown] } : event)) }; },
    machines: async () => (await h.hc.machines()).map(machine => ({ ...machine, state: online ? 'connected' : 'disconnected' })),
    get: async address => { if (!online && address === console.address) throw Object.assign(new Error('missing while offline'), { code: 'not_found' }); return h.hc.get(address); },
  };
  const handoff = createJobHandoff({ root: h.root, owner, hc, adopt: async () => { throw new Error('A settled run must not be adopted'); } });
  try {
    await handoff.reconcile(); expect((await store.read()).child?.settled).toBe(false);
    await h.hc.kill(console.address); await h.hc.rm(console.address);
    online = true; await handoff.reconcile();
    expect((await store.read()).child?.settled).toBe(true);
  } finally { await handoff.shutdown('reload'); }
}, 30000);

it('does not close a terminal whose console label changes after inventory', async () => {
  const h = await createHerdrHarness('fake'); harnesses.push(h); await h.start();
  const owner = h.owner!, run = 'relabelled-run' as RunId;
  const terminal = await h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as MachineName,
    labels: { 'spider.kind': 'remote-console', 'spider.session': owner.sessionId, 'spider.machine': 'remote.invalid', 'spider.run': run }, noNotify: true, background: true, outliveParent: true });
  const hc: HcClient = { ...h.hc, get: async address => ({ ...await h.hc.get(address), labels: { ...(await h.hc.get(address)).labels, 'spider.kind': 'exec' } }) };
  await closeAgentConsoles({ ...owner, runId: run }, hc);
  const surviving = await h.hc.get(terminal.address).catch(error => { if ((error as { code?: string }).code === 'not_found') return null; throw error; });
  expect(surviving?.state).toBe('live');
}, 30000);

it('reconstructs ended-run console cleanup on reload without closing a live run', async () => {
  const h = await createHerdrHarness('fake'); harnesses.push(h); await h.start();
  const callbacks = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => { callbacks.set(name, handler); return () => callbacks.delete(name); } } as unknown as ExtensionAPI;
  const owner = h.owner!;
  const launch = (run: string) => h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as MachineName,
    labels: { 'spider.kind': 'remote-console', 'spider.session': owner.sessionId, 'spider.machine': 'remote.invalid', 'spider.owner-core': owner.terminal.coreId, 'spider.owner-terminal': owner.terminal.terminalId, 'spider.run': run }, noNotify: true, background: true, outliveParent: true });
  const ended = await launch('ended-after-reload'), live = await launch('live-after-reload');
  const life = registerAgentConsoleLifecycle(pi, { hc: h.hc, env: h.localEnv, currentOwner: () => h.owner, ownerIsLive: async () => true,
    runIsLive: async terminal => terminal.labels['spider.run'] === 'live-after-reload' });
  try {
    await callbacks.get('session_start')!({ reason: 'reload' }, {} as ExtensionContext);
    await expect.poll(async () => { try { await h.hc.get(ended.address); return false; } catch (error) { if ((error as { code?: string }).code === 'not_found') return true; throw error; } }, { timeout: 3000 }).toBe(true);
    expect((await h.hc.get(live.address)).state).toBe('live');
  } finally { life.dispose(); }
}, 30000);

it('reaps a finished run console recovered in a missed-event snapshot', async () => {
  const h = await createHerdrHarness('fake'); harnesses.push(h); await h.start();
  const callbacks = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => { callbacks.set(name, handler); return () => callbacks.delete(name); } } as unknown as ExtensionAPI;
  let notifyRunEnd: (run: RunId) => void = () => {}, deliver: (event: HcEvent) => void = () => {};
  let snapshotSeen!: () => void, waiting = false, subscriptions = 0;
  const snapshot = new Promise<void>(resolve => { snapshotSeen = resolve; });
  const hc: HcClient = { ...h.hc, events() {
    const source = h.hc.events();
    return { ...source, subscribe: listener => {
      if (++subscriptions === 1) deliver = listener;
      return source.subscribe(event => {
        if (event.type !== 'created') listener(event);
        if (waiting && event.type === 'snapshot') snapshotSeen();
      });
    } };
  } };
  const life = registerAgentConsoleLifecycle(pi, { hc, env: h.localEnv, currentOwner: () => h.owner, ownerIsLive: async () => true,
    runIsLive: async () => false, subscribeRunEnds: (_owner, listener) => { notifyRunEnd = listener; return () => {}; },
  });
  try {
    await callbacks.get('session_start')!({ reason: 'startup' }, {} as ExtensionContext);
    const run = 'missed-run' as RunId, owner = h.owner!;
    waiting = true; notifyRunEnd(run); await snapshot;
    const terminal = await h.hc.run({ argv: [h.nodeBinary, '-e', 'setInterval(()=>{},1000)'], cwd: null, on: 'remote.invalid' as MachineName,
      labels: { 'spider.kind': 'remote-console', 'spider.session': owner.sessionId, 'spider.machine': 'remote.invalid', 'spider.owner-core': owner.terminal.coreId, 'spider.owner-terminal': owner.terminal.terminalId, 'spider.run': run }, noNotify: true, background: true, outliveParent: true });
    deliver({ type: 'missed', seq: 100, terminals: [await h.hc.get(terminal.address)] });
    await expect.poll(async () => { try { await h.hc.get(terminal.address); return false; } catch (error) { if ((error as { code?: string }).code === 'not_found') return true; throw error; } }, { timeout: 8000 }).toBe(true);
  } finally { life.dispose(); }
}, 30000);
