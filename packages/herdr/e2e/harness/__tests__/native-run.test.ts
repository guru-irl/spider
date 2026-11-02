// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, expect, it } from 'vitest';
import { createNativeRun } from '../native-run.js';
describe('native fire-and-forget run bridge', () => {
  it('returns null synchronously and records the actual command result', async () => {
    const seen: unknown[] = [];
    const bridge = createNativeRun(async (name, args) => { seen.push({ name, args }); return { pane: 'p3' }; });
    expect(bridge.run('terminal.peek', { terminal: 't3' })).toBe(null);
    expect(bridge.calls[0].state).toBe('pending');
    await bridge.flush();
    expect(seen).toEqual([{ name: 'terminal.peek', args: { terminal: 't3' } }]);
    expect(bridge.calls).toEqual([{ name: 'terminal.peek', args: { terminal: 't3' }, state: 'succeeded', result: { pane: 'p3' } }]);
  });
  it('records an unsupported command without returning an unhandled rejected promise', async () => {
    const bridge = createNativeRun(async () => { throw Object.assign(new Error('unplaced terminal peek requires a native overlay'), { code: 'unsupported-capability' }); });
    expect(bridge.run('terminal.peek')).toBe(null);
    await bridge.flush();
    expect(bridge.calls).toEqual([{ name: 'terminal.peek', args: {}, state: 'failed', error: { name: 'Error', code: 'unsupported-capability', message: 'unplaced terminal peek requires a native overlay' } }]);
  });
  it('still fails the fixture for an unrelated refresh failure', async () => {
    const error = new Error('native inventory lost');
    const bridge = createNativeRun(async () => ({ ok: true }), async () => { throw error; });
    bridge.run('pane.focus', { pane: 'p3' });
    await expect(bridge.flush()).rejects.toBe(error);
    expect(bridge.calls[0].state).toBe('succeeded');
  });
});
