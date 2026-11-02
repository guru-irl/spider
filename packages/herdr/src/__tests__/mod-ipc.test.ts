// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
import * as shared from '../../assets/shared/feed.js';
import * as contracts from '../contracts.js';
import type { Generation, RunId, SessionId } from '../contracts.js';

const names = ['panelIpcArgv', 'parsePanelIpcArgv', 'parseSessionIpcRequest', 'parseSessionIpcEnvelope', 'parseSessionIpcReply', 'parseRunViewFrame'] as const;
const source = readFileSync(new URL('../../assets/shared/feed.js', import.meta.url), 'utf8');
const generation = 'generation' as Generation;
const runId = 'run' as RunId;
const descriptor = { version: 1 as const, sessionId: 'session' as SessionId, generation, address: '/owned.sock', capabilityFile: '/owned.capability' };
const request = { op: 'steerRun' as const, runId, generation, text: 'é'.repeat(8192) };

test('mods and contracts use one implementation for every IPC helper', () => {
  for (const name of names) {
    expect(shared[name]).toBeTypeOf('function');
    expect(shared[name]).toBe(contracts[name]);
  }
});

test('the installed shared asset has no Node dependencies', () => {
  expect(source).not.toMatch(/\b(?:Buffer|require|process)\b|node:/);
});

test('the installed shared asset decodes bounded IPC in a plain JS context', () => {
  // Strip only ESM export declarations so vm can evaluate the installed code as a script.
  // No imports or runtime globals are substituted. Herdr runs mods in QuickJS, which has no
  // TextEncoder: a decoder that needs one throws inside the app and every panel action fails.
  const script = source.replace(/^export /gm, '') + `\n({ ${names.join(', ')} })`;
  const context = {};
  const api: typeof shared = runInNewContext(script, context, { timeout: 1000 });
  expect(runInNewContext('[typeof Buffer, typeof require, typeof process, typeof TextEncoder]', context)).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
  const argv = api.panelIpcArgv('node', '/cli.mjs', descriptor, request);
  expect(api.parsePanelIpcArgv(argv)).toEqual({ nodePath: 'node', cliPath: '/cli.mjs', descriptor, request });
  expect(api.parseSessionIpcRequest(JSON.stringify(request))).toEqual(request);
  expect(api.parseSessionIpcRequest(JSON.stringify({ ...request, text: request.text + 'é' }))).toBeNull();
  const envelope = { v: 1, capability: 'a'.repeat(64), request };
  expect(api.parseSessionIpcEnvelope(JSON.stringify(envelope))).toEqual(envelope);
  expect(api.parseSessionIpcEnvelope(JSON.stringify({ ...envelope, request: { ...request, text: request.text + 'é' } }))).toBeNull();
  const reply = { ok: false, code: 'not-found', message: 'Unknown run' };
  expect(api.parseSessionIpcReply(JSON.stringify(reply))).toEqual(reply);
  for (const [decode, value] of [
    [api.parseSessionIpcRequest, request],
    [api.parseSessionIpcEnvelope, envelope],
    [api.parseSessionIpcReply, reply],
    [api.parseRunViewFrame, { runId, cursor: 'opaque-position', kind: 'end', data: { reason: 'overflow' } }],
  ] as const) {
    const line = JSON.stringify(value);
    const padding = 256 * 1024 - new TextEncoder().encode(line).byteLength;
    expect(decode(line + ' '.repeat(padding))).toEqual(value);
    expect(decode(line + ' '.repeat(padding) + 'é')).toBeNull();
    expect(decode(line + '\n' + line)).toBeNull();
  }
  const pageFrame = { runId, cursor: 'opaque-position', kind: 'event', data: { text: '', events: [{ runId, id: 1, type: 'assistant', text: 'é'.repeat(32768) }] } };
  expect(api.parseRunViewFrame(JSON.stringify(pageFrame))).toBeNull();
});
