// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { panelIpcArgv, parsePanelIpcArgv, parseSessionIpcRequest, parseSessionIpcEnvelope, parseSessionIpcReply } from '../contracts.js';
import type { Generation, JobId, SessionId, SessionIpcRequest, SessionIpcReply, TerminalAddress } from '../contracts.js';

const generation = 'generation' as Generation;
const jobId = 'job' as JobId;
const descriptor = { version: 1 as const, sessionId: 'session' as SessionId, generation, address: '/owned.sock', capabilityFile: '/owned.capability' };
const request: SessionIpcRequest = { op: 'openJob', jobId, generation };
type Assert<T extends true> = T;
type OpenJobRequest = { op: 'openJob'; jobId: JobId; generation: Generation };
type OpenJobReply = { ok: true; op: 'openJob'; viewer: TerminalAddress };
export type OpenJobContractChecks = [
  Assert<OpenJobRequest extends SessionIpcRequest ? true : false>,
  Assert<Extract<SessionIpcRequest, { op: 'openJob' }> extends OpenJobRequest ? true : false>,
  Assert<OpenJobReply extends SessionIpcReply ? true : false>,
  Assert<Extract<SessionIpcReply, { op: 'openJob' }> extends OpenJobReply ? true : false>,
];

test('openJob round-trips the packaged panel argv and authenticated request', () => {
  const argv = panelIpcArgv('node', '/cli.mjs', descriptor, request);
  expect(argv).toEqual(['node', '/cli.mjs', 'ipc', '--descriptor', JSON.stringify(descriptor), '--request', JSON.stringify(request)]);
  expect(parsePanelIpcArgv(argv)).toEqual({ nodePath: 'node', cliPath: '/cli.mjs', descriptor, request });
  expect(parseSessionIpcRequest(JSON.stringify(request))).toEqual(request);
  const envelope = { v: 1, capability: 'a'.repeat(64), request };
  expect(parseSessionIpcEnvelope(JSON.stringify(envelope))).toEqual(envelope);
});

test('openJob replies identify a local observer or preserve not-found', () => {
  const reply: SessionIpcReply = { ok: true, op: 'openJob', viewer: 't2' as TerminalAddress };
  expect(parseSessionIpcReply(JSON.stringify(reply))).toEqual(reply);
  const missing: SessionIpcReply = { ok: false, code: 'not-found', message: 'Unknown or foreign job' };
  expect(parseSessionIpcReply(JSON.stringify(missing))).toEqual(missing);
});

test.each([undefined, '', null, 1, 'job\0'])('openJob rejects invalid job identity %j', jobId => {
  expect(parseSessionIpcRequest(JSON.stringify({ ...request, jobId }))).toBeNull();
});
test.each([undefined, '', null, 1, 't2\0'])('openJob rejects invalid viewer identity %j', viewer => {
  expect(parseSessionIpcReply(JSON.stringify({ ok: true, op: 'openJob', viewer }))).toBeNull();
});
