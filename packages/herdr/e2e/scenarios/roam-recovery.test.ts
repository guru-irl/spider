// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { appendFile, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { openDb } from '@spider/db-core';
import { recoverMirror } from '@spider/roam/mirrors';
import { readLocal } from '@spider/db-core/roam/local-state';
import { createHcClient } from '../../src/client/hc.js';
import type { AppClient, AppPaneInspection, OwnerPlacement, TerminalAddress } from '../../src/contracts.js';
import { paneAddress, parsePaneTarget, parsePaneTerminal } from '../../src/panes/codec.js';
import { convertNativePresentation, type PaneOpenPorts } from '../../src/panes/open.js';
import { confirmPresentationClose, parkPresentation } from '../../src/panes/lifecycle.js';
import { createPaneService } from '../../src/panes/service.js';
import { createPanePlacementStore } from '../../src/panes/store.js';
import { createRoamPresentationOperations } from '../../src/roam-placement.js';
import type { PaneTarget, PanePresentation } from '../../src/panes/types.js';
import { inspectIdLock } from '../../src/sessions/id-lock.js';
import { readObserved } from '../harness/pi.js';
import { runHc } from '../harness/hc.js';
import { assertSocketPath } from '../harness/environment.js';
import { deadline, waitFor } from '../harness/wait.js';
import { createSuite, type Suite } from '../harness/suite.js';
import type { ScenarioDefinition } from '../harness/scenario.js';
import { createMoveStory, assertMoveState, HUB, BOX, type MoveMachine } from './roam-move.test.js';

export interface StoryPresentation {
  socket: string; store: ReturnType<typeof createPanePlacementStore>; slot: OwnerPlacement;
  events: string[]; placements: Map<TerminalAddress, OwnerPlacement>;
  sourceFocused(value: boolean): void; park(): Promise<void>; prepare(machine: MoveMachine, epoch: number): Promise<void>;
  present(machine: MoveMachine, epoch: number): Promise<void>;
  staleClose(presentation: PanePresentation): Promise<unknown>; readyTarget(target: PaneTarget): Promise<unknown>;
  machineText(): Promise<string | null>; close(): Promise<void>;
}

