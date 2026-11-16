// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { copyFile, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerScenarios, type ScenarioDefinition, type StoryId } from '../harness/scenario.js';
import { deadline, waitFor } from '../harness/wait.js';
import { identityAlive, identityOf, type ProcessIdentity } from '../harness/resources.js';
import { writeScript, type ObservedEvent } from '../harness/pi.js';
import type { Suite } from '../harness/suite.js';
import { CHILD_MODEL, parentTurns, held, scripts } from '../fixtures/child-scripts.js';
import { preparePanePresentations, launchPaneOwner, presentationRows, stopPaneHelper, paneProcesses, paneHeaderFunctions, stableTerminal, type PaneFixture, type PaneOwner, type PresentationDocument } from '../fixtures/pane-presentations.js';
import type { PaneAgentRow, PanePresentation, PaneServiceRequest, PaneTarget } from '../../src/panes/types.js';
import { parseTerminal } from '../../src/client/parse.js';

async function ownerPresentation(f: PaneFixture, owner: PaneOwner): Promise<PanePresentation> {
  const reply = await f.request({ version: 1, op: 'open-existing', operationId: randomUUID(), sessionId: owner.row.sessionId, generation: owner.row.generation, slot: { ...f.anchor } });
  expect(reply).toMatchObject({ kind: 'outcome', outcome: { status: 'complete' } });
  return (await f.state()).presentations.find(row => row.target.sessionId === owner.row.sessionId)!;
}
async function openView(f: PaneFixture, row: Extract<PaneAgentRow, { unavailableReason: null }>, view: Extract<PaneServiceRequest, { op: 'open-auxiliary' }>['view']): Promise<PanePresentation> {
  const reply = await f.request({ version: 1, op: 'open-auxiliary', operationId: randomUUID(), sessionId: row.sessionId, generation: row.generation, view });
  expect(reply).toMatchObject({ kind: 'outcome', outcome: { status: 'complete', reason: 'view-presented' } });
  if (reply.kind !== 'outcome' || !reply.outcome.presentation) throw new Error('view was not acknowledged');
  return reply.outcome.presentation;
}
async function sourceRow(f: PaneFixture, owner: PaneOwner, ready: (row: Extract<PaneAgentRow, { unavailableReason: null }>) => boolean) {
  const snapshot = await waitFor('source inventory includes auxiliary identity', () => f.snapshot(), value => value.rows.some(row => row.unavailableReason === null && row.sessionId === owner.row.sessionId && row.generation === owner.row.generation && ready(row)), deadline(20000));
  const row = snapshot.rows.find(row => row.unavailableReason === null && row.sessionId === owner.row.sessionId && row.generation === owner.row.generation && ready(row));
  if (!row || row.unavailableReason !== null) throw new Error('source row unavailable'); return row;
}
async function leases(f: PaneFixture, remote = true): Promise<Record<string, any>[]> {
  const root = join((remote ? f.remoteEnv : f.env).SPIDER_GLOBAL_ROOT!, 'herdr/panes/view-leases');
  const names = await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return Promise.all(names.filter(name => name.endsWith('.json')).map(async name => ({ file: name, ...JSON.parse(await readFile(join(root, name), 'utf8')) })));
}
async function unchanged(f: PaneFixture) { const other = await f.assertUnrelated(); expect(other.after).toEqual(other.before); }
async function machineText(f: PaneFixture, p: PanePresentation): Promise<string> {
  const module = await paneHeaderFunctions(f.packageRoot);
  const address = p.mode === 'native' ? p.target.terminalId : p.proxy!;
  const terminal = await f.terminal(address);
  return module.paneMachineFact({ address, labels: terminal.labels, programIsAgent: true }, [p])?.label;
}

