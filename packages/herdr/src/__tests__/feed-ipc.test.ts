// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connect, createServer, Socket } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'vite';
import { processStartTime } from '../../../subagents/src/process-identity.js';
import { mkdir, readFile, rm, symlink, writeFile, stat, readdir, lstat, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createSessionIpcClient } from '../feed/ipc-client.js';
import { submitViewerSteer } from '../viewers/steering.js';
import { setTimeout as delay } from 'node:timers/promises';
import { HerdrError } from '../client/parse.js';
import { startSessionEndpoint, type SessionEndpointPorts } from '../feed/ipc-server.js';
import { publishSessionFeed, readPrivateText, coalesceFeedWrites, sweepSessionFeeds, atomicPrivateWrite } from '../feed/publisher.js';
import type { IpcDescriptor, Owner, RunCursor, RunId, RunViewFrame, SessionFeed, JobId } from '../contracts.js';
import { parseFeed } from '../../assets/shared/feed.js';
const globalRoot = resolve('.spider/scratch/h/ip'); const root = join(globalRoot, 'herdr');
const runId = 'run-a' as RunId;
const owner: Owner = { sessionId: 'session-a' as Owner['sessionId'], generation: 'generation-a' as Owner['generation'], terminal: { coreId: 'core-a' as Owner['terminal']['coreId'], terminalId: 't1' as Owner['terminal']['terminalId'], address: 't1' as Owner['terminal']['address'], socket: join(globalRoot, 'core.sock'), sessionNamespace: 'fixture' }, cwd: globalRoot, sessionFile: null, name: null };
function fixtureFeed(value: Owner = owner): SessionFeed {
  return { version: 1, sessionId: value.sessionId, generation: value.generation, revision: 1, updatedAt: 1234, owner: { ...value, terminal: { ...value.terminal } }, placement: null, lifecycle: 'live', status: { native: null, effective: null, message: null }, runs: { rows: [], total: 0, truncated: false }, todos: { rows: [], total: 0, truncated: false }, triggers: [], pace: { scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'unavailable' }, approvals: [], notifications: [], ipc: null, errors: [] };
}
function ports(steers: string[] = []): SessionEndpointPorts {
  return { currentOwner: () => owner, liveCapabilities: () => ({ native: 'done', effective: 'working' }), ownsRun: async id => id === runId,
    subscribeRun: () => ({ dispose() {} }), steerRun: (_id, text) => { steers.push(text); return { accepted: true, delivered: false, queued: false, delivery: 'accepted but not confirmed' }; }, openView() {}, openRun: () => 'viewer/t1' as Owner['terminal']['address'],
    ownsJob: id => id === 'job-a', openJob: () => 'observer/t1' as Owner['terminal']['address'] };
}
async function rawIpc(address: string, envelope: unknown): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = connect(address); let text = '';
    socket.once('error', reject);
    socket.on('data', data => { text += data.toString(); if (text.includes('\n')) { socket.destroy(); resolve(JSON.parse(text.split('\n')[0])); } });
    socket.once('connect', () => socket.write(JSON.stringify(envelope) + '\n'));
  });
}
async function envelope(descriptor: IpcDescriptor, request: unknown): Promise<unknown> { return { v: 1, capability: await readFile(descriptor.capabilityFile, 'utf8'), request }; }
beforeEach(async () => { await mkdir(globalRoot, { recursive: true }); vi.stubEnv('SPIDER_GLOBAL_ROOT', globalRoot); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(globalRoot, { recursive: true, force: true }); });
it('waits for a user-open placement that takes longer than the ordinary request deadline', async () => {
  const endpoint = await startSessionEndpoint(owner, { ...ports(), openRun: async () => { await delay(350); return 'viewer/t1' as Owner['terminal']['address']; } }, root);
  const original = Socket.prototype.setTimeout;
  const timers = vi.spyOn(Socket.prototype, 'setTimeout').mockImplementation(function (this: Socket, ms: number, callback?: () => void) {
    return original.call(this, ms ? ms / 100 : ms, callback);
  });
  const client = createSessionIpcClient(endpoint.descriptor);
  try { expect(await client.openRun(runId)).toMatchObject({ ok: true, op: 'openRun', viewer: 'viewer/t1' }); }
  finally { client.dispose(); timers.mockRestore(); await endpoint.dispose(); }
});
it('uses the explicitly configured integration root for IPC', async () => {
  const configured = join(globalRoot, 'c');
  const endpoint = await startSessionEndpoint(owner, ports(), configured);
  try { expect(endpoint.descriptor.address.startsWith(join(configured, 'ipc') + '/')).toBe(true); }
  finally { await endpoint.dispose(); }
});
it('removes refused sockets and their capabilities but retains a listening endpoint', async () => {
  const directory = join(root, 'ipc'); await mkdir(directory, { recursive: true });
  const abandoned = join(directory, 'abandoned.sock');
  const child = await import('node:child_process');
  const worker = child.spawn(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[1],()=>process.stdout.write("ready"));', abandoned], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => { worker.stdout.once('data', () => resolve()); worker.once('error', reject); });
  await writeFile(join(directory, 'abandoned.cap'), 'a'.repeat(64), { mode: 0o600 });
  worker.kill('SIGKILL'); await new Promise<void>(resolve => worker.once('exit', () => resolve()));
  const live = await startSessionEndpoint(owner, ports(), root);
  const nextOwner = { ...owner, sessionId: 'other-session' as Owner['sessionId'] };
  const next = await startSessionEndpoint(nextOwner, { ...ports(), currentOwner: () => nextOwner }, root);
  try {
    await expect(lstat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(directory, 'abandoned.cap'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await createSessionIpcClient(live.descriptor).ping()).ok).toBe(true);
  } finally { await next.dispose(); await live.dispose(); }
});
it('retains a live writer with an old heartbeat even before its endpoint is published', async () => {
  await publishSessionFeed(root, { ...fixtureFeed(), updatedAt: Date.now() - 7200000 });
  expect(await sweepSessionFeeds(root, { now: Date.now(), completedHours: 1 })).toMatchObject({ removed: 0 });
  expect(parseFeed(await readFile(join(root, 'sessions', owner.sessionId, 'session.json'), 'utf8'))?.generation).toBe(owner.generation);
});
it('bounds retention passes and preserves fresh feeds while removing old closed and dead feeds', async () => {
  const now = Date.now();
  for (const [id, lifecycle, updatedAt] of [['a', 'closed', now - 7200000], ['b', 'live', now - 7200000], ['c', 'live', now], ['d', 'closed', now - 7200000]] as const) {
    const feed = fixtureFeed({ ...owner, sessionId: id as Owner['sessionId'] });
    if (id === 'b') {
      const source = join(globalRoot, 'departed-publisher.ts');
      await writeFile(source, `import { publishSessionFeed } from ${JSON.stringify(resolve('packages/herdr/src/feed/publisher.ts'))};\nawait publishSessionFeed(process.argv[2], JSON.parse(process.argv[3]));\n`);
      await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: { ssr: source, outDir: globalRoot, emptyOutDir: false,
        rollupOptions: { external: id => id.startsWith('node:'), output: { entryFileNames: 'departed-publisher.mjs' } } } });
      // execFile completes only after the actual publisher exits; its writer record remains.
      await promisify(execFile)(process.execPath, [join(globalRoot, 'departed-publisher.mjs'), root, JSON.stringify({ ...feed, lifecycle, updatedAt })]);
    } else await atomicPrivateWrite(join(root, 'sessions', id, 'session.json'), JSON.stringify({ ...feed, lifecycle, updatedAt }));
  }
  const result = await sweepSessionFeeds(root, { now, completedHours: 1, maxEntries: 2 });
  expect(result.examined).toBeLessThanOrEqual(2); expect(result.removed).toBe(2);
  await sweepSessionFeeds(root, { now, completedHours: 1, maxEntries: 2 });
  expect(await readdir(join(root, 'sessions'))).toEqual(['c']);
});
it('retains an old live feed with no writer record because ownership is unknown', async () => {
  await publishSessionFeed(root, { ...fixtureFeed(), updatedAt: Date.now() - 7200000 });
  await rm(join(root, 'feed-writers', owner.sessionId + '.json'));
  const path = join(root, 'sessions', owner.sessionId, 'session.json'), before = await readFile(path);
  expect(await sweepSessionFeeds(root, { now: Date.now(), completedHours: 1 })).toMatchObject({ removed: 0 });
  expect(await readFile(path)).toEqual(before);
});
it('refuses a competing process before endpoint startup and reclaims its writer only after exit', async () => {
  const worker = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => { worker.stdout.once('data', () => resolve()); worker.once('error', reject); });
  const directory = join(root, 'feed-writers'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, owner.sessionId + '.json'), JSON.stringify({ pid: worker.pid, startIdentity: processStartTime(worker.pid!), generation: owner.generation }), { mode: 0o600 });
  try {
    await expect(publishSessionFeed(root, fixtureFeed())).rejects.toMatchObject({ code: 'feed-writer-occupied' });
    await expect(startSessionEndpoint(owner, ports(), root)).rejects.toMatchObject({ code: 'feed-writer-occupied' });
    await expect(lstat(join(root, 'sessions', owner.sessionId, 'session.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { worker.kill('SIGKILL'); await new Promise<void>(resolve => worker.once('exit', () => resolve())); }
  await publishSessionFeed(root, fixtureFeed());
  expect(parseFeed(await readFile(join(root, 'sessions', owner.sessionId, 'session.json'), 'utf8'))?.generation).toBe(owner.generation);
});
it('refuses a second live generation without overwriting its feed', async () => {
  const first = { ...fixtureFeed(), updatedAt: Date.now() }; await publishSessionFeed(root, first);
  const second = fixtureFeed({ ...owner, generation: 'second' as Owner['generation'] });
  await expect(publishSessionFeed(root, second)).rejects.toMatchObject({ code: 'feed-writer-occupied' });
  expect(parseFeed(await readFile(join(root, 'sessions', owner.sessionId, 'session.json'), 'utf8'))?.generation).toBe(owner.generation);
  await publishSessionFeed(root, { ...first, lifecycle: 'closed', revision: 2 });
  await publishSessionFeed(root, second);
  expect(parseFeed(await readFile(join(root, 'sessions', owner.sessionId, 'session.json'), 'utf8'))?.generation).toBe('second');
});
it('coalesces a burst into one active write and one trailing snapshot', async () => {
  let value = 0; const snapshots: number[] = []; const releases: (() => void)[] = [];
  const publish = coalesceFeedWrites(async () => {
    snapshots.push(value);
    await new Promise<void>(resolve => releases.push(resolve));
  });
  const first = publish(); await Promise.resolve();
  for (let i = 1; i <= 100; i++) { value = i; void publish(); }
  expect(snapshots).toEqual([0]);
  releases.shift()!(); await new Promise<void>(resolve => setImmediate(resolve));
  expect(snapshots).toEqual([0, 100]);
  releases.shift()!(); await first;
  value = 101; const next = publish(); await Promise.resolve(); releases.shift()!(); await next;
  expect(snapshots).toEqual([0, 100, 101]);
});
it('a failed coalesced write permits a later retry', async () => {
  let failed = true; const snapshots: string[] = [];
  const publish = coalesceFeedWrites(async () => { if (failed) throw new Error('unavailable'); snapshots.push('written'); });
  await expect(publish()).rejects.toThrow('unavailable');
  failed = false; await publish(); expect(snapshots).toEqual(['written']);
});
it.each(['size', 'version', 'symlink', 'unsafe-id'])('refuses an unsafe publication: %s', async boundary => {
  const feed = fixtureFeed();
  if (boundary === 'size') feed.errors.push({ source: 'fixture', message: 'x'.repeat(1024 * 1024) });
  if (boundary === 'version') Reflect.set(feed, 'version', 2);
  if (boundary === 'unsafe-id') { Reflect.set(feed, 'sessionId', '../escape'); Reflect.set(feed.owner, 'sessionId', '../escape'); }
  if (boundary === 'symlink') { await mkdir(root, { recursive: true }); await mkdir(join(globalRoot, 'outside')); await symlink(join(globalRoot, 'outside'), join(root, 'sessions')); }
  await expect(publishSessionFeed(root, feed)).rejects.toBeDefined();
});
it('bounds row lists without changing truthful totals or mutating the input', async () => {
  const feed = fixtureFeed(); feed.todos = { rows: Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, sessionId: owner.sessionId, text: 'x'.repeat(20000), done: false })), total: 100, truncated: false };
  await publishSessionFeed(root, feed); const text = await readFile(join(root, 'sessions', owner.sessionId, 'session.json'), 'utf8'); const parsed = parseFeed(text)!;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024 * 1024); expect(parsed.todos).toMatchObject({ total: 100, truncated: true });
  expect(parsed.todos.rows.length).toBeGreaterThan(0); expect(parsed.todos.rows.length).toBeLessThan(100); expect(feed.todos.rows).toHaveLength(100); expect(feed.todos.truncated).toBe(false);
});
it('publishes complete JSON with private modes during repeated replacement', async () => {
  await publishSessionFeed(root, fixtureFeed()); const path = join(root, 'sessions', owner.sessionId, 'session.json');
  expect((await stat(path)).mode & 0o777).toBe(0o600); expect((await stat(join(root, 'sessions', owner.sessionId))).mode & 0o777).toBe(0o700);
  const reader = async () => { for (let i = 0; i < 60; i++) expect(parseFeed(await readFile(path, 'utf8'))).not.toBeNull(); };
  const writer = async () => { for (let i = 2; i < 30; i++) await publishSessionFeed(root, { ...fixtureFeed(), revision: i, errors: [{ source: 'fixture', message: 'x'.repeat(60000) }] }); };
  await Promise.all([reader(), writer()]); expect(await readdir(join(root, 'sessions', owner.sessionId))).toEqual(['heartbeat.json', 'session.json']);
  expect((await stat(join(root, 'sessions', owner.sessionId, 'heartbeat.json'))).mode & 0o777).toBe(0o600);
});
it.each([
  ['capability', 'unauthorized'], ['version', 'unauthorized'], ['operation', 'unknown-op'], ['owner', 'refused'],
  ['steer-bytes', 'too-large'], ['blank', 'refused'], ['slash', 'refused'], ['frame-bytes', 'too-large'], ['cursor', 'unauthorized'],
] as const)('refuses invalid %s before calling an action', async (boundary, code) => {
  const steers: string[] = []; const endpoint = await startSessionEndpoint(owner, ports(steers), root);
  try {
    const request: Record<string, unknown> = { op: 'steerRun', generation: owner.generation, runId, text: 'hello' };
    const value = { v: 1, capability: await readFile(endpoint.descriptor.capabilityFile, 'utf8'), request };
    if (boundary === 'capability') value.capability = '0'.repeat(64);
    if (boundary === 'version') value.v = 2;
    if (boundary === 'operation') request.op = 'dispatch';
    if (boundary === 'owner') request.runId = 'foreign-run';
    if (boundary === 'steer-bytes') request.text = 'x'.repeat(16 * 1024 + 1);
    if (boundary === 'blank') request.text = '  ';
    if (boundary === 'slash') request.text = '/reload';
    if (boundary === 'frame-bytes') request.text = 'x'.repeat(256 * 1024);
    if (boundary === 'cursor') { request.op = 'subscribeRun'; request.cursor = { runId: 'foreign', seq: 1 }; }
    const reply = await rawIpc(endpoint.descriptor.address, value); expect(reply).toMatchObject({ ok: false, code }); expect(steers).toEqual([]);
    if (boundary === 'owner') expect(reply.reason).toBe('wrong-owner'); if (boundary === 'slash') expect(reply.reason).toBe('slash-prefixed');
  } finally { await endpoint.dispose(); }
});
it('authenticated ping returns the live instance status or its absence', async () => {
  const p = ports(); let live: ReturnType<SessionEndpointPorts['liveCapabilities']> = { native: 'done', effective: 'working' }; p.liveCapabilities = () => live;
  const endpoint = await startSessionEndpoint(owner, p, root); const client = createSessionIpcClient(endpoint.descriptor);
  try { expect(await client.ping()).toEqual({ ok: true, op: 'ping', status: live }); live = null; expect(await client.ping()).toMatchObject({ ok: false, code: 'status-instance-unavailable' }); }
  finally { client.dispose(); await endpoint.dispose(); }
});
it.each([
  [new HerdrError('remote-observer-unavailable', 'Failure at /fixture/private/output'), 'unavailable', 'remote-observer-unavailable'],
  [new HerdrError('too-large', 'Private detail at /fixture/private/output'), 'too-large', 'too-large'],
  [new Error('Secret detail at /fixture/private/output'), 'unavailable', 'Session action failed.'],
  [new HerdrError('/fixture/private/output', 'Secret detail'), 'unavailable', 'Session action failed.'],
] as const)('preserves safe typed action codes without leaking error details: %s', async (error, code, message) => {
  const p = ports(); p.openJob = () => { throw error; };
  const endpoint = await startSessionEndpoint(owner, p, root); const client = createSessionIpcClient(endpoint.descriptor);
  try {
    const reply = await client.request({ op: 'openJob', jobId: 'job-a' as JobId, generation: owner.generation });
    expect(reply).toEqual({ ok: false, code, message });
    expect(JSON.stringify(reply)).not.toContain('/fixture/private'); expect(JSON.stringify(reply)).not.toContain('Secret');
  } finally { client.dispose(); await endpoint.dispose(); }
});
it('viewer receives a definitive refused steer even after the host queue and answer budget', async () => {
  const cancel = new AbortController(); const p = ports();
  p.steerRun = async () => {
    await delay(21000, undefined, { signal: cancel.signal }).catch(() => {});
    return { accepted: false, delivered: false, queued: false, delivery: 'refused', error: 'Not sent: earlier steer did not finish.' };
  };
  const endpoint = await startSessionEndpoint(owner, p, root); const client = createSessionIpcClient(endpoint.descriptor);
  try {
    expect(await submitViewerSteer(client, runId, 'next case')).toEqual({ accepted: false, delivered: false, queued: false, delivery: 'refused', error: 'Not sent: earlier steer did not finish.' });
  } finally { cancel.abort(); client.dispose(); await endpoint.dispose(); }
}, 28000);
it('client preserves actual steering refusals and dispatches view and run openers', async () => {
  const p = ports(); const view = vi.fn(); const openRun = vi.fn(p.openRun); p.openView = view; p.openRun = openRun;
  const endpoint = await startSessionEndpoint(owner, p, root); const client = createSessionIpcClient(endpoint.descriptor);
  try {
    expect(await client.steerRun(runId, 'hello')).toEqual({ ok: true, op: 'steerRun', acknowledgement: { accepted: true, delivered: false, queued: false, delivery: 'accepted but not confirmed' } });
    p.steerRun = () => ({ accepted: false, delivered: false, queued: false, delivery: 'refused', error: 'Child finished during submission.' });
    expect(await client.steerRun(runId, 'raced')).toEqual({ ok: true, op: 'steerRun', acknowledgement: { accepted: false, delivered: false, queued: false, delivery: 'refused', error: 'Child finished during submission.' } });
    expect(await client.openView('todos')).toEqual({ ok: true, op: 'openView' }); expect(view).toHaveBeenCalledWith('todos');
    expect(await client.openRun(runId)).toEqual({ ok: true, op: 'openRun', viewer: 'viewer/t1' }); expect(openRun).toHaveBeenCalledWith(runId);
    expect(await client.openRun('foreign' as RunId)).toMatchObject({ ok: false, code: 'not-found' }); expect(openRun).toHaveBeenCalledTimes(1);
    expect(await client.request({ op: 'openJob', jobId: 'job-a' as JobId, generation: owner.generation })).toEqual({ ok: true, op: 'openJob', viewer: 'observer/t1' });
    expect(await client.request({ op: 'openJob', jobId: 'foreign-job' as JobId, generation: owner.generation })).toMatchObject({ ok: false, code: 'not-found' });
  } finally { client.dispose(); await endpoint.dispose(); }
});
it('opens only a journal-owned job through its injected observer opener', async () => {
  const p = ports(); const openJob = vi.fn(p.openJob); p.openJob = openJob;
  const endpoint = await startSessionEndpoint(owner, p, root); const client = createSessionIpcClient(endpoint.descriptor);
  try {
    expect(await client.request({ op: 'openJob', jobId: 'job-a' as JobId, generation: owner.generation })).toEqual({ ok: true, op: 'openJob', viewer: 'observer/t1' });
    expect(openJob).toHaveBeenCalledWith('job-a');
    expect(await client.request({ op: 'openJob', jobId: 'foreign-job' as JobId, generation: owner.generation })).toMatchObject({ ok: false, code: 'not-found' });
    expect(openJob).toHaveBeenCalledTimes(1);
  } finally { client.dispose(); await endpoint.dispose(); }
});
it('reports not-found if a run loses ownership between the ownership check and subscription', async () => {
  const p = ports(); p.subscribeRun = () => { throw Object.assign(new Error('Run no longer owned'), { code: 'run-not-owned' }); };
  const endpoint = await startSessionEndpoint(owner, p, root); const client = createSessionIpcClient(endpoint.descriptor);
  try { await expect(client.subscribeRun(runId, null, () => {})).rejects.toMatchObject({ code: 'not-found' }); }
  finally { client.dispose(); await endpoint.dispose(); }
});
it('streams committed pages by cursor without replaying an earlier page', async () => {
  const p = ports(); const release = vi.fn();
  p.subscribeRun = (id, cursor, emit) => {
    expect(cursor).toBe('after-4');
    emit({ runId: id, cursor: 'after-5' as RunCursor, kind: 'event', data: { text: 'new text', events: [{ runId: id, id: 5, type: 'assistant', text: 'new text' }] } });
    emit({ runId: id, cursor: 'after-5' as RunCursor, kind: 'end', data: { reason: 'finished' } }); return { dispose: release };
  };
  const endpoint = await startSessionEndpoint(owner, p, root); const client = createSessionIpcClient(endpoint.descriptor); const frames: RunViewFrame[] = [];
  let finish!: () => void; const finished = new Promise<void>(resolve => { finish = resolve; });
  try { const subscription = await client.subscribeRun(runId, 'after-4' as RunCursor, frame => { frames.push(frame); if (frame.kind === 'end') finish(); }); await finished; await subscription.closed;
    expect(frames).toMatchObject([{ kind: 'event', cursor: 'after-5', data: { text: 'new text' } }, { kind: 'end', data: { reason: 'finished' } }]);
  } finally { client.dispose(); await endpoint.dispose(); }
  expect(release).toHaveBeenCalledTimes(1);
});
it.each(['pending-output', 'transcript-page'])('ends %s overflow instead of sending partial or unbounded JSON', async boundary => {
  const p = ports(); const release = vi.fn();
  p.subscribeRun = (id, _cursor, emit) => {
    if (boundary === 'pending-output') for (let i = 1; i <= 100; i++) emit({ runId: id, cursor: `c${i}` as RunCursor, kind: 'event', data: { text: 'x'.repeat(60 * 1024), events: [] } });
    else emit({ runId: id, cursor: 'oversize' as RunCursor, kind: 'event', data: { text: 'x'.repeat(64 * 1024), events: [] } });
    return { dispose: release };
  };
  const endpoint = await startSessionEndpoint(owner, p, root); const client = createSessionIpcClient(endpoint.descriptor); const frames: RunViewFrame[] = [];
  try { const subscription = await client.subscribeRun(runId, null, frame => frames.push(frame)); await subscription.closed;
    expect(frames).toEqual([{ runId, cursor: boundary === 'pending-output' ? 'c18' : 'oversize', kind: 'gap', data: { reason: boundary === 'pending-output' ? 'backpressure' : 'transcript-page-too-large' } }, { runId, cursor: boundary === 'pending-output' ? 'c18' : 'oversize', kind: 'end', data: { reason: 'overflow' } }]); }
  finally { client.dispose(); await endpoint.dispose(); }
  expect(release).toHaveBeenCalledTimes(1);
});
it.each(['silent-server-close', 'client-dispose'])('stream closed resolves once without requiring an end frame: %s', async reason => {
  const address = join(globalRoot, 'silent.sock'); const capabilityFile = join(globalRoot, 'silent.cap'); await writeFile(capabilityFile, 'a'.repeat(64), { mode: 0o600 });
  const connected = new Set<Socket>();
  const server = createServer(socket => {
    connected.add(socket); socket.on('error', () => {}); socket.once('close', () => connected.delete(socket));
    socket.once('data', () => { socket.write(JSON.stringify({ runId, cursor: 'first' as RunCursor, kind: 'gap', data: { reason: 'initial' } } satisfies RunViewFrame) + '\n'); if (reason === 'silent-server-close') setImmediate(() => socket.end()); });
  });
  await new Promise<void>(resolve => server.listen(address, resolve)); await chmod(address, 0o600);
  const client = createSessionIpcClient({ version: 1, sessionId: owner.sessionId, generation: owner.generation, address, capabilityFile }); const frames: RunViewFrame[] = [];
  try {
    const subscription = await client.subscribeRun(runId, null, frame => frames.push(frame));
    expect(subscription).toHaveProperty('closed');
    if (reason === 'client-dispose') subscription.dispose();
    await subscription.closed;
    expect(frames).toEqual([{ runId, cursor: 'first', kind: 'gap', data: { reason: 'initial' } }]);
    subscription.dispose(); await subscription.closed;
  } finally { client.dispose(); for (const socket of connected) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
it('buffers split UTF-8 JSON until LF without performing a partial action', async () => {
  const steers: string[] = []; const endpoint = await startSessionEndpoint(owner, ports(steers), root);
  try {
    const payload = Buffer.from(JSON.stringify(await envelope(endpoint.descriptor, { op: 'steerRun', generation: owner.generation, runId, text: 'café' })) + '\n'); const cut = payload.indexOf(Buffer.from('é')) + 1;
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = connect(endpoint.descriptor.address); let pending = ''; socket.once('error', reject);
      socket.on('data', bytes => { pending += bytes.toString(); if (pending.includes('\n')) { socket.destroy(); resolve(JSON.parse(pending.split('\n')[0])); } });
      socket.once('connect', () => { socket.write(payload.subarray(0, cut)); setImmediate(() => { expect(steers).toEqual([]); socket.write(payload.subarray(cut)); }); });
    });
    expect(reply.ok).toBe(true); expect(steers).toEqual(['café']);
  } finally { await endpoint.dispose(); }
});
it('refuses symlink capability files, missing files, and disposed generations', async () => {
  const endpoint = await startSessionEndpoint(owner, ports(), root); const client = createSessionIpcClient(endpoint.descriptor);
  const foreign = join(globalRoot, 'foreign.cap'); await writeFile(foreign, '0'.repeat(64), { mode: 0o600 });
  try {
    await rm(endpoint.descriptor.capabilityFile); await symlink(foreign, endpoint.descriptor.capabilityFile); await expect(client.ping()).rejects.toMatchObject({ code: 'symlink-refused' });
    await rm(endpoint.descriptor.capabilityFile); await expect(client.ping()).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readPrivateText(join(globalRoot, 'absent.json'), 1024)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { client.dispose(); await endpoint.dispose(); }
  await expect(lstat(endpoint.descriptor.address)).rejects.toMatchObject({ code: 'ENOENT' });
  const nextOwner = { ...owner, generation: 'new-generation' as Owner['generation'] };
  const next = await startSessionEndpoint(nextOwner, { ...ports(), currentOwner: () => nextOwner }, root);
  try { expect(next.descriptor.address).not.toBe(endpoint.descriptor.address); await expect(createSessionIpcClient(endpoint.descriptor).ping()).rejects.toMatchObject({ code: 'ENOENT' }); }
  finally { await next.dispose(); }
});
it('rejects a foreign generation without steering or partial JSON', async () => {
  const steers: string[] = []; const endpoint = await startSessionEndpoint(owner, ports(steers), root);
  try {
    const reply = await rawIpc(endpoint.descriptor.address, await envelope(endpoint.descriptor, { op: 'steerRun', runId, text: 'Use the smaller case', generation: 'foreign' }));
    expect(reply).toMatchObject({ ok: false, code: 'wrong-generation' }); expect(steers).toEqual([]);
    await publishSessionFeed(root, fixtureFeed()); expect(parseFeed(await readFile(join(root, 'sessions', owner.sessionId, 'session.json'), 'utf8'))).toMatchObject({ version: 1, sessionId: owner.sessionId });
  } finally { await endpoint.dispose(); }
});
