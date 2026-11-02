// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { panelIpcArgv, parsePanelIpcArgv, parseRunViewFrame, parseSessionIpcEnvelope, parseSessionIpcReply, parseSessionIpcRequest } from '../contracts.js';
import type { Generation, RunCursor, RunId, RunSummary, RunViewFrame, SessionId, SteerReply } from '../contracts.js';

const runId = 'run' as RunId;
const cursor = 'opaque-event-and-byte-position' as RunCursor;
const generation = 'generation' as Generation;
const run: RunSummary = { id: runId, ownerSessionId: 'session' as SessionId, name: null, status: 'paused', childMode: 'print', canSteer: false, startedAt: 1, finishedAt: null, viewer: null, result: null };
const event = { runId, id: 1, type: 'tool-call', summary: 'Reading file', tool: 'read' };
const frames: RunViewFrame[] = [
  { runId, cursor, kind: 'snapshot', data: { run } },
  { runId, cursor, kind: 'event', data: { text: 'Hello', events: [event] } },
  { runId, cursor, kind: 'gap', data: { reason: 'rotated' } },
  { runId, cursor, kind: 'end', data: { reason: 'run-not-owned' } },
];

test.each(frames)('decodes the approved $kind viewer frame', frame => {
  expect(parseRunViewFrame(JSON.stringify(frame))).toEqual(frame);
});

test.each(['queued', 'running', 'paused', 'done', 'failed', 'cancelled'] as const)('snapshot preserves canonical run state %s', status => {
  const frame = { runId, cursor, kind: 'snapshot', data: { run: { ...run, status, result: 'Retained result' } } };
  expect(parseRunViewFrame(JSON.stringify(frame))).toEqual(frame);
});

test.each(['finished', 'disposed', 'wrong-generation', 'overflow', 'run-not-owned'])('decodes end reason %s', reason => {
  const frame = { runId, cursor, kind: 'end', data: { reason } };
  expect(parseRunViewFrame(JSON.stringify(frame))).toEqual(frame);
});

test('opaque cursors round-trip in request argv and authenticated envelopes', () => {
  const request = { op: 'subscribeRun' as const, runId, cursor, generation };
  const descriptor = { version: 1 as const, sessionId: 'session' as SessionId, generation, address: '/owned.sock', capabilityFile: '/owned.capability' };
  expect(parsePanelIpcArgv(panelIpcArgv('node', '/cli.mjs', descriptor, request))?.request).toEqual(request);
  expect(parseSessionIpcRequest(JSON.stringify(request))).toEqual(request);
  const envelope = { v: 1, capability: 'a'.repeat(64), request };
  expect(parseSessionIpcEnvelope(JSON.stringify(envelope))).toEqual(envelope);
});

test('bounds opaque cursors at 1024 UTF-8 bytes in frames, requests and envelopes', () => {
  for (const value of ['é'.repeat(512), '😀'.repeat(256)]) {
    const request = { op: 'subscribeRun', runId, generation, cursor: value };
    const frame = { runId, cursor: value, kind: 'gap', data: { reason: 'invalid-cursor' } };
    const envelope = { v: 1, capability: 'a'.repeat(64), request };
    expect(parseSessionIpcRequest(JSON.stringify(request))).toEqual(request);
    expect(parseSessionIpcEnvelope(JSON.stringify(envelope))).toEqual(envelope);
    expect(parseRunViewFrame(JSON.stringify(frame))).toEqual(frame);
    expect(parseSessionIpcRequest(JSON.stringify({ ...request, cursor: value + 'a' }))).toBeNull();
    expect(parseSessionIpcEnvelope(JSON.stringify({ ...envelope, request: { ...request, cursor: value + 'a' } }))).toBeNull();
    expect(parseRunViewFrame(JSON.stringify({ ...frame, cursor: value + 'a' }))).toBeNull();
  }
});

test.each([null, '', 1, { runId, seq: 1 }, 'bad\0cursor'])('rejects invalid frame cursor %j', cursor => {
  expect(parseRunViewFrame(JSON.stringify({ ...frames[2], cursor }))).toBeNull();
  if (cursor !== null) expect(parseSessionIpcRequest(JSON.stringify({ op: 'subscribeRun', runId, generation, cursor }))).toBeNull();
});