async function viewStopped(f: PaneFixture, view: PanePresentation, identity: ProcessIdentity): Promise<boolean> {
  const result = await f.suite.hc(['get', view.target.address, '--json']);
  if (result.exitCode === 0) return (result.json as { state: string }).state === 'finished' && !identityAlive(identity);
  let value: any = result.json;
  if (!value) { try { value = JSON.parse(result.stderr); } catch { throw new Error(result.stderr || result.stdout); } }
  if (value?.error?.kind !== 'not_found') throw new Error(result.stderr || result.stdout);
  return !identityAlive(identity);
}

async function viewer(suite: Suite): Promise<void> {
  const f = await preparePanePresentations(suite);
  const childControl = await scripts(suite, {
    spawn: parentTurns({ steps: [{ tool: { id: 'B06-child', name: 'spider', arguments: { action: 'run', tasks: [{ agent: 'worker', name: 'Visible child', task: '[[e2e:child]] Work inline, no subagents.', model: CHILD_MODEL, thinking: 'off', context: 'fresh' }, { agent: 'worker', name: 'Second child', task: '[[e2e:second]] Work inline, no subagents.', model: CHILD_MODEL, thinking: 'off', context: 'fresh' }] } } }] }),
    child: [held('B06-child-running', 'Child finished.')],
    second: [held('B06-second-running', 'Second child finished.')],
  });
  const owner = await launchPaneOwner(f, 'dest'), parent = await ownerPresentation(f, owner);
  await owner.pi.prompt('[[e2e:spawn]]');
  const running = await childControl.ready('B06-child-running', deadline(30000)), secondRunning = await childControl.ready('B06-second-running', deadline(30000));
  expect(identityAlive(owner.pi.identity)).toBe(true);
  const row = await sourceRow(f, owner, row => row.children.some(child => child.name === 'Visible child'));
  const child = row.children.find(child => child.name === 'Visible child')!;
  const childIdentity = identityOf(running.pid), secondIdentity = identityOf(secondRunning.pid);
  suite.ledger.update(value => { value.processes.push({ ...childIdentity, label: 'pane-view-child', group: false }, { ...secondIdentity, label: 'pane-view-second-child', group: false }); });
  const before = stableTerminal(await f.terminal(parent.target.address));
  const p = await openView(f, row, { kind: 'subagent', runId: child.runId });
  expect(p.target).toMatchObject({ coreId: suite.cores!.dest.coreId, sessionId: owner.row.sessionId, generation: owner.row.generation, runId: child.runId, kind: 'subagent' });
  expect(p.mode).toBe('proxy'); expect(p.target.terminalId).not.toBe(parent.target.terminalId);
  expect(p.slot).toMatchObject({ space: parent.slot!.space, tab: parent.slot!.tab });
  expect(presentationRows(await f.app('ls', {}) as PresentationDocument).filter(row => row.terminal === p.proxy)).toEqual([{ ...p.slot, terminal: p.proxy }]);
  const target = await f.terminal(p.target.address);
  const viewIdentity = identityOf(target.pid);
  expect(target.state).toBe('live'); expect(JSON.stringify(target.argv)).toContain(join(f.packageRoot, 'dist/herdr/viewer.mjs'));
  expect(target.cols).toBeGreaterThanOrEqual(60); expect(target.rows).toBeGreaterThanOrEqual(8);
  expect(await machineText(f, p)).toBe(suite.cores!.machine);
  const secondRow = await sourceRow(f, owner, row => row.children.some(child => child.name === 'Second child'));
  const second = secondRow.children.find(child => child.name === 'Second child')!;
  const secondView = await openView(f, secondRow, { kind: 'subagent', runId: second.runId });
  expect(secondView.target.runId).toBe(second.runId); expect(secondView.slot!.tab).toBe(parent.slot!.tab);
  const secondViewIdentity = identityOf((await f.terminal(secondView.target.address)).pid);
  const active = await leases(f);
  expect(active.filter(lease => lease.sessionId === owner.row.sessionId && lease.state === 'active')).toHaveLength(2);
  expect(active.filter(lease => lease.runId === child.runId && lease.state === 'active')).toHaveLength(1);
  const expiry = active.find(lease => lease.runId === child.runId)!.expiresAt;
  expect(expiry).toBeGreaterThan(Date.now()); expect(expiry).toBeLessThanOrEqual(Date.now() + 20000);
  const processBefore = await paneProcesses(f);
  await waitFor('one batched lease renewal advances the owned view', () => leases(f), values => values.some(lease => lease.runId === child.runId && lease.expiresAt > expiry), deadline(10000));
  const renewed = await leases(f);
  expect(renewed.filter(lease => lease.runId === child.runId && lease.state === 'active')).toHaveLength(1);
  const renewals = (await suite.cores!.records()).filter(record => record.argv[0] === 'exec').flatMap(record => { try { const request = JSON.parse(record.argv.at(-1)!); return request.op === 'renew-viewers' ? [request] : []; } catch { return []; } });
  const ids = active.map(lease => lease.leaseId);
  expect(renewals.some(request => request.leases.length === 2 && request.leases.every((lease: any) => ids.includes(lease.leaseId)))).toBe(true);
  expect(identityAlive(childIdentity)).toBe(true);
  const idleStart = Date.now(), cpuBefore = (await paneProcesses(f)).find(row => row.pid === target.pid);
  expect(cpuBefore).toBeDefined();
  await waitFor('thirty-second idle viewer sample', async () => Date.now(), value => value - idleStart >= 30000, deadline(35000));
  const cpuAfter = (await paneProcesses(f)).find(row => row.pid === target.pid), idleMs = Date.now() - idleStart;
  expect(cpuAfter).toBeDefined();
  expect(Number(cpuAfter!.cpuSeconds) - Number(cpuBefore!.cpuSeconds)).toBeLessThanOrEqual(1);
  expect(Number(cpuAfter!.rssKiB) - Number(cpuBefore!.rssKiB)).toBeLessThanOrEqual(16 * 1024);
  expect((await f.terminal(p.target.address)).state).toBe('live');
  await stopPaneHelper(f);
  const sleepingAt = Date.now();
  // No snapshot or pane request may restart the helper during this interval.
  await waitFor('thirty-second disconnected display interval', async () => ({ at: Date.now(), stopped: await viewStopped(f, p, viewIdentity) }), value => value.at - sleepingAt >= 30000 && value.stopped, deadline(40000));
  expect(identityAlive(childIdentity)).toBe(true); expect(identityAlive(secondIdentity)).toBe(true);
  expect(await viewStopped(f, secondView, secondViewIdentity)).toBe(true);
  expect(identityAlive(owner.pi.identity)).toBe(true);
  expect(stableTerminal(await f.terminal(parent.target.address))).toEqual(before);
  const reopened = await openView(f, row, { kind: 'subagent', runId: child.runId });
  expect(reopened.target.terminalId).not.toBe(p.target.terminalId);
  expect(reopened.target.runId).toBe(child.runId);
  expect(reopened.slot).toMatchObject({ space: parent.slot!.space, tab: parent.slot!.tab });
  expect((await f.terminal(reopened.target.address)).state).toBe('live');
  expect(identityAlive(childIdentity)).toBe(true);
  const reopenedCurrent = await f.current(reopened.id);
  expect(await f.request({ version: 1, op: 'park', operationId: randomUUID(), presentationId: reopened.id, expectedRevision: reopenedCurrent.revision })).toMatchObject({ kind: 'outcome', outcome: { status: 'complete' } });
  await waitFor('closing the view stops its display lease only', () => leases(f), values => values.filter(lease => lease.runId === child.runId).every(lease => lease.state === 'stopped' || lease.expiresAt <= Date.now()), deadline(25000));
  expect(identityAlive(childIdentity)).toBe(true); expect(identityAlive(owner.pi.identity)).toBe(true);
  const priorLeaseIds = new Set((await leases(f)).map(lease => lease.leaseId));
  await writeFile(f.faultFile, JSON.stringify({ disconnected: false, viewerLaunchFailed: true }), { mode: 0o600 });
  let failed;
  try { failed = await f.request({ version: 1, op: 'open-auxiliary', operationId: randomUUID(), sessionId: row.sessionId, generation: row.generation, view: { kind: 'subagent', runId: child.runId } }); }
  finally { await writeFile(f.faultFile, JSON.stringify({ disconnected: false }), { mode: 0o600 }); }
  expect(failed).toMatchObject({ kind: 'outcome', outcome: { status: 'refused' } });
  const failedLeases = (await leases(f)).filter(lease => !priorLeaseIds.has(lease.leaseId));
  expect(failedLeases).toHaveLength(1);
  expect(failedLeases[0]).toMatchObject({ runId: child.runId, state: 'stopped', expiresAt: 0, target: null, address: null });
  expect(identityAlive(childIdentity)).toBe(true); expect(identityAlive(secondIdentity)).toBe(true);
  const processAfter = await paneProcesses(f);
  await suite.evidence('B06-processes-and-leases.json', { before: processBefore, after: processAfter, idle: { before: cpuBefore, after: cpuAfter, elapsedMs: idleMs, maximumCpuSeconds: 1, maximumRssGrowthKiB: 16 * 1024 }, active, renewed, sleepMs: Date.now() - sleepingAt, children: [childIdentity, secondIdentity], renewals, failed, failedLeases, limits: 'Native small-window fallback needs isolated app geometry' });
  childControl.release('B06-child-running'); childControl.release('B06-second-running');
  await unchanged(f); await f.evidence('B06-observations.json');
}

