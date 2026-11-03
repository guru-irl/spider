// SPDX-License-Identifier: MIT
import { open, type FileHandle } from 'node:fs/promises';
import type { Generation, JobId, Owner } from '../contracts.js';
import { HerdrError } from '../client/parse.js';
import type { JobJournal, JournalJob } from './store.js';

export interface JobNoticeIdentity { jobId: JobId; nonce?: string; generation?: Generation }
export function jobNoticeIdentity(value: unknown): JobNoticeIdentity | null {
  if (!value || typeof value !== 'object' || !('customType' in value) || value.customType !== 'spider.job_done' || !('details' in value)) return null;
  const details = value.details;
  if (!details || typeof details !== 'object' || !('jobId' in details) || typeof details.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(details.jobId)) return null;
  const nonce = 'nonce' in details ? details.nonce : undefined, generation = 'generation' in details ? details.generation : undefined;
  if (nonce !== undefined && (typeof nonce !== 'string' || !nonce || nonce.length > 160)) return null;
  if (generation !== undefined && (typeof generation !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(generation))) return null;
  return { jobId: details.jobId as JobId, ...(nonce === undefined ? {} : { nonce }), ...(generation === undefined ? {} : { generation: generation as Generation }) };
}
function openSavedSession(path: string, signal?: AbortSignal): Promise<FileHandle> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, file?: FileHandle) => {
      if (settled) { if (file) void file.close().catch(() => {}); return; }
      settled = true; clearTimeout(deadline); signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(file!);
    };
    const aborted = () => finish(new HerdrError('aborted', 'Saved notice recovery stopped'));
    const deadline = setTimeout(() => finish(new HerdrError('session-read-timeout', 'Saved session open timed out')), 1000);
    signal?.addEventListener('abort', aborted, { once: true });
    void open(path, 'r').then(file => finish(undefined, file), error => finish(error));
    if (signal?.aborted) aborted();
  });
}
async function savedNotices(owner: Owner, expected: ReadonlyMap<JobId, string>, signal?: AbortSignal): Promise<Set<JobId>> {
  let file;
  try { file = await openSavedSession(owner.sessionFile!, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set(); throw error; }
  const lines = file.readLines({ autoClose: false, signal }), notices = new Set<JobId>();
  let header = false;
  try {
    for await (const line of lines) {
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (value && typeof value === 'object' && 'type' in value && value.type === 'session') {
        if (!('id' in value) || value.id !== owner.sessionId) throw new HerdrError('invalid-journal', 'Saved session identity does not match the job owner');
        header = true;
      }
      const notice = value && typeof value === 'object' && 'type' in value && value.type === 'custom_message' ? jobNoticeIdentity(value) : null;
      if (notice && expected.has(notice.jobId) && (notice.nonce === expected.get(notice.jobId) || notice.nonce === undefined)) notices.add(notice.jobId);
    }
    if (!header) throw new HerdrError('invalid-journal', 'Saved session identity could not be verified');
    return notices;
  } finally { lines.close(); await file.close(); }
}
export function noticeRecoveryCandidates(journal: JobJournal, owner: Owner): JournalJob[] {
  if (journal.child || !owner.sessionFile) return [];
  return journal.jobs.filter(job => job.noticeMode === 'async' && (job.notice === 'observed' || job.notice === 'submitted') && job.noticeSavedNonce !== job.nonce && (job.noticeObservedGeneration ?? job.owner.generation) !== owner.generation);
}
/** Read outside the journal queue. Apply the result only through its writer. */
export async function recoverJobNotices(jobs: readonly JournalJob[], owner: Owner, signal?: AbortSignal): Promise<() => void> {
  const saved = await savedNotices(owner, new Map(jobs.map(job => [job.id, job.nonce])), signal);
  return () => {
    for (const job of jobs) {
      if (job.notice !== 'observed' && job.notice !== 'submitted' || job.noticeSavedNonce === job.nonce || job.noticeObservedGeneration === owner.generation) continue;
      if (!saved.has(job.id)) { job.notice = 'pending'; job.noticeDelivered = false; delete job.noticeObservedGeneration; }
      else { job.notice = 'observed'; job.noticeDelivered = true; job.noticeObservedGeneration = owner.generation; job.noticeSavedNonce = job.nonce; }
    }
  };
}
