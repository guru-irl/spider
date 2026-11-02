// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Disposable, JobId, Owner } from '../contracts.js';
import { createJobMonitor, type JobMonitor, type JobMonitorOptions } from './monitor.js';
import { HerdrError } from '../client/parse.js';
export interface JobRegistrationPorts {
  currentOwner(ctx: ExtensionContext): Owner | null;
  monitorOptions(owner: Owner, ctx: ExtensionContext): Omit<JobMonitorOptions, 'notifier' | 'observedJobMessages'>;
  bind(monitor: JobMonitor | null): void;
  jobIdsForToolResult(result: unknown): readonly JobId[];
}
function noticeId(value: unknown): JobId | null {
  if (!value || typeof value !== 'object' || !('customType' in value) || value.customType !== 'spider.job_done' || !('details' in value)) return null;
  const details = value.details;
  if (!details || typeof details !== 'object' || !('jobId' in details) || typeof details.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(details.jobId)) return null;
  return details.jobId as JobId;
}
export function registerHerdrJobs(pi: ExtensionAPI, ports: JobRegistrationPorts): Disposable {
  let monitor: JobMonitor | null = null;
  let activation = 0;
  let disposed = false;
  async function stop(reason: 'reload' | 'quit'): Promise<void> {
    const previous = monitor; monitor = null; activation++; ports.bind(null);
    await previous?.shutdown(reason);
  }
  const subscriptions = [
    pi.on('session_start', async (event, ctx) => {
      if (disposed) return;
      await stop(event?.reason === 'reload' ? 'reload' : 'quit');
      const owner = ports.currentOwner(ctx);
      if (!owner) return;
      const generation = activation;
      const options = ports.monitorOptions(owner, ctx);
      const next = createJobMonitor({ ...options,
        observedJobMessages: async () => (ctx?.sessionManager?.getBranch?.() ?? []).flatMap(entry => { const id = noticeId(entry); return id ? [id] : []; }),
        notifier: notice => {
          if (disposed || generation !== activation) throw new HerdrError('activation-ended', 'Notice remains uncertain after its owning activation ended');
          pi.sendMessage(notice, { triggerTurn: true, deliverAs: 'followUp' });
        },
      });
      try { await next.activate(owner); monitor = next; ports.bind(next); }
      catch (error) { await next.shutdown('reload'); options.reportError?.(error); }
    }),
    pi.on('session_shutdown', async event => { await stop(event?.reason === 'reload' ? 'reload' : 'quit'); }),
    pi.on('tool_execution_end', async event => {
      const current = monitor; if (!current) return;
      for (const id of ports.jobIdsForToolResult(event?.result)) await current.toolReturned(id);
    }),
    pi.on('message_end', async event => {
      const current = monitor, id = noticeId(event?.message); if (!current || !id) return;
      try { await current.consumeNotice(id); }
      catch (error) { if (!(error instanceof HerdrError && error.code === 'job-not-owned')) throw error; }
    }),
  ];
  return { dispose: async () => { if (disposed) return; disposed = true; for (const unsubscribe of subscriptions) unsubscribe(); await stop('quit'); } };
}
