// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { inspectIdLock } from '../../src/sessions/id-lock.js';
import { createSessionLeases } from '../../src/sessions/lease.js';
import { expect } from 'vitest';
import { assertHostedLaunches, digestFile, v0HostingFixture, type HostedOwner, type V0HostingFixture } from '../fixtures/roam-hosting.js';
import { assertNativeLaunch } from '../fixtures/relocate-assertions.js';
import { mark, parentTurns, runChild, text, tool } from '../fixtures/child-scripts.js';
import { writeScript, type ObservedEvent } from '../harness/pi.js';
import { registerScenarios, storyId, type ScenarioDefinition } from '../harness/scenario.js';
import type { Suite } from '../harness/suite.js';
import { deadline, waitFor } from '../harness/wait.js';

async function send(fixture: Pick<V0HostingFixture, 'hc'>, owner: HostedOwner, message: string): Promise<void> {
  const result = await fixture.hc(['send', '--json', '--force', owner.terminal, message]);
  expect(result.exitCode, result.stderr).toBe(0);
}
type ObservableFixture = Pick<V0HostingFixture, 'events' | 'hc'>;
async function event(fixture: ObservableFixture, owner: HostedOwner, type: string, predicate: (row: ObservedEvent) => boolean, ms = 30_000): Promise<ObservedEvent> {
  const rows = await waitFor(`hosted session ${type}`, () => fixture.events(owner.pid), values => values.some(row => row.type === type && predicate(row)), deadline(ms), { reconcileMs: 100 });
  return rows.find(row => row.type === type && predicate(row))!;
}
async function runTool(fixture: ObservableFixture, owner: HostedOwner, marker: string, id: string): Promise<ObservedEvent> {
  await send(fixture, owner, mark(marker));
  const result = await event(fixture, owner, 'tool_execution_end', row => row.toolCallId === id);
  expect(result.isError).toBe(false);
  return result;
}
async function restartAndRestore(suite: Suite): Promise<void> {
  await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: {
    probe: parentTurns(tool('hosting-probe', { action: 'todo', op: 'list' })),
    spawn: parentTurns(runChild('hosting-child', 'core-only-child', 'child')),
    child: [text('core-only child finished')],
    schedule: parentTurns(tool('schedule-trigger', { action: 'schedule', name: 'fixture-wakeup', delaySeconds: 60, prompt: `${mark('trigger')} deliver the scheduled check` })),
    list: parentTurns(tool('list-triggers', { action: 'loop' })),
    trigger: [text('scheduled check delivered')],
  } });
  const fixture = await v0HostingFixture(suite);
  try {
    const unitDirectory = dirname(fixture.supervisorUnit);
    const existingUnits = ['herdr-core.service', 'unrelated.service'];
    const expectedUnits = [...existingUnits, 'spider-roam-supervisor-v0.service'].sort();
    const before = await Promise.all([digestFile(fixture.coreUnit), digestFile(fixture.unrelatedUnit)]);
    const sentinel = await fixture.sentinel();
    const provision = await fixture.provision();
    expect(provision).toMatchObject({ code: 0, value: { hostingReady: expect.any(Boolean) } });
    expect(await fixture.participating()).toBe(false);
    await access(fixture.supervisor, constants.X_OK);
    expect(await digestFile(fixture.supervisor)).toBe(suite.packed.digests['dist/roam/supervisor.mjs']);
    expect((await readdir(unitDirectory)).sort()).toEqual(existingUnits);
    expect(await fixture.serviceCommands()).toEqual([]);
    expect(await Promise.all([digestFile(fixture.coreUnit), digestFile(fixture.unrelatedUnit)])).toEqual(before);
    expect(await fixture.sentinel()).toEqual(sentinel);

    await fixture.enable();
    expect(await fixture.participating()).toBe(true);
    expect((await readdir(unitDirectory)).sort()).toEqual(expectedUnits);
    const unit = await readFile(fixture.supervisorUnit, 'utf8');
    expect(unit).toMatch(/^ExecStart=.*supervisor\.mjs.*--v0$/m);
    expect(unit).not.toMatch(/^(After|Requires|PartOf)=/m);
    const commands = await fixture.serviceCommands();
    expect(commands).toEqual(['--user daemon-reload', '--user enable --now spider-roam-supervisor-v0.service']);
    expect(await Promise.all([digestFile(fixture.coreUnit), digestFile(fixture.unrelatedUnit)])).toEqual(before);
    expect(await fixture.sentinel()).toEqual(sentinel);
    await suite.evidence('R04-provision.json', { provision, units: expectedUnits, commands, sentinel });

    await fixture.seedHome();
    const home = fixture.home();
    expect(home).toMatchObject({ session_id: fixture.sessionId, machine_id: fixture.machineId, epoch: fixture.epoch, state: 'running', destination: null });
    await fixture.start();
    const first = await fixture.waitOwner();
    const nativeFirst = await fixture.hc(['get', first.terminal, '--json']);
    expect(nativeFirst.exitCode, nativeFirst.stderr).toBe(0);
    expect(nativeFirst.json).toMatchObject({ address: first.terminal, state: 'live', pid: first.pid });
    assertNativeLaunch(nativeFirst.json, await suite.cores!.records(), fixture, suite.cores!.dest.namespace, fixture.sessionId, fixture.machineId, fixture.epoch);
    const startup = await event(fixture, first, 'session_start', row => row.sessionId === fixture.sessionId);
    expect(startup).toMatchObject({ mode: 'tui', stdinTTY: true, sessionFile: fixture.file, cwd: fixture.cwd, hcTerminal: first.terminal });
    const probe = await runTool(fixture, first, 'probe', 'hosting-probe');
    expect(probe.toolName).toBe('spider');
    expect(probe.result).toMatchObject({ details: expect.any(Array) });
    const config = JSON.parse(await readFile(join(fixture.root, 'herdr', 'config.json'), 'utf8'));
    expect(config.mode).toBe('core-only');
    expect(config).not.toHaveProperty('app');
    const feedPath = join(fixture.root, 'herdr', 'sessions', fixture.sessionId, 'session.json');
    const feed = await waitFor('core-only session feed', async () => {
      try { return JSON.parse(await readFile(feedPath, 'utf8')); } catch { return null; }
    }, value => value?.lifecycle === 'live', deadline(30_000));
    expect(feed.sessionId).toBe(fixture.sessionId);
    const childCall = await runTool(fixture, first, 'spawn', 'hosting-child');
    const childFeed = await waitFor('core-only child status', async () => {
      try { return JSON.parse(await readFile(feedPath, 'utf8')); } catch { return null; }
    }, value => value?.runs?.rows?.some((row: { name: string; status: string }) => row.name === 'core-only-child' && row.status === 'done'), deadline(60_000));
    const children = childFeed.runs.rows.filter((row: { name: string }) => row.name === 'core-only-child');
    expect(children).toHaveLength(1);
    expect(children[0].ownerSessionId).toBe(fixture.sessionId);
    await event(fixture, first, 'agent_settled', row => Number(row.at) >= Number(childCall.at));
    const schedule = await runTool(fixture, first, 'schedule', 'schedule-trigger');
    await event(fixture, first, 'agent_settled', row => Number(row.at) >= Number(schedule.at));
    const recordsBeforeRestart = (await suite.cores!.records()).length;
    suite.cores!.dest.env.PATH = '/usr/bin:/bin';
    delete suite.cores!.dest.env.SPIDER_ROAM_PI;
    await fixture.restartCore();
    const ambient = await fixture.hc(['exec', '--timeout', '5', '--', '/bin/sh', '-c',
      'if command -v pi >/dev/null 2>&1; then exit 41; fi; [ "${SPIDER_ROAM_PI+x}" != x ]']);
    expect(ambient.exitCode, ambient.stderr).toBe(0);
    const restored = await fixture.waitOwner(first.pid);
    expect(restored.pid).not.toBe(first.pid);
    expect(restored.terminal).not.toBe(first.terminal);
    expect(restored.file).toBe(first.file); expect(restored.sessionId).toBe(first.sessionId);
    const restoredStartup = (await fixture.events(restored.pid)).find(row => row.type === 'session_start' && row.sessionId === fixture.sessionId);
    expect(restoredStartup).toMatchObject({ mode: 'tui', stdinTTY: true, sessionFile: fixture.file, cwd: fixture.cwd, hcTerminal: restored.terminal });
    expect(fixture.home()).toEqual(home);
    const adopted = await inspectIdLock(join(fixture.root, 'herdr'), restored.sessionId);
    expect(adopted).toMatchObject({ identity: { pid: restored.pid }, pendingOperationId: null });
    const lease = await createSessionLeases(join(fixture.root, 'herdr')).get(restored.file);
    expect(lease).toMatchObject({ pid: restored.pid, startIdentity: adopted!.identity.startIdentity });
    const nativeRestored = await fixture.hc(['get', restored.terminal, '--json']);
    expect(nativeRestored.exitCode, nativeRestored.stderr).toBe(0);
    expect(nativeRestored.json).toMatchObject({ address: restored.terminal, state: 'live', pid: restored.pid });
    assertNativeLaunch(nativeRestored.json, (await suite.cores!.records()).slice(recordsBeforeRestart), fixture,
      suite.cores!.dest.namespace, fixture.sessionId, fixture.machineId, fixture.epoch);
    const ownersAfterRestart = await fixture.owners(); expect(ownersAfterRestart).toHaveLength(1);
    const listing = await runTool(fixture, restored, 'list', 'list-triggers');
    expect(JSON.stringify(listing.result)).toContain('fixture-wakeup');
    const delivery = await event(fixture, restored, 'message_end', row => row.role === 'user' && JSON.stringify(row.content).includes(mark('trigger')), 90_000);
    await event(fixture, restored, 'agent_settled', row => Number(row.at) >= Number(delivery.at));
    const entries = (await readFile(fixture.file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const deliveries = entries.filter(row => row.type === 'message' && row.message?.role === 'user' && JSON.stringify(row.message.content).includes(mark('trigger')));
    expect(deliveries).toHaveLength(1);
    expect((await fixture.owners()).map(value => value.pid)).toEqual([restored.pid]);
    const launchCount = assertHostedLaunches(await suite.cores!.records(), fixture.pi, fixture.file);
    const finalUnits = (await readdir(unitDirectory)).sort();
    expect(finalUnits).toEqual(expectedUnits);
    const coreAfter = await digestFile(fixture.coreUnit);
    expect(coreAfter).toBe(before[0]);
    expect(await digestFile(fixture.unrelatedUnit)).toBe(before[1]);
    await suite.evidence('R04-restart.json', { sessionId: fixture.sessionId, file: fixture.file, cwd: fixture.cwd, home,
      first: { pid: first.pid, terminal: first.terminal }, restored: { pid: restored.pid, terminal: restored.terminal },
      lockPid: adopted!.identity.pid, leasePid: lease!.pid, owners: ownersAfterRestart.length,
      coreUnitUnchanged: coreAfter === before[0], ambientPiAbsent: ambient.exitCode === 0, triggerEntries: deliveries.length,
      launchCount, unitFiles: finalUnits });
  } finally { await fixture.close(); }
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: storyId('R04'), title: 'Provision leaves hosting off; local enable and core restart keep one owner', tiers: ['headless'], run: restartAndRestore },
];
registerScenarios(scenarios);
