// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { chmod, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import type { LedgerProcess } from '../harness/resources.js';
import { readObserved, type InteractiveDriver } from '../harness/pi.js';
import { identityAlive, identityOf } from '../harness/resources.js';
import { deadline, waitFor } from '../harness/wait.js';
import { marker } from '../fixtures/scripted-provider.js';
import { configureActiveHerdr, installScripts } from '../fixtures/session-scripts.js';
import { quitPi, reloadInteractive } from '../fixtures/lifecycle-driver.js';

function herdrUi(records: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return records.filter(row => row.type === 'extension_ui_request' && /herdr/i.test(JSON.stringify(row)));
}
async function socketListening(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(path);
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}
async function rpcRecords(pi: InteractiveDriver): Promise<Record<string, unknown>[]> {
  return (await pi.rawOutput()).toString('utf8').split('\n').flatMap(line => {
    try { const row = JSON.parse(line.trim()); return row && typeof row === 'object' && !Array.isArray(row) ? [row as Record<string, unknown>] : []; }
    catch { return []; }
  });
}
let requestId = 0;
async function rpcPrompt(pi: InteractiveDriver, text: string): Promise<void> {
  const id = `fixture-${++requestId}`, before = Date.now();
  await pi.key(JSON.stringify({ id, type: 'prompt', message: text }) + '\r');
  const records = await waitFor('RPC prompt response', () => rpcRecords(pi), rows => rows.some(row => row.type === 'response' && row.id === id), deadline(60_000));
  expect(records.find(row => row.type === 'response' && row.id === id)).toMatchObject({ success: true });
  await pi.waitEvent('agent_settled', event => event.at >= before, deadline(90_000));
}

async function pauseApp(suite: Suite): Promise<LedgerProcess> {
  const app = suite.ledger.read().processes.find(process => process.label === 'fake-app-daemon');
  if (!app || !identityAlive(app)) throw new Error('prerequisite: the supervised fake app process is required');
  process.kill(app.pid, 'SIGSTOP');
  try {
    await waitFor('owned fake app is paused', () => execFileSync('ps', ['-p', String(app.pid), '-o', 'stat='], { encoding: 'utf8' }).trim(), state => state.startsWith('T'), deadline(10_000));
    await waitFor('fake app hc commands finish', () => execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,stat='], { encoding: 'utf8' }).split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
      return match && Number(match[2]) === app.pid && !match[3].startsWith('Z') ? [Number(match[1])] : [];
    }), children => children.length === 0, deadline(20_000));
    return app;
  } catch (error) { if (identityAlive(app)) process.kill(app.pid, 'SIGCONT'); throw error; }
}
async function recordRunningCore(suite: Suite, expectedCoreId: string | null = suite.cores!.local.coreId): Promise<{ pid: number; start: string; coreId: string }> {
  const cores = suite.cores!;
  const result = await suite.hc(['server', 'status', '--json']);
  const value = result.json as { pid?: number; core?: { id?: string } };
  expect(result.exitCode, result.stderr).toBe(0);
  expect(typeof value.core?.id).toBe('string'); expect(typeof value.pid).toBe('number');
  if (expectedCoreId !== null) expect(value.core!.id).toBe(expectedCoreId);
  const identity = identityOf(value.pid!), coreId = value.core!.id!;
  cores.local.pid = identity.pid; cores.local.coreId = coreId;
  suite.ledger.update(ledger => { const core = ledger.cores.find(entry => entry.side === 'local')!; core.pid = identity.pid; core.start = identity.start; core.coreId = coreId; core.env = { ...cores.local.env }; });
  return { ...identity, coreId };
}
async function crashOwnedCore(suite: Suite): Promise<void> {
  const core = suite.cores!.local, registered = suite.ledger.read().cores.find(value => value.side === 'local');
  expect(registered?.pid).toBe(core.pid);
  const identity = identityOf(core.pid); expect(registered?.start).toBe(identity.start);
  process.kill(identity.pid, 'SIGKILL');
  await waitFor('owned core exits', () => identityAlive(identity), alive => !alive, deadline(30_000));
  await waitFor('owned core socket closes', () => socketListening(core.socket), live => !live, deadline(30_000));
}

