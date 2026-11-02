// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite, InvokeResult } from '../harness/suite.js';
import { identityAlive, identityOf } from '../harness/resources.js';
import { readObserved, type InteractiveDriver } from '../harness/pi.js';
import { deadline, waitFor } from '../harness/wait.js';
import { connectOwnedShell, installScripts } from '../fixtures/session-scripts.js';
import { marker } from '../fixtures/scripted-provider.js';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
let offerCalls = 0;
async function offerCapture(suite: Suite, configPath: string): Promise<{ command: string; read(): Promise<InvokeResult> }> {
  const prefix = suite.ownPath(join(suite.root, `resume-offer-${++offerCalls}`));
  const stdout = `${prefix}.out`, stderr = `${prefix}.err`, code = `${prefix}.code`;
  const command = `${quote(process.execPath)} ${quote(suite.packed.cli)} resume-offer --config ${quote(configPath)} >${quote(stdout)} 2>${quote(stderr)}; printf '%s' "$?" >${quote(code)}`;
  return { command, async read() {
    const exit = await waitFor('owned terminal resume-offer exit is recorded', () => readFile(code, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }), value => /^\d+$/.test(value), deadline(30_000));
    const result = { exitCode: Number(exit), stdout: await readFile(stdout, 'utf8'), stderr: await readFile(stderr, 'utf8') };
    await suite.evidence(`resume-offer-${offerCalls}.json`, { command, result, capture: { stdout, stderr, code } });
    return result;
  } };
}
async function offerInPi(suite: Suite, pi: InteractiveDriver, configPath: string): Promise<InvokeResult> {
  const capture = await offerCapture(suite, configPath), name = `resume-offer-${offerCalls}`, callId = `offer-${offerCalls}`;
  const script = JSON.parse(await readFile(suite.pi.scriptPath, 'utf8')) as { scripts: Parameters<typeof installScripts>[1] };
  await installScripts(suite, { ...script.scripts, [name]: [
    { steps: [{ tool: { id: callId, name: 'spider', arguments: { action: 'exec', language: 'shell', code: capture.command } } }] },
    { steps: [{ text: 'Owned resume-offer completed.' }] },
  ] });
  const at = Date.now(); await pi.prompt(marker(name));
  await pi.toolResult(callId, deadline(60_000));
  await pi.waitEvent('agent_settled', event => event.at >= at, deadline(60_000));
  return capture.read();
}

