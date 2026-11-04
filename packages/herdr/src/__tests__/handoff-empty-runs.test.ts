// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readChildJobJournals } from '../jobs/handoff.js';
import { createJobStore } from '../jobs/store.js';
import { monitorFixture } from './herdr-monitor-fixture.js';

const io = vi.hoisted(() => ({ runs: '', reads: 0, opens: 0, mkdirs: 0, chmods: 0, stats: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs,
    readdir: (...args: Parameters<typeof fs.readdir>) => { if (String(args[0]).startsWith(`${io.runs}/`)) io.reads++; return fs.readdir(...args); },
    open: (...args: Parameters<typeof fs.open>) => { if (String(args[0]).startsWith(`${io.runs}/`)) io.opens++; return fs.open(...args); },
    mkdir: (...args: Parameters<typeof fs.mkdir>) => { io.mkdirs++; return fs.mkdir(...args); },
    chmod: (...args: Parameters<typeof fs.chmod>) => { io.chmods++; return fs.chmod(...args); },
    lstat: (...args: Parameters<typeof fs.lstat>) => { io.stats++; return fs.lstat(...args); },
  };
});
function reset() { io.reads = 0; io.opens = 0; io.mkdirs = 0; io.chmods = 0; io.stats = 0; }

it('skips unchanged empty runs and discovers a journal when the folder changes', async () => {
  const h = await monitorFixture(), runs = join(h.f.root, 'sessions', h.owner.sessionId, 'runs');
  await Promise.all(Array.from({ length: 100 }, (_, i) => mkdir(join(runs, `empty-${i}`), { recursive: true })));
  io.runs = runs; reset();
  expect(await readChildJobJournals(h.f.root, h.owner)).toEqual([]);
  expect({ mkdirs: io.mkdirs, chmods: io.chmods, opens: io.opens }).toEqual({ mkdirs: 0, chmods: 0, opens: 0 });
  expect(io.stats).toBeLessThanOrEqual(100);
  reset();
  expect(await readChildJobJournals(h.f.root, h.owner)).toEqual([]);
  expect({ reads: io.reads, opens: io.opens, mkdirs: io.mkdirs, chmods: io.chmods }).toEqual({ reads: 0, opens: 0, mkdirs: 0, chmods: 0 });
  const store = createJobStore(h.f.root, h.owner.sessionId, 'empty-0' as never), journal = await store.read();
  journal.child = { id: 'empty-0' as never, pid: process.pid, startIdentity: 'test', ended: true };
  await store.write(journal); reset();
  expect((await readChildJobJournals(h.f.root, h.owner)).map(value => value.child?.id)).toEqual(['empty-0']);
});
