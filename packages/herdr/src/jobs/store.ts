// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JobRecord, JobId, Owner, SessionId, RunId, TerminalFinish } from '../contracts.js';
import type { ChildJobWriter } from './handoff.js';
import { HerdrError, object, text, integer, nullableInteger, nullableText, absolutePath } from '../client/parse.js';

export interface JournalJob extends JobRecord {
  nonce: string;
  releaseDeadlineAt: number;
  originalFinish: TerminalFinish | null;
  output: { complete: boolean; summary: string } | null;
  callerOwned: boolean;
  uncertain: boolean;
  evidenceConflict: boolean;
  noticeDelivered: boolean;
  settledMarked: boolean;
  terminalExpired: boolean;
  terminalReleased?: boolean;
  updatedAt: number;
  handoffCancelled?: boolean;
}
export interface JobJournalWriter {
  pid: number;
  startIdentity: string;
  shutdown: 'reload' | 'quit' | null;
  /** Fixed before taking over, so retries never cancel the new caller's jobs. */
  crashJobs?: JobId[];
}
export interface JobJournal { version: 1; sessionId: SessionId; revision: number; updatedAt: number; jobs: JournalJob[]; child?: ChildJobWriter & { ended: boolean; settled?: boolean }; writer?: JobJournalWriter }
const MAX_BYTES = 1024 * 1024;
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new HerdrError('invalid-journal', 'Expected a journal boolean'); return value;
}
function id(value: unknown): string {
  const s = text(value); if (!/^[a-zA-Z0-9_-]{1,160}$/.test(s)) throw new HerdrError('invalid-journal', 'Invalid journal identifier'); return s;
}
export function parseFinish(value: unknown): TerminalFinish {
  const v = object(value);
  const result = { exitCode: nullableInteger(v.exitCode), reason: text(v.reason), signal: nullableInteger(v.signal), finishedAt: integer(v.finishedAt) };
  if (result.finishedAt < 0 || (result.exitCode !== null && result.signal !== null)) throw new HerdrError('invalid-journal', 'Conflicting result fields');
  return result;
}
function parseOwner(value: unknown): Owner {
  const o = object(value), t = object(o.terminal);
  return { sessionId: id(o.sessionId) as Owner['sessionId'], generation: id(o.generation) as Owner['generation'], cwd: absolutePath(o.cwd), sessionFile: o.sessionFile === null ? null : absolutePath(o.sessionFile), name: nullableText(o.name), terminal: {
    coreId: text(t.coreId) as Owner['terminal']['coreId'], terminalId: text(t.terminalId) as Owner['terminal']['terminalId'], address: text(t.address) as Owner['terminal']['address'], socket: absolutePath(t.socket), sessionNamespace: text(t.sessionNamespace),
  } };
}
export function parseJobJournal(value: unknown, sessionId: SessionId): JobJournal {
  const j = object(value);
  if (j.version !== 1 || j.sessionId !== sessionId || !Array.isArray(j.jobs)) throw new HerdrError('invalid-journal', 'Unknown or foreign job journal');
  const jobs = j.jobs.map((value): JournalJob => {
    const v = object(value), owner = parseOwner(v.owner), p = object(v.phase);
    if (v.version !== 1 || owner.sessionId !== sessionId || !['exec', 'exec-file', 'batch'].includes(String(v.kind)) || !['pending', 'submitted', 'observed'].includes(String(v.notice)) || !['tool', 'async'].includes(String(v.noticeMode))) throw new HerdrError('invalid-journal', 'Invalid or foreign job');
    let phase: JobRecord['phase'];
    const address = () => text(p.address) as Owner['terminal']['address'];
    switch (p.kind) {
      case 'preparing': phase = { kind: 'preparing' }; break;
      case 'waiting-for-pane': phase = { kind: 'waiting-for-pane', address: address() }; break;
      case 'running': phase = { kind: 'running', address: address(), releasedAt: integer(p.releasedAt) }; break;
      case 'disconnected': phase = { kind: 'disconnected', address: address(), lastSeq: integer(p.lastSeq) }; break;
      case 'finished': phase = { kind: 'finished', address: address(), result: parseFinish(p.result) }; break;
      case 'launch-failed': phase = { kind: 'launch-failed', error: text(p.error) }; break;
      default: throw new HerdrError('invalid-journal', 'Invalid job phase');
    }
    const evidence = v.exitEvidence === undefined ? undefined : object(v.exitEvidence);
    const exitEvidence = evidence ? { native: parseFinish(evidence.native), receipt: parseFinish(evidence.receipt) } : undefined;
    if (exitEvidence && v.evidenceConflict !== true) throw new HerdrError('invalid-journal', 'Exit evidence requires a conflicted job');
    const output = v.output === null ? null : object(v.output);
    if (output && typeof output.summary !== 'string') throw new HerdrError('invalid-journal', 'Invalid output summary');
    if (v.commandPreview !== undefined && (typeof v.commandPreview !== 'string' || v.commandPreview.length > 180 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v.commandPreview))) throw new HerdrError('invalid-journal', 'Invalid command preview');
    return { version: 1, ...(v.terminalReleased === undefined ? {} : { terminalReleased: boolean(v.terminalReleased) }), ...(exitEvidence ? { exitEvidence } : {}), ...(v.commandPreview === undefined ? {} : { commandPreview: v.commandPreview as string }), id: id(v.id) as JobId, ...(v.runId === undefined ? {} : { runId: id(v.runId) as RunId }), ...(v.handoffCancelled === undefined ? {} : { handoffCancelled: boolean(v.handoffCancelled) }), owner, machine: text(v.machine) as JobRecord['machine'], kind: v.kind as JobRecord['kind'], phase, viewer: nullableText(v.viewer) as JobRecord['viewer'], remoteDirectory: typeof v.remoteDirectory === 'string' && v.remoteDirectory === '' ? '' : absolutePath(v.remoteDirectory), localDirectory: absolutePath(v.localDirectory), detached: boolean(v.detached), noticeMode: v.noticeMode as JobRecord['noticeMode'], notice: v.notice as JobRecord['notice'], nonce: typeof v.nonce === 'string' ? v.nonce : text(v.nonce), releaseDeadlineAt: integer(v.releaseDeadlineAt), originalFinish: v.originalFinish === null ? null : parseFinish(v.originalFinish), output: output ? { complete: boolean(output.complete), summary: output.summary as string } : null, callerOwned: boolean(v.callerOwned), uncertain: boolean(v.uncertain), evidenceConflict: boolean(v.evidenceConflict), noticeDelivered: boolean(v.noticeDelivered), settledMarked: boolean(v.settledMarked), terminalExpired: boolean(v.terminalExpired), updatedAt: integer(v.updatedAt) };
  });
  if (new Set(jobs.map(j => j.id)).size !== jobs.length) throw new HerdrError('invalid-journal', 'Duplicate journal job');
  let child: JobJournal['child'];
  if (j.child !== undefined) {
    const c = object(j.child); const pid = integer(c.pid);
    if (pid <= 0) throw new HerdrError('invalid-journal', 'Invalid child writer pid');
    child = { id: id(c.id) as RunId, pid, startIdentity: text(c.startIdentity), ended: boolean(c.ended), ...(c.settled === undefined ? {} : { settled: boolean(c.settled) }) };
    if (jobs.some(job => job.runId !== child!.id)) throw new HerdrError('invalid-journal', 'Foreign run in child journal');
  }
  let writer: JobJournalWriter | undefined;
  if (j.writer !== undefined) {
    const w = object(j.writer), pid = integer(w.pid);
    if (pid <= 0 || ![null, 'reload', 'quit'].includes(w.shutdown as null | string)) throw new HerdrError('invalid-journal', 'Invalid job writer');
    if (w.crashJobs !== undefined && !Array.isArray(w.crashJobs)) throw new HerdrError('invalid-journal', 'Invalid crash recovery jobs');
    writer = { pid, startIdentity: text(w.startIdentity), shutdown: w.shutdown as JobJournalWriter['shutdown'],
      ...(w.crashJobs === undefined ? {} : { crashJobs: (w.crashJobs as unknown[]).map(value => id(value) as JobId) }),
    };
  }
  return { version: 1, sessionId, revision: integer(j.revision), updatedAt: integer(j.updatedAt), jobs, ...(child ? { child } : {}), ...(writer ? { writer } : {}) };
}
/** All existing components must be real directories, never symbolic links. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new HerdrError('invalid-journal-root', 'A journal root must be absolute');
  let current = parse(path).root;
  for (const component of resolve(path).slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const st = await lstat(current); if (!st.isDirectory() || st.isSymbolicLink()) throw new HerdrError('unsafe-journal-path', 'Journal directories cannot be symlinks');
  }
  await chmod(path, 0o700);
}
export interface JobStore { path: string; directory: string; read(): Promise<JobJournal>; write(journal: JobJournal): Promise<void> }
export function createJobStore(root: string, sessionId: SessionId, runId?: RunId): JobStore {
  id(sessionId); if (runId !== undefined) id(runId);
  const directory = runId === undefined ? join(root, 'sessions', sessionId) : join(root, 'sessions', sessionId, 'runs', runId), path = join(directory, 'jobs.json');
  return {
    path, directory,
    read: async (): Promise<JobJournal> => {
      await ensurePrivateDirectory(directory);
      let file;
      try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessionId, revision: 0, updatedAt: 0, jobs: [] }; throw error; }
      try {
        const st = await file.stat(); if (!st.isFile() || st.size > MAX_BYTES) throw new HerdrError('invalid-journal', 'Job journal is not a bounded file');
        const bytes = Buffer.alloc(MAX_BYTES + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_BYTES) throw new HerdrError('journal-too-large', 'Job journal exceeds 1 MiB');
        return parseJobJournal(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead))), sessionId);
      } finally { await file.close(); }
    },
    write: async (journal: JobJournal): Promise<void> => {
      const bytes = Buffer.from(JSON.stringify(journal)); if (bytes.length > MAX_BYTES) throw new HerdrError('journal-too-large', 'Job journal exceeds 1 MiB');
      await ensurePrivateDirectory(directory);
      try { if (!(await lstat(path)).isFile()) throw new HerdrError('unsafe-journal-path', 'Refusing a non-file journal'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const temporary = join(directory, `.jobs-${randomUUID()}.json`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      try { await rename(temporary, path); const dir = await open(directory, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); } }
      finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    },
  };
}
