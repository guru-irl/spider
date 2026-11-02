// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Every fixture process starts here: its own process group, recorded in the ledger by PID and start identity.
import { spawn, execFileSync, type ChildProcess, type StdioOptions } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { processStart, spawnedIdentity, type LedgerHandle, type ProcessIdentity } from './resources.js';
import { HarnessError } from './environment.js';
import { waitFor, deadline as makeDeadline, type Deadline } from './wait.js';

export interface OwnedProcess {
  readonly label: string; readonly identity: ProcessIdentity; readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(limit?: Deadline): Promise<void>;
}
export interface SpawnOwnedOptions {
  label: string; command: string; args: readonly string[]; env: Record<string, string>; cwd: string;
  /** Apps and other actors that can start a core must opt in to the first teardown phase. */
  startsCores?: boolean;
  /** 'pipe' keeps stdin/stdout piped (RPC); a log path sends stdout and stderr to that file. */
  stdio: 'pipe' | { log: string }; stderrLog?: string;
}

function groupMembers(identity: ProcessIdentity): number[] {
  const current = processStart(identity.pid);
  if (current !== null && current !== identity.start) throw new HarnessError('process-identity-changed', `${identity.pid} no longer belongs to this fixture`);
  const output = execFileSync('ps', ['-ax', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TMPDIR: process.env.TMPDIR } });
  return output.split('\n').flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    return row && Number(row[2]) === identity.pid && !row[3].startsWith('Z') ? [Number(row[1])] : [];
  });
}

export async function stopProcessGroup(identity: ProcessIdentity, label: string, limit: Deadline = makeDeadline(5000)): Promise<void> {
  const signal = (name: NodeJS.Signals) => {
    if (!groupMembers(identity).length) return;
    try { process.kill(-identity.pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  signal('SIGTERM');
  try { await waitFor(`${label} process group exits after SIGTERM`, () => groupMembers(identity), members => members.length === 0, limit, { reconcileMs: 50 }); }
  catch (error) {
    if (!(error instanceof HarnessError) || error.code !== 'wait-deadline') throw error;
    signal('SIGKILL');
    await waitFor(`${label} process group exits after SIGKILL`, () => groupMembers(identity), members => members.length === 0, makeDeadline(5000), { reconcileMs: 50 });
  }
}

export function spawnOwned(ledger: LedgerHandle, options: SpawnOwnedOptions): OwnedProcess {
  let stdio: StdioOptions; const opened: number[] = [];
  const open = (path: string) => { mkdirSync(dirname(path), { recursive: true }); const fd = openSync(path, 'a'); opened.push(fd); return fd; };
  if (options.stdio === 'pipe') stdio = ['pipe', 'pipe', options.stderrLog ? open(options.stderrLog) : 'pipe'];
  else { const fd = open(options.stdio.log); stdio = ['ignore', fd, fd]; }
  const child = spawn(options.command, [...options.args], { cwd: options.cwd, env: options.env, stdio, detached: true });
  for (const fd of opened) closeSync(fd);
  if (!child.pid) throw new HarnessError('spawn-failed', `${options.label}: ${options.command}`);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let identity: ProcessIdentity;
  try { identity = spawnedIdentity(child.pid); } catch (error) { child.kill('SIGKILL'); throw error; }
  ledger.update(l => { l.processes.push({ ...identity, label: options.label, group: true, ...(options.startsCores ? { startsCores: true } : {}) }); });
  return {
    label: options.label, identity, child, exited,
    async stop(limit = makeDeadline(5000)) {
      await stopProcessGroup(identity, options.label, limit);
      await waitFor(`${options.label} child exit event is observed`, () => child.exitCode !== null || child.signalCode !== null, Boolean, makeDeadline(5000), { reconcileMs: 50 });
      await exited;
    },
  };
}

/** Strict LF-framed JSON records. Unicode separators stay inside records. Malformed input is a failure, never skipped. */
export function jsonLines(onRecord: (value: unknown) => void, onMalformed: (line: string, error: unknown) => void): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    for (let index = pending.indexOf(10); index !== -1; index = pending.indexOf(10)) {
      let line = pending.subarray(0, index).toString('utf8'); pending = pending.subarray(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch (error) { onMalformed(line, error); continue; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { onMalformed(line, new Error('record is not an object')); continue; }
      onRecord(value);
    }
  };
}
