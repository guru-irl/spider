// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import { observe, readObserved, type InteractiveDriver, type RpcDriver } from '../harness/pi.js';
import { createSuite, type Suite } from '../harness/suite.js';
import { identityAlive, identityOf, registerModeRestore } from '../harness/resources.js';
import { deadline, waitFor } from '../harness/wait.js';
import { marker, type ScriptFile } from '../fixtures/scripted-provider.js';
import { configureActiveHerdr, configureHerdr, connectOwnedShell, installScripts } from '../fixtures/session-scripts.js';
import { stagePayload, type PayloadHandle } from '../fixtures/payloads/index.js';
import { forkInteractive, newInteractive, quitPi, reloadInteractive, replaceRpcSession, resumeInteractive, signalPi } from '../fixtures/lifecycle-driver.js';

const todoMarker = 'first-session-only';
function writeFailureScript(id: string): ScriptFile['scripts'][string] {
  return [
    { steps: [{ tool: { id: `${id}-exec`, name: 'spider', arguments: { action: 'exec', language: 'shell', code: "printf 'local-hook-ok\\n'" } } }] },
    { steps: [{ tool: { id: `${id}-todo`, name: 'spider', arguments: { action: 'todo', op: 'add', text: `hook-${id}` } } }] },
    { steps: [{ text: `${id} completed` }] },
  ];
}
function listScript(id: string): ScriptFile['scripts'][string] {
  return [
    { steps: [{ tool: { id: `${id}-todos`, name: 'spider', arguments: { action: 'todo', op: 'list' } } }] },
    { steps: [{ tool: { id: `${id}-triggers`, name: 'spider', arguments: { action: 'loop' } } }] },
    { steps: [{ text: `${id} checked` }] },
  ];
}

type Feed = { sessionId: string; generation: string; lifecycle: 'live' | 'closed'; updatedAt: number; owner: { terminal: { address: string } }; ipc: { version: number; sessionId: string; generation: string; address: string; capabilityFile: string } | null };
async function readFeed(path: string): Promise<Feed | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Feed; } catch { return null; }
}
async function liveFeed(suite: Suite, id: string, terminal: string, generation?: string): Promise<Feed> {
  const path = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', id, 'session.json');
  return (await waitFor(`live feed for ${id}`, () => readFeed(path), feed => feed?.lifecycle === 'live' && feed.owner.terminal.address === terminal && feed.ipc !== null && (generation === undefined || feed.generation !== generation), deadline(60_000)))!;
}
async function terminalMapping(suite: Suite, terminal: string, sessionId: string): Promise<void> {
  const directory = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'terminals');
  await waitFor('terminal maps to current session', async () => {
    const files = await readdir(directory).catch(() => []);
    const values = await Promise.all(files.filter(f => f.endsWith('.json')).map(async f => JSON.parse(await readFile(join(directory, f), 'utf8')) as { owner?: { sessionId?: string; terminal?: { address?: string } } }));
    return values.filter(value => value.owner?.terminal?.address === terminal);
  }, rows => rows.length === 1 && rows[0].owner?.sessionId === sessionId, deadline(60_000));
}

