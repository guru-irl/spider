// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { createFeedReader } from '../../assets/shared/feed.js';

const config = { nodePath: '/fixture/node', cliPath: '/fixture/cli.mjs', feedRoot: '/fixture/feeds' };
const acknowledgement = { version: 1, port: 34567, pid: 1, token: 'a'.repeat(64) };
const empty = { version: 1, entries: [], changes: [], errors: [] };
const timer = { every(ms: number, callback: () => void) {
  const handle = setTimeout(callback, ms);
  return { cancel: () => clearTimeout(handle) };
} };
afterEach(() => vi.useRealTimers());

test.each(['fetch', 'body'] as const)('a hung snapshot %s does not prevent later refreshes', async hung => {
  vi.useFakeTimers(); let starts = 0, calls = 0, outcome = 'pending';
  const reader = createFeedReader(config, {
    timer,
    exec: async () => { starts++; return { code: 0, stdout: JSON.stringify(acknowledgement), stderr: '' }; },
    fetch: async url => {
      if (url.endsWith('/close')) return { ok: true, json: async () => ({}) };
      if (++calls === 1 && hung === 'fetch') return new Promise(() => {});
      if (calls === 1 && hung === 'body') return { ok: true, json: () => new Promise(() => {}) };
      return { ok: true, json: async () => empty };
    },
  });
  const first = reader.read().then(() => { outcome = 'success'; }, () => { outcome = 'timeout'; });
  try {
    await vi.advanceTimersByTimeAsync(15000);
    expect(outcome).toBe('timeout');
    await vi.advanceTimersByTimeAsync(60000);
    await expect(reader.read()).resolves.toEqual({ feeds: [], errors: [] });
    expect(starts).toBe(2); expect(calls).toBe(2);
    await first;
  } finally { await reader.close(); }
});

test('closing a reader also times out if the close request hangs', async () => {
  vi.useFakeTimers(); let closed = false;
  const reader = createFeedReader(config, {
    timer,
    exec: async () => ({ code: 0, stdout: JSON.stringify(acknowledgement), stderr: '' }),
    fetch: async url => url.endsWith('/close') ? new Promise(() => {}) : { ok: true, json: async () => empty },
  });
  await reader.read();
  const close = reader.close().then(() => { closed = true; });
  await vi.advanceTimersByTimeAsync(15000);
  expect(closed).toBe(true);
  await close;
  await expect(reader.read()).rejects.toThrow('Feed reader closed');
});

test('failed reader starts retry with exponential backoff capped at one minute', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0); let starts = 0;
  const reader = createFeedReader(config, {
    timer,
    exec: async () => { starts++; return { code: 1, stdout: '', stderr: '' }; },
    fetch: async () => { throw new Error('Unexpected request'); },
  });
  try {
    await expect(reader.read()).rejects.toThrow();
    for (const wait of [5000, 10000, 20000, 40000, 60000, 60000]) {
      const previous = starts;
      await vi.advanceTimersByTimeAsync(wait - 1);
      await expect(reader.read()).rejects.toThrow(); expect(starts).toBe(previous);
      await vi.advanceTimersByTimeAsync(1);
      await expect(reader.read()).rejects.toThrow(); expect(starts).toBe(previous + 1);
    }
    expect(starts).toBe(7);
  } finally { await reader.close(); }
});

test('a timed-out launch closes a reader that acknowledges late', async () => {
  vi.useFakeTimers(); let resolveLaunch!: (reply: { code: number; stdout: string; stderr: string }) => void;
  let outcome = 'pending', closes = 0;
  const reader = createFeedReader(config, {
    timer,
    exec: () => new Promise(resolve => { resolveLaunch = resolve; }),
    fetch: async url => { if (url.endsWith('/close')) closes++; return { ok: true, json: async () => ({}) }; },
  });
  const reading = reader.read().then(() => { outcome = 'success'; }, () => { outcome = 'timeout'; });
  try {
    await vi.advanceTimersByTimeAsync(15000);
    expect(outcome).toBe('timeout');
    resolveLaunch({ code: 0, stdout: JSON.stringify(acknowledgement), stderr: '' });
    await vi.advanceTimersByTimeAsync(0);
    expect(closes).toBe(1);
    await reading;
  } finally {
    resolveLaunch({ code: 0, stdout: JSON.stringify(acknowledgement), stderr: '' });
    await reader.close();
  }
});
