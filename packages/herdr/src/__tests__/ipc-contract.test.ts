// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import * as contracts from '../contracts.js';
import * as foundation from '../index.js';
import type { Generation, RunId, SessionId } from '../contracts.js';

const generation = 'generation' as Generation;
const runId = 'run' as RunId;
const descriptor = { version: 1 as const, sessionId: 'session' as SessionId, generation, address: '/owned.sock', capabilityFile: '/owned.capability' };
const capability = 'a'.repeat(64);
const ping = { op: 'ping' as const, generation };
const event = { runId, id: 1, type: 'assistant', text: 'Hello' };
const cursor = 'opaque-position' as contracts.RunCursor;
const page = { text: 'Hello', events: [event] };
const run: contracts.RunSummary = { id: runId, ownerSessionId: 'session' as SessionId, name: null, status: 'done', childMode: 'rpc', canSteer: false, startedAt: 1, finishedAt: 100, viewer: null, result: 'Finished' };
const json = JSON.stringify;

test('the foundation entrypoint exports the IPC builder and decoders as values', () => {
  for (const name of ['panelIpcArgv', 'parsePanelIpcArgv', 'parseSessionIpcRequest', 'parseSessionIpcEnvelope', 'parseSessionIpcReply', 'parseRunViewFrame'] as const) {
    expect(foundation[name]).toBe(contracts[name]);
  }
});

const requests: contracts.SessionIpcRequest[] = [ping,
  { op: 'openView', view: 'usage', generation },
  { op: 'openRun', runId, generation },
  { op: 'steerRun', runId, text: 'Use a smaller case', generation },
  { op: 'subscribeRun', runId, cursor: null, generation },
  { op: 'subscribeRun', runId, cursor, generation },
];

test.each(requests)('panel IPC argv round-trips $op without a capability secret', request => {
  const argv = contracts.panelIpcArgv('node', '/cli.mjs', descriptor, request);
  expect(argv).toEqual(['node', '/cli.mjs', 'ipc', '--descriptor', json(descriptor), '--request', json(request)]);
  expect(contracts.parsePanelIpcArgv(argv)).toEqual({ nodePath: 'node', cliPath: '/cli.mjs', descriptor, request });
  expect(argv.some(arg => arg.includes(capability))).toBe(false);
});

test('the argv parser rejects malformed flags, descriptors and requests', () => {
  const valid = ['node', '/cli.mjs', 'ipc', '--descriptor', json(descriptor), '--request', json(ping)];
  expect(contracts.parsePanelIpcArgv(valid.slice(1))).toBeNull();
  expect(contracts.parsePanelIpcArgv([...valid, 'extra'])).toBeNull();
  expect(contracts.parsePanelIpcArgv(valid.map((v, i) => i === 3 ? '--capability' : v))).toBeNull();
  expect(contracts.parsePanelIpcArgv(valid.map((v, i) => i === 4 ? json({ ...descriptor, version: 2 }) : v))).toBeNull();
  expect(contracts.parsePanelIpcArgv(valid.map((v, i) => i === 6 ? '{}' : v))).toBeNull();
});

test.each(requests)('decodes authenticated $op envelopes and requests', request => {
  expect(contracts.parseSessionIpcRequest(json(request))).toEqual(request);
  const envelope = { v: 1, capability, request };
  expect(contracts.parseSessionIpcEnvelope(json(envelope))).toEqual(envelope);
});

test.each([
  { ...ping, generation: undefined }, { ...ping, op: 'feed-list' },
  { op: 'openView', generation, view: 'editor' },
  { op: 'subscribeRun', generation, runId, cursor: { runId: 'foreign', seq: 1 } },
  { op: 'subscribeRun', generation, runId, cursor: '' },
])('rejects invalid request %#', request => {
  expect(contracts.parseSessionIpcRequest(json(request))).toBeNull();
});

test('rejects invalid envelope versions and capabilities', () => {
  for (const value of [{ v: 2, capability, request: ping }, { v: 1, capability: 'short', request: ping }, { v: 1, capability: 'x'.repeat(64), request: ping }]) {
    expect(contracts.parseSessionIpcEnvelope(json(value))).toBeNull();
  }
});

