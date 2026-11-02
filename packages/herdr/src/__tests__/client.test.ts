// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, test, expect } from 'vitest';
import { parseHerdrConfig } from '../config.js';
import type { MachineName, CoreId, HcRunRequest } from '../contracts.js';
import { createHcClient } from '../client/hc.js';
import { createClientFixture, terminal, type ClientFixture } from './testutil.js';
const fixtures: ClientFixture[] = [];
afterEach(async () => { for (const h of fixtures.splice(0)) await h.close(); });
async function fixture(): Promise<ClientFixture> { const h = await createClientFixture(); fixtures.push(h); return h; }
test('preserves the isolated caller and rejects a foreign socket', async () => {
  const h = await fixture();
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
  expect(await client.identity()).toMatchObject({ sessionNamespace: h.namespace, socket: h.localSocket });
  expect(await client.caller(h.localEnv)).toMatchObject({ terminalId: 't1', coreId: 'local-core', address: 't1' });
  await expect(client.caller({ ...h.localEnv, HC_TERMINAL_SOCKET: h.foreignSocket })).rejects.toMatchObject({ code: 'caller-mismatch' });
  const calls = await h.calls();
  expect(calls.every(c => c.env.HC_SESSION === 'fl' && c.env.HC_TERMINAL_ID === 't1' && c.env.HC_TERMINAL_SOCKET === h.localSocket)).toBe(true);
});

test('decodes a reply split inside a UTF-8 character', async () => {
  const h = await fixture(); const reply = JSON.stringify({ core: { id: 'café' }, version: '0.1.16' });
  await h.configure({ reply, split: Buffer.from(reply).indexOf(0xc3) + 1 });
  expect((await createHcClient({ binary: h.hcBinary, env: h.localEnv }).identity()).coreId).toBe('café');
});
test('preserves structured nonzero CLI errors separately from stdout', async () => {
  const h = await fixture(); await h.configure({ failure: { kind: 'blocked', message: 'Needs approval', hint: 'Review it' } });
  await expect(createHcClient({ binary: h.hcBinary, env: h.localEnv }).identity()).rejects.toMatchObject({ code: 'blocked', message: 'Needs approval', details: { exitCode: 7, hint: 'Review it' } });
});
test('bounds stdout and stderr before retaining a reply', async () => {
  const h = await fixture(); await h.configure({ reply: 'x'.repeat(10000) });
  await expect(createHcClient({ binary: h.hcBinary, env: h.localEnv, maxReplyBytes: 64 }).identity()).rejects.toMatchObject({ code: 'reply-too-large' });
});
test('reports missing hc without launching anything else', async () => {
  const h = await fixture();
  await expect(createHcClient({ binary: h.root + '/missing', env: h.localEnv }).identity()).rejects.toMatchObject({ code: 'missing-hc' });
  expect(await h.calls()).toEqual([]);
});
test('keeps two independent core namespaces and immutable caller environments', async () => {
  const a = await fixture(), b = await fixture();
  b.localEnv.HC_SESSION = 'fr'; b.localEnv.HC_SOCKET = b.localEnv.HC_TERMINAL_SOCKET = b.root + '/s/herdr-core/fr/fr.sock';
  await b.listenCore(b.localEnv.HC_TERMINAL_SOCKET);
  await b.configure({ coreId: 'remote-core' });
  const client = createHcClient({ binary: b.hcBinary, env: b.localEnv }); b.localEnv.HC_SESSION = 'changed';
  expect(await client.identity()).toMatchObject({ coreId: 'remote-core', sessionNamespace: 'fr' });
  expect((await createHcClient({ binary: a.hcBinary, env: a.localEnv }).identity()).coreId).toBe('local-core');
});
test('rejects malformed replies and arbitrary program status strings', async () => {
  const h = await fixture(); await h.configure({ terminals: [{ ...terminal('t1'), status: { state: 'success' } }] });
  await expect(createHcClient({ binary: h.hcBinary, env: h.localEnv }).get(h.address('t1'))).rejects.toMatchObject({ code: 'invalid-reply' });
  await h.configure({ reply: '{' });
  await expect(createHcClient({ binary: h.hcBinary, env: h.localEnv }).identity()).rejects.toMatchObject({ code: 'invalid-reply' });
});