async function observeDefaultRecovery(suite: Suite, appMode: 'paused' | 'live'): Promise<void> {
  const cores = suite.cores!;
  const ssh = join(suite.root, 'bin', 'ssh'), sentinel = join(suite.root, `default-${appMode}-ssh`);
  await writeFile(ssh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sentinel}'\nprintf 'transport-ok\\n'\n`); await chmod(ssh, 0o700);
  const env = await configureActiveHerdr(suite);
  const local = "printf 'local-ok\\n'; ssh dest.invalid fixture";
  const effect = join(suite.root, 'default-remote-effect');
  const pair = (prefix: string) => [
    { steps: [{ tool: { id: `${prefix}-local`, name: 'spider', arguments: { action: 'exec', language: 'shell', code: local } } }] },
    { steps: [{ tool: { id: `${prefix}-remote`, name: 'spider', arguments: { action: 'exec', language: 'shell', on: 'dest.invalid', code: `printf unexpected > '${effect}'` } } }] },
    { steps: [{ text: `${prefix} observed` }] }, { steps: [{ text: `${prefix} child notice observed` }] },
  ];
  await installScripts(suite, {
    'default-deny': [{ steps: [{ tool: { id: 'default-deny', name: 'spider', arguments: { action: 'exec', language: 'shell', code: 'ssh dest.invalid fixture' } } }] }, { steps: [{ text: 'denial observed' }] }],
    'default-spawn': [{ steps: [{ tool: { id: 'default-child', name: 'spider', arguments: { action: 'run', agent: 'worker', name: 'default-child', model: 'e2e-fixture/scripted', task: `${marker('default-child')} observe core recovery` } } }] }, { steps: [{ text: 'child waiting' }] }],
    'default-child': [
      { steps: [{ gate: 'default-before' }, { tool: { id: 'child-before-local', name: 'spider', arguments: { action: 'exec', language: 'shell', code: local } } }] },
      { steps: [{ tool: { id: 'child-before-remote', name: 'spider', arguments: { action: 'exec', language: 'shell', on: 'dest.invalid', code: `printf unexpected > '${effect}'` } } }] },
      { steps: [{ gate: 'default-after' }, { tool: { id: 'child-after-local', name: 'spider', arguments: { action: 'exec', language: 'shell', code: local } } }] },
      { steps: [{ tool: { id: 'child-after-remote', name: 'spider', arguments: { action: 'exec', language: 'shell', on: 'dest.invalid', code: `printf unexpected > '${effect}'` } } }] },
      { steps: [{ gate: 'default-done' }, { text: 'child finished' }] },
    ],
    'parent-before': pair('parent-before'), 'parent-after': pair('parent-after'),
    'spawn-after': [{ steps: [{ tool: { id: 'fresh-child-run', name: 'spider', arguments: { action: 'run', agent: 'worker', name: 'after-reload', model: 'e2e-fixture/scripted', task: `${marker('fresh-child')} verify active routing` } } }] }, { steps: [{ text: 'fresh child started' }] }, { steps: [{ text: 'fresh child completed' }] }],
    'fresh-child': [
      { steps: [{ tool: { id: 'fresh-child-ssh', name: 'spider', arguments: { action: 'exec', language: 'shell', code: 'ssh dest.invalid fixture' } } }] },
      { steps: [{ tool: { id: 'fresh-child-on', name: 'spider', arguments: { action: 'exec', language: 'shell', on: 'dest.invalid', code: `printf unexpected > '${effect}'` } } }] },
      { steps: [{ gate: 'fresh-child-done' }, { text: 'fresh child observed active routing' }] },
    ],
  });
  const cwd = await suite.project(`default-recovery-${appMode}`), gates = await suite.gates();
  const parent = await suite.launchPi({ mode: 'interactive', cwd, extraEnv: env }) as InteractiveDriver;
  const sibling = await suite.launchPi({ mode: 'interactive', cwd, args: ['--mode', 'rpc'], extraEnv: env }) as InteractiveDriver;
  let app: LedgerProcess | undefined, coreDead = false;
  const report: Record<string, unknown> = { holderGrace: 'default', appBoundary: appMode === 'paused' ? 'paused and drained during outage' : 'resumed immediately after the socket went down' };
  try {
    const start = await parent.waitEvent('session_start', () => true, deadline(60_000));
    await sibling.waitEvent('session_start', () => true, deadline(60_000));
    const feedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', String(start.sessionId), 'session.json');
    const originalFeed = await waitFor('default recovery live feed', async () => { try { return JSON.parse(await readFile(feedPath, 'utf8')) as { generation?: string; lifecycle?: string }; } catch { return null; } }, value => value?.lifecycle === 'live' && typeof value.generation === 'string', deadline(60_000));
    let at = Date.now(); await parent.prompt(`${marker('default-deny')} verify active policy`);
    await parent.waitEvent('agent_settled', event => event.at >= at, deadline(90_000));
    report.activeControl = await parent.toolResult('default-deny', deadline(10_000));
    expect((report.activeControl as { isError?: boolean }).isError).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
    at = Date.now(); await parent.prompt(`${marker('default-spawn')} hold the child`);
    const child = await gates.ready('default-before', deadline(90_000));
    await parent.waitEvent('agent_settled', event => event.at >= at, deadline(90_000));
    app = await pauseApp(suite);
    const appPid = app.pid, beforeCalls = (await cores.records()).length;
    report.coreBefore = { ...identityOf(cores.local.pid), coreId: cores.local.coreId };
    report.crashAt = Date.now(); await crashOwnedCore(suite); coreDead = true;
    if (appMode === 'live') { process.kill(app.pid, 'SIGCONT'); app = undefined; }
    await waitFor('app or holder restores the default core', () => socketListening(cores.local.socket), live => live, deadline(20_000));
    report.socketReturnedAt = Date.now(); coreDead = false;
    report.coreAfter = await recordRunningCore(suite);
    report.appCallsThroughRecovery = (await cores.records()).slice(beforeCalls).filter(call => call.ppid === appPid);
    if (app) { process.kill(app.pid, 'SIGCONT'); app = undefined; }
    report.noticesAfterRecovery = herdrUi(await rpcRecords(sibling));
    at = Date.now(); await parent.prompt(`${marker('parent-before')} inspect after automatic core recovery`);
    await parent.waitEvent('agent_settled', event => event.at >= at, deadline(90_000));
    report.parentBeforeReload = [await parent.toolResult('parent-before-local', deadline(10_000)), await parent.toolResult('parent-before-remote', deadline(10_000))];
    gates.release('default-before'); await gates.ready('default-after', deadline(90_000));
    let childEvents = await readObserved(suite.pi.observerDir, child.pid);
    report.childBeforeReload = childEvents.filter(event => ['child-before-local', 'child-before-remote'].includes(String(event.toolCallId)) && event.type === 'tool_execution_end');
    expect((report.childBeforeReload as unknown[])).toHaveLength(2);
    const reload = await reloadInteractive(parent, deadline(90_000)); report.reload = reload;
    await waitFor('default recovery feed after reload', async () => { try { return JSON.parse(await readFile(feedPath, 'utf8')) as { generation?: string; lifecycle?: string }; } catch { return null; } }, value => value?.lifecycle === 'live' && value.generation !== originalFeed?.generation, deadline(90_000));
    at = Date.now(); await parent.prompt(`${marker('parent-after')} inspect after reload`);
    await parent.waitEvent('agent_settled', event => event.at >= at, deadline(90_000));
    report.parentAfterReload = [await parent.toolResult('parent-after-local', deadline(10_000)), await parent.toolResult('parent-after-remote', deadline(10_000))];
    gates.release('default-after'); await gates.ready('default-done', deadline(90_000));
    childEvents = await readObserved(suite.pi.observerDir, child.pid);
    const childAfter = childEvents.filter(event => ['child-after-local', 'child-after-remote'].includes(String(event.toolCallId)) && event.type === 'tool_execution_end');
    report.childAfterReload = childAfter;
    expect(childAfter).toHaveLength(2);
    if (appMode === 'paused') {
      const localResult = childAfter.find(event => event.toolCallId === 'child-after-local');
      const remoteResult = childAfter.find(event => event.toolCallId === 'child-after-remote');
      expect(localResult).toMatchObject({ isError: false });
      expect(JSON.stringify(localResult?.result)).toContain('transport-ok');
      expect(remoteResult).toMatchObject({ isError: true });
      expect(JSON.stringify(remoteResult?.result)).toMatch(/herdr-disabled|core-unavailable/i);
    }
    report.noticesAfterReload = herdrUi(await rpcRecords(sibling));
    report.sentinel = await readFile(sentinel, 'utf8').catch(() => '');
    report.effectPresent = existsSync(effect);
    const doneAt = Date.now(); gates.release('default-done');
    await parent.waitEvent('message_end', event => event.at >= doneAt && event.customType === 'spider.subagent_done', deadline(60_000));
    await parent.waitEvent('agent_settled', event => event.at >= doneAt, deadline(60_000));
    const freshAt = Date.now(); await parent.prompt(`${marker('spawn-after')} start a child after reload`);
    const fresh = await gates.ready('fresh-child-done', deadline(90_000));
    await parent.waitEvent('agent_settled', event => event.at >= freshAt, deadline(90_000));
    expect((await parent.toolResult('fresh-child-run', deadline(10_000))).isError).toBe(false);
    const freshEvents = await readObserved(suite.pi.observerDir, fresh.pid);
    const freshSsh = freshEvents.find(event => event.type === 'tool_execution_end' && event.toolCallId === 'fresh-child-ssh');
    const freshOn = freshEvents.find(event => event.type === 'tool_execution_end' && event.toolCallId === 'fresh-child-on');
    report.newChildAfterReload = [freshSsh, freshOn];
    expect(freshSsh).toMatchObject({ isError: true });
    expect(JSON.stringify(freshSsh?.result)).toMatch(/use spider exec with on/i);
    expect(freshOn).toMatchObject({ isError: true });
    expect(JSON.stringify(freshOn?.result)).toMatch(/destination.*not configured/i);
    expect(existsSync(effect)).toBe(false);
    const freshDoneAt = Date.now(); gates.release('fresh-child-done');
    await parent.waitEvent('message_end', event => event.at >= freshDoneAt && event.customType === 'spider.subagent_done', deadline(60_000));
    await parent.waitEvent('agent_settled', event => event.at >= freshDoneAt, deadline(60_000));
    await suite.evidence(`default-${appMode}-recovery.json`, report);
    await quitPi(parent);
  } finally {
    if (app && identityAlive(app)) process.kill(app.pid, 'SIGCONT');
    await suite.evidence(`default-${appMode}-partial.json`, report);
    await suite.evidence(`default-${appMode}-parent.raw`, await parent.rawOutput());
    await suite.evidence(`default-${appMode}-sibling.raw`, await sibling.rawOutput());
    if (!coreDead) { await parent.close(); await sibling.close(); }
  }
}

