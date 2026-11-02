// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import { createJobStore, type JournalJob } from '@spider/herdr/jobs/store';
import { readChildJobJournals } from '@spider/herdr/jobs/handoff';
import { HerdrError } from '@spider/herdr/client/parse';
import { HERDR_LABELS } from '@spider/herdr';
import { atomicRuntimeFile } from '@spider/herdr/remote/runtime';
import type { HcClient, HerdrConfig, JobId, Owner, TerminalAddress, RemoteExecutionPort } from '@spider/herdr';
import { resolveMachine } from './machine.js';
import type { ActionHandler } from '../dispatch.js';
import { RunStore, matchKillTargets } from '@spider/subagents';
import { HERDR_NOTICES } from '@spider/herdr/notices';

export interface KillJobResult { jobId: JobId; machine: string; address: TerminalAddress; state: 'cancellation-requested' }

export function routeKillAction(getMount: () => { enabled(): boolean; findKillJobs(id: string): Promise<Array<{ id: string }>>; killJob(id: string): Promise<KillJobResult> } | undefined, fallback: ActionHandler): ActionHandler {
  return async (args, ctx) => {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    const mount = getMount();
    if (!mount?.enabled() || !id || id === 'all') return fallback(args, ctx);
    try {
      const runs = matchKillTargets(new RunStore(ctx.db, ctx.globalDb), ctx.sessionId, id);
      const jobs = await mount.findKillJobs(id);
      const exactRuns = runs.filter(run => run.id === id || run.name === id);
      const exactJobs = jobs.filter(job => job.id.toLowerCase() === id.toLowerCase());
      const exact = exactRuns.length + exactJobs.length > 0;
      const selectedRuns = exact ? exactRuns : runs, selectedJobs = exact ? exactJobs : jobs;
      if (selectedRuns.length + selectedJobs.length > 1) {
        const matches = [...selectedRuns.map(run => `subagent ${run.name ?? run.agent} (${run.id})`), ...selectedJobs.map(job => `command ${job.id}`)];
        const message = `${HERDR_NOTICES.killAmbiguous.text}\n${matches.join('\n')}`;
        return { content: message, isError: true, details: { error: message, matches } };
      }
      if (selectedRuns.length) return fallback({ ...args, id: selectedRuns[0].id }, ctx);
      if (selectedJobs.length) {
        const job = await mount.killJob(selectedJobs[0].id);
        return { content: `Cancellation requested for job ${job.jobId} on ${job.machine} (${job.address}). Wait for spider.job_done.`, details: { job } };
      }
      const message = `No active run or job owned by this session matches ${JSON.stringify(id)}.`;
      return { content: message, isError: true, details: { error: message } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: message, isError: true, details: { error: message } };
    }
  };
}

export async function findOwnedKillJobs(id: string, owner: Owner, journalRoot: string): Promise<JournalJob[]> {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) return [];
  const journals = [await createJobStore(journalRoot, owner.sessionId).read(), ...await readChildJobJournals(journalRoot, owner)];
  const matches = journals.flatMap(journal => journal.jobs).filter(job => job.phase.kind === 'running'
    && job.id.toLowerCase().startsWith(id.toLowerCase()) && job.owner.sessionId === owner.sessionId);
  const exact = matches.filter(job => job.id.toLowerCase() === id.toLowerCase());
  return exact.length ? exact : matches;
}