async function remoteLifecycle(): Promise<void> {
  const helperPath = '../fixtures/install-inputs.js';
  const helper = await import(/* @vite-ignore */ helperPath).catch(error => {
    if (/Cannot find module ['\"]?[^'\"]*\/fixtures\/install-inputs\.js/i.test(String(error))) throw new Error('prerequisite: the shared setup helper is unavailable');
    throw error;
  }) as { installFresh(suite: Suite): Promise<{ suite: Suite; app: { command(name: string, args: Record<string, unknown>): Promise<unknown> } }> };
  const original = await createSuite({ tier: 'headless', story: storyId('H-s51-remote') });
  try {
    const { suite, app } = await helper.installFresh(original);
    const cwd = await suite.project('remote-lifecycle');
    const payload = await stagePayload(suite, { id: 'held', gateMs: 300_000, beforeStdout: 'before-release\n', stdout: 'after-release\n', exitCode: 23 });
    const resumePayload = await stagePayload(suite, { id: 'resume', gateMs: 300_000, beforeStdout: 'resume-held\n', exitCode: 23 });
    const forkPayload = await stagePayload(suite, { id: 'fork', gateMs: 300_000, beforeStdout: 'fork-held\n', exitCode: 23 });
    const crashPayload = await stagePayload(suite, { id: 'crash', gateMs: 300_000, beforeStdout: 'crash-held\n', exitCode: 23 });
    const quitPayload = await stagePayload(suite, { id: 'quit', gateMs: 300_000, beforeStdout: 'quit-held\n', exitCode: 23 });
    const foregroundPayload = await stagePayload(suite, { id: 'foreground', gateMs: 300_000, beforeStdout: 'foreground-held\n', exitCode: 23 });
    const adoptedPayload = await stagePayload(suite, { id: 'adopted', gateMs: 300_000, beforeStdout: 'adopted-held\n', exitCode: 23 });
    const crashForeground = await stagePayload(suite, { id: 'crash-foreground', gateMs: 300_000, beforeStdout: 'crash-foreground-held\n', exitCode: 23 });
    const script = (id: string, value: PayloadHandle): ScriptFile['scripts'][string] => [
      { steps: [{ tool: { id: `${id}-exec`, name: 'spider', arguments: { action: 'exec', language: 'shell', on: value.machine, code: value.code, background: true, timeout: 3000 } } }] },
      { steps: [{ text: `${id} detached` }] }, { steps: [{ text: `${id} completed` }] },
    ];
    await installScripts(suite, { remote: script('remote', payload), 'remote-resume': script('resume', resumePayload), 'remote-fork': script('fork', forkPayload), 'remote-crash': script('crash', crashPayload), 'remote-quit': script('quit', quitPayload),
      'remote-foreground': [{ steps: [{ tool: { id: 'foreground-exec', name: 'spider', arguments: { action: 'exec', language: 'shell', on: foregroundPayload.machine, code: foregroundPayload.code } } }] }, { steps: [{ text: 'foreground completed' }] }],
      'remote-crash-foreground': [{ steps: [{ tool: { id: 'crash-foreground-exec', name: 'spider', arguments: { action: 'exec', language: 'shell', on: crashForeground.machine, code: crashForeground.code } } }] }, { steps: [{ text: 'crash foreground completed' }] }],
      'adopt-parent': [{ steps: [{ tool: { id: 'adopt-run', name: 'spider', arguments: { action: 'run', agent: 'worker', name: 'adopted-child', model: 'e2e-fixture/scripted', task: `${marker('adopt-child')} start detached work` } } }] }, { steps: [{ text: 'child started' }] }, { steps: [{ text: 'child result received' }] }],
      'adopt-child': [{ steps: [{ tool: { id: 'adopt-exec', name: 'spider', arguments: { action: 'exec', language: 'shell', on: adoptedPayload.machine, code: adoptedPayload.code, background: true, timeout: 3000 } } }] }, { steps: [{ gate: 'adopt-child-held' }, { text: 'child completed' }] }],
    });
    const socket = suite.ownPath(join(suite.root, 'remote-broker.s')), log = suite.ownPath(join(suite.root, 'remote-broker.raw'));
    const environment = suite.ownPath(join(suite.root, 'remote-broker-env.json'));
    await writeFile(environment, JSON.stringify({ ...suite.env, PI_PROGRAM_STATUS: '1' }), { mode: 0o600 });
    const broker = fileURLToPath(new URL('../harness/pty-broker.py', import.meta.url));
    const allocated = await app.command('space.new', { name: 'Fixture space', folder: cwd, tab: 'Owner', argv: ['/usr/bin/python3', broker, '--socket', socket, '--log', log, '--env-file', environment, '--', suite.pi.launcher] }) as { terminal: string; space: string; tab: string };
    suite.ledger.update(ledger => { ledger.terminals.push({ side: 'local', address: allocated.terminal }); });
    const pi = await connectOwnedShell(suite, allocated.terminal, socket, log);
    const observed = observe(suite.pi.observerDir, () => pi.identity.pid);
    const start = await observed.waitEvent('session_start', event => event.mode === 'tui', deadline(60_000));
    const sessionId = String(start.sessionId), feedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', sessionId, 'session.json');
    const initial = await liveFeed(suite, sessionId, pi.terminal);
    await pi.input('/name lifecycle-remote-original\r');
    await waitFor('original remote session title', async () => (await suite.hc(['get', pi.terminal, '--json'])).json as { title?: string } | null,
      value => value?.title?.includes('lifecycle-remote-original') === true, deadline(40_000));
    const turnAt = Date.now(); await pi.input(`${marker('remote')} start a held detached job\r`);
    await payload.ready(deadline(90_000));
    expect(await payload.effect()).toBe(null);
    const result = await observed.toolResult('remote-exec', deadline(90_000));
    expect(result.isError, JSON.stringify(result)).toBe(false);
    const details = (result.result as { details?: { exitCode?: number | null; backgrounded?: boolean; remote?: { jobId?: string; address?: string } } }).details;
    expect(details).toMatchObject({ exitCode: null, backgrounded: true });
    expect(typeof details?.remote?.jobId).toBe('string'); expect(typeof details?.remote?.address).toBe('string');
    const jobId = details!.remote!.jobId!, jobAddress = details!.remote!.address!;
    await observed.waitEvent('agent_settled', event => event.at >= turnAt, deadline(90_000));
    const console = await waitFor('one owned remote console', async () => {
      const list = await suite.hc(['ls', '--all', '--json']);
      const rows = (list.json as { terminals?: { address: string }[] } | null)?.terminals ?? [];
      const matches: { address: string; state: string; labels: Record<string, string> }[] = [];
      for (const row of rows.filter(row => row.address.startsWith(payload.machine + '/'))) {
        const detail = await suite.hc(['get', row.address, '--json']);
        const value = detail.json as { address: string; state: string; labels: Record<string, string> } | null;
        if (detail.exitCode === 0 && value?.labels?.['spider.kind'] === 'remote-console' && value.labels['spider.session'] === sessionId) matches.push(value);
      }
      return matches;
    }, rows => rows.length === 1 && rows[0].state === 'live', deadline(60_000), { reconcileMs: 300 });
    const originalConsole = console[0].address;
    const jobBefore = await suite.hc(['get', jobAddress, '--json']);
    expect(jobBefore.json).toMatchObject({ address: jobAddress, state: 'live', labels: { 'spider.job': jobId, 'spider.session': sessionId } });

    const reloadOffset = (await observed.events()).length;
    await pi.input('/reload\r');
    const reloadRows = await waitFor('real remote-owner reload', observed.events, rows => rows.slice(reloadOffset).some(event => event.type === 'session_start' && event.reason === 'reload'), deadline(90_000));
    expect(reloadRows.slice(reloadOffset).find(event => event.type === 'session_start' && event.reason === 'reload')?.sessionId).toBe(sessionId);
    const reloaded = await liveFeed(suite, sessionId, pi.terminal, initial.generation);
    const stillConsole = await suite.hc(['get', originalConsole, '--json']);
    expect(stillConsole.json).toMatchObject({ address: originalConsole, state: 'live', labels: { 'spider.kind': 'remote-console', 'spider.session': sessionId } });
    const stillJob = await suite.hc(['get', jobAddress, '--json']);
    expect(stillJob.json).toMatchObject({ address: jobAddress, state: 'live', labels: { 'spider.job': jobId, 'spider.session': sessionId } });
    expect(await payload.effect()).toBe(null);
    expect((await readdir(join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'ipc'))).filter(name => name.endsWith('.sock'))).toHaveLength(1);

    const newOffset = (await observed.events()).length;
    await pi.input('/new\r');
    const newRows = await waitFor('real remote-owner replacement', observed.events, rows => rows.slice(newOffset).some(event => event.type === 'session_start' && event.reason === 'new'), deadline(90_000));
    const newId = String(newRows.slice(newOffset).find(event => event.type === 'session_start' && event.reason === 'new')?.sessionId);
    expect(newId).not.toBe(sessionId);
    const next = await liveFeed(suite, newId, pi.terminal);
    await terminalMapping(suite, pi.terminal, newId);
    expect((await readFeed(feedPath))?.lifecycle).toBe('live');
    await waitFor('old console closes after replacement', async () => {
      const value = await suite.hc(['get', originalConsole, '--json']);
      if (value.exitCode !== 0) {
        if (/not.?found|no such/i.test(value.stderr + value.stdout)) return true;
        throw new Error(`unexpected console query failure: ${value.stderr || value.stdout}`);
      }
      return (value.json as { state?: string } | null)?.state === 'finished';
    }, Boolean, deadline(60_000), { reconcileMs: 300 });
    const ipc = (request: Record<string, unknown>) => suite.invoke(process.execPath, [suite.packed.cli, 'ipc', '--descriptor', JSON.stringify(next.ipc), '--request', JSON.stringify({ ...request, generation: next.generation })], suite.env, cwd);
    const ping = await ipc({ op: 'ping' }); expect(ping.exitCode, ping.stderr).toBe(0); expect(JSON.parse(ping.stdout)).toMatchObject({ ok: true, op: 'ping' });
    const wrongOwner = await ipc({ op: 'openJob', jobId });
    expect(wrongOwner.exitCode).not.toBe(0); expect(JSON.parse(wrongOwner.stdout)).toMatchObject({ ok: false, code: 'not-found' });
    const afterNew = await suite.hc(['get', jobAddress, '--json']);
    expect(afterNew.json).toMatchObject({ state: 'live', labels: { 'spider.job': jobId, 'spider.session': sessionId } });
    expect(await payload.effect()).toBe(null);
    await payload.release();
    await waitFor('detached payload finishes once after replacement', () => payload.effect(), value => value === 'held\n', deadline(90_000));
    const finished = await waitFor('real detached terminal finishes', async () => (await suite.hc(['get', jobAddress, '--json'])).json as { state?: string; exit_code?: number; signal?: number | null } | null,
      value => value?.state === 'finished', deadline(90_000), { reconcileMs: 300 });
    expect(finished).toMatchObject({ exit_code: 23, signal: null });
    expect(await payload.effect()).toBe('held\n');
    await suite.evidence('remote-lifecycle.json', { start, result, console, reloaded, newSession: next, wrongOwner, finished });

    const launch = async (label: 'resume' | 'fork' | 'crash' | 'quit', value: PayloadHandle, owner: string, actor = pi, observation = observed) => {
      const at = Date.now(); await actor.input(`${marker(`remote-${label}`)} start ${label} job\r`);
      await value.ready(deadline(90_000)); expect(await value.effect()).toBe(null);
      const event = await observation.toolResult(`${label}-exec`, deadline(90_000));
      expect(event.isError, JSON.stringify(event)).toBe(false);
      const data = (event.result as { details?: { exitCode?: number | null; backgrounded?: boolean; remote?: { jobId?: string; address?: string } } }).details;
      expect(data).toMatchObject({ exitCode: null, backgrounded: true });
      expect(typeof data?.remote?.jobId).toBe('string'); expect(typeof data?.remote?.address).toBe('string');
      await observation.waitEvent('agent_settled', row => row.at >= at, deadline(90_000));
      const consoles = await waitFor(`one ${label} owner console`, async () => {
        const list = await suite.hc(['ls', '--all', '--json']);
        const rows = (list.json as { terminals?: { address: string }[] } | null)?.terminals ?? [];
        const found: { address: string; state: string; labels: Record<string, string> }[] = [];
        for (const row of rows.filter(row => row.address.startsWith(value.machine + '/'))) {
          const detail = await suite.hc(['get', row.address, '--json']);
          const item = detail.json as { address: string; state: string; labels: Record<string, string> } | null;
          if (detail.exitCode === 0 && item?.labels?.['spider.kind'] === 'remote-console' && item.labels['spider.session'] === owner) found.push(item);
        }
        return found;
      }, rows => rows.length === 1 && rows[0].state === 'live', deadline(60_000), { reconcileMs: 300 });
      const job = { id: data!.remote!.jobId!, address: data!.remote!.address!, console: consoles[0].address, owner, payload: value };
      const detail = await suite.hc(['get', job.address, '--json']);
      expect(detail.json).toMatchObject({ state: 'live', labels: { 'spider.job': job.id, 'spider.session': owner } });
      await suite.evidence(`remote-${label}-launch.json`, { event, consoles, detail: detail.json });
      return job;
    };
    const replaced = async (label: string, job: Awaited<ReturnType<typeof launch>>, current: Feed) => {
      await waitFor(`${label} old console closes`, async () => {
        const value = await suite.hc(['get', job.console, '--json']);
        if (value.exitCode !== 0) {
          if (/not.?found|no such/i.test(value.stderr + value.stdout)) return true;
          throw new Error(`unexpected console query failure: ${value.stderr || value.stdout}`);
        }
        return (value.json as { state?: string } | null)?.state === 'finished';
      }, Boolean, deadline(60_000), { reconcileMs: 300 });
      const call = (request: Record<string, unknown>) => suite.invoke(process.execPath, [suite.packed.cli, 'ipc', '--descriptor', JSON.stringify(current.ipc), '--request', JSON.stringify({ ...request, generation: current.generation })], suite.env, cwd);
      const ping = await call({ op: 'ping' }); expect(ping.exitCode, ping.stderr).toBe(0); expect(JSON.parse(ping.stdout)).toMatchObject({ ok: true, op: 'ping' });
      const denied = await call({ op: 'openJob', jobId: job.id });
      expect(denied.exitCode).not.toBe(0); expect(JSON.parse(denied.stdout)).toMatchObject({ ok: false, code: 'not-found' });
      const live = await suite.hc(['get', job.address, '--json']);
      expect(live.json).toMatchObject({ state: 'live', labels: { 'spider.job': job.id, 'spider.session': job.owner } });
      expect(await job.payload.effect()).toBe(null);
      await job.payload.release();
      await waitFor(`${label} detached effect`, () => job.payload.effect(), value => value === `${job.payload.id}\n`, deadline(90_000));
      const exit = await waitFor(`${label} detached terminal finishes`, async () => (await suite.hc(['get', job.address, '--json'])).json as { state?: string; exit_code?: number; signal?: number | null } | null,
        value => value?.state === 'finished', deadline(90_000), { reconcileMs: 300 });
      expect(exit).toMatchObject({ exit_code: 23, signal: null });
      expect(await job.payload.effect()).toBe(`${job.payload.id}\n`);
      await suite.evidence(`remote-${label}-replacement.json`, { current, denied, live: live.json, exit });
    };

    const resumeJob = await launch('resume', resumePayload, newId);
    const resumeOffset = (await observed.events()).length, resumeRaw = (await pi.output()).length;
    await pi.input('/resume\r');
    await waitFor('remote resume selector lists the original session', async () => (await pi.output()).slice(resumeRaw), text => text.includes('Resume Session') && text.includes('lifecycle-remote-original'), deadline(60_000));
    await pi.input('lifecycle-remote-original');
    await waitFor('remote resume search renders', async () => (await pi.output()).slice(resumeRaw), text => text.lastIndexOf('lifecycle-remote-original') > text.indexOf('Resume Session'), deadline(30_000));
    await pi.input('\r');
    const resumedRows = await waitFor('remote resume session_start', observed.events, rows => rows.slice(resumeOffset).some(event => event.type === 'session_start' && event.reason === 'resume'), deadline(90_000));
    expect(resumedRows.slice(resumeOffset).find(event => event.type === 'session_start' && event.reason === 'resume')?.sessionId).toBe(sessionId);
    const resumedFeed = await liveFeed(suite, sessionId, pi.terminal, reloaded.generation);
    await terminalMapping(suite, pi.terminal, sessionId);
    const newFeedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', newId, 'session.json');
    expect((await readFeed(newFeedPath))?.lifecycle).toBe('live');
    await replaced('resume', resumeJob, resumedFeed);

    const forkJob = await launch('fork', forkPayload, sessionId);
    const forkOffset = (await observed.events()).length, forkRaw = (await pi.output()).length;
    await pi.input('/fork\r');
    await waitFor('remote fork selector renders', async () => (await pi.output()).slice(forkRaw), text => text.includes('Fork from Message'), deadline(60_000));
    await pi.input('\r');
    const forkRows = await waitFor('remote fork session_start', observed.events, rows => rows.slice(forkOffset).some(event => event.type === 'session_start' && event.reason === 'fork'), deadline(90_000));
    const forkId = String(forkRows.slice(forkOffset).find(event => event.type === 'session_start' && event.reason === 'fork')?.sessionId);
    expect(forkId).not.toBe(sessionId); expect(forkId).not.toBe(newId);
    const forkFeed = await liveFeed(suite, forkId, pi.terminal);
    await terminalMapping(suite, pi.terminal, forkId);
    expect((await readFeed(feedPath))?.lifecycle).toBe('live');
    await waitFor('fork restores the selected draft', () => pi.draft(), text => text.includes(marker('remote-fork')), deadline(30_000));
    await pi.input('\u0015'); await waitFor('fork draft is cleared', () => pi.draft(), text => text === '', deadline(30_000));
    await replaced('fork', forkJob, forkFeed);

    const crashJob = await launch('crash', crashPayload, forkId);
    const crashFeedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', forkId, 'session.json');
    const crashAt = Date.now();
    expect(identityAlive(pi.identity)).toBe(true);
    process.kill(pi.identity.pid, 'SIGKILL');
    await waitFor('crashed owner exits', () => identityAlive(pi.identity), alive => !alive, deadline(30_000));
    expect((await observed.events()).some(event => event.type === 'session_shutdown' && event.at >= crashAt && event.reason === 'quit')).toBe(false);
    expect((await readFeed(crashFeedPath))?.lifecycle, 'crash cannot write a clean closed feed').toBe('live');
    const recoverySocket = suite.ownPath(join(suite.root, 'recovery-broker.s'));
    const recoveryLog = suite.ownPath(join(suite.root, 'recovery-broker.raw'));
    const recoveryTab = await app.command('tab.new', { space: allocated.space, name: 'Recovery', folder: cwd,
      argv: ['/usr/bin/python3', broker, '--socket', recoverySocket, '--log', recoveryLog, '--env-file', environment, '--', suite.pi.launcher] }) as { terminal: string };
    suite.ledger.update(ledger => { ledger.terminals.push({ side: 'local', address: recoveryTab.terminal }); });
    const recoveryPi = await connectOwnedShell(suite, recoveryTab.terminal, recoverySocket, recoveryLog);
    const recoveryObserved = observe(suite.pi.observerDir, () => recoveryPi.identity.pid);
    const recoveryStart = await recoveryObserved.waitEvent('session_start', event => event.mode === 'tui', deadline(60_000));
    const recoveryId = String(recoveryStart.sessionId);
    expect(recoveryId).not.toBe(forkId);
    const recoveryFeed = await liveFeed(suite, recoveryId, recoveryPi.terminal);
    await replaced('crash', crashJob, recoveryFeed);
    expect((await readFeed(crashFeedPath))?.lifecycle, 'recovery must not fabricate a closed old feed').toBe('live');
    await suite.evidence('remote-crash-recovery.json', { crashAt, recoveryStart, oldFeed: await readFeed(crashFeedPath), recoveryFeed });

    const recoveryReloadOffset = (await recoveryObserved.events()).length;
    await recoveryPi.input('/reload\r');
    const recoveryReloadRows = await waitFor('recovery owner reloads', recoveryObserved.events, rows => rows.slice(recoveryReloadOffset).some(event => event.type === 'session_start' && event.reason === 'reload'), deadline(90_000));
    expect(recoveryReloadRows.slice(recoveryReloadOffset).find(event => event.type === 'session_start' && event.reason === 'reload')?.sessionId).toBe(recoveryId);
    await liveFeed(suite, recoveryId, recoveryPi.terminal, recoveryFeed.generation);
    const gates = await suite.gates();
    const adoptAt = Date.now(); await recoveryPi.input(`${marker('adopt-parent')} start a child after reload\r`);
    await adoptedPayload.ready(deadline(90_000));
    const childReady = await gates.ready('adopt-child-held', deadline(90_000));
    const run = await recoveryObserved.toolResult('adopt-run', deadline(30_000));
    expect(run.isError).toBe(false);
    const runId = (run.result as { details?: { run?: { id?: string } } }).details?.run?.id;
    expect(typeof runId).toBe('string');
    const childEvents = await readObserved(suite.pi.observerDir, childReady.pid);
    expect(childEvents.find(event => event.type === 'session_start')).toMatchObject({ subagentChild: '1', mode: 'rpc' });
    const childExec = childEvents.find(event => event.type === 'tool_execution_end' && event.toolCallId === 'adopt-exec');
    expect(childExec).toMatchObject({ isError: false });
    const childDetails = (childExec?.result as { details?: { exitCode?: number | null; backgrounded?: boolean; remote?: { jobId?: string; address?: string } } } | undefined)?.details;
    expect(childDetails).toMatchObject({ exitCode: null, backgrounded: true });
    expect(typeof childDetails?.remote?.jobId).toBe('string'); expect(typeof childDetails?.remote?.address).toBe('string');
    const adoptedId = childDetails!.remote!.jobId!, adoptedAddress = childDetails!.remote!.address!;
    await recoveryObserved.waitEvent('agent_settled', event => event.at >= adoptAt, deadline(90_000));
    const childConsoles = await waitFor('live child-owned console', async () => {
      const list = await suite.hc(['ls', '--all', '--json']);
      const rows = (list.json as { terminals?: { address: string }[] } | null)?.terminals ?? [];
      const matches: { address: string; state: string; labels: Record<string, string> }[] = [];
      for (const row of rows.filter(row => row.address.startsWith(adoptedPayload.machine + '/'))) {
        const detail = await suite.hc(['get', row.address, '--json']);
        const value = detail.json as { address: string; state: string; labels: Record<string, string> } | null;
        if (detail.exitCode === 0 && value?.labels?.['spider.kind'] === 'remote-console' && value.labels['spider.run'] === runId) matches.push(value);
      }
      return matches;
    }, rows => rows.length === 1 && rows[0].state === 'live', deadline(60_000), { reconcileMs: 300 });
    const childDoneAt = Date.now(); gates.release('adopt-child-held');
    await recoveryObserved.waitEvent('message_end', event => event.at >= childDoneAt && event.customType === 'spider.subagent_done', deadline(90_000));
    await recoveryObserved.waitEvent('agent_settled', event => event.at >= childDoneAt, deadline(90_000));
    await waitFor('ended child console closes', async () => {
      const value = await suite.hc(['get', childConsoles[0].address, '--json']);
      if (value.exitCode !== 0) {
        if (/not.?found|no such/i.test(value.stderr + value.stdout)) return true;
        throw new Error(`unexpected child console query failure: ${value.stderr || value.stdout}`);
      }
      return (value.json as { state?: string } | null)?.state === 'finished';
    }, Boolean, deadline(60_000), { reconcileMs: 300 });
    const adoptedLive = await suite.hc(['get', adoptedAddress, '--json']);
    expect(adoptedLive.json).toMatchObject({ state: 'live', labels: { 'spider.job': adoptedId, 'spider.session': recoveryId, 'spider.run': runId } });
    expect(await adoptedPayload.effect()).toBe(null);

    const quitJob = await launch('quit', quitPayload, recoveryId, recoveryPi, recoveryObserved);
    const recoveryFeedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', recoveryId, 'session.json');
    const quitAt = Date.now(); await recoveryPi.input('/quit\r');
    await recoveryObserved.waitEvent('session_shutdown', event => event.at >= quitAt && event.reason === 'quit', deadline(90_000));
    await waitFor('quit owner exits', () => identityAlive(recoveryPi.identity), alive => !alive, deadline(60_000));
    const closed = await waitFor('quit closes its owner feed', () => readFeed(recoveryFeedPath), feed => feed?.lifecycle === 'closed', deadline(60_000));
    await waitFor('quit owner console closes', async () => {
      const value = await suite.hc(['get', quitJob.console, '--json']);
      if (value.exitCode !== 0) {
        if (/not.?found|no such/i.test(value.stderr + value.stdout)) return true;
        throw new Error(`unexpected console query failure: ${value.stderr || value.stdout}`);
      }
      return (value.json as { state?: string } | null)?.state === 'finished';
    }, Boolean, deadline(60_000), { reconcileMs: 300 });
    const quitLive = await suite.hc(['get', quitJob.address, '--json']);
    expect(quitLive.json).toMatchObject({ state: 'live', labels: { 'spider.job': quitJob.id, 'spider.session': recoveryId } });
    expect(await quitPayload.effect()).toBe(null); await quitPayload.release();
    await waitFor('detached job survives owner quit', () => quitPayload.effect(), value => value === 'quit\n', deadline(90_000));
    const quitExit = await waitFor('quit detached terminal finishes', async () => (await suite.hc(['get', quitJob.address, '--json'])).json as { state?: string; exit_code?: number; signal?: number | null } | null,
      value => value?.state === 'finished', deadline(90_000), { reconcileMs: 300 });
    expect(quitExit).toMatchObject({ exit_code: 23, signal: null });
    expect(await quitPayload.effect()).toBe('quit\n');
    const adoptedAfterQuit = await suite.hc(['get', adoptedAddress, '--json']);
    expect(adoptedAfterQuit.json).toMatchObject({ state: 'live', labels: { 'spider.job': adoptedId, 'spider.session': recoveryId, 'spider.run': runId } });
    expect(await adoptedPayload.effect()).toBe(null); await adoptedPayload.release();
    await waitFor('adopted child job survives parent quit', () => adoptedPayload.effect(), value => value === 'adopted\n', deadline(90_000));
    const adoptedExit = await waitFor('adopted terminal finishes', async () => (await suite.hc(['get', adoptedAddress, '--json'])).json as { state?: string; exit_code?: number; signal?: number | null } | null,
      value => value?.state === 'finished', deadline(90_000), { reconcileMs: 300 });
    expect(adoptedExit).toMatchObject({ exit_code: 23, signal: null });
    expect(await adoptedPayload.effect()).toBe('adopted\n');
    await suite.evidence('remote-quit-survival.json', { closed, quitLive: quitLive.json, quitExit, run, childExec, childConsoles, adoptedLive: adoptedLive.json, adoptedAfterQuit: adoptedAfterQuit.json, adoptedExit });

    const foregroundSocket = suite.ownPath(join(suite.root, 'foreground-broker.s'));
    const foregroundLog = suite.ownPath(join(suite.root, 'foreground-broker.raw'));
    const foregroundTab = await app.command('space.new', { name: 'Foreground fixture', folder: cwd, tab: 'Owner',
      argv: ['/usr/bin/python3', broker, '--socket', foregroundSocket, '--log', foregroundLog, '--env-file', environment, '--', suite.pi.launcher] }) as { terminal: string };
    suite.ledger.update(ledger => { ledger.terminals.push({ side: 'local', address: foregroundTab.terminal }); });
    const foregroundPi = await connectOwnedShell(suite, foregroundTab.terminal, foregroundSocket, foregroundLog);
    const foregroundObserved = observe(suite.pi.observerDir, () => foregroundPi.identity.pid);
    const foregroundStart = await foregroundObserved.waitEvent('session_start', event => event.mode === 'tui', deadline(60_000));
    const foregroundId = String(foregroundStart.sessionId);
    await liveFeed(suite, foregroundId, foregroundPi.terminal);
    await foregroundPi.input(`${marker('remote-foreground')} start held foreground work\r`);
    const ready = await foregroundPayload.ready(deadline(90_000));
    const payloadIdentity = identityOf(ready.pid);
    suite.ledger.update(ledger => { ledger.processes.push({ ...payloadIdentity, label: 'foreground-payload', group: false }); });
    expect(await foregroundPayload.effect()).toBe(null);
    const foregroundQuitAt = Date.now(); await foregroundPi.input('/quit\r');
    await foregroundObserved.waitEvent('session_shutdown', event => event.at >= foregroundQuitAt && event.reason === 'quit', deadline(90_000));
    await waitFor('foreground owner exits', () => identityAlive(foregroundPi.identity), alive => !alive, deadline(60_000));
    await waitFor('foreground payload is cancelled on quit', () => identityAlive(payloadIdentity), alive => !alive, deadline(90_000));
    await foregroundPayload.release();
    expect(await foregroundPayload.effect()).toBe(null);
    const foregroundFeedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', foregroundId, 'session.json');
    const foregroundClosed = await waitFor('foreground quit closes its feed', () => readFeed(foregroundFeedPath), feed => feed?.lifecycle === 'closed', deadline(60_000));
    await suite.evidence('remote-foreground-quit.json', { ready, foregroundStart, foregroundClosed });

    const crashFgSocket = suite.ownPath(join(suite.root, 'crash-fg-broker.s'));
    const crashFgLog = suite.ownPath(join(suite.root, 'crash-fg-broker.raw'));
    const crashFgTab = await app.command('space.new', { name: 'Crash foreground fixture', folder: cwd, tab: 'Owner',
      argv: ['/usr/bin/python3', broker, '--socket', crashFgSocket, '--log', crashFgLog, '--env-file', environment, '--', suite.pi.launcher] }) as { terminal: string };
    suite.ledger.update(ledger => { ledger.terminals.push({ side: 'local', address: crashFgTab.terminal }); });
    const crashFgPi = await connectOwnedShell(suite, crashFgTab.terminal, crashFgSocket, crashFgLog);
    const crashFgObserved = observe(suite.pi.observerDir, () => crashFgPi.identity.pid);
    const crashFgStart = await crashFgObserved.waitEvent('session_start', event => event.mode === 'tui', deadline(60_000));
    const crashFgId = String(crashFgStart.sessionId);
    expect(typeof crashFgStart.sessionFile).toBe('string');
    const crashFgFile = suite.ownPath(crashFgStart.sessionFile as string);
    const crashFgFeedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', crashFgId, 'session.json');
    await liveFeed(suite, crashFgId, crashFgPi.terminal);
    await crashFgPi.input(`${marker('remote-crash-foreground')} start held foreground work\r`);
    const crashFgReady = await crashForeground.ready(deadline(90_000));
    const crashFgPayloadIdentity = identityOf(crashFgReady.pid);
    suite.ledger.update(ledger => { ledger.processes.push({ ...crashFgPayloadIdentity, label: 'crashed-foreground-payload', group: false }); });
    expect(await crashForeground.effect()).toBe(null);
    expect(identityAlive(crashFgPi.identity), 'foreground owner identity is still current').toBe(true);
    const crashFgAt = Date.now(); process.kill(crashFgPi.identity.pid, 'SIGKILL');
    await waitFor('foreground crash owner exits', () => identityAlive(crashFgPi.identity), alive => !alive, deadline(30_000));
    expect((await crashFgObserved.events()).some(event => event.type === 'session_shutdown' && event.at >= crashFgAt)).toBe(false);
    expect((await readFeed(crashFgFeedPath))?.lifecycle).toBe('live');
    const resumedSocket = suite.ownPath(join(suite.root, 'crash-fg-resume.s'));
    const resumedLog = suite.ownPath(join(suite.root, 'crash-fg-resume.raw'));
    const resumedTab = await app.command('space.new', { name: 'Resume foreground fixture', folder: cwd, tab: 'Owner',
      argv: ['/usr/bin/python3', broker, '--socket', resumedSocket, '--log', resumedLog, '--env-file', environment, '--', suite.pi.launcher, '--session', crashFgFile] }) as { terminal: string };
    suite.ledger.update(ledger => { ledger.terminals.push({ side: 'local', address: resumedTab.terminal }); });
    const resumedPi = await connectOwnedShell(suite, resumedTab.terminal, resumedSocket, resumedLog);
    const resumedObserved = observe(suite.pi.observerDir, () => resumedPi.identity.pid);
    const resumedStart = await resumedObserved.waitEvent('session_start', event => event.mode === 'tui', deadline(60_000));
    expect(resumedStart.sessionId).toBe(crashFgId); expect(resumedStart.sessionFile).toBe(crashFgFile);
    await liveFeed(suite, crashFgId, resumedPi.terminal);
    try { await waitFor('resumed owner cancels crashed foreground work', () => identityAlive(crashFgPayloadIdentity), alive => !alive, deadline(30_000), { reconcileMs: 500 }); }
    catch (error) {
      await suite.evidence('remote-crash-foreground-failure.json', { crashFgStart, crashFgReady, resumedStart, payloadAlive: identityAlive(crashFgPayloadIdentity), inventory: (await suite.hc(['ls', '--all', '--json'])).json });
      throw error;
    }
    await crashForeground.release(); expect(await crashForeground.effect()).toBe(null);
    await suite.evidence('remote-crash-foreground.json', { crashFgStart, crashFgReady, resumedStart });
    await suite.evidence('remote-lifecycle-events.json', await observed.events());
    await suite.evidence('remote-lifecycle.raw', await pi.output());
    await suite.evidence('remote-crash-recovery.raw', await recoveryPi.output());
    await suite.evidence('remote-foreground.raw', await foregroundPi.output());
  } finally { await original.close(); }
}

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S51'), title: 'Session replacement, reload, quit and crash have distinct ownership', tiers: ['headless', 'ci', 'app'],
  async run(suite) {
    await configureHerdr(suite, false, false);
    await installScripts(suite, {
      create: [
        { steps: [{ tool: { id: 'todo-create', name: 'spider', arguments: { action: 'todo', op: 'add', text: todoMarker } } }] },
        { steps: [{ tool: { id: 'trigger-create', name: 'spider', arguments: { action: 'schedule', name: 'fixture-wakeup', delaySeconds: 3600, prompt: 'fixture future prompt' } } }] },
        { steps: [{ text: 'first session created' }] },
      ],
      fresh: listScript('fresh'), resumed: listScript('resumed'), forked: listScript('forked'),
      signal: [{ steps: [{ text: 'signal-session-saved' }] }],
      'denied-before': writeFailureScript('denied-before'), 'denied-reload': writeFailureScript('denied-reload'), 'denied-new': writeFailureScript('denied-new'),
    });
    const project = await suite.project('lifecycle');
    const pi = await suite.launchPi({ mode: 'rpc', cwd: project, label: 'lifecycle-rpc' }) as RpcDriver;
    try {
      await pi.waitEvent('session_start', () => true, deadline(60_000));
      await pi.prompt(`${marker('create')} create session data`, deadline(90_000));
      expect((await pi.toolResult('todo-create', deadline(10_000))).isError).toBe(false);
      expect((await pi.toolResult('trigger-create', deadline(10_000))).isError).toBe(false);
      const firstState = (await pi.rpc({ type: 'get_state' })).data as { sessionId: string; sessionFile: string };
      expect(firstState.sessionId).toBeTruthy();
      expect(firstState.sessionFile.startsWith(suite.root + '/')).toBe(true);
      const messages = (await pi.rpc({ type: 'get_fork_messages' })).data as { messages: { entryId: string; text: string }[] };
      const forkEntry = messages.messages.find(m => m.text.includes(marker('create')))?.entryId;
      expect(forkEntry).toBeTruthy();

      await expect(replaceRpcSession(pi, { kind: 'fork', entryId: 'not-an-entry' })).rejects.toThrow();
      expect(((await pi.rpc({ type: 'get_state' })).data as { sessionId: string }).sessionId).toBe(firstState.sessionId);
      expect((await replaceRpcSession(pi, { kind: 'new' })).response.data).toMatchObject({ cancelled: false });
      const freshId = ((await pi.rpc({ type: 'get_state' })).data as { sessionId: string }).sessionId;
      expect(freshId).not.toBe(firstState.sessionId);
      await pi.prompt(`${marker('fresh')} inspect fresh session`, deadline(90_000));
      const freshTodos = await pi.toolResult('fresh-todos', deadline(10_000));
      const freshTriggers = await pi.toolResult('fresh-triggers', deadline(10_000));
      expect(freshTodos.isError).toBe(false); expect(freshTriggers.isError).toBe(false);
      expect(JSON.stringify(freshTodos.result)).not.toContain(todoMarker);
      expect(JSON.stringify(freshTriggers.result)).not.toContain('fixture-wakeup');

      expect((await replaceRpcSession(pi, { kind: 'resume', sessionFile: firstState.sessionFile })).response.data).toMatchObject({ cancelled: false });
      expect(((await pi.rpc({ type: 'get_state' })).data as { sessionId: string }).sessionId).toBe(firstState.sessionId);
      await pi.prompt(`${marker('resumed')} inspect resumed session`, deadline(90_000));
      expect(JSON.stringify((await pi.toolResult('resumed-todos', deadline(10_000))).result)).toContain(todoMarker);
      expect(JSON.stringify((await pi.toolResult('resumed-triggers', deadline(10_000))).result)).toContain('fixture-wakeup');
      expect((await replaceRpcSession(pi, { kind: 'fork', entryId: forkEntry! })).response.data).toMatchObject({ cancelled: false });
      const forkId = ((await pi.rpc({ type: 'get_state' })).data as { sessionId: string }).sessionId;
      expect(forkId).not.toBe(firstState.sessionId); expect(forkId).not.toBe(freshId);
      await pi.prompt(`${marker('forked')} inspect fork`, deadline(90_000));
      expect(JSON.stringify((await pi.toolResult('forked-todos', deadline(10_000))).result)).not.toContain(todoMarker);
      expect(JSON.stringify((await pi.toolResult('forked-triggers', deadline(10_000))).result)).not.toContain('fixture-wakeup');
      const herdr = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr');
      await waitFor('one inactive process presence', async () => (await readdir(join(herdr, 'processes')).catch(() => [])).length, count => count === 1, deadline(20_000));
      for (const name of ['sessions', 'ipc', 'ssh']) expect(existsSync(join(herdr, name)), name).toBe(false);
    } finally {
      await suite.evidence('lifecycle-rpc-events.json', await pi.events());
      await suite.evidence('lifecycle-rpc-records.json', pi.records());
      await quitPi(pi);
      await suite.evidence('lifecycle-rpc-after-close.json', await pi.events());
    }
    expect((await pi.events()).some(e => e.type === 'session_shutdown' && e.reason === 'quit'), 'closing RPC stdin produces a real quit').toBe(true);
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const killed = await suite.launchPi({ mode: 'rpc', cwd: project, label: `lifecycle-${signal}` }) as RpcDriver;
      try {
        await killed.waitEvent('session_start', () => true, deadline(60_000));
        await killed.prompt(`${marker('signal')} save before ${signal}`, deadline(90_000));
        const state = (await killed.rpc({ type: 'get_state' })).data as { sessionId: string; sessionFile: string };
        expect(state.sessionFile.startsWith(suite.root + '/')).toBe(true);
        expect(identityAlive(killed.identity)).toBe(true);
        await signalPi(killed, signal);
        expect(identityAlive(killed.identity)).toBe(false);
        await expect(signalPi(killed, signal)).rejects.toThrow(/not alive/i);
        const observed = await killed.events();
        await suite.evidence(`lifecycle-${signal}-events.json`, observed);
        if (signal === 'SIGKILL') expect(observed.some(e => e.type === 'session_shutdown'), 'SIGKILL cannot run a clean quit hook').toBe(false);
        else expect(observed.some(e => e.type === 'session_shutdown' && e.reason === 'quit'), 'SIGTERM takes the orderly pi shutdown path').toBe(true);
        const reopened = await suite.launchPi({ mode: 'rpc', cwd: project, args: ['--session', state.sessionFile], label: `lifecycle-${signal}-resume` }) as RpcDriver;
        try {
          await reopened.waitEvent('session_start', () => true, deadline(60_000));
          expect(((await reopened.rpc({ type: 'get_state' })).data as { sessionId: string }).sessionId).toBe(state.sessionId);
          expect(JSON.stringify((await reopened.rpc({ type: 'get_messages' })).data)).toContain('signal-session-saved');
          await suite.evidence(`lifecycle-${signal}-resume.json`, reopened.records());
        } finally { await reopened.close(); }
      } finally { await killed.close(); }
    }
    if (suite.options.tier !== 'ci') {
      const tui = await suite.launchPi({ mode: 'interactive', cwd: project }) as InteractiveDriver;
      try {
        const initial = await tui.waitEvent('session_start', () => true, deadline(60_000));
        expect(initial).toMatchObject({ mode: 'tui', hcTerminal: tui.terminal });
        await tui.prompt(`${marker('signal')} establish interactive history`);
        await tui.waitEvent('agent_settled', () => true, deadline(90_000));
        const reloaded = await reloadInteractive(tui);
        expect(reloaded).toMatchObject({ reason: 'reload', sessionId: initial.sessionId });
        const fresh = await newInteractive(tui);
        expect(fresh.reason).toBe('new'); expect(fresh.sessionId).not.toBe(initial.sessionId);
        await quitPi(tui);
        expect((await tui.events()).some(e => e.type === 'session_shutdown' && e.reason === 'quit')).toBe(true);
      } finally {
        await suite.evidence('lifecycle-tui-events.json', await tui.events());
        await suite.evidence('lifecycle-tui-raw.log', await tui.rawOutput());
        await tui.close();
      }
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        const signalled = await suite.launchPi({ mode: 'interactive', cwd: project }) as InteractiveDriver;
        try {
          await signalled.waitEvent('session_start', () => true, deadline(60_000));
          await signalled.prompt(`${marker('signal')} before interactive ${signal}`);
          await signalled.waitEvent('agent_settled', () => true, deadline(90_000));
          const events = await signalPi(signalled, signal);
          if (signal === 'SIGKILL') expect(events.some(e => e.type === 'session_shutdown')).toBe(false);
          else expect(events.some(e => e.type === 'session_shutdown' && e.reason === 'quit')).toBe(true);
          await expect(signalPi(signalled, signal)).rejects.toThrow(/not alive/i);
          await suite.evidence(`lifecycle-tui-${signal}.json`, events);
        } finally { await signalled.close(); }
      }
      const activeEnv = await configureActiveHerdr(suite);
      const activeProject = await suite.project('active-lifecycle');
      const active = await suite.launchPi({ mode: 'interactive', cwd: activeProject, extraEnv: activeEnv }) as InteractiveDriver;
      try {
        const initial = await active.waitEvent('session_start', () => true, deadline(60_000));
        const firstId = String(initial.sessionId);
        const firstFeedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', firstId, 'session.json');
        const firstFeed = await liveFeed(suite, firstId, active.terminal);
        await terminalMapping(suite, active.terminal, firstId);
        const firstTurn = Date.now();
        await active.prompt(`${marker('create')} original conversation`);
        await active.waitEvent('agent_settled', event => event.at >= firstTurn, deadline(90_000));
        expect((await active.toolResult('todo-create', deadline(10_000))).isError).toBe(false);
        expect((await active.toolResult('trigger-create', deadline(10_000))).isError).toBe(false);
        await active.prompt('/name lifecycle-original');
        await waitFor('original session title', async () => (await suite.hc(['get', active.terminal, '--json'])).json as { title?: string } | null,
          value => value?.title?.includes('lifecycle-original') === true, deadline(40_000));

        const reload = await reloadInteractive(active);
        expect(reload.sessionId).toBe(firstId);
        const reloadedFeed = await liveFeed(suite, firstId, active.terminal, firstFeed.generation);
        expect(reloadedFeed.lifecycle).toBe('live');
        await terminalMapping(suite, active.terminal, firstId);
        const sockets = (await readdir(join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'ipc'))).filter(name => name.endsWith('.sock'));
        expect(sockets).toHaveLength(1);
        await suite.evidence('lifecycle-reloaded-feed.json', reloadedFeed);

        const fresh = await newInteractive(active);
        const secondId = String(fresh.sessionId);
        expect(secondId).not.toBe(firstId);
        await liveFeed(suite, secondId, active.terminal);
        await terminalMapping(suite, active.terminal, secondId);
        expect((await readFeed(firstFeedPath))?.lifecycle, 'new does not mark the old feed closed').toBe('live');
        const secondTurn = Date.now(); await active.prompt(`${marker('fresh')} second conversation`);
        await active.waitEvent('agent_settled', event => event.at >= secondTurn, deadline(90_000));
        expect(JSON.stringify((await active.toolResult('fresh-todos', deadline(10_000))).result)).not.toContain(todoMarker);
        expect(JSON.stringify((await active.toolResult('fresh-triggers', deadline(10_000))).result)).not.toContain('fixture-wakeup');
        await active.prompt('/name lifecycle-other');
        await waitFor('second session title', async () => (await suite.hc(['get', active.terminal, '--json'])).json as { title?: string } | null,
          value => value?.title?.includes('lifecycle-other') === true, deadline(40_000));

        const resumed = await resumeInteractive(active, { name: 'lifecycle-original', sessionId: firstId });
        expect(resumed.sessionId).toBe(firstId);
        await liveFeed(suite, firstId, active.terminal, reloadedFeed.generation);
        await terminalMapping(suite, active.terminal, firstId);
        const secondFeedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', secondId, 'session.json');
        expect((await readFeed(secondFeedPath))?.lifecycle, 'resume does not mark the replaced feed closed').toBe('live');
        const resumedAt = Date.now(); await active.prompt(`${marker('resumed')} inspect the restored owner`);
        await active.waitEvent('agent_settled', event => event.at >= resumedAt, deadline(90_000));
        expect(JSON.stringify((await active.toolResult('resumed-todos', deadline(10_000))).result)).toContain(todoMarker);
        expect(JSON.stringify((await active.toolResult('resumed-triggers', deadline(10_000))).result)).toContain('fixture-wakeup');

        const fork = await forkInteractive(active);
        const forkId = String(fork.sessionId);
        expect(forkId).not.toBe(firstId); expect(forkId).not.toBe(secondId);
        await liveFeed(suite, forkId, active.terminal);
        await terminalMapping(suite, active.terminal, forkId);
        expect((await readFeed(firstFeedPath))?.lifecycle, 'fork does not mark the old feed closed').toBe('live');
        await waitFor('fork restores the selected message to the editor', () => active.draft(), text => text.includes(marker('resumed')), deadline(30_000));
        await active.key('\u0015');
        await waitFor('clear the fork draft', () => active.draft(), text => text === '', deadline(30_000));
        const forkTurn = Date.now(); await active.prompt(`${marker('forked')} inspect the fork`);
        await active.waitEvent('agent_settled', event => event.at >= forkTurn, deadline(90_000));
        expect(JSON.stringify((await active.toolResult('forked-todos', deadline(10_000))).result)).not.toContain(todoMarker);
        expect(JSON.stringify((await active.toolResult('forked-triggers', deadline(10_000))).result)).not.toContain('fixture-wakeup');
        await quitPi(active);
        const forkFeedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', forkId, 'session.json');
        const closed = await waitFor('quit closes its feed', () => readFeed(forkFeedPath), feed => feed?.lifecycle === 'closed', deadline(60_000));
        await suite.evidence('lifecycle-quit-feed.json', closed!);
      } finally {
        await suite.evidence('lifecycle-active-events.json', await active.events());
        await suite.evidence('lifecycle-active.raw', await active.rawOutput());
        await active.close();
      }
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        const crashed = await suite.launchPi({ mode: 'interactive', cwd: activeProject, extraEnv: activeEnv }) as InteractiveDriver;
        try {
          const start = await crashed.waitEvent('session_start', () => true, deadline(60_000));
          const id = String(start.sessionId), path = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', id, 'session.json');
          await liveFeed(suite, id, crashed.terminal);
          const at = Date.now(); await crashed.prompt(`${marker('signal')} before active ${signal}`);
          await crashed.waitEvent('agent_settled', event => event.at >= at, deadline(90_000));
          const events = await signalPi(crashed, signal);
          if (signal === 'SIGTERM') {
            expect(events.some(event => event.type === 'session_shutdown' && event.reason === 'quit')).toBe(true);
            const closed = await waitFor('SIGTERM quit closes feed', () => readFeed(path), feed => feed?.lifecycle === 'closed', deadline(60_000));
            await suite.evidence('lifecycle-active-term-feed.json', closed!);
          } else {
            expect(events.some(event => event.type === 'session_shutdown')).toBe(false);
            const stale = await readFeed(path);
            expect(stale?.lifecycle, 'crash cannot fabricate a clean quit').toBe('live');
            await waitFor('crashed feed becomes stale', async () => {
              const feed = await readFeed(path);
              if (!feed || feed.lifecycle !== 'live' || feed.generation !== stale?.generation || feed.updatedAt !== stale.updatedAt) throw new Error('crashed feed changed or closed');
              return Date.now() - feed.updatedAt;
            }, age => age > 10_000, deadline(20_000), { reconcileMs: 250 });
            await suite.evidence('lifecycle-active-kill-feed.json', stale!);
          }
        } finally { await crashed.close(); }
      }

      const denied = await suite.launchPi({ mode: 'interactive', cwd: activeProject, extraEnv: activeEnv }) as InteractiveDriver;
      const permissionPaths: string[] = [], restorers: { restore(): void }[] = [];
      try {
        const start = await denied.waitEvent('session_start', () => true, deadline(60_000));
        const id = String(start.sessionId);
        await liveFeed(suite, id, denied.terminal);
        const herdr = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr');
        permissionPaths.push(join(herdr, 'sessions', id), join(herdr, 'sessions'), join(herdr, 'ipc'));
        for (const path of permissionPaths) {
          const owned = suite.ownPath(path); restorers.push(registerModeRestore(suite.ledger, owned));
          await chmod(owned, 0o500);
        }
        for (const path of permissionPaths) await expect(writeFile(join(path, 'write-control'), 'x')).rejects.toMatchObject({ code: 'EACCES' });
        const check = async (label: 'denied-before' | 'denied-reload' | 'denied-new') => {
          const before = Date.now(); await denied.prompt(`${marker(label)} run local tools with denied writes`);
          await denied.waitEvent('agent_settled', event => event.at >= before, deadline(90_000));
          const exec = await denied.toolResult(`${label}-exec`, deadline(10_000));
          expect(exec.isError).toBe(false); expect(JSON.stringify(exec.result)).toContain('local-hook-ok');
          expect((await denied.toolResult(`${label}-todo`, deadline(10_000))).isError).toBe(false);
        };
        await check('denied-before');
        await reloadInteractive(denied, deadline(90_000));
        await check('denied-reload');
        await newInteractive(denied, deadline(90_000));
        await check('denied-new');
      } finally {
        for (const restore of restorers.reverse()) restore.restore();
        await suite.evidence('lifecycle-denied-events.json', await denied.events());
        await suite.evidence('lifecycle-denied.raw', await denied.rawOutput());
        await denied.close();
      }
      if (suite.options.tier === 'app') throw new Error('prerequisite: native remote lifecycle requires the opt-in app batch');
      await remoteLifecycle();
    }
  },
}];
