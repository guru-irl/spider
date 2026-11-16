// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { beforeEach, expect, test, vi } from 'vitest';
import { invokeCli } from '../client/hc.js';
import { parsePaneTerminal, parseMachineChoices, parsePaneTarget, parsePaneServiceRequest, parsePaneServiceReply, parseRemotePaneRequest, parseRemotePaneReply, parseConsoleId, encodePaneServiceRequest, encodePaneServiceReply, encodeRemotePaneRequest, encodeRemotePaneReply } from '../panes/codec.js';
import { readPaneTerminal } from '../panes/hc.js';
import { readAppPaneCapabilities } from '../panes/capabilities.js';
import type { CoreIdentity, CoreId } from '../contracts.js';
vi.mock('../client/hc.js', () => ({ invokeCli: vi.fn() }));
const local: CoreIdentity = { coreId: 'core-local' as CoreId, socket: '/owned/core.sock', sessionNamespace: 'test' };
const terminalFixture = { address: 'core-remote/t7', parent: null, labels: { 'spider.session': 'session-1' }, state: 'live', status: { state: 'working' }, exit_code: null, reason: null, signal: null, finished_ms: null, created_ms: 17, title: 'Example', app: 'pi' };
const targetFixture = { coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', createdMs: 17, identityLabels: { 'spider.session': 'session-1' }, alias: 'box-1.invalid', machineId: 'machine-1', kind: 'session', sessionId: 'session-1', generation: 'gen-1', homeEpoch: 2, runId: null, consoleId: null, name: 'Example', cwd: '/home/example/work' };
const intent = { operationId: 'operation-1', space: 'space-1', place: 'tab', anchor: null, program: { kind: 'shell' } };
const commands = (modern: boolean) => [{ name: 'tab.new', args: [{ name: 'space', required: false }, ...(modern ? [{ name: 'focus', required: false }] : [])], about: '' }, { name: 'pane.swap', args: modern ? [{ name: 'pane', required: false }, { name: 'target', required: false }] : [{ name: 'direction', required: true }], about: '' }];
beforeEach(() => vi.mocked(invokeCli).mockReset());
test('pane cwd comes from the foreground not the starting folder', () => {
  expect(parsePaneTerminal({ ...terminalFixture, cwd: '/home/example/start', foreground: { pid: 7, name: 'sh', argv: ['sh'], cwd: '/home/example/work' } }).currentCwd).toBe('/home/example/work');
});
test('missing or unavailable foreground cwd is null', () => {
  for (const foreground of [undefined, null, {}, { cwd: null }]) expect(parsePaneTerminal({ ...terminalFixture, cwd: '/home/example/start', foreground }).currentCwd).toBeNull();
});
test('remote Windows cwd remains a foreign absolute path', () => {
  for (const cwd of ['C:\\work\\project', '\\\\server.invalid\\share\\project', '/home/example/work']) expect(parsePaneTerminal({ ...terminalFixture, foreground: { cwd } }).currentCwd).toBe(cwd);
});
test('disconnected configured machine remains a disabled choice', () => {
  const choices = parseMachineChoices({ machines: [] }, ['box-1.invalid'], local);
  expect(choices[0]).toMatchObject({ alias: null, label: 'This computer', coreId: 'core-local' });
  expect(choices[1]).toMatchObject({ key: 'box-1.invalid', state: 'disconnected', coreId: null });
});
test('connected machine without identity refuses', () => {
  expect(() => parseMachineChoices({ machines: [{ name: 'box-1.invalid', state: 'connected', id: null }] }, ['box-1.invalid'], local)).toThrow();
});
test('machine aliases resolve once and ambiguous mappings refuse', () => {
  const row = { name: 'route-1.invalid', aliases: ['box-1.invalid'], id: 'core-remote', machine_id: 'machine-1', state: 'connected' };
  expect(parseMachineChoices({ machines: [row] }, ['box-1.invalid'], local)[1]).toMatchObject({ key: 'box-1.invalid', alias: 'box-1.invalid', coreId: 'core-remote', machineId: 'machine-1' });
  expect(() => parseMachineChoices({ machines: [row, { ...row, id: 'core-other' }] }, ['box-1.invalid'], local)).toThrow();
});
test('qualified get never falls back locally', async () => {
  vi.mocked(invokeCli).mockResolvedValueOnce({ version: '0.1.18', core: { id: 'core-local' } }).mockResolvedValueOnce(terminalFixture);
  expect((await readPaneTerminal(parsePaneTarget(targetFixture), { binary: '/owned/hc', env: { HC_SOCKET: local.socket } })).createdMs).toBe(17);
  expect(vi.mocked(invokeCli).mock.calls[1][1]).toContain('core-remote/t7');
  expect(vi.mocked(invokeCli).mock.calls.filter(c => c[1].includes('t7'))).toEqual([]);
  vi.mocked(invokeCli).mockClear().mockResolvedValueOnce({ version: '0.1.18', core: { id: 'core-local' } }).mockRejectedValueOnce(new Error('unreachable'));
  await expect(readPaneTerminal(parsePaneTarget(targetFixture), { binary: '/owned/hc', env: { HC_SOCKET: local.socket } })).rejects.toThrow('unreachable');
  expect(vi.mocked(invokeCli).mock.calls.filter(c => c[1][0] === 'get').map(c => c[1])).toEqual([['get', 'core-remote/t7', '--json']]);
});
test('get refuses successor incarnation or ownership labels', async () => {
  for (const changed of [{ ...terminalFixture, created_ms: 18 }, { ...terminalFixture, labels: {} }, { ...terminalFixture, address: 'core-other/t7' }]) {
    vi.mocked(invokeCli).mockResolvedValueOnce({ version: '0.1.18', core: { id: 'core-local' } }).mockResolvedValueOnce(changed);
    await expect(readPaneTerminal(parsePaneTarget(targetFixture), { binary: '/owned/hc', env: { HC_SOCKET: local.socket } })).rejects.toThrow();
  }
});
test('background tab capability depends on command fields not version', () => {
  expect(readAppPaneCapabilities({ version: '0.1.16', commands: commands(true) })).toMatchObject({ backgroundTabCreation: true, explicitTargetSwap: true, noFocusConversion: false });
  expect(readAppPaneCapabilities({ version: '0.1.13', commands: commands(false) }).backgroundTabCreation).toBe(false);
  expect(readAppPaneCapabilities({ version: '9.9.9', commands: commands(true) })).toEqual(readAppPaneCapabilities(commands(true)));
  expect(readAppPaneCapabilities(commands(false)).backgroundTabCreation).toBe(false);
  expect(readAppPaneCapabilities(null)).toMatchObject({ backgroundTabCreation: false, explicitTargetSwap: false, noFocusConversion: false });
  expect(readAppPaneCapabilities([...commands(true)].reverse()).commandDigest).toBe(readAppPaneCapabilities(commands(true)).commandDigest);
});
test('control characters malformed ids and relative folders refuse', () => {
  for (const cwd of ['relative', 'C:relative', '\\relative', '/ok\nno', '/ok\x1bno']) expect(() => parsePaneTerminal({ ...terminalFixture, foreground: { cwd } })).toThrow();
  for (const value of [{ ...targetFixture, coreId: '../core' }, { ...targetFixture, terminalId: 't7\n' }, { ...targetFixture, address: 'box-1.invalid/t7' }, { ...targetFixture, cwd: 'relative' }, { ...targetFixture, kind: 'subagent', runId: null }, { ...targetFixture, kind: 'console', consoleId: null }, { ...targetFixture, sessionId: null }]) expect(() => parsePaneTarget(value)).toThrow();
  expect(() => parseConsoleId('../console')).toThrow();
  expect(parseConsoleId('console-' + '1'.repeat(64))).toBe('console-' + '1'.repeat(64));
  expect(() => parseConsoleId('console-1')).toThrow();
});
test('legacy null generation displays but cannot authorize close', () => {
  const legacy = parsePaneTarget({ ...targetFixture, generation: null });
  expect(legacy.generation).toBeNull();
  expect(() => parsePaneServiceRequest({ version: 1, operationId: 'operation-1', op: 'close-confirmed', presentationId: 'pane-1', expectedRevision: 1, target: legacy })).toThrow();
});
test('every remote request survives serialization and unknown fields grant no authority', () => {
  const common = { version: 1, sessionId: 'session-1', generation: 'gen-1' };
  const requests = [{ version: 1, op: 'handshake', protocol: 1, buildDigest: 'a'.repeat(64) }, { version: 1, op: 'list', cursor: null }, { version: 1, op: 'locate-folder', cwd: 'C:\\work' }, { version: 1, op: 'resolve-folder', repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' }, { ...common, op: 'launch-viewer', runId: 'run-1', leaseId: 'lease-1' }, { version: 1, op: 'renew-viewers', leases: [{ leaseId: 'lease-1', generation: 'gen-1' }] }, { version: 1, op: 'stop-viewer', leaseId: 'lease-1' }, { ...common, op: 'open-console', machineKey: 'box-1.invalid', consoleId: ('console-' + '1'.repeat(64)) as never, leaseId: 'lease-1' }, { ...common, op: 'close-session', homeEpoch: 2, operationId: 'operation-1' }];
  for (const request of requests) expect(parseRemotePaneRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
  expect(() => parseRemotePaneRequest({ ...requests[1], version: 2 })).toThrow();
  expect(() => parseRemotePaneRequest({ ...requests[1], argv: ['kill'] })).toThrow();
  expect(() => parseRemotePaneRequest({ ...requests[3], relativeCwd: '../escape' })).toThrow();
});
test('service mutations are revision or creation bound', () => {
  const base = { version: 1, operationId: 'operation-1' };
  const bound = { ...base, presentationId: 'pane-1', expectedRevision: 1 };
  const requests = [{ ...base, op: 'snapshot' }, { ...base, op: 'open', intent, machineKey: 'box-1.invalid', coreId: 'core-remote', machineId: null }, { ...base, op: 'open-existing', sessionId: 'session-1', generation: 'gen-1', slot: null }, { ...base, op: 'open-auxiliary', sessionId: 'session-1', generation: 'gen-1', view: { kind: 'subagent', runId: 'run-1' } }, { ...bound, op: 'move', slot: { space: 'space-1', tab: 'tab-1', pane: null } }, { ...bound, op: 'park' }, { ...bound, op: 'close-confirmed', target: targetFixture }, { ...bound, op: 'prepare-handoff', sessionId: 'session-1', generation: 'gen-1', homeEpoch: 2 }, { ...bound, op: 'present-ready', target: targetFixture }];
  for (const request of requests) expect(parsePaneServiceRequest(request)).toEqual(request);
  expect(() => parsePaneServiceRequest({ ...requests[1], coreId: undefined })).toThrow();
  expect(() => parsePaneServiceRequest({ ...requests[1], machineId: undefined })).toThrow();
  expect(() => parsePaneServiceRequest({ ...bound, op: 'park', expectedRevision: undefined })).toThrow();
  expect(() => parsePaneServiceRequest({ ...requests[1], intent: { ...intent, operationId: 'other' } })).toThrow();
});
test('auxiliary requests accept optional automatic or explicit mode without changing legacy requests', () => {
  const request = { version: 1, operationId: 'aux-1', op: 'open-auxiliary', sessionId: 'session-1', generation: 'gen-1', view: { kind: 'subagent', runId: 'run-1' } };
  expect(parsePaneServiceRequest(request)).toEqual(request);
  for (const mode of ['automatic', 'explicit']) {
    const parsed = parsePaneServiceRequest({ ...request, mode });
    expect(parsed).toEqual({ ...request, mode });
    expect(JSON.parse(encodePaneServiceRequest(parsed))).toEqual({ ...request, mode });
  }
  for (const mode of [null, undefined, '', 'other', true, 1, {}]) expect(() => parsePaneServiceRequest({ ...request, mode })).toThrow();
  expect(() => parsePaneServiceRequest({ ...request, origin: 'automatic' })).toThrow();
});

test('reply codecs retain typed inventory and folder distinctions but reject capability descriptors', () => {
  const row = { sessionId: 'session-1', generation: 'gen-1', name: 'Example', owner: null, target: null, status: 'working', updatedAt: 1, machineKey: 'box-1.invalid', unavailableReason: 'not-in-hc', children: [], consoles: [] };
  const reply = { version: 1, op: 'list', page: { version: 1, rows: [row], next: null, complete: true } };
  expect(parseRemotePaneReply(reply)).toEqual(reply);
  expect(() => parseRemotePaneReply({ ...reply, page: { ...reply.page, rows: [{ ...row, ipc: { capabilityFile: '/secret' } }] } })).toThrow();
  for (const result of [{ status: 'no-mapping', cwd: null, exists: null }, { status: 'unavailable', cwd: null, exists: null }, { status: 'missing', cwd: '/home/example/removed', exists: false }, { status: 'mapped', cwd: '/home/example/work', exists: true }]) expect(parseRemotePaneReply({ version: 1, op: 'resolve-folder', result })).toEqual({ version: 1, op: 'resolve-folder', result });
  const snapshot = { version: 1, kind: 'snapshot', complete: true, omittedRows: 0, revision: 1, machines: [], presentations: [], rows: [], targetFacts: {} };
  expect(parsePaneServiceReply(snapshot)).toEqual(snapshot);
  const facts = parsePaneTerminal({ ...terminalFixture, foreground: { cwd: '/home/example/work' } });
  expect(parsePaneServiceReply({ ...snapshot, targetFacts: { 'core-remote/t7': facts } })).toEqual({ ...snapshot, targetFacts: { 'core-remote/t7': facts } });
  expect(() => parseRemotePaneReply({ ...reply, page: { ...reply.page, rows: Array(257).fill(row) } })).toThrow();
});
test('all source reply variants and encoded protocols survive serialization', () => {
  const target = parsePaneTarget(targetFixture);
  const outcome = { status: 'complete' as const, reason: '', presentation: null };
  const replies = [{ version: 1, op: 'handshake', protocol: 1, buildDigest: 'a'.repeat(64) }, { version: 1, op: 'locate-folder', folder: { repoKey: 'repo-1', workspaceId: 'workspace-1', relativeCwd: 'src' }, unavailable: false }, { version: 1, op: 'launch-viewer', target }, { version: 1, op: 'open-console', target }, { version: 1, op: 'renew-viewers', outcome }, { version: 1, op: 'stop-viewer', outcome }, { version: 1, op: 'close-session', outcome }];
  for (const reply of replies) expect(JSON.parse(encodeRemotePaneReply(parseRemotePaneReply(reply)))).toEqual(reply);
  const request = parsePaneServiceRequest({ version: 1, operationId: 'operation-1', op: 'snapshot' });
  expect(JSON.parse(encodePaneServiceRequest(request))).toEqual(request);
  const reply = parsePaneServiceReply({ version: 1, kind: 'outcome', outcome });
  expect(JSON.parse(encodePaneServiceReply(reply))).toEqual(reply);
  const remote = parseRemotePaneRequest({ version: 1, op: 'list', cursor: null });
  expect(JSON.parse(encodeRemotePaneRequest(remote))).toEqual(remote);
});
test('display-only rows allow no generation but never carry source authority', () => {
  const row = { sessionId: 'session-ssh', generation: null, name: 'Builder', owner: null, target: null, status: 'working', updatedAt: 1, machineKey: 'box-1.invalid', unavailableReason: 'not-in-hc', children: [], consoles: [] };
  const reply = (candidate: unknown) => ({ version: 1, op: 'list', page: { version: 1, rows: [candidate], next: null, complete: true } });
  expect(parseRemotePaneReply(reply(row))).toEqual(reply(row));
  expect(() => parseRemotePaneReply(reply({ ...row, unavailableReason: null }))).toThrow();
  expect(() => parseRemotePaneReply(reply({ ...row, owner: { sessionId: 'session-ssh' } }))).toThrow();
  expect(() => parseRemotePaneReply(reply({ ...row, target: targetFixture }))).toThrow();
  expect(() => parseRemotePaneReply(reply({ ...row, children: [{ runId: 'run-1', name: null, status: 'working' }] }))).toThrow();
  expect(() => parseRemotePaneReply(reply({ ...row, consoles: [targetFixture] }))).toThrow();
});
test('display-only rows cannot authorize open move close or view requests', () => {
  const base = { version: 1, operationId: 'operation-1' };
  expect(() => parsePaneServiceRequest({ ...base, op: 'open-existing', sessionId: 'session-ssh', generation: null, slot: null })).toThrow();
  expect(() => parsePaneServiceRequest({ ...base, op: 'open-auxiliary', sessionId: 'session-ssh', generation: null, view: { kind: 'subagent', runId: 'run-1' } })).toThrow();
  expect(() => parsePaneServiceRequest({ ...base, op: 'move', presentationId: null, expectedRevision: 0, slot: { space: 'space-1', tab: 'tab-1', pane: null } })).toThrow();
  expect(() => parsePaneServiceRequest({ ...base, op: 'close-confirmed', presentationId: null, expectedRevision: 0, target: null })).toThrow();
});
test('source inventory preserves foreign owner facts but rejects mismatched session generations', () => {
  const target = parsePaneTarget(targetFixture);
  const owner = { sessionId: 'session-1', generation: 'gen-1', terminal: { coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', socket: '/source/core.sock', sessionNamespace: 'test' }, cwd: 'C:\\work', sessionFile: 'C:\\sessions\\example.jsonl', name: 'Example' };
  const row = { sessionId: 'session-1', generation: 'gen-1', name: 'Example', owner, target, status: 'working', updatedAt: 1, machineKey: 'box-1.invalid', unavailableReason: null, children: [], consoles: [] };
  const reply = { version: 1, op: 'list', page: { version: 1, rows: [row], next: null, complete: true } };
  expect(parseRemotePaneReply(reply)).toEqual(reply);
  expect(() => parseRemotePaneReply({ ...reply, page: { ...reply.page, rows: [{ ...row, generation: 'gen-2' }] } })).toThrow();
});

test('parked shell reopening requires revision and target incarnation', () => {
  const request = { version: 1, op: 'open-existing', operationId: 'reopen-1', presentationId: 'pane-1', expectedRevision: 1, targetIncarnation: { coreId: 'core-remote', terminalId: 't7', createdMs: 17 } };
  expect(parsePaneServiceRequest(request)).toEqual(request);
  expect(() => parsePaneServiceRequest({ ...request, expectedRevision: undefined })).toThrow();
  expect(() => parsePaneServiceRequest({ ...request, targetIncarnation: undefined })).toThrow();
});

test('display snapshot metadata is bounded and complete snapshots omit nothing', () => {
  const snapshot = { version: 1, kind: 'snapshot', revision: 1, machines: [], presentations: [], rows: [], targetFacts: {}, complete: false, omittedRows: 12 };
  expect(parsePaneServiceReply(snapshot)).toEqual(snapshot);
  for (const omittedRows of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '12']) expect(() => parsePaneServiceReply({ ...snapshot, omittedRows })).toThrow();
  expect(() => parsePaneServiceReply({ ...snapshot, complete: true })).toThrow();
  expect(() => parsePaneServiceReply({ ...snapshot, complete: 'false' })).toThrow();
  expect(parsePaneServiceReply({ ...snapshot, complete: true, omittedRows: 0 })).toMatchObject({ complete: true, omittedRows: 0 });
});

test('retained and open console descriptors parse without invented terminal identity', () => {
  const consoleId = 'console-' + 'a'.repeat(64);
  const owner = { sessionId: 'session-1', generation: 'gen-1', terminal: { coreId: 'core-remote', terminalId: 't7', address: 'core-remote/t7', socket: '/home/example/core.sock', sessionNamespace: 'fixture' }, cwd: '/home/example', sessionFile: null, name: 'Example' };
  const target = { ...targetFixture, kind: 'console', consoleId };
  const row = { sessionId: 'session-1', generation: 'gen-1', name: 'Example', owner, target: targetFixture, status: 'working', updatedAt: 1, machineKey: 'box-1.invalid', unavailableReason: null, children: [], consoles: [] };
  const reply = (console: unknown) => ({ version: 1, op: 'list', page: { version: 1, rows: [{ ...row, consoles: [console] }], next: null, complete: true } });
  for (const live of [null, target]) {
    const console = { consoleId, machineKey: 'box-1.invalid', name: 'Output', target: live };
    expect(parseRemotePaneReply(reply(console))).toMatchObject({ page: { rows: [{ consoles: [console] }] } });
  }
  const console = { consoleId, machineKey: 'box-1.invalid', name: 'Output', target: null };
  for (const bad of [{ ...console, consoleId: 'chosen-by-client' }, { ...console, target: targetFixture }, { ...console, target: { ...target, consoleId: 'console-' + 'b'.repeat(64) } }, { ...console, target: { ...target, sessionId: 'another-session' } }]) expect(() => parseRemotePaneReply(reply(bad))).toThrow();
});