const machine = { id: 'remote-core', name: 'remote.invalid', host: 'REMOTE.EXAMPLE.invalid', target: 'user@Remote.Example.invalid', version: '0.1.16', session: 'fr', via: false };
test('routes exact remote argv without a parent or destination cwd guess', async () => {
  const h = await fixture(); await h.configure({ machines: [machine] });
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
  const handle = await client.run({ argv: ['node', "a 'quoted' value"], cwd: null, on: 'remote.invalid' as MachineName, labels: { 'spider.job': 'j1' }, outliveParent: true, background: true, noNotify: true });
  expect(handle).toEqual({ address: 'remote.invalid/t2', coreId: 'remote-core' });
  const launch = (await h.calls()).find(c => c.argv[0] === 'run')!;
  expect(launch.argv).toEqual(['run', '--json', '--bg', '--no-notify', '--outlive-parent', '--on', 'remote.invalid', '--label', 'spider.job=j1', '--', 'node', "a 'quoted' value"]);
  await client.kill(handle.address); expect((await client.get(handle.address)).reason).toBe('killed');
  await client.rm(handle.address); await expect(client.get(handle.address)).rejects.toMatchObject({ code: 'not_found' });
});
test('always suppresses native launch notices despite an untyped request flag', async () => {
  const h = await fixture();
  const request: HcRunRequest = { argv: ['node', '-e', 'process.exit(0)'], cwd: null, labels: {}, outliveParent: false, background: true, noNotify: true };
  Reflect.set(request, 'noNotify', false);
  await createHcClient({ binary: h.hcBinary, env: h.localEnv }).run(request);
  expect((await h.calls()).find(c => c.argv[0] === 'run')?.argv).toContain('--no-notify');
});

test('normalizes machine aliases and refuses missing machines before file or run mutation', async () => {
  const h = await fixture(); await h.configure({ machines: [machine] });
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
  expect(await client.machines()).toMatchObject([{ id: 'remote-core', name: 'remote.invalid', aliases: ['remote.invalid', 'remote.example.invalid'], sessionNamespace: 'fr' }]);
  await expect(client.fileWrite('missing.invalid' as MachineName, '/file', Buffer.from('x'))).rejects.toMatchObject({ code: 'machine-not-found' });
  expect((await h.calls()).filter(c => c.argv[0] === 'file')).toEqual([]);
});
test('transfers UTF-8 file contents independently of terminal history', async () => {
  const h = await fixture(); await h.configure({ machines: [machine] });
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
  await client.fileWrite('remote.invalid' as MachineName, '/files/chunk.json', Buffer.from('α\nsecond\n'));
  expect((await client.fileRead('remote.invalid' as MachineName, '/files/chunk.json')).toString('utf8')).toBe('α\nsecond\n');
});
test('events yields the parsed initial snapshot and notifications through one subscriber', async () => {
  const h = await fixture(); const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
  const stream = client.events();
  try {
    await stream.ready;
    expect(await stream.lookup(h.address('t1'))).toMatchObject({ address: 't1', state: 'live' });
    const event = new Promise(resolve => stream.subscribe(event => { if (event.type === 'status') resolve(event); }));
    await h.emitCore({ jsonrpc: '2.0', method: 'event', params: { type: 'status', seq: 1, terminal: 't1', data: { status: { state: 'working', msg: 'busy' } } } });
    expect(await event).toMatchObject({ type: 'status', seq: 1 });
    expect(await stream.lookup(h.address('t1'))).toMatchObject({ status: { state: 'working' }, state: 'live', exitCode: null });
    expect(client.events()).not.toBe(stream);
    expect((await h.calls()).filter(call => call.argv[0] === 'events').map(call => call.argv)).toEqual([['events', '--json']]);
  } finally { await client.dispose(); }
});
test('rejects relative configuration roots and supplies only generic defaults', () => {
  const value = { app: { binary: '/bin/app', home: '/app' }, core: { binary: '/bin/hc', config: '/core' }, agentDirectory: '/agent', globalRoot: '/global', shellRc: '/shell', spaces: [], machines: [] };
  expect(parseHerdrConfig(value)).toMatchObject({ enabled: 'auto', limits: { auxiliaryPanes: 2 }, retention: { foregroundDays: 7 } });
  expect(() => parseHerdrConfig({ ...value, globalRoot: 'relative' })).toThrow();
  expect(() => parseHerdrConfig({ ...value, limits: { auxiliaryPanes: 7 } })).toThrow();
});