/** Session IPC and spider kill share this ownership-checked cancellation path. */
export async function killOwnedJob(id: string, owner: Owner, hc: HcClient, configured: HerdrConfig['machines'], journalRoot: string, remote?: RemoteExecutionPort): Promise<KillJobResult> {
  const matches = await findOwnedKillJobs(id, owner, journalRoot);
  if (matches.length > 1) throw new HerdrError('job-ambiguous', `${HERDR_NOTICES.killAmbiguous.text}\n${matches.map(job => job.id).join('\n')}`);
  const job = matches[0];
  if (!job || job.phase.kind !== 'running') throw new HerdrError('job-not-owned', 'No active job owned by this session matches that ID');
  const selected = await resolveMachine(hc, configured, job.machine);
  if (selected.on !== job.machine || !/^[a-f0-9]{32}$/.test(posix.relative(selected.machine.runtime.directory, job.remoteDirectory))) throw new HerdrError('job-owner-mismatch', 'Job destination does not match the configured runtime');
  const terminal = await hc.get(job.phase.address), labels = terminal.labels;
  if (terminal.state !== 'live' || terminal.address !== job.phase.address || labels[HERDR_LABELS.job] !== job.id || labels[HERDR_LABELS.kind] !== job.kind || labels[HERDR_LABELS.session] !== owner.sessionId || labels[HERDR_LABELS.ownerCore] !== job.owner.terminal.coreId || labels[HERDR_LABELS.ownerTerminal] !== job.owner.terminal.terminalId || (labels[HERDR_LABELS.run] ?? undefined) !== job.runId) throw new HerdrError('job-owner-mismatch', 'Original live terminal does not match this session job');
  const request = await hc.fileRead(job.machine, posix.join(job.remoteDirectory, 'request.json'));
  const expected = (await hc.fileRead(job.machine, posix.join(job.remoteDirectory, 'request.json.sha256'))).toString().trim();
  if (createHash('sha256').update(request).digest('hex') !== expected) throw new HerdrError('job-owner-mismatch', 'Job request digest does not match');
  const record: unknown = JSON.parse(request.toString());
  if (!record || typeof record !== 'object' || !('jobId' in record) || record.jobId !== job.id || !('nonce' in record) || record.nonce !== job.nonce || !/^[a-f0-9]{32}$/.test(job.nonce)) throw new HerdrError('job-owner-mismatch', 'Job request identity does not match the session journal');
  let capability: unknown;
  try { capability = JSON.parse((await hc.fileRead(job.machine, posix.join(job.remoteDirectory, 'capabilities.json'))).toString()); }
  catch (error) {
    const e = error as { code?: string; message?: string };
    if (!['ENOENT', 'not_found', 'file-not-found'].includes(e.code ?? '') && !(e.code === 'invalid_params' && /ENOENT|not found/i.test(e.message ?? ''))) throw error;
  }
  if (capability !== undefined) {
    if (!capability || typeof capability !== 'object' || !('jobId' in capability) || capability.jobId !== job.id || !('nonce' in capability) || capability.nonce !== job.nonce || !('cancelAfterRelease' in capability) || capability.cancelAfterRelease !== true) throw new HerdrError('job-owner-mismatch', 'Job cancellation capability does not match the session journal');
    await hc.fileWrite(job.machine, posix.join(job.remoteDirectory, 'cancel.json'), Buffer.from(JSON.stringify({ version: 1, jobId: job.id, nonce: job.nonce })));
  } else {
    const manual = () => new HerdrError('legacy-job-unidentifiable', `This job was started by an older spider. Its process group cannot be identified safely. Runtime path: ${job.remoteDirectory}. Stop it by hand.`);
    if (!remote || !('argv' in record) || !Array.isArray(record.argv)) throw manual();
    const paths = record.argv.filter((value): value is string => typeof value === 'string' && value.startsWith(job.remoteDirectory + '/'));
    if (!paths.length) throw manual();
    const expectedLocal = join(createJobStore(journalRoot, owner.sessionId, job.runId).directory, 'logs', job.id);
    if (job.localDirectory !== expectedLocal) throw new HerdrError('job-owner-mismatch', 'Local job log directory does not match the session journal');
    const marker = join(job.localDirectory, '.spider-kill.json'), expiresAt = Date.now() + 60000;
    const mark = (state: 'pending' | 'sent' | 'failed') => atomicRuntimeFile(marker, JSON.stringify({ version: 1, jobId: job.id, nonce: job.nonce, state, expiresAt }));
    await mark('pending');
    try {
      const code = `
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const paths = ${JSON.stringify(paths)}, uid = process.getuid();
function rows() {
  return execFileSync('ps', ['-axo', 'pid=,pgid=,uid=,lstart=,command='], { encoding: 'utf8', timeout: 3000 })
    .split('\\n').map(s => /^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+)\\s+(.*)$/.exec(s))
    .filter(Boolean).map(m => ({ pid: Number(m[1]), pgid: Number(m[2]), uid: Number(m[3]), start: m[4], command: m[5] }));
}
function hasJobPath(row) {
  if (process.platform === 'linux') {
    try {
      const args = fs.readFileSync('/proc/' + row.pid + '/cmdline', 'utf8').split(String.fromCharCode(0));
      return paths.some(path => args.includes(path));
    } catch { return false; }
  }
  return paths.some(path => {
    const at = row.command.indexOf(path), end = at + path.length;
    return at >= 0 && (at === 0 || /\\s/.test(row.command[at - 1])) && (end === row.command.length || /\\s/.test(row.command[end]));
  });
}
const before = rows(), leaders = before.filter(row => row.pid === row.pgid && row.uid === uid && hasJobPath(row));
if (leaders.length !== 1) console.log(JSON.stringify({ state: 'unidentifiable' }));
else {
  const pgid = leaders[0].pid, members = before.filter(row => row.pgid === pgid && row.uid === uid);
  try { process.kill(-pgid, 'SIGTERM'); }
  catch { console.log(JSON.stringify({ state: 'unidentifiable' })); process.exit(0); }
  setTimeout(() => {
    const after = rows();
    if (members.some(a => after.some(b => a.pid === b.pid && a.start === b.start && b.pgid === pgid && b.uid === uid))) {
      try { process.kill(-pgid, 'SIGKILL'); } catch { /* The group exited. */ }
    }
    console.log(JSON.stringify({ state: 'sent' }));
  }, 1500);
}`;
      const result = await remote.execute({ on: job.machine, owner, source: { kind: 'code', language: 'javascript', code }, timeout: 20000 });
      if (result.outcome !== 'exited' || result.exitCode !== 0 || JSON.parse(result.stdout).state !== 'sent') throw manual();
      await mark('sent');
    } catch (error) { await mark('failed'); if (error instanceof HerdrError && error.code === 'legacy-job-unidentifiable') throw error; throw manual(); }
  }
  return { jobId: job.id, machine: job.machine, address: job.phase.address, state: 'cancellation-requested' };
}