async function assertChangedCoreIsolation(suite: Suite): Promise<void> {
  const cores = suite.cores!, env = await configureActiveHerdr(suite), gates = await suite.gates();
  const cwd = await suite.project('changed-core');
  const effect = join(suite.root, 'changed-core-forbidden');
  await installScripts(suite, {
    hold: [{ steps: [{ gate: 'changed-core-hold' }, { text: 'old owner settled' }] }],
    remote: [{ steps: [{ tool: { id: 'changed-core-remote', name: 'spider', arguments: { action: 'exec', language: 'shell', on: 'dest.invalid', code: `printf unexpected > '${effect}'` } } }] }, { steps: [{ text: 'remote attempt completed' }] }],
    after: [{ steps: [{ text: 'reload completed' }] }],
  });
  const pi = await suite.launchPi({ mode: 'interactive', cwd, extraEnv: env }) as InteractiveDriver;
  let app: LedgerProcess | undefined, appPaused = false;
  const holders: ReturnType<typeof identityOf>[] = [];
  try {
    const start = await pi.waitEvent('session_start', () => true, deadline(60_000));
    const sessionId = String(start.sessionId), feedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', sessionId, 'session.json');
    const initial = await waitFor('old-core live feed', async () => { try { return JSON.parse(await readFile(feedPath, 'utf8')) as { lifecycle?: string; owner?: { terminal?: { coreId?: string; address?: string } } }; } catch { return null; } },
      feed => feed?.lifecycle === 'live' && feed.owner?.terminal?.address === pi.terminal, deadline(60_000));
    const oldId = cores.local.coreId;
    expect(initial?.owner?.terminal?.coreId).toBe(oldId);
    await pi.prompt(`${marker('hold')} keep the old owner alive`); await gates.ready('changed-core-hold', deadline(60_000));
    const rows = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n');
    const localHolderPath = join(cores.local.env.XDG_STATE_HOME, 'herdr-core', cores.local.namespace) + '/';
    for (const row of rows) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(row);
      if (!match || !match[2].includes(localHolderPath) || !/\bhold\b/.test(match[2])) continue;
      const identity = identityOf(Number(match[1])); holders.push(identity);
      suite.ledger.update(ledger => { ledger.processes.push({ ...identity, label: 'old-core-holder', group: false }); });
    }
    if (!holders.length) throw new Error('prerequisite: the owned terminal holder was not identified');
    app = await pauseApp(suite); appPaused = true;
    await crashOwnedCore(suite);
    const state = suite.ownPath(join(cores.local.env.XDG_STATE_HOME, 'herdr-core', cores.local.namespace));
    const previous = suite.ownPath(join(cores.local.env.XDG_STATE_HOME, 'herdr-core', 'prior-identity-state'));
    await rename(state, previous);
    const started = await suite.hc(['server', 'start', '--json']); expect(started.exitCode, started.stderr).toBe(0);
    const current = await recordRunningCore(suite, null);
    expect(current.coreId).not.toBe(oldId);
    const empty = await suite.hc(['ls', '--all', '--json']);
    expect((empty.json as { terminals: unknown[] }).terminals).toEqual([]);
    let address = '';
    for (let n = 0; n < 128; n++) {
      const decoy = await suite.hc(['run', '--bg', '--no-notify', '--outlive-parent', '--json', '--', '/bin/cat']);
      expect(decoy.exitCode, decoy.stderr).toBe(0);
      address = (decoy.json as { address: string }).address;
      suite.ledger.update(ledger => { ledger.terminals.push({ side: 'local', address }); });
      if (address === pi.terminal) break;
      expect((await suite.hc(['kill', address, '--json'])).exitCode).toBe(0);
      expect((await suite.hc(['rm', address, '--json'])).exitCode).toBe(0);
    }
    expect(address, 'the negative control uses a reused terminal address').toBe(pi.terminal);
    const detail = await suite.hc(['get', address, '--json']);
    expect((detail.json as { pid?: number }).pid).not.toBe(pi.pid);
    process.kill(app.pid, 'SIGCONT'); appPaused = false;
    const settledAt = Date.now(); gates.release('changed-core-hold');
    await pi.waitEvent('agent_settled', event => event.at >= settledAt, deadline(60_000));
    const remoteAt = Date.now(); await pi.prompt(`${marker('remote')} refuse stale remote work`);
    await pi.waitEvent('agent_settled', event => event.at >= remoteAt, deadline(60_000));
    const attempt = await pi.toolResult('changed-core-remote', deadline(10_000));
    const reload = await reloadInteractive(pi, deadline(60_000));
    const afterAt = Date.now(); await pi.prompt(`${marker('after')} complete a post-reload turn`);
    await pi.waitEvent('agent_settled', event => event.at >= afterAt, deadline(60_000));
    const feed = JSON.parse(await readFile(feedPath, 'utf8')) as { owner: { sessionId: string; terminal: { coreId: string; address: string } } };
    const directory = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'terminals');
    const mappings = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(directory, name), 'utf8')) as { owner: { sessionId: string; terminal: { coreId: string; address: string } } }));
    const wronglyOwned = mappings.filter(mapping => mapping.owner.sessionId === sessionId && mapping.owner.terminal.coreId === current.coreId && mapping.owner.terminal.address === address);
    await suite.evidence('changed-core-observation.json', { oldId, newId: current.coreId, oldTerminal: pi.terminal, decoy: detail.json, oldFeed: initial, feed, mappings, attempt, reload, effectPresent: existsSync(effect) });
    expect(attempt.isError).toBe(true); expect(existsSync(effect)).toBe(false);
    expect(feed.owner.terminal.coreId, 'old pi must not claim the new core terminal').not.toBe(current.coreId);
    expect(wronglyOwned, 'no mapping may attribute the old session to the decoy').toEqual([]);
  } finally {
    if (appPaused && app && identityAlive(app)) process.kill(app.pid, 'SIGCONT');
    // The supervisor stops the app and registered holders before stopping either core.
    await suite.evidence('changed-core-parent.raw', await pi.rawOutput());
  }
}

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S50'), title: 'A lost core disables Herdr without stopping pi', tiers: ['headless', 'app'],
  async run(suite) {
    if (!suite.cores) throw new Error('prerequisite: a real isolated core is required');
    const cores = suite.cores;
    await observeDefaultRecovery(suite, 'paused');
    await observeDefaultRecovery(suite, 'live');
    // No story terminal is left on the local core. Restart it with the approved holder grace before allocating new ones.
    const stop = await suite.hc(['server', 'stop', '--json']);
    expect(stop.exitCode, stop.stderr).toBe(0);
    await waitFor('local core stopped before configured outage', () => socketListening(cores.local.socket), live => !live, deadline(30_000));
    cores.local.env.HC_HOLDER_GRACE_MS = '30000';
    suite.ledger.update(ledger => { ledger.cores.find(entry => entry.side === 'local')!.env = { ...cores.local.env }; });
    const start = await suite.hc(['server', 'start', '--json']);
    expect(start.exitCode, start.stderr).toBe(0);
    await recordRunningCore(suite);
    await suite.evidence('core-death-setting.json', { HC_HOLDER_GRACE_MS: '30000', scope: 'owned local core and holders only' });
    const ssh = join(suite.root, 'bin', 'ssh'), sentinel = join(suite.root, 'core-death-ssh');
    await writeFile(ssh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sentinel}'\nprintf 'transport-ok\\n'\n`); await chmod(ssh, 0o700);
    const env = await configureActiveHerdr(suite);
    const effect = join(suite.root, 'core-death-forbidden');
    const local = "printf 'local-ok\\n'; ssh dest.invalid fixture";
    await installScripts(suite, {
      deny: [{ steps: [{ tool: { id: 'deny', name: 'spider', arguments: { action: 'exec', language: 'shell', code: 'ssh dest.invalid fixture' } } }] }, { steps: [{ text: 'denial observed' }] }],
      spawn: [{ steps: [{ tool: { id: 'core-child', name: 'spider', arguments: { action: 'run', agent: 'worker', name: 'core-child', model: 'e2e-fixture/scripted', task: `${marker('child')} wait for core loss` } } }] }, { steps: [{ text: 'child waiting' }] }, { steps: [{ text: 'child finished' }] }],
      child: [
        { steps: [{ gate: 'child-before-core-loss' }, { tool: { id: 'child-after-local', name: 'spider', arguments: { action: 'exec', language: 'shell', code: local } } }] },
        { steps: [{ tool: { id: 'child-after-remote', name: 'spider', arguments: { action: 'exec', language: 'shell', on: 'dest.invalid', code: `printf unexpected > '${effect}'` } } }] },
        { steps: [{ gate: 'child-after-core-loss' }, { text: 'child observed core loss' }] },
      ],
      local: [{ steps: [{ tool: { id: 'after-local', name: 'spider', arguments: { action: 'exec', language: 'shell', code: local } } }] }, { steps: [{ text: 'local survived' }] }],
      remote: [{ steps: [{ tool: { id: 'after-remote', name: 'spider', arguments: { action: 'exec', language: 'shell', on: 'dest.invalid', code: `printf unexpected > '${effect}'` } } }] }, { steps: [{ text: 'remote refused' }] }],
      recovery: [{ steps: [{ tool: { id: 'recovery-deny', name: 'spider', arguments: { action: 'exec', language: 'shell', code: 'ssh dest.invalid fixture' } } }] }, { steps: [{ text: 'recovery guard observed' }] }],
      'after-back': [
        { steps: [{ tool: { id: 'after-back-local', name: 'spider', arguments: { action: 'exec', language: 'shell', code: "printf 'after-restart-local\\n'" } } }] },
        { steps: [{ tool: { id: 'after-back-remote', name: 'spider', arguments: { action: 'exec', language: 'shell', on: 'dest.invalid', code: `printf unexpected > '${effect}'` } } }] },
        { steps: [{ text: 'post-restart inactive behavior checked' }] },
      ],
    });
    const cwd = await suite.project('core-death');
    const gates = await suite.gates();
    const parent = await suite.launchPi({ mode: 'interactive', cwd, args: ['--mode', 'rpc'], extraEnv: env }) as InteractiveDriver;
    const recovery = await suite.launchPi({ mode: 'interactive', cwd, extraEnv: env }) as InteractiveDriver;
    const failures: string[] = [];
    let restarted = false, pausedApp = false;
    const app = suite.ledger.read().processes.find(process => process.label === 'fake-app-daemon');
    if (!app) throw new Error('prerequisite: the supervised fake app process is required');
    try {
      const pstart = await parent.waitEvent('session_start', () => true, deadline(60_000));
      const rstart = await recovery.waitEvent('session_start', () => true, deadline(60_000));
      expect(pstart).toMatchObject({ mode: 'rpc', hcTerminal: parent.terminal });
      expect(rstart).toMatchObject({ mode: 'tui', hcTerminal: recovery.terminal });
      const feedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', String(rstart.sessionId), 'session.json');
      const feed = await waitFor('live recovery feed', async () => { try { return JSON.parse(await readFile(feedPath, 'utf8')) as { generation?: string; lifecycle?: string }; } catch { return null; } }, value => value?.lifecycle === 'live' && typeof value.generation === 'string', deadline(60_000));
      const initialGeneration = feed!.generation;
      await rpcPrompt(parent, `${marker('deny')} check active routing`);
      expect((await parent.toolResult('deny', deadline(10_000))).isError).toBe(true);
      expect(existsSync(sentinel), 'managed SSH is refused while active').toBe(false);
      await rpcPrompt(parent, `${marker('spawn')} start the child`);
      expect((await parent.toolResult('core-child', deadline(10_000))).isError).toBe(false);
      const child = await gates.ready('child-before-core-loss', deadline(90_000));
      expect(identityAlive(identityOf(child.pid))).toBe(true);
      expect(cores.local.socket.startsWith(suite.root + '/')).toBe(true);
      expect(await socketListening(cores.local.socket)).toBe(true);
      // The fake app has its own hc calls. Pause and drain it so they cannot mask spider's outage behavior.
      await pauseApp(suite); pausedApp = true;
      const registeredCore = suite.ledger.read().cores.find(core => core.side === 'local');
      expect(registeredCore?.pid).toBe(cores.local.pid);
      const coreIdentity = identityOf(cores.local.pid);
      expect(registeredCore?.start).toBe(coreIdentity.start);
      const uiBefore = herdrUi(await rpcRecords(parent)).length;
      const recordsAtKill = (await cores.records()).length;
      await suite.evidence('core-death-boundary.json', { at: Date.now(), coreIdentity, appIdentity: app, appPaused: true, holderGraceMs: 30000, recordsAtKill });
      process.kill(coreIdentity.pid, 'SIGKILL');
      await waitFor('owned core process exits', () => identityAlive(coreIdentity), alive => !alive, deadline(30_000));
      await waitFor('owned core socket closes', () => socketListening(cores.local.socket), live => !live, deadline(30_000));
      expect(identityAlive(parent.identity), 'RPC parent survives core loss').toBe(true);
      expect(identityAlive(recovery.identity), 'interactive parent survives core loss').toBe(true);
      const observationStarted = Date.now(), until = observationStarted + 10_000;
      let samples = 0;
      const observation = await waitFor('ten-second core-down observation', async () => {
        samples++;
        const live = await socketListening(cores.local.socket), records = (await cores.records()).slice(recordsAtKill);
        const spider = records.filter(record => record.ppid === parent.pid || record.ppid === child.pid || record.ppid === recovery.pid);
        if (live || spider.length) throw new Error(`core was restarted or spider spawned hc: ${JSON.stringify({ live, spider })}`);
        return { at: Date.now(), records };
      }, value => value.at >= until, deadline(15_000), { reconcileMs: 250 });
      await suite.evidence('core-death-down-calls.json', { startedAt: observationStarted, finishedAt: observation.at, samples, records: observation.records });
      await waitFor('inactive diagnostic after core loss', async () => herdrUi(await rpcRecords(parent)), rows => rows.some(row => /core.*unavailable/i.test(JSON.stringify(row))), deadline(30_000));
      await rpcPrompt(parent, `${marker('local')} run locally after core loss`);
      const parentLocal = await parent.toolResult('after-local', deadline(10_000));
      expect(parentLocal.isError, JSON.stringify(parentLocal)).toBe(false);
      expect(JSON.stringify(parentLocal.result)).toContain('transport-ok');
      await rpcPrompt(parent, `${marker('remote')} refuse remote execution after core loss`);
      const parentRemote = await parent.toolResult('after-remote', deadline(10_000));
      expect(parentRemote.isError).toBe(true);
      expect(JSON.stringify(parentRemote.result)).toMatch(/herdr-(disabled|unavailable)/i);
      expect(existsSync(effect)).toBe(false);
      gates.release('child-before-core-loss');
      await gates.ready('child-after-core-loss', deadline(90_000));
      const childEvents = await readObserved(suite.pi.observerDir, child.pid);
      const childLocal = childEvents.find(event => event.type === 'tool_execution_end' && event.toolCallId === 'child-after-local');
      const childRemote = childEvents.find(event => event.type === 'tool_execution_end' && event.toolCallId === 'child-after-remote');
      await suite.evidence('core-death-child.json', childEvents);
      try {
        expect(childLocal).toMatchObject({ isError: false });
        expect(JSON.stringify(childLocal?.result)).toContain('transport-ok');
        expect(childRemote).toMatchObject({ isError: true });
        expect(JSON.stringify(childRemote?.result)).toMatch(/herdr-(disabled|unavailable)/i);
        expect(existsSync(effect)).toBe(false);
      } catch (error) { failures.push(`child inactive behavior: ${String((error as Error).stack ?? error)}`); }
      gates.release('child-after-core-loss');
      expect(await socketListening(cores.local.socket), 'core remains down through local actions').toBe(false);
      const laterCalls = (await cores.records()).slice(recordsAtKill);
      expect(laterCalls.filter(record => record.ppid === parent.pid || record.ppid === child.pid || record.ppid === recovery.pid), 'no spider hc calls through local actions').toEqual([]);
      await suite.evidence('core-death-after-actions.json', laterCalls);
      const ui = herdrUi(await rpcRecords(parent)).slice(uiBefore);
      await suite.evidence('core-death-ui.json', ui);
      try {
        expect(ui.filter(row => row.method === 'setStatus' && row.statusText), 'no persistent core-loss footer').toEqual([]);
        const unavailable = ui.filter(row => row.method === 'notify' && /core.*(?:unavailable|not running)|herdr unavailable/i.test(String(row.message)));
        expect(unavailable, 'one core-unavailable notice per outage').toHaveLength(1);
      } catch (error) { failures.push(`core-loss notice: ${String((error as Error).stack ?? error)}`); }

      const started = await suite.hc(['server', 'start', '--json']);
      expect(started.exitCode, started.stderr).toBe(0); restarted = true;
      process.kill(app.pid, 'SIGCONT'); pausedApp = false;
      await recordRunningCore(suite);
      const noticeUntil = Date.now() + 2500;
      await waitFor('post-restart notice reconciliation', async () => ({ at: Date.now(), records: await rpcRecords(parent) }), value => value.at >= noticeUntil, deadline(10_000), { reconcileMs: 200 });
      await rpcPrompt(parent, `${marker('after-back')} remain inactive until reload`);
      expect((await parent.toolResult('after-back-local', deadline(10_000))).isError).toBe(false);
      const afterBackRemote = await parent.toolResult('after-back-remote', deadline(10_000));
      expect(afterBackRemote.isError).toBe(true);
      expect(JSON.stringify(afterBackRemote.result)).toMatch(/herdr-disabled|core-unavailable/i);
      const afterBackUi = herdrUi(await rpcRecords(parent)).slice(uiBefore);
      await suite.evidence('core-death-after-restart-ui.json', afterBackUi);
      try {
        expect(afterBackUi.filter(row => row.method === 'notify' && /core.*(?:unavailable|not running)|herdr unavailable/i.test(String(row.message))), 'at most one unavailable notice').toHaveLength(1);
        expect(afterBackUi.filter(row => row.method === 'notify' && /Herdr core is back\. \/reload to reconnect\./i.test(String(row.message))).length, 'at most one recovery notice').toBeLessThanOrEqual(1);
      } catch (error) { failures.push(`post-restart notices: ${String((error as Error).stack ?? error)}`); }
      await reloadInteractive(recovery, deadline(90_000));
      await waitFor('fresh activation after core restart and reload', async () => { try { return JSON.parse(await readFile(feedPath, 'utf8')) as { generation?: string; lifecycle?: string; owner?: { terminal?: { address?: string } } }; } catch { return null; } },
        value => value?.lifecycle === 'live' && value.generation !== initialGeneration && value.owner?.terminal?.address === recovery.terminal, deadline(90_000));
      const sentBefore = await readFile(sentinel, 'utf8');
      const recoveryAt = Date.now(); await recovery.prompt(`${marker('recovery')} check restored routing`);
      await recovery.waitEvent('agent_settled', event => event.at >= recoveryAt, deadline(90_000));
      expect((await recovery.toolResult('recovery-deny', deadline(10_000))).isError).toBe(true);
      expect(await readFile(sentinel, 'utf8')).toBe(sentBefore);
      await suite.evidence('core-death-recovered-feed.json', JSON.parse(await readFile(feedPath, 'utf8')));
      await quitPi(recovery);
    } finally {
      if (pausedApp && identityAlive(app)) process.kill(app.pid, 'SIGCONT');
      await suite.evidence('core-death-parent.raw', await parent.rawOutput());
      await suite.evidence('core-death-recovery.raw', await recovery.rawOutput());
      await suite.evidence('core-death-parent-events.json', await parent.events());
      await suite.evidence('core-death-recovery-events.json', await recovery.events());
      // Do not call hc against the stopped socket; suite cleanup handles a dead core without autostart.
      if (restarted) { await parent.close(); await recovery.close(); }
    }
    try { await assertChangedCoreIsolation(suite); }
    catch (error) { failures.push(`changed core identity: ${String((error as Error).stack ?? error)}`); }
    if (failures.length) throw new Error(failures.join('\n\n'));
  },
}];