async function toolResult(owner: PaneOwner, id: string): Promise<ObservedEvent> {
  const result = await owner.pi.toolResult(id, deadline(30000)); expect(result.isError).toBe(false); return result;
}
async function consoleView(suite: Suite): Promise<void> {
  const f = await preparePanePresentations(suite);
  await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: {
    jobs: [{ steps: [1, 2].map(index => ({ tool: { id: `B07-job-${index}`, name: 'spider', arguments: { action: 'exec', on: suite.cores!.machine, language: 'shell', code: `printf 'B07-job-${index}-ready\\n'; sleep 90`, background: true, timeout: 1000 } } })) }, { steps: [{ text: 'Jobs started.' }] }],
  } });
  const owner = await launchPaneOwner(f, 'local'); await ownerPresentation(f, owner);
  await owner.pi.prompt('[[e2e:jobs]]');
  await toolResult(owner, 'B07-job-1'); await toolResult(owner, 'B07-job-2');
  const row = await sourceRow(f, owner, row => row.consoles.length === 1), console = row.consoles[0]!;
  expect(row.consoles).toHaveLength(1);
  const inventory = (await suite.hc(['ls', '--all', '--json'], 'dest')).json as { terminals: { address: string; labels: Record<string, string>; state: string }[] };
  const observed = await Promise.all(inventory.terminals.map(terminal => f.terminal(terminal.address, 'dest')));
  const jobRows = observed.map(parseTerminal).filter(terminal => terminal.labels['spider.kind'] === 'exec' && terminal.labels['spider.session'] === owner.row.sessionId);
  expect(jobRows).toHaveLength(2);
  const before = await Promise.all(jobRows.map(job => f.terminal(job.address, 'dest')));
  expect(before.every(job => job.state === 'live')).toBe(true);
  const p = await openView(f, row, { kind: 'console', consoleId: console.consoleId, machineKey: console.machineKey });
  expect(p.target).toMatchObject({ kind: 'console', coreId: suite.cores!.dest.coreId, sessionId: owner.row.sessionId, consoleId: console.consoleId });
  expect(await machineText(f, p)).toBe(suite.cores!.machine);
  await waitFor('console displays both retained jobs', () => f.screen(p.proxy!), text => text.includes('B07-job-1-ready') && text.includes('B07-job-2-ready'), deadline(10000));
  const same = await openView(f, row, { kind: 'console', consoleId: console.consoleId, machineKey: console.machineKey });
  expect(same.target.terminalId).toBe(p.target.terminalId); expect(same.proxy).toBe(p.proxy);
  await f.send(p.proxy!, "printf 'B07-no-console-input'");
  const record = (await suite.cores!.records()).filter(record => record.argv[0] === 'attach' && record.argv.at(-1) === p.target.address);
  expect(record.length).toBeGreaterThan(0);
  expect(record.every(record => record.argv.includes('--observe'))).toBe(true);
  expect(await f.screen(p.target.address)).not.toContain('B07-no-console-input');
  for (const job of jobRows) expect(await f.screen(job.address, 'dest')).not.toContain('B07-no-console-input');
  const current = await f.current(p.id);
  expect(await f.request({ version: 1, op: 'park', operationId: randomUUID(), presentationId: p.id, expectedRevision: current.revision })).toMatchObject({ kind: 'outcome', outcome: { status: 'complete' } });
  const after = await Promise.all(jobRows.map(job => f.terminal(job.address, 'dest')));
  expect(after.map(stableTerminal)).toEqual(before.map(stableTerminal));
  expect(after.every(job => job.state === 'live')).toBe(true);
  expect(identityAlive(owner.pi.identity)).toBe(true);
  expect((await sourceRow(f, owner, row => row.consoles.length === 1)).consoles[0]!.consoleId).toBe(console.consoleId);
  await suite.evidence('B07-jobs.json', { consoleId: console.consoleId, before, after, readOnlyAttach: record.map(row => row.argv) });
  await unchanged(f); await f.evidence('B07-observations.json');
}

