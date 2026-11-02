// SPDX-License-Identifier: MIT
import { expect, it, vi } from 'vitest';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerHerdrJobs } from '../jobs/register.js';
import { createJobHandoff, processStartIdentity, readChildJobJournals } from '../jobs/handoff.js';
import { createJobStore } from '../jobs/store.js';
import { bounded, cleanup, deferred, monitorFixture, on, program } from './herdr-monitor-fixture.js';

it('a failed startup never cancels a surviving parent job', async () => {
  const h = await monitorFixture(), old = h.monitor();
  const handle = await old.start(program, h.owner, on, {}); await old.shutdown('reload');
  h.hc.events = () => ({ ready: new Promise(() => {}), lookup: async () => null, subscribe: () => () => {}, dispose: () => {} });
  const hooks = new Map<string, Function>();
  const registration = registerHerdrJobs({ on: (name: string, handler: Function) => { hooks.set(name, handler); return () => {}; }, sendMessage() {} } as never, {
    currentOwner: () => h.owner, monitorOptions: () => h.options, bind() {}, jobIdsForToolResult: () => [],
  });
  cleanup(() => registration.dispose());
  await expect(hooks.get('session_start')!({}, { sessionManager: { getBranch: () => [] } })).resolves.toBeUndefined();
  expect(h.terminals.get(handle.address)?.state).toBe('live');
  expect(h.kills).toEqual([]);
});

it('an ended-run cleanup failure does not disable parent activation and is retried', async () => {
  const h = await monitorFixture(), child = h.monitor({ child: { id: 'ended-run' as never, pid: process.pid, startIdentity: 'ended' } });
  await child.start(program, h.owner, on, { background: true }); await child.shutdown('quit');
  let attempts = 0;
  const parent = h.monitor({ closeAgentConsoles: async () => { if (++attempts === 1) throw new Error('transient console failure'); } });
  await expect(parent.activate(h.owner)).resolves.toBeUndefined();
  await parent.reconcile();
  expect(attempts).toBe(2);
  expect(h.kills).toEqual([]);
  expect(h.errors).toHaveLength(1);
});

it('one corrupt child journal cannot prevent a healthy ended run from being adopted', async () => {
  const h = await monitorFixture(), child = h.monitor({ child: { id: 'healthy-run' as never, pid: process.pid, startIdentity: 'ended' } });
  await child.start(program, h.owner, on, { background: true }); await child.shutdown('quit');
  const corrupt = createJobStore(h.f.root, h.owner.sessionId, 'corrupt-run' as never);
  await mkdir(corrupt.directory, { recursive: true }); await writeFile(join(corrupt.directory, 'jobs.json'), '{');
  const adopted: string[] = [], errors: unknown[] = [];
  const handoff = createJobHandoff({ root: h.f.root, owner: h.owner, hc: h.hc, closeAgentConsoles: async () => {},
    adopt: async id => { adopted.push(id); return { reconcile: async () => {}, shutdown: async () => {} }; }, reportError: error => { errors.push(error); },
  });
  cleanup(() => handoff.shutdown('reload'));
  await expect(handoff.reconcile()).resolves.toBeUndefined();
  expect(adopted).toEqual(['healthy-run']); expect(errors).toHaveLength(1);
});

it('settled child projections do not reread the journal on every tick', async () => {
  const h = await monitorFixture(), store = createJobStore(h.f.root, h.owner.sessionId, 'settled-run' as never);
  const journal = await store.read(); journal.child = { id: 'settled-run' as never, pid: process.pid, startIdentity: 'ended', ended: true, settled: true }; await store.write(journal);
  expect(await readChildJobJournals(h.f.root, h.owner)).toHaveLength(1);
  await writeFile(join(store.directory, 'jobs.json'), '{');
  expect(await readChildJobJournals(h.f.root, h.owner)).toHaveLength(1);
});

it('periodic child identity checks do not block the parent event loop', async () => {
  const h = await monitorFixture(), store = createJobStore(h.f.root, h.owner.sessionId, 'live-run' as never);
  const journal = await store.read(); journal.child = { id: 'live-run' as never, pid: process.pid, startIdentity: processStartIdentity(process.pid)!, ended: false }; await store.write(journal);
  const bin = join(h.f.root, 'bin'); await mkdir(bin);
  const ps = join(bin, 'ps'); await writeFile(ps, '#!/bin/sh\nsleep 1\nexec /bin/ps "$@"\n'); await chmod(ps, 0o700);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`); cleanup(() => vi.unstubAllEnvs());
  let ticked = false;
  const handoff = createJobHandoff({ root: h.f.root, owner: h.owner, hc: h.hc, closeAgentConsoles: async () => {}, adopt: async () => { throw new Error('Live run cannot be adopted'); } });
  cleanup(() => handoff.shutdown('reload'));
  const began = Date.now(), pending = handoff.reconcile();
  setTimeout(() => { ticked = true; }, 30);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(ticked).toBe(true);
  expect(Date.now() - began).toBeLessThan(500);
  await bounded(pending, 3000);
});
