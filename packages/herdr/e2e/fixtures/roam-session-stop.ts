// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, readlink, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { openDbReadOnly } from '@spider/db-core';
import { readManifestSafe, readReceiptSafe, type BackgroundManifest, type BackgroundReceipt } from '../../../context/src/background-job.js';
import type { OwnerGeneration } from '../../../roam/src/relocate/session-stop-types.js';
import { inspectIdLock, localBootId } from '../../src/sessions/id-lock.js';
import { createSessionLeases } from '../../src/sessions/lease.js';
import type { HcRecord } from '../harness/hc.js';
import { observe, readObserved } from '../harness/pi.js';
import { processStart } from '../harness/resources.js';
import type { Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';
import { mark } from './child-scripts.js';
import { shellQuote } from './payloads/index.js';
import { relocateFixture, type RelocateFixture } from './roam-relocate.js';
import { verifyRelocatedTranscript } from './relocate-transcript.js';

export interface CliResult { exitCode: number | null; stdout: string; stderr: string }
type Machine = RelocateFixture['hub'];
type Home = ReturnType<RelocateFixture['home']>;
type CheckoutIdentity = { device: string; inode: string; git: Awaited<ReturnType<RelocateFixture['gitState']>> };
interface ProcessRow { pid: number; parent: number; group: number; startIdentity: string }
interface JobEvidence { manifest: BackgroundManifest; receipt: BackgroundReceipt | undefined; live: OwnerGeneration[] }
interface NativeTerminal { address: string; pid: number; state: 'live'; cwd: string; argv: string[]; labels: Record<string, string> }
interface SideProof {
  home: Home;
  lock: Awaited<ReturnType<typeof inspectIdLock>>;
  lease: Awaited<ReturnType<ReturnType<typeof createSessionLeases>['get']>>;
  terminals: NativeTerminal[];
}

export interface StopFixtureProof {
  sessionId: string;
  file: string;
  cwd: string;
  transcriptPrefixHash: string;
  liveOwnerCount: number;
  liveOwned: readonly OwnerGeneration[];
  owner: OwnerGeneration | null;
  runs: readonly { id: string; status: string }[];
  jobs: readonly { id: string; exitVerified: boolean }[];
  jobEvidence: readonly JobEvidence[];
  hub: SideProof;
  box: SideProof;
}

export interface SessionStopFixture {
  sessionId: string;
  hub: Machine;
  box: Machine;
  cli(...args: string[]): Promise<CliResult>;
  partition(down: boolean): Promise<void>;
  proof(): Promise<StopFixtureProof>;
  checkoutIdentity(): Promise<CheckoutIdentity>;
  prompt(marker: string, callId: string): Promise<void>;
  supervisorScanAfter(after: number): Promise<HcRecord>;
  close(): Promise<void>;
}

/** A single OS snapshot includes detached descendants that have been reparented. */
function liveProcesses(): Map<number, ProcessRow> {
  const output = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,pgid=,stat=,lstart='],
    { encoding: 'utf8', env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } });
  const rows = new Map<number, ProcessRow>();
  for (const line of output.trimEnd().split('\n')) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*)$/.exec(line);
    if (!fields) throw new Error('Invalid process inventory row');
    const [, pid, parent, group, state, startIdentity] = fields;
    if (!state.startsWith('Z')) rows.set(Number(pid), { pid: Number(pid), parent: Number(parent), group: Number(group), startIdentity });
  }
  return rows;
}

function liveAt(row: ProcessRow, recordedAt: number): boolean {
  return Math.floor(recordedAt / 1000) * 1000 >= Date.parse(`${row.startIdentity} UTC`);
}