/** Synthetic app placement, real terminal identity, and the same presentation service used by moves. */
export async function storyPresentation(suite: Suite, machines: readonly MoveMachine[], sessionId: string): Promise<StoryPresentation> {
  const [hub, box] = machines, cores = suite.cores!;
  const stateRoot = join(hub.root, 'roam', 'placement'), root = join(hub.root, 'herdr', 'panes');
  const store = createPanePlacementStore(stateRoot), hc = createHcClient({ binary: cores.wrapper, env: hub.env });
  const slot = { space: 'fixture-space', tab: 'fixture-tab', pane: 'fixture-pane' } as OwnerPlacement;
  const events: string[] = [], placements = new Map<TerminalAddress, OwnerPlacement>();
  const observedTargets = new Map<string, PaneTarget>();
  let focused = true, focusedSlot = slot;
  const actualTarget = async (machine: MoveMachine, epoch: number): Promise<PaneTarget> => {
    const lock = await inspectIdLock(join(machine.root, 'herdr'), sessionId);
    if (!lock || lock.pendingOperationId !== null) throw Error('presentation owner unavailable');
    const event = (await readObserved(suite.pi.observerDir, lock.identity.pid)).find(row => row.type === 'session_start' && row.sessionId === sessionId);
    if (!event || typeof event.hcTerminal !== 'string') throw Error('presentation terminal unavailable');
    const raw = await runHc(cores.wrapper, ['get', event.hcTerminal, '--json'], machine.env);
    expect(raw.exitCode, raw.stderr).toBe(0);
    const facts = parsePaneTerminal(raw.json);
    const feed = JSON.parse(await readFile(join(machine.root, 'herdr', 'sessions', sessionId, 'session.json'), 'utf8'));
    if (!feed.owner?.generation) throw Error('presentation generation unavailable');
    const coreId = machine.coreId;
    const db = openDb(join(hub.root, 'spider.db'));
    try { expect(db.prepare('SELECT machine_id,epoch FROM session_homes WHERE session_id=?').get(sessionId)).toEqual({ machine_id: machine.id, epoch }); }
    finally { db.close(); }
    const target = parsePaneTarget({ coreId, terminalId: event.hcTerminal, address: `${coreId}/${event.hcTerminal}`, createdMs: facts.createdMs,
      identityLabels: facts.identityLabels, alias: machine.id === HUB ? null : machine.alias, machineId: machine.id,
      kind: 'session', sessionId, generation: feed.owner.generation, homeEpoch: epoch, runId: null, consoleId: null, name: feed.owner.name ?? 'Move fixture', cwd: machine.cwd });
    observedTargets.set(target.terminalId, target);
    return target;
  };
  const app = {
    ownerPlacement: async (address: TerminalAddress) => { const placement = placements.get(address); if (!placement) throw Error('terminal is not presented'); return placement; },
    focusedPane: async () => focused ? focusedSlot : { ...slot, pane: 'another-pane' },
    tabTerminals: async () => [...placements.keys()],
    async command(name: string, args: Record<string, any>) {
      events.push(name);
      if (name === 'terminal.keep') { focusedSlot = { ...slot, pane: `pane-${events.length}` as never }; placements.set(args.terminal, focusedSlot); }
      if (name === 'terminal.park') placements.delete(args.terminal);
      return {};
    },
  } as unknown as AppClient & AppPaneInspection;
  const proxies = new Map<string, TerminalAddress>();
  const validateTarget: PaneOpenPorts['validateTarget'] = async target => {
    const machine = machines.find(row => row.id === target.machineId && target.coreId === row.coreId);
    if (!machine || machine.id !== target.machineId || (machine.id === HUB ? null : machine.alias) !== target.alias) throw Error('presentation machine changed');
    if (target.alias) {
      const reply = await suite.hc(['machine', 'ls', '--json']);
      const routes = (reply.json as { machines: Array<{ name: string; id: string }> }).machines.filter(row => row.name === target.alias);
      if (routes.length !== 1 || routes[0].id !== target.coreId) throw Error('presentation alias was reused');
    }
    const current = await actualTarget(machine, target.homeEpoch!);
    if (current.terminalId !== target.terminalId || current.createdMs !== target.createdMs || current.generation !== target.generation) throw Error('presentation incarnation changed');
    return current;
  };
  const open: PaneOpenPorts = {
    store, hc, app, placeholderMod: 'synthetic-waiting', validateTarget,
    launchTarget: async () => { throw Error('presentation must not launch an owner'); },
    async launchProxy(p) {
      // This owned terminal observes presentation identity, not native window pixels or attach rendering.
      const result = await suite.hc(['run', '--bg', '--no-notify', '--outlive-parent', '--json', '--label', 'spider.kind=pane-proxy',
        '--label', `spider.pane-id=${p.id}`, '--label', `spider.pane-operation=${p.id}`, '--label', `spider.target-core=${p.target.coreId}`,
        '--label', `spider.target-terminal=${p.target.terminalId}`, '--', '/bin/cat']);
      expect(result.exitCode, result.stderr).toBe(0);
      const address = (result.json as { address: TerminalAddress }).address;
      expect(address).toBeTruthy(); proxies.set(p.id, address); events.push('proxy-created');
      suite.ledger.update(ledger => { ledger.terminals.push({ side: 'local', address }); });
      return address;
    },
    findProxy: async p => proxies.get(p.id) ?? null, findTargetLaunch: async () => null, agentArgv: async () => [],
    readNativeTarget: async address => {
      const target = observedTargets.get(address.split('/').at(-1)!);
      if (!target) throw Error('native target was never captured');
      const raw = await suite.hc(['get', address, '--json']);
      expect(raw.exitCode, raw.stderr).toBe(0);
      const current = parsePaneTerminal(raw.json);
      expect(current.createdMs).toBe(target.createdMs);
      return { ...target, identityLabels: current.identityLabels, kind: 'terminal', sessionId: null, generation: null, homeEpoch: null };
    },
    appCapabilities: async () => ({ backgroundTabCreation: false, explicitTargetSwap: false, noFocusConversion: false, commandDigest: 'a'.repeat(64) }),
    verifyPlaceholder: async () => false, findPlaceholder: async () => null, deferSourceView: async () => false,
    async awaitPresented(address, target, expected) {
      expect((await hc.get(address)).state).toBe('live');
      const machine = machines.find(row => row.id === target.machineId)!;
      const screen = await runHc(cores.wrapper, ['read', target.terminalId, '--lines', '20', '--json'], machine.env);
      expect(screen.exitCode, screen.stderr).toBe(0);
      const placed = await app.ownerPlacement(address);
      expect({ space: placed.space, tab: placed.tab }).toEqual({ space: expected.space, tab: expected.tab });
      events.push('destination-observed'); return placed;
    },
  };
  const captured = new Map<string, { source: OwnerPlacement | null; sourceFocused: boolean }>();
  const service = createPaneService({ root, store, hc, app, coreAvailable: async () => true, clock: Date.now,
    machines: async () => [], inventory: async () => ({ version: 1, rows: [], complete: true, next: null }), targetFacts: async () => ({}),
    renewLeases: async () => {}, appCapabilities: open.appCapabilities, subscribe: () => () => {}, schedule: () => () => {}, validateTarget,
    closeSession: async () => { throw Error('stale close must not reach an owner'); },
    async dispatch(request) {
      const p = 'presentationId' in request ? (await store.read()).presentations.find(row => row.id === request.presentationId) : null;
      if (!p) throw Error('presentation missing');
      if (request.op === 'prepare-handoff') {
        captured.set(p.id, { source: p.slot as OwnerPlacement, sourceFocused: focused }); events.push('source-captured');
        return { status: 'complete', reason: 'handoff-prepared', presentation: p };
      }
      if (request.op === 'present-ready') return convertNativePresentation({ presentation: p, destination: request.target, source: p.conversion?.source ?? p.slot as OwnerPlacement, sourceFocused: focused }, open);
      throw Error('unexpected presentation action');
    },
  });
  const operations = createRoamPresentationOperations({ stateRoot, hc, app, request: request => service.request(request) });
  const prepare = async (machine: MoveMachine, epoch: number) => {
    const target = await actualTarget(machine, epoch);
    if (!(await store.read()).presentations.length) placements.set(paneAddress(target.terminalId), slot);
    expect(await operations.prepareHandoff(target.sessionId!, target)).toMatchObject({ status: 'complete' });
  };
  const present = async (machine: MoveMachine, epoch: number) => {
    const outcome = await operations.presentReadyTarget(await actualTarget(machine, epoch));
    expect(outcome).toMatchObject({ status: 'complete' });
  };
  const socket = assertSocketPath(suite.root, join(suite.root, 'p.s'));
  const server = createServer(connection => {
    let buffer = '';
    connection.on('error', () => {});
    connection.on('data', data => {
      buffer += data.toString('utf8'); const newline = buffer.indexOf('\n'); if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      void (async () => {
        const machine = machines.find(row => row.id === request.home.machineId);
        if (!machine || request.home.sessionId !== sessionId) throw Error('unknown presentation owner');
        const target = await actualTarget(machine, request.home.epoch ?? request.home.homeEpoch);
        if (request.action === 'prepare') {
          if (!(await store.read()).presentations.length) placements.set(paneAddress(target.terminalId), slot);
          const presentation = await operations.prepareHandoff(target.sessionId!, target);
          return { capture: 'durable', presentation };
        }
        if (request.action === 'present') return operations.presentReadyTarget(target);
        throw Error('unknown presentation operation');
      })().then(value => connection.end(JSON.stringify({ value }) + '\n'), error => connection.end(JSON.stringify({ error: String(error.stack ?? error) }) + '\n'));
    });
  });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  const machineText = async () => {
    const presentations = (await store.read()).presentations, p = presentations[0];
    const address = p?.mode === 'proxy' ? p.proxy : p?.target.terminalId;
    if (!address) return null;
    const header = { address, programIsAgent: p.mode === 'native', labels: (await hc.get(address as TerminalAddress)).labels };
    const code = (await readFile(new URL('../../assets/pane/machine.js', import.meta.url), 'utf8')).replace(/^import .*;\s*$/gm, '').replace(/export /g, '');
    const paneMachineFact = new Function(`${code}; return paneMachineFact;`)() as (header: object, presentations: PanePresentation[]) => { label: string } | null;
    return paneMachineFact(header, presentations)?.label ?? null;
  };
  return { socket, store, slot, events, placements, prepare, present, machineText, readyTarget: target => operations.presentReadyTarget(target), sourceFocused: value => { focused = value; },
    async park() {
      await waitFor('owned proxy is removed when parked', async () => {
        const p = (await store.read()).presentations[0];
        return parkPresentation(p.id, p.revision, { store, hc, app, validateTarget,
          closeSession: async () => { throw Error('parking cannot stop an owner'); } });
      }, outcome => outcome.status === 'complete', deadline(30_000));
      expect(placements.size).toBe(0);
    },
    staleClose: p => confirmPresentationClose({ id: p.id, expectedRevision: p.revision, target: p.target, operationId: randomUUID() }, { store, hc, app, validateTarget, closeSession: async () => { throw Error('stale close reached restored owner'); } }),
    async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await service.stop(); await hc.dispose(); },
  };
}

