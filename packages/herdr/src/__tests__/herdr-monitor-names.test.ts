// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { join } from 'node:path';
import { createViewerLauncher } from '../viewers/register.js';
import { openRemoteObserver, observerMarker } from '../jobs/observer.js';
import { ensureAgentConsole } from '../remote/console.js';
import type { HcClient, HcRunRequest, JobRecord, RuntimeTarget } from '../contracts.js';
import { bounded, cleanup, deferred, monitorFixture } from './herdr-monitor-fixture.js';

it('a viewer launches with its run display name and hc-safe alias', async () => {
  const h = await monitorFixture(), calls: HcRunRequest[] = [], run = h.hc.run;
  h.hc.run = async request => { calls.push(request); return run(request); };
  const launcher = createViewerLauncher({ hc: h.hc, owner: () => h.owner, ipcDescriptor: () => ({ version: 1, sessionId: h.owner.sessionId, generation: h.owner.generation, socket: 'fixture', token: 'token' } as never), viewerExecutable: 'viewer.mjs', feedRoot: h.f.root, runInfo: () => ({ name: 'Inspect output' }) });
  await launcher('run-one' as never, h.owner);
  expect(calls[0].labels['spider.display-name']).toBe('Inspect output');
  expect(calls[0].name).toMatch(/^[a-z0-9][a-z0-9_.-]{0,31}$/);
});

it('an observer launches with a machine and readable command name', async () => {
  const h = await monitorFixture(), calls: HcRunRequest[] = [];
  h.hc.run = async request => { calls.push(request); h.terminals.set('observer' as never, { address: 'observer' as never, parent: null, labels: request.labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null }); return { address: 'observer' as never, coreId: h.owner.terminal.coreId }; };
  h.hc.read = async () => observerMarker('nonce'); h.hc.fileRead = async () => Buffer.from(JSON.stringify({ argv: ['/bin/sh', '/runtime/script.sh'] }));
  const placement = { space: 's1', tab: 'tb1', pane: 'pane' } as never;
  const job: JobRecord = { version: 1, id: 'job-one' as never, owner: h.owner, machine: 'remote.invalid' as never, kind: 'exec', phase: { kind: 'waiting-for-pane', address: 'original' as never }, viewer: null, localDirectory: h.f.root, remoteDirectory: '/runtime', detached: false, notice: 'pending', noticeMode: 'tool' };
  const handle = await openRemoteObserver(job, { hc: h.hc, app: { tabTerminals: async () => [], ownerPlacement: async () => placement, command: async () => ({}), awaitPane: async () => 'pane' as never }, panes: { reserveRemote: async () => ({ id: 'slot' }), placement: () => placement, display: async () => ({ id: job.id, owner: h.owner, kind: 'remote', viewer: 'observer', pane: 'pane' }) as never, release: async () => {}, abandon: async () => {} } as never, viewerExecutable: ['viewer.mjs'], hcBinary: 'hc', nonce: 'nonce', deadlineAt: 10000, clock: () => 1000 }); cleanup(() => handle.release());
  expect(calls[0].labels['spider.display-name']).toBe('remote.invalid · sh script.sh');
  expect(calls[0].name).toMatch(/^[a-z0-9][a-z0-9_.-]{0,31}$/);
});

it('a slow optional command-name read does not delay or fail an observer launch', async () => {
  const h = await monitorFixture(), calls: HcRunRequest[] = [], metadata = deferred<Buffer>();
  h.hc.run = async request => { calls.push(request); h.terminals.set('observer' as never, { address: 'observer' as never, parent: null, labels: request.labels, state: 'live', status: null, exitCode: null, reason: null, signal: null, finishedAt: null }); return { address: 'observer' as never, coreId: h.owner.terminal.coreId }; };
  h.hc.read = async () => observerMarker('nonce'); h.hc.fileRead = () => metadata.promise;
  const placement = { space: 's1', tab: 'tb1', pane: 'pane' } as never;
  const job: JobRecord = { version: 1, id: 'job-one' as never, owner: h.owner, machine: 'remote.invalid' as never, kind: 'exec', phase: { kind: 'waiting-for-pane', address: 'original' as never }, viewer: null, localDirectory: h.f.root, remoteDirectory: '/runtime', detached: false, notice: 'pending', noticeMode: 'tool' };
  const opening = openRemoteObserver(job, { hc: h.hc, app: { tabTerminals: async () => [], ownerPlacement: async () => placement, command: async () => ({}), awaitPane: async () => 'pane' as never }, panes: { reserveRemote: async () => ({ id: 'slot' }), placement: () => placement, display: async () => ({ id: job.id, owner: h.owner, kind: 'remote', viewer: 'observer', pane: 'pane' }) as never, release: async () => {}, abandon: async () => {} } as never, viewerExecutable: ['viewer.mjs'], hcBinary: 'hc', nonce: 'nonce', deadlineAt: Date.now() + 5000, clock: Date.now });
  try { await bounded(opening, 700); expect(calls[0].labels['spider.display-name']).toBe('remote.invalid · exec'); }
  finally { metadata.resolve(Buffer.from(JSON.stringify({ argv: ['sh'] }))); const handle = await opening; await handle.release(); }
});

it('a console launches with agent @ machine while retaining its supervised identity', async () => {
  const h = await monitorFixture(), calls: HcRunRequest[] = [], run = h.hc.run, events = h.hc.events;
  let instance = '';
  h.hc.events = () => { const stream = events(); return { ...stream, subscribe: listener => { const off = stream.subscribe(listener); queueMicrotask(() => listener({ type: 'snapshot', seq: 0, terminals: [] })); return off; } }; };
  h.hc.fileRead = async (_on, path) => { if (path.endsWith('/heartbeat.json')) return Buffer.from(JSON.stringify({ version: 1, instance })); throw Object.assign(new Error('missing'), { code: 'not_found' }); };
  h.hc.run = async request => { calls.push(request); instance = request.argv.at(-1)!; return run(request); };
  const target: RuntimeTarget = { on: 'remote.invalid' as never, directory: join(h.f.root, 'runtime'), cwd: null, commands: {}, environment: {}, nodePath: 'node', runtimePath: 'runtime.mjs', runtimeSha256: '' };
  await ensureAgentConsole({ owner: { ...h.owner, sessionId: 'console-names' as never, name: 'Agent' }, on: target.on, target, source: { kind: 'code', language: 'shell', code: 'true' } }, h.hc, { HC_TERMINAL_ID: 'owner' });
  expect(calls[0].labels['spider.display-name']).toBe('Agent @ remote.invalid');
  expect(calls[0].name).toMatch(/^[a-z0-9][a-z0-9_.-]{0,31}$/);
  expect(calls[0].labels).toMatchObject({ 'spider.kind': 'remote-console', 'spider.machine': 'remote.invalid', 'spider.session': 'console-names' });
});