async function labelledTerminals(suite: Suite, machine: Machine, sessionId: string): Promise<NativeTerminal[]> {
  const result = await suite.hc(['ls', '--all', '--json', '--label', `spider.session=${sessionId}`], machine.side);
  expect(result.exitCode, result.stderr).toBe(0);
  const list = (result.json as { terminals: { address: string; state: string }[] }).terminals;
  expect(Array.isArray(list)).toBe(true);
  const found: NativeTerminal[] = [];
  for (const row of list) {
    if (row.state !== 'live' || row.address.includes('/')) continue;
    const detail = await suite.hc(['get', row.address, '--json'], machine.side);
    if ((detail.json as { error?: { kind?: string } } | null)?.error?.kind === 'not_found') continue;
    expect(detail.exitCode, detail.stderr).toBe(0);
    const terminal = detail.json as NativeTerminal;
    if (terminal.state === 'live') found.push(terminal);
  }
  return found;
}

export async function sessionStopFixture(suite: Suite): Promise<SessionStopFixture> {
  const cores = suite.cores;
  if (!cores || process.platform !== 'linux') throw new Error('Session Stop needs the two owned Linux fixture cores');
  const route = suite.ownPath(join(suite.root, 'stop-route.json'));
  const wrapper = suite.ownPath(join(suite.root, 'bin', 'stop-hc'));
  const fault = fileURLToPath(new URL('./roam-hc-fault.mjs', import.meta.url));
  await writeFile(wrapper, `#!/bin/sh
SPIDER_E2E_FIXTURE_ROOT=${shellQuote(suite.root)} SPIDER_E2E_HC_REAL=${shellQuote(cores.wrapper)} SPIDER_E2E_HC_FAULT=${shellQuote(route)} SPIDER_E2E_STOP_ROUTE=${shellQuote(cores.machine)} exec ${shellQuote(process.execPath)} ${shellQuote(fault)} "$@"
`, { mode: 0o700 });
  let partitions = 0;
  const partition = async (down: boolean) => {
    const next = suite.ownPath(`${route}.new`);
    await writeFile(next, JSON.stringify({ down: down ? [cores.machine] : [] }), { mode: 0o600 });
    await rename(next, route);
    await suite.evidence(`stop-route-${++partitions}.json`, { at: Date.now(), machine: cores.machine, down });
  };
  await partition(false);
  const fixture = await relocateFixture(suite, { hubCoreWrapper: wrapper });
  const { hub, box, original } = fixture;
  const { sessionId } = original;
  const close = async () => {
    try { await partition(false); }
    finally { await fixture.close(); }
  };
  try {
    const sourceBytes = await readFile(original.file);
    await suite.evidence('stop-source.jsonl', sourceBytes);
    const placement = await fixture.relocate(sessionId, cores.machine);
    const { file, cwd } = await fixture.owner(box, placement.terminal, sessionId, placement);
    const initialBytes = await readFile(file);
    const transcript = verifyRelocatedTranscript(sourceBytes, initialBytes, sessionId, original.cwd, cwd);
    await suite.evidence('stop-relocated-transcript.json', transcript);
    await suite.evidence('stop-relocated.jsonl', initialBytes);
    const bootId = await localBootId();
    if (!bootId) throw new Error('The fixture boot ID is unavailable');
    const supervisor = suite.ledger.read().processes.find(row => row.label === 'v0-supervisor');
    if (!supervisor) throw new Error('The packaged supervisor is not in the ledger');
    let cliCalls = 0;
    const cli: SessionStopFixture['cli'] = async (...args) => {
      const { exitCode, stdout, stderr } = await suite.invoke(process.execPath, [suite.packed.roamCli, 'roam', ...args], hub.env);
      const result = { exitCode, stdout, stderr };
      await suite.evidence(`stop-cli-${++cliCalls}.json`, { args, ...result });
      return result;
    };

    const tracked = new Map<string, OwnerGeneration>();
    const generation = ({ pid, startIdentity }: ProcessRow): OwnerGeneration => ({ pid, startIdentity, bootId });
    const key = ({ pid, startIdentity }: OwnerGeneration) => `${pid}:${startIdentity}`;
    const track = (row: ProcessRow, label: string, group = false) => {
      const identity = generation(row);
      if (!tracked.has(key(identity))) {
        suite.ledger.update(ledger => {
          if (!ledger.processes.some(actor => actor.pid === row.pid && actor.start === row.startIdentity)) {
            ledger.processes.push({ pid: row.pid, start: row.startIdentity, label, group });
          }
        });
        tracked.set(key(identity), identity);
      }
      return identity;
    };

    const checkoutIdentity = async () => {
      const info = await stat(cwd, { bigint: true });
      return { device: String(info.dev), inode: String(info.ino), git: await fixture.gitState(cwd) };
    };
    const sideProof = async (machine: Machine): Promise<SideProof> => {
      const terminals = await labelledTerminals(suite, machine, sessionId);
      const herdr = join(machine.root, 'herdr');
      return { terminals, home: fixture.home(machine), lock: await inspectIdLock(herdr, sessionId),
        lease: await createSessionLeases(herdr).get(file) };
    };
    const proof = async (): Promise<StopFixtureProof> => {
      const [hubProof, boxProof, events, bytes] = await Promise.all([
        sideProof(hub), sideProof(box), readObserved(suite.pi.observerDir), readFile(file),
      ]);
      const processes = liveProcesses();
      const db = openDbReadOnly(join(cwd, '.spider', 'project.db'));
      if (!db) throw new Error('The relocated checkout run database is missing');
      let runs: { id: string; status: string; pid: number | null }[];
      try { runs = db.prepare('SELECT id,status,pid FROM runs WHERE session_id=? ORDER BY id').all(sessionId) as typeof runs; }
      finally { db.close(); }
      const owners = new Map<number, OwnerGeneration>();
      const addOwner = (proc: ProcessRow, label: string) => owners.set(proc.pid, track(proc, label));
      for (const event of events) {
        if (event.type !== 'session_start') continue;
        const proc = processes.get(event.pid);
        if (!proc || !liveAt(proc, event.at)) continue;
        if (event.sessionId === sessionId && event.subagentChild !== '1') addOwner(proc, 'stop-pi');
        else if (event.subagentChild === '1' && typeof event.sessionFile === 'string' &&
          runs.some(run => run.pid === event.pid || (event.sessionFile as string).includes(run.id))) track(proc, 'stop-subagent');
      }
      for (const [machine, side] of [[hub, hubProof], [box, boxProof]] as const) {
        const found = side.lock && processes.get(side.lock.identity.pid);
        if (found && side.lock?.bootId === bootId && side.lock.identity.startIdentity === found.startIdentity) addOwner(found, 'stop-lock-owner');
        for (const terminal of side.terminals) {
          const proc = processes.get(terminal.pid);
          if (!proc) continue;
          if (terminal.labels['spider.kind'] === 'session') addOwner(proc, 'stop-labelled-owner');
          else track(proc, 'stop-labelled-work');
          suite.ledger.update(ledger => {
            if (!ledger.terminals.some(row => row.side === machine.side && row.address === terminal.address)) {
              ledger.terminals.push({ side: machine.side, address: terminal.address });
            }
          });
        }
      }
      for (const row of processes.values()) {
        let parent = processes.get(row.parent);
        while (parent && !owners.has(parent.pid)) parent = processes.get(parent.parent);
        if (parent) track(row, 'stop-owner-descendant');
      }

      const jobRoot = join(cwd, '.spider', 'scratch', 'bg');
      const jobEvidence: JobEvidence[] = [];
      for (const id of (await readdir(jobRoot).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      })).sort()) {
        const manifest = readManifestSafe(join(jobRoot, id, 'job.json'));
        if (!manifest || manifest.id !== id || manifest.ownerSessionId !== sessionId) continue;
        const receipt = readReceiptSafe(join(jobRoot, id, 'exit.json'));
        const leader = manifest.supervisorPid && processes.get(manifest.supervisorPid);
        const groupOwned = manifest.supervisorPid && (!leader || liveAt(leader, Date.parse(manifest.startedAt) + 1_000));
        const live = [...processes.values()].filter(row =>
          (groupOwned && row.group === manifest.supervisorPid) ||
          (row.pid === manifest.childPid && (!receipt || !liveAt(row, Date.parse(receipt.endedAt ?? '')))))
          .sort((a, b) => a.pid - b.pid)
          .map(row => track(row, 'stop-detached-job', row.pid === manifest.supervisorPid));
        jobEvidence.push({ manifest, receipt, live });
      }
      const jobs = jobEvidence.map(({ manifest, receipt, live }) => ({ id: manifest.id,
        exitVerified: live.length === 0 && receipt?.state === 'exited' && receipt.exitCode === 0 && receipt.signal === null &&
          receipt.childPid === manifest.childPid && receipt.supervisorPid === manifest.supervisorPid }));
      const liveOwned = [...tracked.values()].filter(identity => processes.get(identity.pid)?.startIdentity === identity.startIdentity)
        .sort((a, b) => a.pid - b.pid);
      let owner: OwnerGeneration | null = null;
      if (owners.size === 1) {
        const candidate = [...owners.values()][0];
        const { lock, lease, terminals, home } = boxProof;
        const terminal = terminals.find(row => row.pid === candidate.pid);
        const event = events.find(row => row.type === 'session_start' && row.pid === candidate.pid && row.sessionId === sessionId && row.hcTerminal === terminal?.address);
        if (lock?.bootId === bootId && lock.pendingOperationId === null && lock.identity.pid === candidate.pid && lock.identity.startIdentity === candidate.startIdentity &&
          lease?.pid === candidate.pid && lease.startIdentity === candidate.startIdentity && (!lease.bootId || lease.bootId === bootId) &&
          home?.state === 'running' && terminal?.labels['spider.kind'] === 'session' && terminal.labels['spider.session'] === sessionId &&
          terminal.labels['spider.machine'] === box.id && terminal.labels['spider.roam.epoch'] === String(home.epoch) &&
          event?.sessionFile === file && event.cwd === cwd && terminal.cwd === cwd && terminal.argv.at(-1) === file &&
          (await readFile(`/proc/${candidate.pid}/comm`, 'utf8').catch(() => '')).trim() === 'pi' &&
          await readlink(`/proc/${candidate.pid}/cwd`).catch(() => null) === cwd) owner = candidate;
      }
      const header = JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString()) as { id: string; cwd: string };
      return { sessionId: header.id, file, cwd: header.cwd,
        transcriptPrefixHash: createHash('sha256').update(bytes.subarray(0, initialBytes.length)).digest('hex'),
        liveOwnerCount: owners.size, liveOwned, owner, hub: hubProof, box: boxProof,
        runs: runs.map(({ id, status }) => ({ id, status })), jobs, jobEvidence };
    };
    const prompt = async (marker: string, callId: string) => {
      const current = await proof();
      const terminal = current.box.terminals.find(row => row.pid === current.owner?.pid);
      if (!current.owner || !terminal) throw new Error('No verified owner to receive the scripted turn');
      const pi = observe(suite.pi.observerDir, () => current.owner!.pid);
      const sentAt = Date.now();
      const sent = await suite.hc(['send', '--force', '--json', terminal.address, mark(marker)], box.side);
      expect(sent.exitCode, sent.stderr + sent.stdout).toBe(0);
      const result = await pi.toolResult(callId, deadline(30_000));
      await suite.evidence(`stop-tool-${callId}.json`, result);
      expect(result.isError).toBe(false);
      await pi.waitEvent('agent_settled', row => row.at >= result.at && row.at >= sentAt, deadline(30_000));
    };
    const supervisorScanAfter = async (after: number) => {
      const found = await waitFor('the packed supervisor completes a labelled terminal scan', async () => (await cores.records()).find(row =>
        row.at > after && row.ppid === supervisor.pid && row.namespace === cores.dest.namespace && row.socket === cores.dest.socket &&
        row.argv[0] === 'ls' && row.argv[row.argv.indexOf('--label') + 1] === `spider.session=${sessionId}` && processStart(row.pid) === null),
      Boolean, deadline(25_000), { reconcileMs: 200 });
      if (!found) throw new Error('Missing supervisor scan');
      return found;
    };
    return { sessionId, hub, box, cli, partition, proof, checkoutIdentity, prompt, supervisorScanAfter, close };
  } catch (error) { await close(); throw error; }
}