test('rejects changed selected-core identity', async () => {
  const h = await fixture(); const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
  await client.identity(); await h.configure({ coreId: 'replaced-core' });
  await expect(client.identity()).rejects.toMatchObject({ code: 'core-mismatch' });
});
test('rejects unsupported hc versions', async () => {
  const h = await fixture();
  await h.configure({ reply: JSON.stringify({ core: { id: 'core' }, version: '0.1.15' }) });
  await expect(createHcClient({ binary: h.hcBinary, env: h.localEnv }).identity()).rejects.toMatchObject({ code: 'unsupported-version' });
});
test('rejects a foreign terminal reply', async () => {
  const h = await fixture(); const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
  await h.configure({ reply: JSON.stringify(terminal('foreign/t1')) });
  await expect(client.get(h.address('t1'))).rejects.toMatchObject({ code: 'caller-mismatch' });
});

test('accepts the native machine-list envelope', async () => {
  const h = await fixture(); await h.configure({ reply: JSON.stringify({ machines: [machine] }) });
  expect(await createHcClient({ binary: h.hcBinary, env: h.localEnv }).machines()).toMatchObject([{ name: 'remote.invalid', id: 'remote-core' }]);
});

test('a multi-core isolation proof pins the core at the selected socket', async () => {
  const h = await fixture();
  const isolationProof = { checkout: process.cwd(), sessionNamespace: h.namespace,
    sockets: [h.foreignSocket, h.localSocket], coreIds: ['unused-core' as CoreId, 'foreign-core' as CoreId] };
  await expect(Promise.resolve().then(() => createHcClient({ binary: h.hcBinary, env: h.localEnv, isolationProof }).identity())).rejects.toMatchObject({ code: 'core-mismatch' });
});

test('sets and removes canonical labels using separate hc argv entries', async () => {
  const h = await fixture(); await h.configure({ reply: '{}' });
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
  expect(typeof client.setLabels).toBe('function');
  await client.setLabels(h.address('t1'), { 'herdr.space': 'space with spaces', 'herdr.tab': null });
  expect((await h.calls()).map(c => c.argv)).toEqual([
    ['label', 't1', 'herdr.space=space with spaces', 'herdr.tab=', '--json'],
  ]);
});

const invalidLabelMaps: Readonly<Record<string, string | null>>[] = [{ 'unknown.key': 'value' }, {}];
test.each(invalidLabelMaps)('refuses invalid or empty label maps before any hc call %#', async labels => {
  const h = await fixture(); const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
  await expect(Promise.resolve().then(() => client.setLabels(h.address('t1'), labels))).rejects.toMatchObject({ code: 'invalid-labels' });
  expect(await h.calls()).toEqual([]);
});

test('setLabels preserves a nonzero hc exit as a typed error', async () => {
  const h = await fixture(); await h.configure({ failure: { kind: 'not_found', message: 'No such terminal' }, failureExitCode: 3 });
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
  await expect(Promise.resolve().then(() => client.setLabels(h.address('missing.invalid'), { 'herdr.space': 'space' }))).rejects.toMatchObject({ code: 'not_found', details: { exitCode: 3 } });
  expect((await h.calls()).map(c => c.argv)).toEqual([['label', 'missing.invalid', 'herdr.space=space', '--json']]);
});

test('an isolation proof pins the selected core identity', async () => {
  const h = await fixture();
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv, isolationProof: { checkout: process.cwd(), sockets: [h.localSocket], sessionNamespace: h.namespace, coreIds: ['foreign-core' as CoreId] } });
  await expect(client.identity()).rejects.toMatchObject({ code: 'core-mismatch' });
});
