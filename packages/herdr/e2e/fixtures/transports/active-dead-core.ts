// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { expect } from 'vitest';
import type { ScriptTurn } from '../scripted-provider.js';
import { assertSocketPath, HarnessError } from '../../harness/environment.js';
import { observe } from '../../harness/pi.js';
import { identityAlive, identityOf, type LedgerProcess } from '../../harness/resources.js';
import type { Suite } from '../../harness/suite.js';
import { deadline, waitFor } from '../../harness/wait.js';
import { launchActiveRouting, runTool, scripted } from './active.js';

const listening = (path: string) => new Promise<boolean>(resolve => {
  const socket = connect(path); const done = (value: boolean) => { socket.destroy(); resolve(value); };
  socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(1000, () => done(false));
});

async function pauseApp(suite: Suite): Promise<LedgerProcess> {
  const app = suite.ledger.read().processes.find(process => process.label === 'fake-app-daemon');
  if (!app || !identityAlive(app)) throw new HarnessError('missing-prerequisite', 'the owned fake app daemon is required');
  process.kill(app.pid, 'SIGSTOP');
  const env = { PATH: '/bin:/usr/bin', LC_ALL: 'C', HOME: suite.directories.HOME, TMPDIR: suite.directories.TMPDIR };
  try {
    await waitFor('owned fake app paused', () => execFileSync('/bin/ps', ['-p', String(app.pid), '-o', 'stat='], { encoding: 'utf8', env }).trim(), state => state.startsWith('T'), deadline(10_000));
    await waitFor('fake app hc commands finish', () => execFileSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,stat='], { encoding: 'utf8', env }).split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
      return match && Number(match[2]) === app.pid && !match[3].startsWith('Z') ? [Number(match[1])] : [];
    }), children => children.length === 0, deadline(20_000));
    return app;
  } catch (error) { if (identityAlive(app)) process.kill(app.pid, 'SIGCONT'); throw error; }
}

async function configureHolderGrace(suite: Suite): Promise<void> {
  const cores = suite.cores;
  if (!cores) throw new HarnessError('missing-prerequisite', 'core-death test needs the owned cores');
  const app = await pauseApp(suite);
  try {
    const stopped = await suite.hc(['server', 'stop', '--json']);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    await waitFor('owned local core stopped before grace setup', () => listening(cores.local.socket), live => !live, deadline(30_000));
    cores.local.env.HC_HOLDER_GRACE_MS = '180000';
    suite.ledger.update(ledger => { ledger.cores.find(core => core.side === 'local')!.env = { ...cores.local.env }; });
    const started = await suite.hc(['server', 'start', '--json']);
    expect(started.exitCode, started.stderr).toBe(0);
    const status = await suite.hc(['server', 'status', '--json']);
    const value = status.json as { pid?: number; core?: { id?: string } };
    expect(status.exitCode, status.stderr).toBe(0);
    expect(value.core?.id).toBe(cores.local.coreId);
    if (typeof value.pid !== 'number') throw new Error('restarted owned core did not report a PID');
    const identity = identityOf(value.pid);
    cores.local.pid = identity.pid;
    suite.ledger.update(ledger => { const core = ledger.cores.find(item => item.side === 'local')!; core.pid = identity.pid; core.start = identity.start; core.env = { ...cores.local.env }; });
    await suite.evidence('core-death-setting.json', { HC_HOLDER_GRACE_MS: '180000', scope: 'owned local core and holders only', identity });
  } finally { if (identityAlive(app)) process.kill(app.pid, 'SIGCONT'); }
}

