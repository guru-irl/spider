// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import type { HcClient, Owner, RunId } from '../contracts.js';
import { createJobHandoff } from '../jobs/handoff.js';
import type { JobJournal } from '../jobs/store.js';

const io = vi.hoisted(() => ({ readdir: vi.fn(), lstat: vi.fn(), open: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), ...io,
}));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

const owner = { sessionId: 'owner', generation: 'g1', cwd: '/fixture', sessionFile: null, name: null,
  terminal: { coreId: 'core', terminalId: 't-owner', address: 't-owner', socket: '/fixture/core.sock', sessionNamespace: 'fixture' },
} as Owner;
const root = '/fixture/jobs';
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 600_000));
function filesystem(count = 2, ended = false) {
  const journals: JobJournal[] = Array.from({ length: count }, (_, i) => ({
    version: 1, sessionId: owner.sessionId, revision: 0, updatedAt: 0, jobs: [],
    child: { id: `run-${i}` as RunId, pid: 1, startIdentity: 'alive', ended },
  }));
  io.lstat.mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false, dev: 1, ino: 1, mtimeMs: 0, ctimeMs: 0 });
  io.readdir.mockImplementation(async (_path, options) => options?.withFileTypes
    ? journals.map(journal => ({ name: journal.child!.id, isDirectory: () => true })) : ['jobs.json']);
  io.open.mockImplementation(async (path: string) => {
    const journal = journals.find(journal => path.endsWith(`/${journal.child!.id}/jobs.json`));
    if (!journal) throw new Error('Unexpected journal path');
    const bytes = Buffer.from(JSON.stringify(journal));
    return { stat: async () => ({ isFile: () => true, size: bytes.length }),
      read: async (target: Buffer) => ({ bytesRead: bytes.copy(target) }), close: async () => {} };
  });
  return journals;
}