export const recoveryCaseNames = [
  'revoked home restores mirrored prefix',
  'restored home retains Mac slot and visible intent',
  'parked revoked home remains parked',
  'reused alias cannot capture a presentation or close its restored target',
] as const;

export async function runRecoveryCases(suite: Suite): Promise<void> {
  for (const parked of [false, true]) {
    const owned = await createSuite({ tier: 'headless', story: suite.story });
    const started = Date.now();
    let f: Awaited<ReturnType<typeof createMoveStory>> | undefined;
    try {
      f = await createMoveStory(owned);
      const [hub, box] = f.machines;
      const expectedTrees = await f.trees(hub.cwd);
      expect(await f.moveTo(hub, box.alias)).toMatchObject({ code: 0 });
      const remote = await assertMoveState(f, box, expectedTrees, 2);
      await f.sync();
      const mirror = await recoverMirror({ root: join(hub.root, 'roam', 'mirrors'), machineId: BOX, sessionId: f.sessionId, epoch: 2 });
      const prefix = await readFile(mirror.file);
      const digest = createHash('sha256').update(prefix).digest('hex');
      await writeFile(f.faults, JSON.stringify({ drop: [], offline: BOX }));
      const last = JSON.parse((await readFile(remote.file, 'utf8')).trimEnd().split('\n').at(-1)!);
      await appendFile(remote.file, JSON.stringify({ type: 'message', id: 'unsent-after-mirror', parentId: last.id,
        timestamp: '2026-01-03T00:00:00Z', message: { role: 'user', content: 'not sent to the hub', timestamp: 3 } }) + '\n');
      expect((await readFile(remote.file, 'utf8'))).toContain('unsent-after-mirror');
      expect(prefix.toString('utf8')).not.toContain('unsent-after-mirror');
      if (parked) await f.presentation.park();
      const captured = (await f.presentation.store.read()).presentations[0];
      const presentationEvents = f.presentation.events.length;
      await f.stopBox();
      expect((await owned.hc(['kill', remote.terminal, '--json'], 'dest')).exitCode).toBe(0);
      await waitFor('destroyed fixture owner exits', () => f!.owners(), rows => !rows.some(row => row.pid === remote.pid), deadline(30_000));
      const restored = await f.cli(hub, ['roam', 'forget', box.alias, '--confirm', `destroyed ${BOX}`]);
      expect(restored).toMatchObject({ code: 0, reason: 'destroyed-machine-recovered' });
      const local = await assertMoveState(f, hub, expectedTrees, 3);
      const bytes = await readFile(local.file, 'utf8'), entries = bytes.trimEnd().split('\n').map(line => JSON.parse(line));
      expect(bytes).not.toContain('unsent-after-mirror');
      const marker = entries.findIndex(row => row.customType === 'spider-roam-segment' && row.data.epoch === 3);
      const actualPrefix = Buffer.from(bytes.trimEnd().split('\n').slice(1, marker).join('\n') + '\n');
      expect(createHash('sha256').update(actualPrefix).digest('hex'), recoveryCaseNames[0]).toBe(mirror.historySha256);
      expect(createHash('sha256').update(await readFile(mirror.file)).digest('hex')).toBe(digest);
      const presentation = (await f.presentation.store.read()).presentations[0];
      expect(presentation, recoveryCaseNames[parked ? 2 : 1]).toMatchObject({ slot: { space: f.presentation.slot.space, tab: f.presentation.slot.tab }, mode: 'native', proxy: null,
        visibility: parked ? 'parked' : 'visible', target: { sessionId: f.sessionId, homeEpoch: 3, terminalId: local.terminal } });
      expect(f.presentation.placements.size).toBe(parked ? 0 : 1);
      expect(f.presentation.events.slice(presentationEvents).filter(event => event === 'terminal.keep')).toHaveLength(parked ? 0 : 1);
      expect(await f.presentation.staleClose(captured)).toMatchObject({ status: 'refused', reason: 'Session changed. Close again.' });
      expect((await f.owners()).map(owner => owner.pid)).toEqual([local.pid]);
      const db = openDb(join(hub.root, 'roam', 'journal.db'));
      try { expect(db.prepare('SELECT machine_id FROM roam_machine_revocations WHERE machine_id=?').get(BOX)).toEqual({ machine_id: BOX }); }
      finally { db.close(); }
      await writeFile(f.faults, JSON.stringify({ drop: [] }));
      const reconnect = await f.cli(hub, ['roam', 'sync', BOX]);
      expect(reconnect.code).not.toBe(0);
      const boxDb = openDb(join(box.root, 'spider.db'));
      try { expect(readLocal(boxDb, 'supervisor-revoked', BOX)).toBe(true); }
      finally { boxDb.close(); }
      expect((await owned.hc(['machine', 'rm', box.alias, '--json'])).exitCode).toBe(0);
      expect((await owned.hc(['machine', 'add', '--via', join(owned.root, 'bin', 'via-i1'), '--name', box.alias,
        '--session', owned.cores!.local.namespace, '--json'])).exitCode).toBe(0);
      const reused = await owned.hc(['machine', 'ls', '--json']);
      expect((reused.json as { machines: Array<{ name: string; id: string }> }).machines.find(row => row.name === box.alias)?.id).toBe(owned.cores!.local.coreId);
      const rejected = await f.presentation.readyTarget(captured.target) as { status: string };
      expect(rejected.status, recoveryCaseNames[3]).not.toBe('complete');
      expect(await f.presentation.staleClose(captured), recoveryCaseNames[3]).toMatchObject({ status: 'refused', reason: 'Session changed. Close again.' });
      expect((await f.presentation.store.read()).presentations[0]).toEqual(presentation);
      expect((await f.owners()).map(owner => owner.pid)).toEqual([local.pid]);
      await suite.evidence(`R09-${parked ? 'parked' : 'visible'}-restore.json`, { cases: [recoveryCaseNames[0], recoveryCaseNames[parked ? 2 : 1], recoveryCaseNames[3]], restored, presentation, local, reconnect, digest,
        blockedObservations: ['native window appearance requires the app'] });
    } finally {
      try { await f?.close(); } finally {
        const cleanup = await owned.close();
        await suite.evidence(`R09-${parked ? 'parked' : 'visible'}-cleanup.json`, { cleanup, durationMs: Date.now() - started, evidence: owned.evidenceDirectory });
      }
    }
  }
}

// R09 invokes these cases after its existing mirror-and-retire assertions.
export const scenarios: readonly ScenarioDefinition[] = [];
