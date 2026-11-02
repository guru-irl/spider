// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { storyId, type ScenarioDefinition } from '../harness/scenario.js';
import { readObserved, type InteractiveDriver, type OneShotDriver, type RpcDriver } from '../harness/pi.js';
import type { Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';
import { marker } from '../fixtures/scripted-provider.js';
import { configureActiveHerdr, configureHerdr, installScripts } from '../fixtures/session-scripts.js';
import { quitPi } from '../fixtures/lifecycle-driver.js';

type TerminalStatus = { state?: string; msg?: string } | null;
async function terminalStatus(suite: Suite, terminal: string): Promise<TerminalStatus> {
  const result = await suite.hc(['get', terminal, '--json']);
  if (result.exitCode !== 0 || !result.json || typeof result.json !== 'object') throw new Error(`hc get failed: ${result.stderr}`);
  return (result.json as { status?: TerminalStatus }).status ?? null;
}
async function waitStatus(suite: Suite, terminal: string, state: string): Promise<TerminalStatus> {
  return waitFor(`hc terminal status ${state}`, () => terminalStatus(suite, terminal), value => value?.state === state, deadline(40_000), { reconcileMs: 200 });
}
async function holdStatus(suite: Suite, terminal: string, expected: (value: TerminalStatus) => boolean, description: string): Promise<void> {
  const until = Date.now() + 2500;
  await waitFor(description, async () => {
    const value = await terminalStatus(suite, terminal);
    if (!expected(value)) throw new Error(`${description}: unexpected ${JSON.stringify(value)}`);
    return Date.now();
  }, now => now >= until, deadline(10_000), { reconcileMs: 200 });
}
async function waitActiveFeed(suite: Suite, sessionId: unknown, terminal: string): Promise<void> {
  expect(typeof sessionId).toBe('string');
  const path = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', sessionId as string, 'session.json');
  await waitFor('live feed for the real terminal', async () => {
    try { return JSON.parse(await readFile(path, 'utf8')) as { lifecycle?: string; owner?: { terminal?: { address?: string } } }; }
    catch { return null; }
  }, feed => feed?.lifecycle === 'live' && feed.owner?.terminal?.address === terminal, deadline(40_000));
}
async function settled(pi: InteractiveDriver, text: string): Promise<void> {
  const before = Date.now();
  await pi.prompt(text);
  await pi.waitEvent('agent_settled', e => e.at >= before, deadline(90_000));
}

export const scenarios: readonly ScenarioDefinition[] = [{
  id: storyId('S01'), title: 'Native working, completion, error, cancellation and compaction status', tiers: ['headless', 'app'],
  async run(suite) {
    const env = await configureActiveHerdr(suite);
    const settingsPath = join(suite.directories.PI_CODING_AGENT_DIR, 'settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    settings.compaction = { enabled: false, reserveTokens: 1024, keepRecentTokens: 100 };
    await writeFile(settingsPath, JSON.stringify(settings));
    await installScripts(suite, {
      work: [{ steps: [{ gate: 'work' }, { text: 'work complete' }] }],
      error: [{ steps: [{ error: 'fixture provider failure' }] }],
      cancel: [{ steps: [{ gate: 'cancel' }, { text: 'unexpected cancellation completion' }] }],
      history: [{ steps: [{ text: 'history '.repeat(5000) }] }],
      compact: [{ steps: [{ gate: 'compact' }, { text: 'fixture compaction summary' }] }],
      off: [{ steps: [{ text: 'status disabled control' }] }],
    });
    const project = await suite.project('status');
    const gates = await suite.gates();
    const pi = await suite.launchPi({ mode: 'interactive', cwd: project, extraEnv: env }) as InteractiveDriver;
    try {
      const start = await pi.waitEvent('session_start', () => true, deadline(60_000));
      expect(start).toMatchObject({ mode: 'tui', hcTerminal: pi.terminal });
      expect(typeof start.sessionFile).toBe('string');
      const feedPath = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', start.sessionId as string, 'session.json');
      await waitActiveFeed(suite, start.sessionId, pi.terminal);
      await waitStatus(suite, pi.terminal, 'idle');

      const workAt = Date.now();
      await pi.prompt(`${marker('work')} hold while working`);
      await gates.ready('work', deadline(60_000));
      await waitStatus(suite, pi.terminal, 'working');
      gates.release('work');
      await pi.waitEvent('agent_settled', e => e.at >= workAt, deadline(60_000));
      await waitStatus(suite, pi.terminal, 'done');

      await settled(pi, `${marker('error')} cause a provider failure`);
      const error = await pi.waitEvent('message_end', e => e.role === 'assistant' && e.stopReason === 'error', deadline(30_000));
      expect(error.errorMessage).toContain('fixture provider failure');
      await waitStatus(suite, pi.terminal, 'error');

      const cancelAt = Date.now();
      await pi.prompt(`${marker('cancel')} hold until cancelled`);
      await gates.ready('cancel', deadline(60_000));
      await waitStatus(suite, pi.terminal, 'working');
      await pi.key('\u001b');
      await pi.waitEvent('agent_settled', e => e.at >= cancelAt, deadline(60_000));
      await waitStatus(suite, pi.terminal, 'idle');

      await settled(pi, `${marker('history')} establish enough history for manual compaction`);
      await pi.prompt(`/compact ${marker('compact')}`);
      await gates.ready('compact', deadline(60_000));
      const compacting = await waitStatus(suite, pi.terminal, 'working');
      expect(compacting?.msg).toContain('Compact');
      gates.release('compact');
      const sessionFile = start.sessionFile as string;
      expect(sessionFile.startsWith(suite.root + '/')).toBe(true);
      await waitFor('saved compaction entry', async () => (await readFile(sessionFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { type?: string; summary?: string }), entries => entries.some(entry => entry.type === 'compaction' && entry.summary?.includes('fixture compaction summary') === true), deadline(60_000));
      await waitStatus(suite, pi.terminal, 'done');
      const raw = await pi.rawOutput();
      for (const state of ['idle', 'working', 'done', 'error']) expect(raw.includes(Buffer.from(`\u001b]7501;state=${state}`)), `real OSC ${state}`).toBe(true);
      await suite.keepEvidence(sessionFile, 'status-session.jsonl');
      await suite.keepEvidence(feedPath, 'status-live-feed.json');
      await quitPi(pi);
    } finally {
      await suite.evidence('status-events.json', await pi.events());
      await suite.evidence('status-terminal.raw', await pi.rawOutput());
      await suite.evidence('status-final-hc.json', await suite.hc(['get', pi.terminal, '--json']));
      await pi.close();
    }

    const off = await suite.launchPi({ mode: 'interactive', cwd: project, extraEnv: { ...env, PI_PROGRAM_STATUS: '0' } }) as InteractiveDriver;
    try {
      const start = await off.waitEvent('session_start', () => true, deadline(60_000));
      await waitActiveFeed(suite, start.sessionId, off.terminal);
      await settled(off, `${marker('off')} status-off negative control`);
      expect((await off.rawOutput()).includes(Buffer.from('\u001b]7501;'))).toBe(false);
      expect((await terminalStatus(suite, off.terminal))?.state).not.toBe('done');
      await suite.evidence('status-disabled-control.raw', await off.rawOutput());
      await quitPi(off);
    } finally { await off.close(); }
  },
}, {
  id: storyId('S02'), title: 'Pending children keep only their owning parent working', tiers: ['headless', 'app'],
  async run(suite) {
    const env = await configureActiveHerdr(suite);
    await installScripts(suite, {
      parent: [
        { steps: [{ tool: { id: 'parent-children', name: 'spider', arguments: { action: 'run', tasks: [
          { agent: 'worker', name: 'first', model: 'e2e-fixture/scripted', task: `${marker('first')} hold first child` },
          { agent: 'worker', name: 'second', model: 'e2e-fixture/scripted', task: `${marker('second')} hold second child` },
        ] } } }] },
        { steps: [{ text: 'children started' }] },
        { steps: [{ text: 'first result observed' }] },
        { steps: [{ text: 'second result observed' }] },
      ],
      foreign: [
        { steps: [{ tool: { id: 'foreign-child', name: 'spider', arguments: { action: 'run', agent: 'worker', name: 'foreign', model: 'e2e-fixture/scripted', task: `${marker('foreign-child')} hold foreign child` } } }] },
        { steps: [{ text: 'foreign child started' }] }, { steps: [{ text: 'foreign result observed' }] },
      ],
      first: [{ steps: [{ gate: 'first' }, { text: 'first completed' }] }],
      second: [{ steps: [{ gate: 'second' }, { text: 'second completed' }] }],
      'foreign-child': [{ steps: [{ gate: 'foreign' }, { text: 'foreign completed' }] }],
    });
    const project = await suite.project('status-owners');
    const gates = await suite.gates();
    const parent = await suite.launchPi({ mode: 'interactive', cwd: project, extraEnv: env }) as InteractiveDriver;
    let foreign: InteractiveDriver | undefined;
    const waitCount = (terminal: string, count: number) => waitFor(`hc status ${count} owned children`, () => terminalStatus(suite, terminal), value => value?.state === 'working' && value.msg === `${count} subagent${count === 1 ? '' : 's'} running`, deadline(60_000), { reconcileMs: 200 });
    try {
      const parentStart = await parent.waitEvent('session_start', () => true, deadline(60_000));
      const before = Date.now();
      await parent.prompt(`${marker('parent')} start two held children`);
      await gates.ready('first', deadline(90_000));
      await gates.ready('second', deadline(90_000));
      await parent.waitEvent('agent_settled', e => e.at >= before, deadline(90_000));
      expect((await parent.toolResult('parent-children', deadline(10_000))).isError).toBe(false);
      await waitCount(parent.terminal, 2);

      foreign = await suite.launchPi({ mode: 'interactive', cwd: project, extraEnv: env }) as InteractiveDriver;
      const foreignStart = await foreign.waitEvent('session_start', () => true, deadline(60_000));
      expect(foreignStart.sessionId).not.toBe(parentStart.sessionId);
      const foreignAt = Date.now();
      await foreign.prompt(`${marker('foreign')} start a held foreign child`);
      await gates.ready('foreign', deadline(90_000));
      await foreign.waitEvent('agent_settled', e => e.at >= foreignAt, deadline(90_000));
      expect((await foreign.toolResult('foreign-child', deadline(10_000))).isError).toBe(false);
      await waitCount(foreign.terminal, 1);
      await waitCount(parent.terminal, 2);

      const rawBefore = (await parent.rawOutput()).length;
      await parent.prompt('/name status-replay-probe');
      await waitFor('terminal title refresh', async () => (await suite.hc(['get', parent.terminal, '--json'])).json as { title?: string } | null,
        info => info?.title?.includes('status-replay-probe') === true, deadline(40_000), { reconcileMs: 200 });
      await waitCount(parent.terminal, 2);
      await holdStatus(suite, parent.terminal, status => status?.state === 'working' && status.msg === '2 subagents running', 'contributed status survives title replay and reconciliation');
      const replay = (await parent.rawOutput()).subarray(rawBefore);
      expect(replay.includes(Buffer.from('\u001b]7501;state=working')), 'title refresh must replay the contributed status').toBe(true);
      expect(replay.includes(Buffer.from('\u001b]7501;state=done')), 'title replay must not write stale native done').toBe(false);
      await suite.evidence('status-replay.raw', replay);

      const foreignDoneAt = Date.now();
      gates.release('foreign');
      await foreign.waitEvent('message_end', e => e.at >= foreignDoneAt && e.customType === 'spider.subagent_done', deadline(90_000));
      await foreign.waitEvent('agent_settled', e => e.at >= foreignDoneAt, deadline(90_000));
      await waitStatus(suite, foreign.terminal, 'done');
      await waitCount(parent.terminal, 2);

      const firstDoneAt = Date.now();
      gates.release('first');
      await parent.waitEvent('message_end', e => e.at >= firstDoneAt && e.customType === 'spider.subagent_done', deadline(90_000));
      await parent.waitEvent('agent_settled', e => e.at >= firstDoneAt, deadline(90_000));
      await waitCount(parent.terminal, 1);
      const secondDoneAt = Date.now();
      gates.release('second');
      await parent.waitEvent('message_end', e => e.at >= secondDoneAt && e.customType === 'spider.subagent_done', deadline(90_000));
      await parent.waitEvent('agent_settled', e => e.at >= secondDoneAt, deadline(90_000));
      await waitStatus(suite, parent.terminal, 'done');
      await quitPi(foreign); await quitPi(parent);
    } finally {
      await suite.evidence('status-owner-events.json', await parent.events());
      await suite.evidence('status-owner.raw', await parent.rawOutput());
      if (foreign) {
        await suite.evidence('status-foreign-events.json', await foreign.events());
        await suite.evidence('status-foreign.raw', await foreign.rawOutput());
        await foreign.close();
      }
      await parent.close();
    }
    await configureHerdr(suite, false, true);
    const control = await suite.launchPi({ mode: 'interactive', cwd: project, extraEnv: env }) as InteractiveDriver;
    try {
      await control.waitEvent('session_start', () => true, deadline(60_000));
      const at = Date.now(); await control.prompt(`${marker('parent')} disabled contribution control`);
      await gates.ready('first', deadline(90_000)); await gates.ready('second', deadline(90_000));
      await control.waitEvent('agent_settled', event => event.at >= at, deadline(90_000));
      const native = await waitStatus(suite, control.terminal, 'done');
      expect(native?.msg).not.toBe('2 subagents running');
      await suite.evidence('status-disabled-count.json', native!);
      for (const name of ['first', 'second']) {
        const doneAt = Date.now(); gates.release(name);
        await control.waitEvent('message_end', event => event.at >= doneAt && event.customType === 'spider.subagent_done', deadline(90_000));
        await control.waitEvent('agent_settled', event => event.at >= doneAt, deadline(90_000));
      }
      await quitPi(control);
    } finally { await control.close(); }
  },
}, {
  id: storyId('S03'), title: 'Native blocked, error and cancellation take precedence over child status', tiers: ['headless', 'ci', 'app'],
  async run(suite) {
    if (suite.options.tier === 'ci') {
      await installScripts(suite, {
        headless: [{ steps: [{ text: 'headless mode completed' }] }],
        spawn: [{ steps: [{ tool: { id: 'ci-child', name: 'spider', arguments: { action: 'run', agent: 'worker', name: 'headless-child', model: 'e2e-fixture/scripted', task: `${marker('child')} hold in rpc` } } }] }, { steps: [{ text: 'child started' }] }, { steps: [{ text: 'child finished' }] }],
        child: [{ steps: [{ gate: 'ci-child' }, { text: 'child response' }] }],
      });
      const cwd = await suite.project('status-headless');
      const extraEnv = { HC_TERMINAL_ID: 'fixture-inherited', HC_TERMINAL_SOCKET: join(suite.root, 'dead.sock'), HC_SOCKET: join(suite.root, 'dead.sock'), HC_SESSION: 'l', PI_PROGRAM_STATUS: '1' };
      for (const mode of ['print', 'json'] as const) {
        const driver = await suite.launchPi({ mode, cwd, extraEnv, prompt: `${marker('headless')} run ${mode}`, label: `headless-${mode}` }) as OneShotDriver;
        try {
          expect(await driver.exited).toEqual({ code: 0, signal: null });
          expect((await driver.waitEvent('session_start', () => true, deadline(20_000))).mode).toBe(mode);
          const output = await driver.output();
          expect(output).toContain('headless mode completed');
          expect(output).not.toContain('\u001b]7501;');
          await suite.evidence(`headless-${mode}.txt`, output);
        } finally { await driver.close(); }
      }
      const rpc = await suite.launchPi({ mode: 'rpc', cwd, extraEnv, label: 'headless-rpc' }) as RpcDriver;
      try {
        expect((await rpc.waitEvent('session_start', () => true, deadline(60_000))).mode).toBe('rpc');
        await rpc.prompt(`${marker('headless')} run rpc`, deadline(60_000));
        const gates = await suite.gates();
        await rpc.prompt(`${marker('spawn')} run a child`, deadline(90_000));
        expect((await rpc.toolResult('ci-child', deadline(10_000))).isError).toBe(false);
        const child = await gates.ready('ci-child', deadline(60_000));
        const childEvents = await readObserved(suite.pi.observerDir, child.pid);
        expect(childEvents.find(event => event.type === 'session_start')).toMatchObject({ mode: 'rpc', subagentChild: '1', hcTerminal: 'fixture-inherited' });
        await suite.evidence('headless-child.json', childEvents);
        const completeAt = Date.now(); gates.release('ci-child');
        await rpc.waitEvent('message_end', e => e.at >= completeAt && e.customType === 'spider.subagent_done', deadline(60_000));
        await rpc.waitEvent('agent_settled', e => e.at >= completeAt, deadline(60_000));
        expect(JSON.stringify(rpc.records())).not.toContain('\\u001b]7501;');
        await suite.evidence('headless-rpc.json', rpc.records());
      } finally { await rpc.close(); }
      return;
    }
    const env = await configureActiveHerdr(suite);
    const extension = join(suite.root, 'confirm.mjs');
    await writeFile(extension, `export default function(pi) { pi.registerCommand('e2e-confirm', { description: 'Fixture confirmation', handler: async (_args, ctx) => { await ctx.ui.confirm('Fixture confirmation', 'Continue?'); } }); }\n`);
    const settingsPath = join(suite.directories.PI_CODING_AGENT_DIR, 'settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { packages: string[] };
    settings.packages.push(extension); await writeFile(settingsPath, JSON.stringify(settings));
    await installScripts(suite, {
      spawn: [{ steps: [{ tool: { id: 'spawn-held', name: 'spider', arguments: { action: 'run', agent: 'worker', name: 'held', model: 'e2e-fixture/scripted', task: `${marker('child')} remain active` } } }] }, { steps: [{ text: 'child started' }] }, { steps: [{ text: 'child completion received' }] }],
      child: [{ steps: [{ gate: 'held-child' }, { text: 'child finished' }] }],
      error: [{ steps: [{ error: 'fixture precedence error' }] }],
      cancel: [{ steps: [{ gate: 'cancel-parent' }, { text: 'unexpected cancellation completion' }] }, { steps: [{ text: 'child completion followed cancellation' }] }],
      'off-cancel': [{ steps: [{ gate: 'off-cancel-parent' }, { text: 'unexpected cancellation completion' }] }, { steps: [{ text: 'disabled-status child completed' }] }],
      off: [{ steps: [{ text: 'no status escapes' }] }],
      'mode-json': [{ steps: [{ gate: 'mode-json' }, { text: 'json completed' }] }],
      'mode-print': [{ steps: [{ gate: 'mode-print' }, { text: 'print completed' }] }],
      'mode-rpc': [{ steps: [{ gate: 'mode-rpc' }, { text: 'rpc completed' }] }],
    });
    const project = await suite.project('status-precedence');
    const gates = await suite.gates();
    const pi = await suite.launchPi({ mode: 'interactive', cwd: project, extraEnv: env }) as InteractiveDriver;
    try {
      await pi.waitEvent('session_start', () => true, deadline(60_000));
      const spawnedAt = Date.now();
      await pi.prompt(`${marker('spawn')} hold a child`);
      const held = await gates.ready('held-child', deadline(90_000));
      const childEvents = await readObserved(suite.pi.observerDir, held.pid);
      expect(childEvents.find(event => event.type === 'session_start')).toMatchObject({ mode: 'rpc', subagentChild: '1', hcTerminal: pi.terminal });
      await suite.evidence('status-held-child.json', childEvents);
      await pi.waitEvent('agent_settled', e => e.at >= spawnedAt, deadline(90_000));
      expect((await pi.toolResult('spawn-held', deadline(10_000))).isError).toBe(false);
      await waitFor('child contribution', () => terminalStatus(suite, pi.terminal), status => status?.state === 'working' && status.msg === '1 subagent running', deadline(60_000));

      await pi.prompt('/e2e-confirm');
      const blocked = await waitStatus(suite, pi.terminal, 'blocked');
      expect(blocked).toMatchObject({ state: 'blocked', kind: 'permission', msg: 'Fixture confirmation' });
      await holdStatus(suite, pi.terminal, status => status?.state === 'blocked', 'confirmation remains blocked while the child runs');
      await pi.key('\u001b');
      await waitFor('dialog closes while child runs', () => terminalStatus(suite, pi.terminal), status => status?.state === 'working' && status.msg === '1 subagent running', deadline(60_000));

      const errorAt = Date.now();
      await pi.prompt(`${marker('error')} fail while the child runs`);
      await pi.waitEvent('agent_settled', e => e.at >= errorAt, deadline(60_000));
      expect((await pi.waitEvent('message_end', e => e.at >= errorAt && e.role === 'assistant', deadline(10_000))).stopReason).toBe('error');
      await waitStatus(suite, pi.terminal, 'error');
      await holdStatus(suite, pi.terminal, status => status?.state === 'error', 'provider error survives child reconciliation');

      const cancelAt = Date.now();
      await pi.prompt(`${marker('cancel')} cancel while child runs`);
      await gates.ready('cancel-parent', deadline(60_000));
      await pi.key('\u001b');
      await pi.waitEvent('agent_settled', e => e.at >= cancelAt, deadline(60_000));
      await waitFor('cancelled parent while child remains', () => terminalStatus(suite, pi.terminal), status => status?.state === 'working' && status.msg === '1 subagent running', deadline(60_000));
      const rawBefore = (await pi.rawOutput()).length;
      const childDoneAt = Date.now();
      gates.release('held-child');
      await pi.waitEvent('message_end', e => e.at >= childDoneAt && e.customType === 'spider.subagent_done', deadline(90_000));
      await pi.waitEvent('agent_settled', e => e.at >= childDoneAt, deadline(90_000));
      const afterChild = (await pi.rawOutput()).subarray(rawBefore);
      await suite.evidence('status-cancel-after-child.raw', afterChild);
      expect(afterChild.includes(Buffer.from('\u001b]7501;state=idle')), 'last child restores retained cancelled idle').toBe(true);
      await quitPi(pi);
    } finally {
      await suite.evidence('status-precedence-events.json', await pi.events());
      await suite.evidence('status-precedence.raw', await pi.rawOutput());
      await pi.close();
    }
    const off = await suite.launchPi({ mode: 'interactive', cwd: project, extraEnv: { ...env, PI_PROGRAM_STATUS: '0' } }) as InteractiveDriver;
    try {
      const start = await off.waitEvent('session_start', () => true, deadline(60_000));
      await waitActiveFeed(suite, start.sessionId, off.terminal);
      const before = Date.now();
      await off.prompt(`${marker('spawn')} hold a child with status disabled`);
      await gates.ready('held-child', deadline(90_000));
      await off.waitEvent('agent_settled', e => e.at >= before, deadline(90_000));
      expect((await off.toolResult('spawn-held', deadline(10_000))).isError).toBe(false);
      expect(await terminalStatus(suite, off.terminal)).toBeNull();
      const screen = async () => {
        const value = await suite.hc(['read', off.terminal, '--json', '--lines', '120']);
        if (value.exitCode !== 0 || typeof (value.json as { text?: unknown } | null)?.text !== 'string') throw new Error('cannot read owned terminal screen');
        return (value.json as { text: string }).text;
      };
      await off.prompt('/e2e-confirm');
      await waitFor('status-off confirmation is displayed', screen, text => text.includes('Fixture confirmation') && text.includes('Continue?'), deadline(60_000));
      await off.key('\u001b');
      await waitFor('status-off confirmation closes', screen, text => !text.includes('Fixture confirmation') && !text.includes('Continue?'), deadline(60_000));
      const errorAt = Date.now(); await off.prompt(`${marker('error')} fail with status disabled`);
      await off.waitEvent('agent_settled', event => event.at >= errorAt, deadline(60_000));
      expect((await off.waitEvent('message_end', event => event.at >= errorAt && event.role === 'assistant', deadline(10_000))).stopReason).toBe('error');
      const cancelAt = Date.now(); await off.prompt(`${marker('off-cancel')} cancel with status disabled`);
      await gates.ready('off-cancel-parent', deadline(60_000)); await off.key('\u001b');
      await off.waitEvent('agent_settled', event => event.at >= cancelAt, deadline(60_000));
      expect((await off.rawOutput()).includes(Buffer.from('\u001b]7501;'))).toBe(false);
      const completedAt = Date.now();
      gates.release('held-child');
      await off.waitEvent('message_end', e => e.at >= completedAt && e.customType === 'spider.subagent_done', deadline(90_000));
      await off.waitEvent('agent_settled', e => e.at >= completedAt, deadline(90_000));
      expect((await off.rawOutput()).includes(Buffer.from('\u001b]7501;'))).toBe(false);
      await suite.evidence('status-disabled-child.raw', await off.rawOutput());
      await quitPi(off);
    } finally { await off.close(); }

    for (const mode of ['json', 'print'] as const) {
      const args = ['run', '--bg', '--no-notify', '--outlive-parent', '--keep', '--json', '--cwd', project, '--', '/usr/bin/env', 'PI_PROGRAM_STATUS=1', suite.pi.launcher,
        ...(mode === 'json' ? ['--mode', 'json'] : ['-p']), `${marker(`mode-${mode}`)} hold in ${mode}`];
      const result = await suite.hc(args);
      expect(result.exitCode, result.stderr).toBe(0);
      const address = (result.json as { address: string }).address;
      expect(address).toBeTruthy();
      suite.ledger.update(ledger => { ledger.terminals.push({ side: 'local', address }); });
      const ready = await gates.ready(`mode-${mode}`, deadline(90_000));
      const events = await readObserved(suite.pi.observerDir, ready.pid);
      const start = events.find(event => event.type === 'session_start');
      expect(start).toMatchObject({ mode, hcTerminal: address });
      const feed = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', String(start?.sessionId), 'session.json');
      // c6240c20: print and JSON never activate Herdr, even in a real native terminal.
      const noOwnership = async () => {
        const value = await readFile(feed, 'utf8').then(text => JSON.parse(text) as unknown).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        const directory = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'terminals');
        const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        const mappings = await Promise.all(files.filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(directory, name), 'utf8')) as { owner: { sessionId: string; terminal: { coreId: string; address: string } } }));
        const owned = mappings.filter(mapping => mapping.owner.sessionId === String(start?.sessionId) || mapping.owner.terminal.coreId === suite.cores!.local.coreId && mapping.owner.terminal.address === address);
        expect(value, `${mode} must create no Herdr owner feed`).toBeNull();
        expect(owned, `${mode} must create no terminal mapping`).toEqual([]);
        return { feed: value, mappings: owned };
      };
      const whileHeld = await noOwnership();
      expect(await terminalStatus(suite, address), `${mode} has no program status contribution`).toBeNull();
      await suite.evidence(`status-${mode}-events.json`, events);
      gates.release(`mode-${mode}`);
      await waitFor(`${mode} terminal exits`, async () => (await suite.hc(['get', address, '--json'])).json as { state?: string; exit_code?: number } | null,
        value => value?.state === 'finished' && value.exit_code === 0, deadline(60_000));
      await suite.evidence(`status-${mode}-inactive-ownership.json`, { whileHeld, afterExit: await noOwnership() });
    }

    const rpcTerminal = await suite.launchPi({ mode: 'interactive', cwd: project, args: ['--mode', 'rpc'], extraEnv: env }) as InteractiveDriver;
    try {
      const start = await rpcTerminal.waitEvent('session_start', () => true, deadline(60_000));
      expect(start).toMatchObject({ mode: 'rpc', hcTerminal: rpcTerminal.terminal });
      await rpcTerminal.key(JSON.stringify({ id: 'fixture-rpc', type: 'prompt', message: `${marker('mode-rpc')} hold in rpc` }) + '\r');
      await gates.ready('mode-rpc', deadline(60_000));
      const feed = join(suite.directories.SPIDER_GLOBAL_ROOT, 'herdr', 'sessions', String(start.sessionId), 'session.json');
      await waitFor('active RPC feed', async () => { try { return JSON.parse(await readFile(feed, 'utf8')) as { lifecycle?: string; owner?: { terminal?: { address?: string } } }; } catch { return null; } },
        value => value?.lifecycle === 'live' && value.owner?.terminal?.address === rpcTerminal.terminal, deadline(60_000));
      expect(await terminalStatus(suite, rpcTerminal.terminal), 'RPC has no program status contribution').toBeNull();
      expect((await rpcTerminal.rawOutput()).includes(Buffer.from('\u001b]7501;'))).toBe(false);
      gates.release('mode-rpc');
      await rpcTerminal.waitEvent('agent_settled', () => true, deadline(60_000));
      await suite.evidence('status-rpc-terminal.raw', await rpcTerminal.rawOutput());
    } finally { await rpcTerminal.close(); }
  },
}];