export async function activeDeadCore(suite: Suite): Promise<void> {
  await configureHolderGrace(suite);
  const scripts: Record<string, ScriptTurn[]> = {
    'dead-parent-control': scripted('dead-parent-control', 'spider', { action: 'exec', language: 'shell', code: 'ssh outside.invalid parent-control' }),
    'start-dead-child': scripted('start-dead-child', 'spider', { action: 'run', agent: 'worker', name: 'dead-core-child', model: 'e2e-fixture/scripted', thinking: 'off', task: '[[e2e:dead-child]] Execute the controlled child fixture.' }),
    'dead-parent': scripted('dead-parent', 'spider', { action: 'exec', language: 'shell', code: 'ssh dest.invalid dead-parent' }),
    'dead-child': [
      { steps: [{ gate: 'dead-child-control' }, { tool: { id: 'dead-child-control', name: 'spider', arguments: { action: 'exec', language: 'shell', code: 'ssh outside.invalid child-control' } } }] },
      { steps: [{ gate: 'dead-child-ready' }, { tool: { id: 'dead-child-ssh', name: 'spider', arguments: { action: 'exec', language: 'shell', code: 'ssh dest.invalid dead-child' } } }] },
      { steps: [{ text: 'dead core fixture complete' }] },
    ],
  };
  assertSocketPath(suite.root, suite.pi.gateSocket);
  const gates = await suite.gates();
  const active = await launchActiveRouting(suite, scripts);
  const observations: object[] = [], failures: string[] = [];
  let app: LedgerProcess | undefined, killedCore = false;
  let stopWatch: (() => Promise<void>) | undefined;
  const details = (result: unknown) => (result as { details?: { stdout?: string; stderr?: string; exitCode?: number } }).details;
  const expectTransport = (result: unknown, args: string[]) => expect(details(result)).toMatchObject({
    stdout: `TRANSPORT-OUT\n${JSON.stringify(args)}\n`, stderr: 'TRANSPORT-ERR\n', exitCode: 41,
  });
  try {
    if (!suite.cores) throw new HarnessError('missing-prerequisite', 'core-death test needs the owned cores');
    let before = (await active.records()).length;
    const parentControl = await runTool(active.driver, 'dead-parent-control', 'dead-parent-control');
    expectTransport(parentControl.result, ['outside.invalid', 'parent-control']);
    expect((await active.records()).slice(before)).toEqual([{ argv: ['outside.invalid', 'parent-control'] }]);
    const parentRun = await runTool(active.driver, 'start-dead-child', 'start-dead-child');
    expect(parentRun.isError).toBe(false);
    const ready = await gates.ready('dead-child-control', deadline(90_000));
    const childIdentity = identityOf(ready.pid);
    suite.ledger.update(ledger => { ledger.processes.push({ ...childIdentity, label: 'dead-core-child', group: true }); });
    const child = observe(suite.pi.observerDir, () => ready.pid);
    const childStart = await child.waitEvent('session_start', () => true, deadline(60_000));
    expect(childStart).toMatchObject({ subagentChild: '1' });
    before = (await active.records()).length;
    gates.release('dead-child-control');
    const childControl = await child.toolResult('dead-child-control', deadline(60_000));
    expectTransport(childControl.result, ['outside.invalid', 'child-control']);
    expect((await active.records()).slice(before)).toEqual([{ argv: ['outside.invalid', 'child-control'] }]);
    await gates.ready('dead-child-ready', deadline(60_000));

    // The app can independently start hc on connect; pause and drain only this fixture-owned daemon.
    app = await pauseApp(suite);
    const core = suite.ledger.read().cores.find(item => item.side === 'local');
    if (!core?.pid || !core.start || !identityAlive({ pid: core.pid, start: core.start })) throw new Error('owned core identity changed');
    expect(await listening(core.socket), 'core must be live before the crash').toBe(true);
    await suite.evidence('core-death-boundary.json', { core: { pid: core.pid, start: core.start, socket: core.socket }, app, holderGraceMs: 180000 });
    process.kill(core.pid, 'SIGKILL'); killedCore = true;
    await waitFor('local core process exits', () => identityAlive({ pid: core.pid!, start: core.start! }), alive => !alive, deadline(20_000));
    await waitFor('local core socket is unavailable', () => listening(core.socket), live => !live, deadline(20_000));
    const samples: { at: number; live: boolean }[] = [];
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        samples.push({ at: Date.now(), live: await listening(core.socket) });
        if (watching) await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    stopWatch = async () => { watching = false; await watcher; await suite.evidence('dead-core-socket-samples.json', { holderGraceMs: 180000, samples }); };
    expect(identityAlive(active.driver.identity)).toBe(true);
    expect(identityAlive(childIdentity)).toBe(true);
    before = (await active.records()).length;
    const parent = await runTool(active.driver, 'dead-parent', 'dead-parent');
    const parentRecords = (await active.records()).slice(before);
    expect(await listening(core.socket), 'core must stay dead during the parent call').toBe(false);
    observations.push({ name: 'parent after core death', result: parent, records: parentRecords, coreListening: false });
    await suite.evidence('dead-core-cases.json', observations);
    const parentDetail = details(parent.result);
    if (parentDetail?.stdout !== 'TRANSPORT-OUT\n["dest.invalid","dead-parent"]\n' || parentDetail?.stderr !== 'TRANSPORT-ERR\n' || parentDetail?.exitCode !== 41) failures.push('parent did not pass managed SSH after core death');
    if (JSON.stringify(parentRecords) !== JSON.stringify([{ argv: ['dest.invalid', 'dead-parent'] }])) failures.push('parent transport argv changed after core death');
    before = (await active.records()).length;
    gates.release('dead-child-ready');
    const childResult = await child.toolResult('dead-child-ssh', deadline(60_000));
    const childRecords = (await active.records()).slice(before);
    expect(await listening(core.socket), 'core must stay dead during the child call').toBe(false);
    observations.push({ name: 'child after core death', result: childResult, records: childRecords, coreListening: false });
    await suite.evidence('dead-core-cases.json', observations);
    const childDetail = details(childResult.result);
    if (childDetail?.stdout !== 'TRANSPORT-OUT\n["dest.invalid","dead-child"]\n' || childDetail?.stderr !== 'TRANSPORT-ERR\n' || childDetail?.exitCode !== 41) failures.push('child did not pass managed SSH after core death');
    if (JSON.stringify(childRecords) !== JSON.stringify([{ argv: ['dest.invalid', 'dead-child'] }])) failures.push('child transport argv changed after core death');
    expect(await listening(core.socket)).toBe(false);
    await stopWatch(); stopWatch = undefined;
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every(sample => !sample.live), 'core socket reopened during the outage window').toBe(true);
    await suite.keepEvidence(active.log, 'dead-core-transport.jsonl');
  } finally {
    if (stopWatch) await stopWatch();
    if (app && identityAlive(app)) process.kill(app.pid, 'SIGCONT');
    if (!killedCore) await active.driver.close();
    else if (identityAlive(active.driver.identity)) {
      process.kill(active.driver.pid, 'SIGTERM');
      try { await waitFor('parent pi exits', () => identityAlive(active.driver.identity), alive => !alive, deadline(10_000)); }
      catch { if (identityAlive(active.driver.identity)) process.kill(active.driver.pid, 'SIGKILL'); }
    }
  }
  if (failures.length) throw new Error(`dead-core routing failures: ${failures.join('; ')}`);
}