async function copySession(f: PaneFixture, owner: PaneOwner, name: string): Promise<string> {
  const path = join(f.suite.root, name); await mkdir(path, { mode: 0o700 });
  const file = join(path, 'session.jsonl'); await copyFile(owner.file, file); return file;
}
async function ready(f: PaneFixture, p: PanePresentation, target: PaneTarget): Promise<PanePresentation> {
  const current = await f.current(p.id);
  const reply = await f.request({ version: 1, op: 'present-ready', operationId: randomUUID(), presentationId: current.id, expectedRevision: current.revision, target });
  expect(reply).toMatchObject({ kind: 'outcome', outcome: { status: 'complete', reason: 'native-view-converted' } });
  const result = await f.current(p.id);
  expect(result.slot).toMatchObject({ space: p.slot!.space, tab: p.slot!.tab });
  expect(result.target).toEqual(target); expect(result.conversion).toBeNull();
  return result;
}
async function handoff(suite: Suite): Promise<void> {
  const f = await preparePanePresentations(suite);
  await writeScript(suite.pi.scriptPath, { story: suite.story, scripts: { save: [{ steps: [{ text: 'Session saved.' }] }] } });
  const local = await launchPaneOwner(f, 'local');
  await local.pi.prompt('[[e2e:save]]');
  await waitFor('source session transcript persists its first response', async () => {
    try { return await readFile(local.file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  }, text => text.includes('Session saved.'), deadline(5000));
  const first = await ownerPresentation(f, local);
  expect(first.mode).toBe('native'); expect(first.proxy).toBeNull();
  expect(await machineText(f, first)).toBe('This computer');
  const sourceSlot = first.slot!;
  await f.app('pane.focus', { pane: sourceSlot.pane });
  const prepared = await f.request({ version: 1, op: 'prepare-handoff', operationId: randomUUID(), presentationId: first.id, expectedRevision: first.revision, sessionId: local.row.sessionId, generation: local.row.generation, homeEpoch: local.row.target.homeEpoch! });
  expect(prepared).toMatchObject({ kind: 'outcome', outcome: { status: 'complete', reason: 'handoff-prepared' } });
  const remote = await launchPaneOwner(f, 'dest', await copySession(f, local, 'remote-resume'));
  expect(remote.row.sessionId).toBe(local.row.sessionId);
  const toRemote = await ready(f, first, remote.row.target);
  expect(toRemote.mode).toBe('proxy'); expect(toRemote.proxy).toBeTruthy();
  expect(await machineText(f, toRemote)).toBe(suite.cores!.machine);
  const remoteWorld = presentationRows(await f.app('ls', {}) as PresentationDocument);
  expect(remoteWorld.filter(row => row.terminal === toRemote.proxy)).toEqual([{ ...toRemote.slot, terminal: toRemote.proxy }]);
  expect(remoteWorld.some(row => row.terminal === local.pi.terminal)).toBe(false);
  expect((await f.terminal(remote.row.target.address)).state).toBe('live');
  await local.pi.close();
  const returning = await launchPaneOwner(f, 'local', await copySession(f, remote, 'local-resume'));
  await f.app('pane.focus', { pane: toRemote.slot!.pane });
  const toLocal = await ready(f, toRemote, returning.row.target);
  expect(toLocal.mode).toBe('native'); expect(toLocal.proxy).toBeNull();
  expect(await machineText(f, toLocal)).toBe('This computer');
  const localWorld = presentationRows(await f.app('ls', {}) as PresentationDocument);
  expect(localWorld.filter(row => row.terminal === returning.pi.terminal)).toEqual([{ ...toLocal.slot, terminal: returning.pi.terminal }]);
  expect(localWorld.some(row => row.terminal === toRemote.proxy)).toBe(false);
  await f.app('pane.focus', { pane: f.anchor.pane });
  const focus = await f.app('status', {}), before = await f.current(first.id);
  const deferred = await f.request({ version: 1, op: 'present-ready', operationId: randomUUID(), presentationId: before.id, expectedRevision: before.revision, target: remote.row.target });
  expect(deferred).toMatchObject({ kind: 'outcome', outcome: { status: 'pending', reason: 'waiting-focus-placeholder-unproved' } });
  const pending = await f.current(first.id);
  expect(pending.mode).toBe('native'); expect(pending.proxy).toBeNull(); expect(pending.target).toEqual(returning.row.target);
  expect(pending.conversion).toMatchObject({ state: 'waiting-focus', sourceFocused: false, destination: remote.row.target });
  expect(await f.app('status', {})).toEqual(focus);
  expect((await f.terminal(remote.row.target.address)).state).toBe('live');
  expect(identityAlive(returning.pi.identity)).toBe(true);
  expect((await f.state()).presentations.filter(row => row.id === first.id)).toHaveLength(1);
  const launches = (await suite.cores!.records()).filter(record => record.argv[0] === 'run' && record.argv.includes('panes'));
  expect(launches.every(record => !record.argv.includes(suite.pi.launcher))).toBe(true);
  await suite.evidence('B08-conversion.json', { first, toRemote, toLocal, pending, focus, nativeMovedPlaceholder: 'blocked: not implemented for 0.1.13', continuousPixels: 'blocked: owned native window required', ownership: 'source-owned synthetic sessions; this story does not perform roaming home CAS' });
  await unchanged(f); await f.evidence('B08-observations.json');
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: 'B06' as StoryId, title: 'remote view never becomes a hidden child process', tiers: ['headless', 'app'], run: viewer },
  { id: 'B07' as StoryId, title: 'read-only console reuses its identity and leaves jobs untouched', tiers: ['headless', 'app'], run: consoleView },
  { id: 'B08' as StoryId, title: 'move preserves Mac space tab and continuous visibility', tiers: ['headless', 'app'], run: handoff },
];
registerScenarios(scenarios);
