// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { digestFile, hasFile, hostingFixture, type HostedOwner, type HostingFixture } from '../fixtures/roam-hosting.js';
import { mark, parentTurns, runChild, text, tool } from '../fixtures/child-scripts.js';
import { writeScript, type ObservedEvent } from '../harness/pi.js';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';

async function send(suite: Suite, owner: HostedOwner, message: string): Promise<void> {
  const result = await suite.hc(['send', '--json', '--force', owner.terminal, message]);
  expect(result.exitCode, result.stderr).toBe(0);
}
async function event(fixture: HostingFixture, owner: HostedOwner, type: string, predicate: (row: ObservedEvent) => boolean, ms = 30_000): Promise<ObservedEvent> {
  const rows = await waitFor(`hosted session ${type}`, () => fixture.events(owner.pid), values => values.some(row => row.type === type && predicate(row)), deadline(ms), { reconcileMs: 100 });
  return rows.find(row => row.type === type && predicate(row))!;
}
async function runTool(fixture: HostingFixture, owner: HostedOwner, marker: string, id: string): Promise<ObservedEvent> {
  await send(fixture.suite, owner, mark(marker));
  const result = await event(fixture, owner, 'tool_execution_end', row => row.toolCallId === id);
  expect(result.isError).toBe(false);
  return result;
}
async function launchCount(fixture: HostingFixture): Promise<number> {
  const records = await fixture.suite.cores!.records();
  return records.filter(record => record.argv[0] === 'run' && record.argv.includes(`spider.session=${fixture.sessionId}`)).length;
}
async function start(fixture: HostingFixture): Promise<HostedOwner> {
  expect(await fixture.control('session-start', `start-${fixture.sessionId}`)).toMatchObject({ code: 3, reason: 'readiness-pending' });
  await fixture.start();
  return fixture.waitOwner();
}

async function coreOnly(suite: Suite): Promise<void> {
  await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: {
    probe: parentTurns(tool('hosting-probe', { action: 'todo', op: 'list' })),
    spawn: parentTurns(runChild('hosting-child', 'core-only-child', 'child')),
    child: [text('core-only child finished')],
  } });
  const fixture = await hostingFixture(suite), before = await digestFile(fixture.coreUnit);
  try {
    const owner = await start(fixture);
    const startup = await event(fixture, owner, 'session_start', row => row.sessionId === fixture.sessionId);
    expect(startup).toMatchObject({ mode: 'tui', stdinTTY: true, sessionFile: fixture.file, cwd: fixture.cwd, hcTerminal: owner.terminal });
    const result = await runTool(fixture, owner, 'probe', 'hosting-probe');
    const extensionLoaded = result.toolName === 'spider' && result.isError === false;
    expect(extensionLoaded).toBe(true);
    const config = JSON.parse(await readFile(join(fixture.root, 'herdr', 'config.json'), 'utf8'));
    expect(config.mode).toBe('core-only'); expect(config).not.toHaveProperty('app');
    const feed = await waitFor('core-only session feed', async () => {
      try { return JSON.parse(await readFile(join(fixture.root, 'herdr', 'sessions', fixture.sessionId, 'session.json'), 'utf8')); } catch { return null; }
    }, value => value?.lifecycle === 'live', deadline(30_000));
    expect(feed.sessionId).toBe(fixture.sessionId);
    const childCall = await runTool(fixture, owner, 'spawn', 'hosting-child');
    const childFeed = await waitFor('core-only child status', async () => {
      try { return JSON.parse(await readFile(join(fixture.root, 'herdr', 'sessions', fixture.sessionId, 'session.json'), 'utf8')); } catch { return null; }
    }, value => value?.runs?.rows?.some((row: { name: string; status: string }) => row.name === 'core-only-child' && row.status === 'done'), deadline(60_000));
    const children = childFeed.runs.rows.filter((row: { name: string }) => row.name === 'core-only-child');
    expect(children).toHaveLength(1);
    expect(children[0].ownerSessionId).toBe(fixture.sessionId);
    expect((await fixture.owners()).map(value => value.pid)).toEqual([owner.pid]);
    expect(hasFile(fixture.shellLog)).toBe(true);
    await event(fixture, owner, 'agent_settled', row => Number(row.at) >= Number(childCall.at));
    await send(suite, owner, '/quit');
    const stopped = await waitFor('interactive quit persists stopped intent', fixture.state,
      row => row?.value.intent.desired === 'stopped', deadline(30_000));
    expect(stopped?.value.intent.desired).toBe('stopped');
    await waitFor('interactive owner exits', fixture.owners, rows => rows.length === 0, deadline(30_000));
    const launchesBeforeQuitSweep = await launchCount(fixture);
    expect(launchesBeforeQuitSweep).toBe(1);
    fixture.advance(300_000);
    await fixture.settle();
    expect(await launchCount(fixture)).toBe(launchesBeforeQuitSweep);
    expect(await fixture.owners()).toEqual([]);
    expect(await digestFile(fixture.coreUnit)).toBe(before);
    await suite.evidence('R03-core-only.json', { sessionId: fixture.sessionId, terminal: owner.terminal, pid: owner.pid, extensionLoaded, interactiveQuitStopped: true, coreUnitUnchanged: true });
  } finally { await fixture.close(); }
}