const replies: contracts.SessionIpcReply[] = [
  { ok: true, op: 'ping', status: { native: null, effective: 'working' } },
  { ok: true, op: 'openView' },
  { ok: true, op: 'openRun', viewer: 'viewer' as contracts.TerminalAddress },
  { ok: true, op: 'steerRun', acknowledgement: { delivery: 'accepted but not confirmed', accepted: true, delivered: false, queued: true } },
  { ok: true, op: 'steerRun', acknowledgement: { delivery: 'delivered', accepted: true, delivered: true, queued: false } },
  { ok: false, code: 'wrong-generation', message: 'Generation changed' },
  { ok: false, code: 'not-found', message: 'Unknown or foreign run' },
  { ok: false, code: 'status-instance-unavailable', message: 'No live instance' },
  { ok: false, code: 'refused', message: 'Cannot steer', reason: 'dead-pipe' },
];
test.each(replies)('decodes reply %#', reply => {
  expect(contracts.parseSessionIpcReply(json(reply))).toEqual(reply);
});
test('rejects unknown replies, states and refusal reasons', () => {
  for (const reply of [
    { ok: true, op: 'ping', status: { native: 'complete', effective: null } },
    { ok: true, op: 'steerRun', acknowledgement: { delivery: 'queued', accepted: true, delivered: false, queued: true } },
    { ok: true, op: 'openRun', viewer: null },
    { ok: true, op: 'openView', reason: 'paused' },
    { ok: false, code: 'wrong-generation', message: 'Wrong', reason: 'paused' },
    { ok: false, code: 'refused', message: 'Wrong', reason: 'unknown' },
    { ok: false, code: 'unknown', message: 'Wrong' },
  ]) expect(contracts.parseSessionIpcReply(json(reply))).toBeNull();
});

const frames: contracts.RunViewFrame[] = [
  { runId, cursor, kind: 'event', data: page }, { runId, cursor, kind: 'snapshot', data: { run } },
  { runId, cursor, kind: 'gap', data: { reason: 'rotated' } }, { runId, cursor, kind: 'end', data: { reason: 'overflow' } },
];
test.each(frames)('decodes streamed frame $kind', frame => {
  expect(contracts.parseRunViewFrame(json(frame))).toEqual(frame);
});
test('rejects malformed frames and foreign page events', () => {
  for (const frame of [
    { runId, cursor, kind: 'event', data: { ...page, events: [{ ...event, runId: 'foreign' }] } },
    { runId, cursor, kind: 'event', data: { ...page, events: [{ ...event, id: -1 }] } },
    { runId, cursor, kind: 'event', data: { ...page, events: [{ ...event, type: 1 }] } },
    { runId, cursor, kind: 'snapshot', data: { run: { ...run, status: 'unknown' } } },
    { runId, cursor, kind: 'end', data: { reason: 'unknown' } },
  ]) expect(contracts.parseRunViewFrame(json(frame))).toBeNull();
});

test('enforces the 16 KiB steer limit in UTF-8 bytes, including envelopes', () => {
  const request = { op: 'steerRun', runId, generation, text: 'é'.repeat(8192) };
  expect(contracts.parseSessionIpcRequest(json(request))).toEqual(request);
  const tooLarge = { ...request, text: request.text + 'é' };
  expect(contracts.parseSessionIpcRequest(json(tooLarge))).toBeNull();
  expect(contracts.parseSessionIpcEnvelope(json({ v: 1, capability, request: tooLarge }))).toBeNull();
});
test('enforces 64 KiB transcript pages independently of the frame limit', () => {
  const frame = { runId, cursor, kind: 'event', data: { ...page, events: [{ ...event, text: 'é'.repeat(32768) }] } };
  expect(contracts.parseRunViewFrame(json(frame))).toBeNull();
});
test('enforces the 256 KiB line limit in all wire decoders', () => {
  const pairs = [
    [contracts.parseSessionIpcRequest, json(ping)],
    [contracts.parseSessionIpcEnvelope, json({ v: 1, capability, request: ping })],
    [contracts.parseSessionIpcReply, json(replies[0])],
    [contracts.parseRunViewFrame, json(frames[0])],
  ] as const;
  for (const [decode, line] of pairs) {
    const atLimit = line + ' '.repeat(256 * 1024 - Buffer.byteLength(line));
    expect(decode(atLimit)).not.toBeNull();
    expect(decode(atLimit + ' ')).toBeNull();
    expect(decode('{')).toBeNull();
    expect(decode(line + '\n' + line)).toBeNull();
  }
});
