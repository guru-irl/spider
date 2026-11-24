// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import * as hcModule from '../../../herdr/src/client/hc.js';
import { createJobStore, type JournalJob } from '../../../herdr/src/jobs/store.js';
import type { JobId, MachineName, RunId, TerminalAddress } from '../../../herdr/src/contracts.js';
import { mountedFixture } from './herdr-wiring-fixture.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([false, true])('a mounted host wakes delayed job cleanup after a verified remote read (child=%s)', async child => {
  const clients: ReturnType<typeof hcModule.createHcClient>[] = [];
  const createClient = hcModule.createHcClient;
  vi.spyOn(hcModule, 'createHcClient').mockImplementation((options, available) => {
    const client = createClient(options, available);
    if (options.binary.endsWith('/recorded-hc')) clients.push(client);
    return client;
  });
  const machine = 'remote.invalid' as MachineName;
  const runId = 'fixture-run' as RunId;
  const input = '/home/fixture/recovery';
  let now = 0;
  let clock: { mockRestore(): void } | undefined;
  const f = await mountedFixture('fake', 'tui', true, child, true, child, true, false, false, true, undefined, {
    beforeStart: async h => {
      if (child) {
        vi.stubEnv('PI_SPIDER_TOP_SESSION_ID', h.owner!.sessionId);
        vi.stubEnv('PI_SUBAGENT_RUN_ID', runId);
      }
      await h.scenario({ files: { [input]: 'reachable' } }, 'remote');
      now = Date.now();
      clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      const owner = h.owner!;
      const address = 'remote.invalid/fixture-missing' as TerminalAddress;
      const job: JournalJob = {
        version: 1, id: 'fixture-job' as JobId, ...(child ? { runId } : {}), owner, machine, kind: 'exec',
        phase: { kind: 'launch-failed', error: 'Launch failed' }, viewer: null,
        remoteDirectory: '/home/fixture/job', localDirectory: join(h.root, 'job-logs'), detached: false,
        noticeMode: 'async', notice: 'observed', nonce: 'fixture-nonce', releaseDeadlineAt: 0,
        originalFinish: null, output: null, callerOwned: false, uncertain: false, evidenceConflict: false,
        noticeDelivered: true, settledMarked: false, terminalExpired: false,
        failedTerminalCleanup: { address, attempts: 0, connectivityFailures: 1, nextAt: now + 3_600_000 }, updatedAt: now,
      };
      const store = createJobStore(join(h.directories.global, 'herdr/jobs'), owner.sessionId, child ? runId : undefined);
      await store.write({ version: 1, sessionId: owner.sessionId, revision: 0, updatedAt: now, jobs: [job] });
    },
  });
  try {
    expect(f.mount.enabled()).toBe(true);
    expect(clients).toHaveLength(1);
    const client = clients[0];
    const store = createJobStore(join(f.config.globalRoot, 'herdr/jobs'), f.owner!.sessionId, child ? runId : undefined);
    const pending = (await store.read()).jobs[0].failedTerminalCleanup;
    expect(pending).toMatchObject({ attempts: 0, connectivityFailures: 1, nextAt: now + 3_600_000 });
    expect((await client.machines()).find(row => row.name === machine)?.state).toBe('connected');
    expect((await store.read()).jobs[0].failedTerminalCleanup).toEqual(pending);

    expect((await client.fileRead(machine, input)).toString()).toBe('reachable');
    await vi.waitFor(async () => {
      const job = (await store.read()).jobs[0];
      expect(job.terminalReleased).toBe(true);
      expect(job.failedTerminalCleanup).toBeUndefined();
    }, { timeout: 10_000 });
    expect(Date.now()).toBe(now);
  } finally { clock?.mockRestore(); await f.close(); }
}, 60_000);