async function restartAndRestore(suite: Suite): Promise<void> {
  await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: {
    schedule: parentTurns(tool('schedule-trigger', { action: 'schedule', name: 'fixture-wakeup', delaySeconds: 60, prompt: `${mark('trigger')} deliver the scheduled check` })),
    list: parentTurns(tool('list-triggers', { action: 'loop' })),
    trigger: [text('scheduled check delivered')],
  } });
  const fixture = await hostingFixture(suite), before = await digestFile(fixture.coreUnit);
  try {
    const first = await start(fixture);
    await runTool(fixture, first, 'schedule', 'schedule-trigger');
    await event(fixture, first, 'agent_settled', () => true);
    await fixture.restartCore();
    await waitFor('restart records the lost owner', fixture.state, row => row?.value.supervision.kind === 'idle' && row.value.failures.length === 1, deadline(30_000));
    fixture.advance(5_000);
    const restored = await fixture.waitOwner(first.pid);
    expect(restored.pid).not.toBe(first.pid);
    expect(restored.terminal).not.toBe(first.terminal);
    expect(restored.file).toBe(first.file); expect(restored.sessionId).toBe(first.sessionId);
    const ownersAfterRestart = await fixture.owners(); expect(ownersAfterRestart).toHaveLength(1);
    const listing = await runTool(fixture, restored, 'list', 'list-triggers');
    expect(JSON.stringify(listing.result)).toContain('fixture-wakeup');
    const delivery = await event(fixture, restored, 'message_end', row => row.role === 'user' && JSON.stringify(row.content).includes(mark('trigger')), 90_000);
    await event(fixture, restored, 'agent_settled', row => Number(row.at) >= Number(delivery.at));
    const entries = (await readFile(fixture.file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const deliveries = entries.filter(row => row.type === 'message' && row.message?.role === 'user' && JSON.stringify(row.message.content).includes(mark('trigger')));
    expect(deliveries).toHaveLength(1);
    expect((await fixture.owners()).map(value => value.pid)).toEqual([restored.pid]);
    expect(await digestFile(fixture.coreUnit)).toBe(before);
    await suite.evidence('R04-restart.json', { sessionId: fixture.sessionId, firstTerminal: first.terminal, restoredTerminal: restored.terminal, owners: ownersAfterRestart.length, triggerEntries: deliveries.length });
  } finally { await fixture.close(); }
}

async function stoppedAndSuspended(suite: Suite): Promise<void> {
  await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: {
    probe: parentTurns(tool('suspension-probe', { action: 'todo', op: 'list' })),
  } });
  const stoppedFixture = await hostingFixture(suite, 'hosting-stop');
  try {
    const owner = await start(stoppedFixture);
    const result = await runTool(stoppedFixture, owner, 'probe', 'suspension-probe');
    expect(result.toolName).toBe('spider');
    expect(await stoppedFixture.control('session-stop', `stop-${stoppedFixture.sessionId}`)).toMatchObject({ code: 0, reason: 'stopped-intent' });
    await waitFor('deliberate stop ends the live owner', stoppedFixture.owners, rows => rows.length === 0, deadline(30_000));
    const stoppedLaunches = await launchCount(stoppedFixture);
    expect(stoppedLaunches).toBe(1);
    await stoppedFixture.restartCore();
    stoppedFixture.advance(300_000);
    await stoppedFixture.settle();
    expect(await launchCount(stoppedFixture)).toBe(stoppedLaunches);
    const stopped = await waitFor('durable stopped intent survives the restart', stoppedFixture.state,
      row => row?.value.intent.desired === 'stopped', deadline(30_000));
    expect(stopped?.value.intent.desired).toBe('stopped');
    expect(await stoppedFixture.owners()).toEqual([]);
    await suite.evidence('R05-stop.json', { sessionId: stoppedFixture.sessionId, stopped: true, owners: 0 });
  } finally { await stoppedFixture.close(); }

  const fixture = await hostingFixture(suite, 'hosting-crashes'), delays = [5_000, 15_000, 60_000, 300_000];
  try {
    let owner = await start(fixture);
    for (let count = 1; count <= 5; count++) {
      await fixture.crash(owner);
      fixture.advance(10_000);
      const state = await waitFor('supervisor records the crash', fixture.state, row => (row?.value.failures.length ?? 0) >= count, deadline(30_000));
      expect(state?.value.failures).toHaveLength(count);
      if (count < 5) { fixture.advance(delays[count - 1]); owner = await fixture.waitOwner(owner.pid); }
      else expect(state?.value.intent.suspended).toMatch(/repeated session crashes/i);
    }
    expect(await fixture.owners()).toEqual([]);
    const suspendedLaunches = await launchCount(fixture);
    expect(suspendedLaunches).toBe(5);
    await fixture.restartCore();
    fixture.advance(300_000);
    await fixture.settle();
    expect(await launchCount(fixture)).toBe(suspendedLaunches);
    expect((await fixture.state())?.value.intent).toMatchObject({ desired: 'running', suspended: expect.stringMatching(/repeated session crashes/i) });
    expect(await fixture.owners()).toEqual([]);
    await suite.evidence('R05-suspension.json', { sessionId: fixture.sessionId, failures: 5, suspended: true, owners: 0 });
  } finally { await fixture.close(); }
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('R03'), title: 'Core-only packaged session loads in an owned terminal', tiers: ['headless'], run: coreOnly },
  { id: storyId('R04'), title: 'Core restart restores one exact owner and its trigger', tiers: ['headless'], run: restartAndRestore },
  { id: storyId('R05'), title: 'Repeated crashes suspend and deliberate stop survives restart', tiers: ['headless'], run: stoppedAndSuspended },
];
registerScenarios(scenarios);
