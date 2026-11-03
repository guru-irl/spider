// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Disposable, JobId, Owner } from '../contracts.js';
import { createJobMonitor, type JobMonitor, type JobMonitorOptions } from './monitor.js';
import { HerdrError } from '../client/parse.js';
import { jobNoticeIdentity } from './notices.js';
export interface JobRegistrationPorts {
  currentOwner(ctx: ExtensionContext): Owner | null;
  monitorOptions(owner: Owner, ctx: ExtensionContext): Omit<JobMonitorOptions, 'notifier' | 'observedJobMessages'>;
  bind(monitor: JobMonitor | null): void;
  activationFailed?(error: unknown): void;
  jobIdsForToolResult(result: unknown): readonly JobId[];
}
export function registerHerdrJobs(pi: ExtensionAPI, ports: JobRegistrationPorts): Disposable {
  let monitor: JobMonitor | null = null;
  let ownerGeneration: Owner['generation'] | null = null;
  let activation = 0;
  let disposed = false;
  async function stop(reason: 'reload' | 'quit'): Promise<void> {
    const previous = monitor; monitor = null; ownerGeneration = null; activation++; ports.bind(null);
    await previous?.shutdown(reason);
  }
  const subscriptions = [
    pi.on('session_start', async (event, ctx) => {
      if (disposed) return;
      const stopping = stop(event?.reason === 'reload' ? 'reload' : 'quit'), generation = activation;
      await stopping;
      if (disposed || generation !== activation) return;
      const owner = ports.currentOwner(ctx);
      if (!owner) return;
      const options = ports.monitorOptions(owner, ctx);
      const next = createJobMonitor({ ...options,
        observedJobMessages: async () => (ctx?.sessionManager?.getBranch?.() ?? []).flatMap(entry => { const notice = jobNoticeIdentity(entry); return notice?.generation === owner.generation ? [notice.jobId] : []; }),
        notifier: notice => {
          if (disposed || generation !== activation) throw new HerdrError('activation-ended', 'Notice remains uncertain after its owning activation ended');
          // A busy agent reads follow-ups only after all its work ends, so it would keep waiting on a finished job.
          // Steering arrives when the current step ends. From pi 1.2 on it cancels no tool calls.
          pi.sendMessage(notice, { triggerTurn: true, deliverAs: 'steer' });
        },
      });
      try {
        await next.activate(owner);
        if (disposed || generation !== activation) { await next.shutdown('reload'); return; }
        monitor = next; ownerGeneration = owner.generation; ports.bind(next);
      }
      catch (error) {
        const current = !disposed && generation === activation;
        if (current) ports.activationFailed?.(error);
        try { await next.shutdown('reload'); }
        finally { if (current) options.reportError?.(error); }
      }
    }),
    pi.on('session_shutdown', async event => { await stop(event?.reason === 'reload' ? 'reload' : 'quit'); }),
    pi.on('tool_execution_end', async event => {
      const current = monitor; if (!current) return;
      for (const id of ports.jobIdsForToolResult(event?.result)) await current.toolReturned(id);
    }),
    pi.on('message_end', async event => {
      const current = monitor, notice = jobNoticeIdentity(event?.message); if (!current || !notice || notice.generation !== ownerGeneration) return;
      try { await current.consumeNotice(notice.jobId); }
      catch (error) { if (!(error instanceof HerdrError && error.code === 'job-not-owned')) throw error; }
    }),
  ];
  return { dispose: async () => { if (disposed) return; disposed = true; for (const unsubscribe of subscriptions) unsubscribe(); await stop('quit'); } };
}