test.each([
  { ...frames[0], data: { run: { ...run, id: 'foreign' } } },
  { ...frames[0], data: { run: { ...run, canSteer: 1 } } },
  { ...frames[0], data: { run: { ...run, childMode: 'unknown' } } },
  { ...frames[0], data: { run: { ...run, status: 'unknown' } } },
  { ...frames[0], data: { run: { ...run, ownerSessionId: null } } },
  { ...frames[0], data: { run: { ...run, finishedAt: -1 } } },
  { ...frames[0], data: {} },
  { ...frames[1], data: { text: 1, events: [] } },
  { ...frames[1], data: { text: '', events: [{ ...event, runId: 'foreign' }] } },
  { ...frames[1], data: { text: '', events: [{ ...event, id: -1 }] } },
  { ...frames[1], data: { text: '', events: [{ ...event, type: 1 }] } },
  { ...frames[1], data: { text: '', events: [{ ...event, text: null }] } },
  { ...frames[1], data: { text: '', events: [{ ...event, summary: false }] } },
  { ...frames[1], data: { text: '', events: [{ ...event, tool: 1 }] } },
  { ...frames[2], data: { reason: null } },
  { ...frames[3], data: { reason: 'unknown' } },
  { ...frames[0], kind: 'unknown' },
  { ...frames[0], runId: '' },
  { ...frames[0], data: null },
  { ...frames[0], data: [] },
])('rejects invalid viewer frame %#', frame => {
  expect(parseRunViewFrame(JSON.stringify(frame))).toBeNull();
});

test('bounds event pages at 64 KiB separately from the full 256 KiB line', () => {
  const emptyPage = { text: '', events: [] };
  const overhead = new TextEncoder().encode(JSON.stringify(emptyPage)).byteLength;
  const page = { ...emptyPage, text: 'a'.repeat(64 * 1024 - overhead) };
  const frame = { runId, cursor, kind: 'event', data: page };
  expect(parseRunViewFrame(JSON.stringify(frame))).toEqual(frame);
  expect(parseRunViewFrame(JSON.stringify({ ...frame, data: { ...page, text: page.text + 'a' } }))).toBeNull();
  expect(parseRunViewFrame(JSON.stringify({ ...frame, data: { ...page, text: 'é'.repeat(32768) } }))).toBeNull();
  const line = JSON.stringify(frame);
  const atLimit = line + ' '.repeat(256 * 1024 - new TextEncoder().encode(line).byteLength);
  expect(parseRunViewFrame(atLimit)).toEqual(frame);
  expect(parseRunViewFrame(atLimit + 'a')).toBeNull();
});

const acknowledgements: SteerReply[] = [
  { delivery: 'delivered', accepted: true, delivered: true, queued: false },
  { delivery: 'accepted but not confirmed', accepted: true, delivered: false, queued: true },
  { delivery: 'broker-accepted', accepted: true, delivered: false, queued: false },
  { delivery: 'consumed by an extension, not delivered', accepted: true, delivered: false, queued: false, transformed: true },
  { delivery: 'no reply yet, delivery unknown', accepted: false, delivered: false, queued: false, error: 'Connection ended' },
  { delivery: 'refused', accepted: false, delivered: false, queued: false, error: 'Cannot steer' },
];
test.each(acknowledgements)('decodes acknowledgement $delivery without claiming uncertain delivery', acknowledgement => {
  const reply = { ok: true, op: 'steerRun', acknowledgement };
  expect(parseSessionIpcReply(JSON.stringify(reply))).toEqual(reply);
});

test.each(acknowledgements)('rejects inconsistent accepted/delivered flags for $delivery', acknowledgement => {
  for (const field of ['accepted', 'delivered'] as const) {
    expect(parseSessionIpcReply(JSON.stringify({ ok: true, op: 'steerRun', acknowledgement: { ...acknowledgement, [field]: !acknowledgement[field] } }))).toBeNull();
  }
});

test.each([
  {}, null,
  { ...acknowledgements[0], delivery: 'accepted' },
  { ...acknowledgements[0], accepted: 1 },
  { ...acknowledgements[0], delivered: 1 },
  { ...acknowledgements[0], queued: undefined },
  { ...acknowledgements[0], queued: 1 },
  { ...acknowledgements[0], transformed: 1 },
  { ...acknowledgements[0], error: null },
])('rejects malformed steer acknowledgement %#', acknowledgement => {
  expect(parseSessionIpcReply(JSON.stringify({ ok: true, op: 'steerRun', acknowledgement }))).toBeNull();
});
