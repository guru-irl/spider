// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { parseSessionIpcRequest, parseSessionIpcReply } from '../../assets/shared/feed.js';
import type * as Shared from '../../assets/shared/feed.js';
import type * as Contracts from '../contracts.js';

type Signatures = {
  panelIpcArgv: (nodePath: string, cliPath: string, descriptor: Contracts.IpcDescriptor, request: Contracts.SessionIpcRequest) => string[];
  parsePanelIpcArgv: (argv: readonly string[]) => { nodePath: string; cliPath: string; descriptor: Contracts.IpcDescriptor; request: Contracts.SessionIpcRequest } | null;
  parseSessionIpcRequest: (line: string) => Contracts.SessionIpcRequest | null;
  parseSessionIpcEnvelope: (line: string) => Contracts.SessionIpcEnvelope | null;
  parseSessionIpcReply: (line: string) => Contracts.SessionIpcReply | null;
  parseRunViewFrame: (line: string) => Contracts.RunViewFrame | null;
};
type Declared = Pick<typeof Shared, keyof Signatures>;
type Exported = Pick<typeof Contracts, keyof Signatures>;
type Assert<T extends true> = T;
export type ModIpcSignatureChecks = [
  Assert<Declared extends Signatures ? true : false>,
  Assert<Signatures extends Declared ? true : false>,
  Assert<Exported extends Signatures ? true : false>,
  Assert<Signatures extends Exported ? true : false>,
];

test('installed asset declarations agree with canonical IPC types in both directions', () => {});

test('accepts a generation-bound session open with a destination or null', () => {
  const request = { op: 'openSession', generation: 'generation', destination: { space: 's1', tab: 'tb1' } };
  expect(parseSessionIpcRequest(JSON.stringify(request))).toEqual(request);
  expect(parseSessionIpcRequest(JSON.stringify({ ...request, destination: null }))).toEqual({ ...request, destination: null });
  expect(parseSessionIpcReply(JSON.stringify({ ok: true, op: 'openSession', terminal: 't1' }))).toEqual({ ok: true, op: 'openSession', terminal: 't1' });
});

test.each([
  { op: 'openSession', generation: 'g' },
  { op: 'openSession', generation: 'g', destination: { space: 's1' } },
  { op: 'openSession', generation: 'g', destination: { space: 's1', tab: '' } },
  { op: 'openSession', generation: 'g', destination: { space: 's1', tab: 'tb1', terminal: 't2' } },
  { op: 'openSession', generation: 'g', destination: null, terminal: 't2' },
])('rejects a malformed or caller-addressed session open: %j', request => {
  expect(parseSessionIpcRequest(JSON.stringify(request))).toBeNull();
});

test('rejects an openSession reply without a terminal address', () => {
  expect(parseSessionIpcReply(JSON.stringify({ ok: true, op: 'openSession' }))).toBeNull();
  expect(parseSessionIpcReply(JSON.stringify({ ok: true, op: 'openSession', terminal: '' }))).toBeNull();
});