it.each(['directory', 'journal'] as const)('keeps one handoff scan while a %s read stalls across ticks', async stage => {
  vi.useFakeTimers(); filesystem();
  let active = 0, started = 0, reservedBytes = 0;
  if (stage === 'directory') {
    const read = io.readdir.getMockImplementation()!;
    io.readdir.mockImplementation(async (...args) => {
      if (!args[1]?.withFileTypes) return read(...args);
      active++; started++;
      try { await pause(); return read(...args); } finally { active--; }
    });
  } else {
    const open = io.open.getMockImplementation()!;
    io.open.mockImplementation(async (path: string) => {
      const file = await open(path);
      if (!path.endsWith('/run-1/jobs.json')) return file;
      return { ...file, read: async (target: Buffer) => {
        active++; started++; reservedBytes += target.length;
        try { await pause(); return file.read(target); } finally { active--; reservedBytes -= target.length; }
      } };
    });
  }
  const handoff = createJobHandoff({ root, owner, hc: {} as HcClient,
    processIdentity: async () => 'alive', adopt: async () => { throw new Error('Live writers must not be adopted'); },
  });
  const tick = () => { void handoff.reconcile(); };
  const timer = setInterval(tick, 2000); tick();
  const counts: number[] = [], buffers: number[] = [];
  try {
    for (const ms of [20_000, 40_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(ms); counts.push(active); buffers.push(reservedBytes);
    }
    expect({ active: counts, reserved: buffers }).toEqual({ active: [1, 1, 1], reserved: stage === 'journal' ? [140, 140, 140] : [0, 0, 0] });
    expect(started).toBe(1);
  } finally {
    clearInterval(timer);
    const stopping = handoff.shutdown('reload');
    await vi.runAllTimersAsync(); await stopping;
  }
  expect(active).toBe(0);
});

it('takes over a newly ended child while another child is stalled', async () => {
  vi.useFakeTimers();
  const journals = filesystem(2);
  journals[0].child!.ended = true;
  journals[1].jobs.push({
    version: 1, id: 'job-1' as never, runId: 'run-1' as RunId, owner, machine: 'remote.invalid' as never,
    kind: 'exec', phase: { kind: 'running', address: 'remote.invalid/t1' as never, releasedAt: 1 },
    viewer: null, remoteDirectory: '/fixture/remote', localDirectory: '/fixture/local', detached: false,
    noticeMode: 'tool', notice: 'pending', nonce: 'nonce', releaseDeadlineAt: 1, originalFinish: null,
    output: null, callerOwned: false, uncertain: false, evidenceConflict: false, noticeDelivered: false,
    settledMarked: false, terminalExpired: false, updatedAt: 1,
  });
  let release!: () => void, entered!: () => void, liveChecked!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const checked = new Promise<void>(resolve => { liveChecked = resolve; });
  const adopted: RunId[] = [];
  const hc = { get: async () => { entered(); await stalled; } };
  const handoff = createJobHandoff({ root, owner, hc: hc as unknown as HcClient,
    processIdentity: async () => { liveChecked(); return 'alive'; },
    closeAgentConsoles: async child => { if (child.runId === 'run-0') await hc.get(); },
    adopt: async id => { adopted.push(id); return { reconcile: async () => {}, shutdown: async () => {} }; },
  });
  const timer = setInterval(() => { void handoff.reconcile(); }, 2000);
  void handoff.reconcile();
  try {
    await started; await checked;
    journals[1].child!.ended = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(adopted).toEqual(['run-1']);
    let stopped = false;
    const stopping = handoff.shutdown('reload').then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(false);
    release(); await stopping;
    expect(stopped).toBe(true);
  } finally { clearInterval(timer); release(); await handoff.shutdown('reload'); }
});

it('bounds slow terminal cleanup while journal scans continue', async () => {
  vi.useFakeTimers(); filesystem(6, true);
  let active = 0, peak = 0;
  const started: RunId[] = [];
  const hc = { get: async () => { active++; peak = Math.max(peak, active); try { await pause(); } finally { active--; } } };
  const handoff = createJobHandoff({ root, owner, hc: hc as unknown as HcClient,
    closeAgentConsoles: async child => { started.push(child.runId); await hc.get(); }, adopt: async () => { throw new Error('Empty journals need no adoption'); },
  });
  const timer = setInterval(() => { void handoff.reconcile(); }, 2000);
  void handoff.reconcile();
  try {
    await vi.advanceTimersByTimeAsync(120_000);
    expect(active).toBe(4);
    expect(peak).toBe(4);
    expect(started).toEqual(['run-0', 'run-1', 'run-2', 'run-3']);
    expect(io.open).toHaveBeenCalledTimes(366);
  } finally {
    clearInterval(timer); const stopping = handoff.shutdown('reload');
    await vi.runAllTimersAsync(); await stopping;
  }
  expect(active).toBe(0);
});

it('waits for a stalled scan on shutdown and refuses later ticks', async () => {
  vi.useFakeTimers(); filesystem();
  let release!: () => void, stopped = false;
  io.readdir.mockImplementationOnce(() => new Promise<[]>(resolve => { release = () => resolve([]); }));
  const handoff = createJobHandoff({ root, owner, hc: {} as HcClient,
    adopt: async () => { throw new Error('No journal should be adopted'); },
  });
  const scanning = handoff.reconcile();
  const stopping = handoff.shutdown('reload').then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(1);
  expect(stopped).toBe(false);
  await handoff.reconcile();
  expect(io.readdir).toHaveBeenCalledTimes(1);
  release(); await scanning; await stopping;
  expect(stopped).toBe(true);
});

it('releases the scan slot after a failed read and discovers later runs', async () => {
  filesystem(); io.readdir.mockRejectedValueOnce(new Error('Read failed'));
  const handoff = createJobHandoff({ root, owner, hc: {} as HcClient,
    processIdentity: async () => 'alive', adopt: async () => { throw new Error('Live writers must not be adopted'); },
  });
  try {
    await expect(handoff.reconcile()).rejects.toThrow('Read failed');
    await handoff.reconcile();
    expect(io.open).toHaveBeenCalledTimes(2);
    await handoff.reconcile();
    expect(io.open).toHaveBeenCalledTimes(4);
  } finally { await handoff.shutdown('reload'); }
});