type FreshResume = { suite: Suite; result: { configPath: string }; config: { core: { config: string }; shellRc: string } };
async function socketListening(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(path);
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function installedResume(fresh: FreshResume): Promise<void> {
  const { suite, config } = fresh, cores = suite.cores!;
  const rc = await readFile(config.shellRc, 'utf8');
  expect(rc.match(/# spider:resume:start/g)).toHaveLength(1);
  expect(rc).toContain('resume.sh');
  const shellSocket = suite.ownPath(join(suite.root, 'resume-shell.s'));
  const shellLog = suite.ownPath(join(suite.root, 'resume-shell.raw'));
  const shellEnv = suite.ownPath(join(suite.root, 'resume-shell-env.json'));
  await writeFile(shellEnv, JSON.stringify(suite.env), { mode: 0o600 });
  const broker = fileURLToPath(new URL('../harness/pty-broker.py', import.meta.url));
  const shellCommand = ['/usr/bin/python3', broker, '--socket', shellSocket, '--log', shellLog, '--env-file', shellEnv, '--', '/bin/bash', '--rcfile', config.shellRc, '-i'];
  const coreConfig = await readFile(config.core.config, 'utf8');
  if (/^\s*shell\s*=/m.test(coreConfig)) throw new Error('fixture core unexpectedly already has a shell');
  await writeFile(config.core.config, `${coreConfig.trimEnd()}\nshell = ${JSON.stringify(shellCommand)}\n`);
  await installScripts(suite, {
    saved: [{ steps: [{ text: 'saved conversation from before reboot' }] }],
    resumed: [{ steps: [{ text: 'resumed conversation after reboot' }] }],
  });
  const project = await suite.project('installed-resume');
  const pi = await suite.launchPi({ mode: 'interactive', cwd: project, extraEnv: { PI_PROGRAM_STATUS: '1' } }) as InteractiveDriver;
  try {
    const start = await pi.waitEvent('session_start', () => true, deadline(60_000));
    expect(typeof start.sessionId).toBe('string'); expect(typeof start.sessionFile).toBe('string');
    const sessionId = start.sessionId as string, sessionFile = suite.ownPath(start.sessionFile as string);
    const turnAt = Date.now(); await pi.prompt(`${marker('saved')} preserve this history`);
    await pi.waitEvent('agent_settled', event => event.at >= turnAt, deadline(90_000));
    await pi.prompt('/name reboot-fixture');
    await waitFor('saved session name', async () => (await suite.hc(['get', pi.terminal, '--json'])).json as { title?: string } | null,
      value => value?.title?.includes('reboot-fixture') === true, deadline(40_000));
    const registry = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'terminals');
    const mapping = await waitFor('saved owner mapping', async () => {
      const files = await readdir(registry).catch(() => []);
      const rows = await Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(registry, name), 'utf8')) as { recordedAt?: number; owner?: { sessionId?: string; sessionFile?: string; cwd?: string; name?: string; terminal?: { address?: string } } }));
      return rows.find(row => row.owner?.sessionId === sessionId && row.owner?.terminal?.address === pi.terminal) ?? null;
    }, row => row?.owner?.name === 'reboot-fixture' && row.owner.sessionFile === sessionFile && row.owner.cwd === project && typeof row.recordedAt === 'number', deadline(60_000));
    const before = await suite.hc(['server', 'status', '--json']);
    const beforeCore = before.json as { pid: number; core: { id: string } };
    expect(beforeCore.core.id).toBe(cores.local.coreId);
    // POSIX process start times have one-second resolution; observe a later second before requesting restart.
    await waitFor('restart epoch can be distinguished', () => Date.now(), now => Math.floor(now / 1000) * 1000 > mapping!.recordedAt!, deadline(5000));
    const restart = await suite.hc(['server', 'restart', '--json']); expect(restart.exitCode, restart.stderr).toBe(0);
    await waitFor('restarted owned core listens', () => socketListening(cores.local.socket), Boolean, deadline(60_000));
    const after = await suite.hc(['server', 'status', '--json']);
    const afterCore = after.json as { pid: number; core: { id: string } };
    expect(afterCore.pid).not.toBe(beforeCore.pid); expect(afterCore.core.id).toBe(beforeCore.core.id);
    const coreIdentity = identityOf(afterCore.pid);
    cores.local.pid = coreIdentity.pid;
    suite.ledger.update(ledger => { const core = ledger.cores.find(entry => entry.side === 'local')!; core.pid = coreIdentity.pid; core.start = coreIdentity.start; });
    expect(identityAlive(pi.identity), 'core handover preserves the original pi until it is lost').toBe(true);
    const liveOffer = await offerInPi(suite, pi, fresh.result.configPath); expect(liveOffer.exitCode, liveOffer.stderr).toBe(0); expect(liveOffer.stdout).toBe('');
    const processDirectory = join(suite.root, 'procs');
    const beforeOfferProcesses = (await readdir(processDirectory)).filter(name => name.endsWith('.json')).sort();
    const detail = await suite.hc(['get', pi.terminal, '--json']);
    const oldBroker = detail.json as { pid?: number; argv?: string[] };
    expect(typeof oldBroker.pid).toBe('number'); expect(oldBroker.argv?.some(arg => arg.endsWith('/pty-broker.py'))).toBe(true);
    expect(Number(execFileSync('ps', ['-p', String(pi.pid), '-o', 'ppid='], { encoding: 'utf8' }).trim())).toBe(oldBroker.pid);
    const brokerIdentity = identityOf(oldBroker.pid!);
    suite.ledger.update(ledger => { ledger.processes.push({ ...brokerIdentity, label: 'reboot-lost-broker', group: false }); });
    expect(identityAlive(brokerIdentity), 'reboot broker identity is still current').toBe(true);
    process.kill(brokerIdentity.pid, 'SIGKILL');
    await waitFor('lost broker exits', () => identityAlive(brokerIdentity), alive => !alive, deadline(20_000));
    await waitFor('original pi exits', () => identityAlive(pi.identity), alive => !alive, deadline(20_000));
    const shell = await connectOwnedShell(suite, pi.terminal, shellSocket, shellLog);
    const invokeOffer = async (): Promise<InvokeResult> => {
      const capture = await offerCapture(suite, fresh.result.configPath);
      await shell.input(capture.command + '\r');
      return capture.read();
    };
    expect(await shell.wrongIdentityControl()).toMatchObject({ error: 'identity-mismatch' });
    await waitFor('installed hook offers the saved session', () => shell.output(), text => text.includes('Resume reboot-fixture: run spider_resume'), deadline(60_000));
    const priorEvents = await readObserved(suite.pi.observerDir);
    expect(priorEvents.filter(event => event.type === 'session_start' && event.sessionId === sessionId && event.pid !== pi.pid)).toEqual([]);
    await shell.input('printf "__decline_%s__\\n" "ok"\r');
    await waitFor('declining leaves a usable shell', () => shell.output(), text => text.includes('__decline_ok__'), deadline(30_000));
    expect((await readObserved(suite.pi.observerDir)).filter(event => event.type === 'session_start' && event.sessionId === sessionId && event.pid !== pi.pid)).toEqual([]);
    expect((await readdir(processDirectory)).filter(name => name.endsWith('.json')).sort(), 'no pi launcher ran before resume was chosen').toEqual(beforeOfferProcesses);

    const negatives: Record<string, unknown> = {};
    const bytes = await readFile(sessionFile), newline = bytes.indexOf(10);
    expect(newline).toBeGreaterThan(0);
    const header = JSON.parse(bytes.subarray(0, newline).toString('utf8')) as Record<string, unknown>;
    try {
      await writeFile(sessionFile, Buffer.concat([Buffer.from(JSON.stringify({ ...header, id: 'different-fixture-id' }) + '\n'), bytes.subarray(newline + 1)]));
      const changed = await invokeOffer(); negatives.changedId = changed; expect(changed.exitCode, changed.stderr).toBe(0); expect(changed.stdout).toBe('');
    } finally { await writeFile(sessionFile, bytes); }
    const savedFile = suite.ownPath(`${sessionFile}.saved`);
    await rename(sessionFile, savedFile);
    try {
      const missing = await invokeOffer(); negatives.missingFile = missing; expect(missing.exitCode, missing.stderr).toBe(0); expect(missing.stdout).toBe('');
    } finally { await rename(savedFile, sessionFile); }

    const foreignCapture = await offerCapture(suite, fresh.result.configPath);
    const foreign = await suite.hc(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--cwd', project, '--', '/bin/sh', '-c', foreignCapture.command], 'dest');
    expect(foreign.exitCode, foreign.stderr).toBe(0);
    const foreignAddress = (foreign.json as { address: string }).address;
    suite.ledger.update(ledger => { ledger.terminals.push({ side: 'dest', address: foreignAddress }); });
    const foreignOffer = await foreignCapture.read(); expect(foreignOffer.exitCode, foreignOffer.stderr).toBe(0); expect(foreignOffer.stdout).toBe('');

    await shell.input('spider_resume\r');
    const resumed = await waitFor('one real resumed pi writer', () => readObserved(suite.pi.observerDir), rows => rows.some(event => event.type === 'session_start' && event.sessionId === sessionId && event.pid !== pi.pid), deadline(90_000));
    const resumedStart = resumed.find(event => event.type === 'session_start' && event.sessionId === sessionId && event.pid !== pi.pid)!;
    expect(resumedStart).toMatchObject({ mode: 'tui', sessionFile, hcTerminal: pi.terminal, cwd: project });
    const resumedIdentity = identityOf(resumedStart.pid);
    suite.ledger.update(ledger => { ledger.processes.push({ ...resumedIdentity, label: 'resumed-pi', group: false }); });
    const launchedProcesses = (await readdir(processDirectory)).filter(name => name.endsWith('.json')).sort();
    expect(launchedProcesses.filter(name => !beforeOfferProcesses.includes(name))).toEqual([`${resumedStart.pid}.json`]);
    const leaseDir = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'leases');
    const leases = await waitFor('real session lease belongs to the resumed pi', async () => {
      const files = await readdir(leaseDir).catch(() => []);
      const rows = await Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(leaseDir, name), 'utf8')) as { file?: string; pid?: number }));
      return rows.filter(row => row.file === sessionFile);
    }, rows => rows.length === 1 && rows[0].pid === resumedStart.pid, deadline(60_000));
    const presenceDir = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'processes');
    const writers = await waitFor('one live session writer', async () => {
      const files = await readdir(presenceDir).catch(() => []);
      const rows = await Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(presenceDir, name), 'utf8')) as { sessionId?: string; pid?: number }));
      return rows.filter(row => row.sessionId === sessionId && typeof row.pid === 'number' && (() => { try { return identityAlive(identityOf(row.pid!)); } catch { return false; } })());
    }, rows => rows.length === 1 && rows[0].pid === resumedStart.pid, deadline(60_000));
    const resumedAt = Date.now(); await shell.input(`${marker('resumed')} continue the saved session\r`);
    await waitFor('resumed pi settles', () => readObserved(suite.pi.observerDir, resumedStart.pid), rows => rows.some(event => event.type === 'agent_settled' && event.at >= resumedAt), deadline(90_000));
    const saved = await readFile(sessionFile, 'utf8'); expect(saved).toContain(marker('saved')); expect(saved).toContain(marker('resumed'));
    await suite.evidence('resume-installed.json', { beforeCore, afterCore, mapping, liveOffer, foreignOffer, negatives, resumedStart, writers, leases: leases.map(({ file, pid }) => ({ file, pid })), beforeOfferProcesses, launchedProcesses });
    await suite.evidence('resume-installed-shell.raw', await shell.output());
    await shell.input('/quit\r');
    await waitFor('resumed pi quits', () => identityAlive(resumedIdentity), alive => !alive, deadline(60_000));
    expect(identityAlive(shell.identity), 'resumed pi returns to the restored shell').toBe(true);
    await shell.input('printf "__returned_%s__\\n" "ok"\r');
    await waitFor('restored shell remains usable', () => shell.output(), text => text.includes('__returned_ok__'), deadline(30_000));
    await shell.input('exit\r');
  } finally { await pi.close(); }
}

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S13'), title: 'Reboot resume offers the exact saved session without automatic launch', tiers: ['headless', 'app'],
  async run(original) {
    const helperPath = '../fixtures/install-inputs.js';
    const helper = await import(/* @vite-ignore */ helperPath).catch(error => {
      if (/Cannot find module ['\"]?[^'\"]*\/fixtures\/install-inputs\.js/i.test(String(error))) throw new Error('prerequisite: the shared setup helper is unavailable');
      throw error;
    }) as {
      installFresh(suite: Suite): Promise<FreshResume>;
    };
    const fresh = await helper.installFresh(original);
    const suite = fresh.suite;
    const cwd = await suite.project('resume-shell-control');
    const socket = suite.ownPath(join(suite.root, 'shell-control.sock'));
    const log = suite.ownPath(join(suite.root, 'shell-control.raw'));
    const env = suite.ownPath(join(suite.root, 'shell-control-env.json'));
    await writeFile(env, JSON.stringify(suite.env), { mode: 0o600 });
    const broker = fileURLToPath(new URL('../harness/pty-broker.py', import.meta.url));
    const result = await suite.hc(['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--cwd', cwd, '--', '/usr/bin/python3', broker,
      '--socket', socket, '--log', log, '--env-file', env, '--', '/bin/bash', '--noprofile', '--norc', '-i']);
    expect(result.exitCode, result.stderr).toBe(0);
    const terminal = (result.json as { address: string }).address;
    expect(terminal).toBeTruthy();
    suite.ledger.update(ledger => { ledger.terminals.push({ side: 'local', address: terminal }); });
    const shell = await connectOwnedShell(suite, terminal, socket, log);
    expect(await shell.wrongIdentityControl()).toMatchObject({ error: 'identity-mismatch' });
    await shell.input('printf "__shell_%s__\\n" "ready"\r');
    await waitFor('owned shell executes the control', () => shell.output(), text => text.includes('__shell_ready__'), deadline(30_000));
    await suite.evidence('resume-shell-control.raw', await shell.output());
    await shell.input('exit\r');
    await waitFor('owned shell exits', () => identityAlive(shell.identity), alive => !alive, deadline(30_000));

    const unprovedSocket = suite.ownPath(join(suite.root, 'unproved-shell.s')), unprovedLog = suite.ownPath(join(suite.root, 'unproved-shell.raw'));
    const unprovedEnv = suite.ownPath(join(suite.root, 'unproved-shell-env.json'));
    await writeFile(unprovedEnv, JSON.stringify(suite.env), { mode: 0o600 });
    const coreConfig = await readFile(fresh.config.core.config, 'utf8');
    const unprovedCommand = ['/usr/bin/python3', broker, '--socket', unprovedSocket, '--log', unprovedLog, '--env-file', unprovedEnv, '--', '/bin/bash', '--noprofile', '--norc', '-i'];
    await writeFile(fresh.config.core.config, `${coreConfig.trimEnd()}\nshell = ${JSON.stringify(unprovedCommand)}\n`);
    const activeEnv = { PI_PROGRAM_STATUS: '1' };
    await installScripts(suite, { resume: [{ steps: [{ text: 'saved resume control' }] }] });
    const project = await suite.project('resume-unproved');
    const pi = await suite.launchPi({ mode: 'interactive', cwd: project, extraEnv: activeEnv }) as InteractiveDriver;
    try {
      const start = await pi.waitEvent('session_start', () => true, deadline(60_000));
      const at = Date.now(); await pi.prompt(`${marker('resume')} save actual history`);
      await pi.waitEvent('agent_settled', event => event.at >= at, deadline(60_000));
      const mappings = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'terminals');
      await waitFor('real session mapping', async () => {
        const files = await readdir(mappings).catch(() => []);
        return Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(mappings, name), 'utf8')) as { owner?: { sessionId?: string; terminal?: { address?: string } } }));
      }, rows => rows.some(row => row.owner?.sessionId === start.sessionId && row.owner?.terminal?.address === pi.terminal), deadline(60_000));
      const liveOffer = await offerInPi(suite, pi, fresh.result.configPath); expect(liveOffer.exitCode, liveOffer.stderr).toBe(0); expect(liveOffer.stdout).toBe('');
      const detail = await suite.hc(['get', pi.terminal, '--json']);
      const broker = detail.json as { pid?: number; argv?: string[] };
      expect(typeof broker.pid).toBe('number'); expect(broker.argv?.some(arg => arg.endsWith('/pty-broker.py'))).toBe(true);
      expect(Number(execFileSync('ps', ['-p', String(pi.pid), '-o', 'ppid='], { encoding: 'utf8' }).trim())).toBe(broker.pid);
      const brokerIdentity = identityOf(broker.pid!);
      suite.ledger.update(ledger => { ledger.processes.push({ ...brokerIdentity, label: 'lost-pi-broker', group: false }); });
      expect(identityAlive(brokerIdentity), 'lost broker identity is still current').toBe(true);
      process.kill(brokerIdentity.pid, 'SIGKILL');
      await waitFor('old broker exits', () => identityAlive(brokerIdentity), alive => !alive, deadline(20_000));
      await waitFor('old pi exits after broker loss', () => identityAlive(pi.identity), alive => !alive, deadline(20_000));
      const keptShell = await connectOwnedShell(suite, pi.terminal, unprovedSocket, unprovedLog);
      expect(await keptShell.wrongIdentityControl()).toMatchObject({ error: 'identity-mismatch' });
      const capture = await offerCapture(suite, fresh.result.configPath);
      await keptShell.input(capture.command + '\r');
      const unproved = await capture.read(); expect(unproved.exitCode, unproved.stderr).toBe(0); expect(unproved.stdout).toBe('');
      await suite.evidence('resume-unproved-offer.json', { liveOffer, unproved, sessionId: start.sessionId, terminal: pi.terminal });
    } finally { await pi.close(); }
    await writeFile(fresh.config.core.config, coreConfig);
    await installedResume(fresh);
  },
}];
