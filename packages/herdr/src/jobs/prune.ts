// SPDX-License-Identifier: MIT
import { join } from 'node:path';
import type { JobId } from '../contracts.js';
import type { JobJournal, JournalJob } from './store.js';

export const RECENT_JOB_BUDGET = 64;
export interface JobPruneContext {
  directory: string;
  now: number;
  recoveringNotices: ReadonlySet<JobId>;
  holds: ReadonlyMap<JobId, unknown>;
  unreturned: ReadonlySet<JobId>;
}
/** Age-based cleanup keeps its original rule. Early eviction requires fully settled ownership. */
export function jobPruneCandidates(journal: JobJournal, context: JobPruneContext, pressure = false): JournalJob[] {
  const expired: JournalJob[] = [], recent: JournalJob[] = [];
  for (const job of journal.jobs) {
    if (context.recoveringNotices.has(job.id) || job.phase.kind !== 'finished' || job.notice !== 'observed' || !job.output?.complete) continue;
    if (job.localDirectory !== join(context.directory, 'logs', job.id)) continue;
    if (!job.callerOwned && !job.detached && context.now - job.updatedAt > 7 * 86400000) {
      expired.push(job);
    } else if (job.terminalReleased && job.settledMarked && !job.uncertain && !job.evidenceConflict && !job.handoffCancelled && !context.holds.has(job.id) && !context.unreturned.has(job.id) && !journal.writer?.crashJobs?.includes(job.id)) {
      recent.push(job);
    }
  }
  // Stable ordering retains the latest inserted result when completion times tie.
  recent.sort((a, b) => a.updatedAt - b.updatedAt);
  return [...expired, ...recent.slice(0, pressure ? recent.length : Math.max(0, recent.length - RECENT_JOB_BUDGET))
    .filter(job => pressure || context.now - job.updatedAt >= 10 * 60000)]
    .sort((a, b) => a.updatedAt - b.updatedAt);
}
