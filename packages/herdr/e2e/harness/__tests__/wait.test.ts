// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { deadline, waitFor } from '../wait.js';

describe('waitFor', () => {
  it('reads immediately and returns the first observation that satisfies the predicate', async () => {
    let reads = 0;
    const value = await waitFor('counter', () => ++reads, n => n >= 1, deadline(1000));
    expect(value).toBe(1); expect(reads).toBe(1);
  });

  it('re-observes on each subscribed signal, not on a sleep', async () => {
    const changes = new EventEmitter(); let state = 0;
    const pending = waitFor('state', () => state, s => s === 2, deadline(5000), { subscribe: wake => { changes.on('x', wake); return () => changes.off('x', wake); }, reconcileMs: 60_000 });
    state = 1; changes.emit('x'); state = 2; changes.emit('x');
    await expect(pending).resolves.toBe(2);
  });

  it('fails at the deadline with the description and last observation', async () => {
    const error = await waitFor('never ready', () => ({ phase: 'booting' }), () => false, deadline(150), { reconcileMs: 20 }).catch(e => e);
    expect(String(error)).toMatch(/wait-deadline: never ready/);
    expect(error.details.last).toEqual({ phase: 'booting' });
  });

  it('stops when its abort signal fires and surfaces observer errors', async () => {
    const controller = new AbortController();
    const pending = waitFor('aborted', () => 0, () => false, deadline(5000, controller.signal), { reconcileMs: 20 });
    controller.abort();
    await expect(pending).rejects.toThrow(/wait-aborted/);
    await expect(waitFor('throws', () => { throw new Error('boom'); }, () => true, deadline(500))).rejects.toThrow(/boom/);
  });
});
