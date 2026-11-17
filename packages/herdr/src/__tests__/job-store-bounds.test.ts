// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionId } from '../contracts.js';
import { createJobStore } from '../jobs/store.js';

const io = vi.hoisted(() => ({ lstat: vi.fn(), open: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), ...io,
}));
afterEach(() => { vi.resetAllMocks(); });
const text = '{"version":1,"sessionId":"owner","revision":0,"updatedAt":0,"jobs":[]}';
function fixture(bytes: Buffer, size = bytes.length) {
  const reservations: number[] = [];
  let closed = 0;
  io.lstat.mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false });
  io.open.mockResolvedValue({ stat: async () => ({ isFile: () => true, size }),
    read: async (target: Buffer) => { reservations.push(target.length); return { bytesRead: bytes.copy(target) }; },
    close: async () => { closed++; },
  });
  const store = createJobStore('/fixture/jobs', 'owner' as SessionId);
  return { store, reservations, closed: () => closed };
}

it('reserves the journal size plus a growth sentinel, not the journal limit', async () => {
  const h = fixture(Buffer.from(text));
  expect(await h.store.read()).toEqual({ version: 1, sessionId: 'owner', revision: 0, updatedAt: 0, jobs: [] });
  expect(h.reservations).toEqual([71]);
  expect(h.closed()).toBe(1);
});
it('round trips a real journal with a size-bounded read', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const root = await fs.mkdtemp(join(tmpdir(), 'job-store-bounds-'));
  const reservations: number[] = [];
  io.lstat.mockImplementation((path: string) => fs.lstat(path));
  io.open.mockImplementation(async (path: string, flags: number, mode?: number) => {
    const file = await fs.open(path, flags, mode);
    return new Proxy(file, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'read') return (...args: unknown[]) => {
        reservations.push((args[0] as Buffer).length);
        return Reflect.apply(value, target, args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  const journal = { version: 1 as const, sessionId: 'owner' as SessionId, revision: 3, updatedAt: 42, jobs: [] };
  const store = createJobStore(root, journal.sessionId);
  try {
    await store.write(journal);
    expect((await fs.stat(store.path)).size).toBe(Buffer.byteLength(JSON.stringify(journal)));
    expect(await store.read()).toEqual(journal);
    expect(reservations).toEqual([Buffer.byteLength(JSON.stringify(journal)) + 1]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('accepts a journal exactly at the byte limit', async () => {
  const h = fixture(Buffer.from(text.padEnd(1_048_576, ' ')));
  expect((await h.store.read()).jobs).toEqual([]);
  expect(h.reservations).toEqual([1_048_577]);
  expect(h.closed()).toBe(1);
});
it('rejects an oversized stat before allocating a read buffer', async () => {
  const h = fixture(Buffer.from(text), 1_048_577);
  await expect(h.store.read()).rejects.toMatchObject({ code: 'invalid-journal' });
  expect(h.reservations).toEqual([]);
  expect(h.closed()).toBe(1);
});
it('detects a file that grows beyond the byte limit after stat', async () => {
  const h = fixture(Buffer.from(text.padEnd(1_048_577, ' ')), 1_048_576);
  await expect(h.store.read()).rejects.toMatchObject({ code: 'journal-too-large' });
  expect(h.reservations).toEqual([1_048_577]);
  expect(h.closed()).toBe(1);
});
it('rejects growth beyond a smaller stat instead of parsing a valid prefix', async () => {
  const h = fixture(Buffer.from(text + ' '), 70);
  await expect(h.store.read()).rejects.toMatchObject({ code: 'invalid-journal' });
  expect(h.reservations).toEqual([71]);
  expect(h.closed()).toBe(1);
});
it('closes an empty or malformed journal without reserving the full limit', async () => {
  const h = fixture(Buffer.alloc(0));
  await expect(h.store.read()).rejects.toThrow();
  expect(h.reservations).toEqual([1]);
  expect(h.closed()).toBe(1);
});
