// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { createHcClient } from '../client/hc.js';
import type { HcCallOptions, TerminalAddress } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import { createClientFixture, type ClientFixture } from './testutil.js';
const fixtures: ClientFixture[] = [];
const boundary = vi.hoisted(() => ({ core: 'core-local', reply: 't2', routes: [] as { id: string; name: string; host: string; target: string; aliases: string[]; state: string; session: string }[], onGet: () => {}, calls: [] as string[][], beforeCall: async (_args: string[], _options?: HcCallOptions) => {} }));
vi.mock('../client/liveness.js', () => ({ requireCoreAvailable: async () => {} }));
vi.mock('../client/cli-transport.js', () => ({ invokeCli: async (_binary: string, args: string[], _env: unknown, _maxBytes: unknown, _input: unknown, options?: HcCallOptions) => {
  boundary.calls.push([...args]); await boundary.beforeCall(args, options);
  if (args[0] === 'server') return { version: '0.1.16', core: { id: boundary.core } };
  if (args[0] === 'machine') return { machines: structuredClone(boundary.routes) };
  if (args[0] === 'get') {
    boundary.onGet();
    return { address: boundary.reply, labels: {}, parent: null, state: 'live', status: null, exit_code: null, finished_ms: null, reason: null, signal: null };
  }
  throw new Error('Unexpected request');
} }));
afterEach(async () => { boundary.core = 'core-local'; boundary.reply = 't2'; boundary.routes = []; boundary.onGet = () => {}; boundary.calls = []; boundary.beforeCall = async () => {}; for (const fixture of fixtures.splice(0)) await fixture.close(); });
const remote = () => ({ id: 'core-remote', name: 'box-1.invalid', host: 'alias-1.invalid', target: 'box-1.invalid', aliases: ['alias-1.invalid'], state: 'connected', session: 'remote' });
const client = async () => { const fixture = await createClientFixture(); fixtures.push(fixture); return createHcClient({ binary: fixture.hcBinary, env: fixture.localEnv }); };
test.each(['core-local/t2', 'core-remote/t2'])('an exact qualified reply for %s needs only its get call', async requested => {
  boundary.reply = requested;
  const hc = await client();
  try {
    expect((await hc.get(requested as TerminalAddress)).address).toBe(requested);
    expect(boundary.calls).toEqual([['get', requested, '--json']]);
  } finally { await hc.dispose(); }
});
test.each([['get', 1], ['server', 1], ['server', 2], ['machine', 1], ['machine', 2]] as const)('abort cancels lookup during %s call %s', async (command, occurrence) => {
  boundary.routes = [remote()]; boundary.reply = 'alias-1.invalid/t2';
  let entered!: () => void, release!: () => void, seen = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  boundary.beforeCall = async (args, options) => {
    if (args[0] !== command || ++seen !== occurrence) return;
    await new Promise<void>((resolve, reject) => {
      release = resolve; entered();
      options?.signal?.addEventListener('abort', () => reject(new HerdrError('cli-aborted', 'Cancelled')), { once: true });
    });
  };
  const hc = await client(), abort = new AbortController();
  const request = hc.get('core-remote/t2' as TerminalAddress, { signal: abort.signal }).then(() => 'resolved', error => error.code);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await started; abort.abort();
    expect(await Promise.race([request, new Promise(resolve => { timer = setTimeout(() => resolve('still-running'), 100); })])).toBe('cli-aborted');
  } finally { clearTimeout(timer); release?.(); await request; await hc.dispose(); }
});
test.each([
  { requested: 'core-local/t2', returned: 't2' },
  { requested: 'core-local/t2', returned: 'core-local/t2' },
  { requested: 'core-remote/t2', returned: 't2' },
  { requested: 'core-remote/t2', returned: 'core-remote/t2' },
  { requested: 'core-remote/t2', returned: 'box-1.invalid/t2' },
  { requested: 'core-remote/t2', returned: 'alias-1.invalid/t2' },
  { requested: 'alias-1.invalid/t2', returned: 't2' },
])('request $requested accepts verified reply $returned', async ({ requested, returned }) => {
  boundary.routes = [remote()]; boundary.reply = returned;
  const hc = await client();
  try { expect((await hc.get(requested as TerminalAddress)).address).toBe(requested); }
  finally { await hc.dispose(); }
});
test.each(['core-other/t2', 'unknown.invalid/t2', 'other.invalid/t2', 'box-1.invalid/t3'])('remote request refuses foreign or unknown reply %s', async returned => {
  boundary.routes = [remote(), { ...remote(), id: 'core-other', name: 'other.invalid', aliases: [] }]; boundary.reply = returned;
  const hc = await client();
  try { await expect(hc.get('core-remote/t2' as TerminalAddress)).rejects.toMatchObject({ code: 'caller-mismatch' }); }
  finally { await hc.dispose(); }
});
test.each(['core-remote/t2', 'other.invalid/t2'])('equivalent configured aliases do not make %s ambiguous', async requested => {
  boundary.routes = [remote(), { ...remote(), name: 'other.invalid', target: 'other.invalid' }]; boundary.reply = 'box-1.invalid/t2';
  const hc = await client();
  try { expect((await hc.get(requested as TerminalAddress)).address).toBe(requested); }
  finally { await hc.dispose(); }
});
test('an advisory connection status change does not change a verified core route', async () => {
  boundary.routes = [remote()]; boundary.onGet = () => { boundary.routes[0].state = 'disconnected'; };
  const hc = await client();
  try { expect((await hc.get('core-remote/t2' as TerminalAddress)).address).toBe('core-remote/t2'); }
  finally { await hc.dispose(); }
});
test('a short reply cannot turn an unknown requested core into the selected local core', async () => {
  const hc = await client();
  try { await expect(hc.get('core-other/t2' as TerminalAddress)).rejects.toMatchObject({ code: 'caller-mismatch' }); }
  finally { await hc.dispose(); }
});
test.each(['t2', 'box-1.invalid/t2'])('refuses reply %s when its configured route changes during the request', async returned => {
  boundary.routes = [remote()]; boundary.reply = returned;
  boundary.onGet = () => { boundary.routes = [{ ...remote(), id: 'core-other' }]; };
  const hc = await client();
  try { await expect(hc.get('core-remote/t2' as TerminalAddress)).rejects.toMatchObject({ code: 'caller-mismatch' }); }
  finally { await hc.dispose(); }
});
test.each(['before', 'during'])('refuses an alias shared by another core %s the request', async when => {
  const conflicting = { ...remote(), id: 'core-other', name: 'other.invalid', target: 'other.invalid' };
  boundary.routes = [remote()]; boundary.reply = 'alias-1.invalid/t2';
  if (when === 'before') boundary.routes.push(conflicting);
  else boundary.onGet = () => { boundary.routes.push(conflicting); };
  const hc = await client();
  try { await expect(hc.get('core-remote/t2' as TerminalAddress)).rejects.toMatchObject({ code: 'caller-mismatch' }); }
  finally { await hc.dispose(); }
});
test.each(['t2', 'alias-1.invalid/t2'])('refuses reply %s when its route changes between normalization checks', async returned => {
  boundary.routes = [remote()]; boundary.reply = returned;
  let reads = 0;
  boundary.beforeCall = async args => { if (args[0] === 'machine' && ++reads === 2) boundary.routes[0].id = 'core-other'; };
  const hc = await client();
  try { await expect(hc.get('core-remote/t2' as TerminalAddress)).rejects.toMatchObject({ code: 'caller-mismatch' }); }
  finally { await hc.dispose(); }
});
test('refuses a core replacement between short-reply normalization checks', async () => {
  let reads = 0;
  boundary.beforeCall = async args => { if (args[0] === 'server' && ++reads === 2) boundary.core = 'core-other'; };
  const hc = await client();
  try { await expect(hc.get('core-local/t2' as TerminalAddress)).rejects.toMatchObject({ code: 'core-mismatch' }); }
  finally { await hc.dispose(); }
});
test('refuses a local core replacement while normalizing a short reply', async () => {
  const hc = await client(); await hc.identity();
  boundary.onGet = () => { boundary.core = 'core-other'; };
  try { await expect(hc.get('core-local/t2' as TerminalAddress)).rejects.toMatchObject({ code: 'core-mismatch' }); }
  finally { await hc.dispose(); }
});
