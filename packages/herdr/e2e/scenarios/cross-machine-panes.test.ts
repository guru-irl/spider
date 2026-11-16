// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerScenarios, type ScenarioDefinition, type StoryId } from '../harness/scenario.js';
import { deadline, waitFor } from '../harness/wait.js';
import type { Suite } from '../harness/suite.js';
import { identityOf, identityAlive } from '../harness/resources.js';
import { preparePanePresentations, presentationRows, mountPanePicker, launchPaneOwner, stopPaneHelper, paneProcesses, paneActionFunctions, paneHeaderFunctions, paneNavigation, replaceAliasWithDecoy, targetFacts, stableTerminal, type PaneFixture, type PresentationDocument } from '../fixtures/pane-presentations.js';
import type { PaneOpenIntent, PanePresentation, PaneServiceRequest } from '../../src/panes/types.js';

async function observed(f: PaneFixture, p: PanePresentation): Promise<void> {
  const target = await f.terminal(p.target.address), layout = presentationRows(await f.app('ls', {}) as PresentationDocument);
  expect(target.state).toBe('live');
  expect(target.created_ms).toBe(p.target.createdMs);
  expect(target.labels['spider.pane-operation']).toBeTruthy();
  expect(p.target.coreId).toBe(f.suite.cores!.dest.coreId);
  expect(p.mode).toBe('proxy');
  expect(p.proxy).not.toContain('/');
  expect(layout.filter(row => row.terminal === p.proxy)).toEqual([{ ...p.slot, terminal: p.proxy }]);
  expect(layout.some(row => row.terminal === p.target.address)).toBe(false);
  const state = await f.state();
  expect(state.presentations.filter(row => row.target.coreId === p.target.coreId && row.target.terminalId === p.target.terminalId)).toHaveLength(1);
  expect(state.launches.filter(row => row.target?.terminalId === p.target.terminalId)).toHaveLength(1);
  const proxy = await f.terminal(p.proxy!);
  expect(proxy.state).toBe('live');
  expect(proxy.labels).toMatchObject({ 'spider.kind': 'pane-proxy', 'spider.pane-id': p.id, 'spider.target-core': f.suite.cores!.dest.coreId, 'spider.target-terminal': p.target.terminalId });
  expect(JSON.stringify(proxy.argv)).toContain(f.cli);
  const unrelated = await f.assertUnrelated(); expect(unrelated.after).toEqual(unrelated.before);
}
async function mutate(f: PaneFixture, p: PanePresentation, operation: 'park' | 'open-existing' | 'close-confirmed') {
  const current = await f.current(p.id);
  const base = { version: 1 as const, op: operation, operationId: randomUUID(), presentationId: p.id, expectedRevision: current.revision };
  const request = operation === 'close-confirmed' ? { ...base, op: operation, target: current.target } : operation === 'open-existing'
    ? { ...base, op: operation, targetIncarnation: { coreId: current.target.coreId, terminalId: current.target.terminalId, createdMs: current.target.createdMs } }
    : { ...base, op: operation };
  return f.request(request as PaneServiceRequest);
}

async function picker(suite: Suite): Promise<void> {
  const f = await preparePanePresentations(suite, { disconnectedChoice: true });
  const snapshot = await f.snapshot(), local = snapshot.machines.find(row => row.alias === null)!;
  expect(local).toMatchObject({ key: suite.cores!.local.coreId, label: 'This computer', state: 'connected' });
  expect(snapshot.machines.find(row => row.key === 'box-2.invalid')).toMatchObject({ state: 'disconnected', coreId: null });
  const actions = await import(/* @vite-ignore */ pathToFileURL(join(f.packageRoot, 'packages/herdr/assets/machines/actions.js')).href);
  for (const [route, place, method] of [['tab-plus', 'tab', 'keyboard'], ['split-right', 'right', 'mouse'], ['split-down', 'down', 'keyboard'], ['go-to-new-terminal', 'tab', 'mouse']] as const) {
    await f.app('pane.focus', { pane: f.anchor.pane });
    const world = await f.app('ls', {}) as PresentationDocument, captured: any[] = [];
    const input = { place, program: { kind: 'shell' }, ...(route === 'go-to-new-terminal' ? {} : { space: f.anchor.space, pane: f.anchor.pane }) };
    actions.openPickerFromHost(input, { focused: () => ({ ...f.anchor }), panes: () => presentationRows(world), spaces: () => world.spaces, openOverlay: (overlay: any) => captured.push(overlay), notify: (notice: any) => { throw new Error(notice.title); } });
    expect(captured).toHaveLength(1); expect(captured[0].mod).toBe('spider-machine-picker');
    const intent = captured[0].props.intent as PaneOpenIntent, operationId = intent.operationId;
    expect(intent).toMatchObject({ space: f.anchor.space, place, anchor: f.anchor, program: { kind: 'shell' } });
    input.program.kind = 'changed-after-capture';
    expect(intent.program).toEqual({ kind: 'shell' });
    const ui = await mountPanePicker(f, intent, null);
    expect(ui.view.selectedKey).toBe(local.key);
    expect(ui.text()).toContain('This computer');
    expect(ui.text()).toContain('Unreachable');
    expect(ui.control('machine-box-2.invalid').events.on_click).toBeUndefined();
    const before = (await f.state()).launches.length;
    await ui.view.activate('box-2.invalid');
    expect((await f.state()).launches).toHaveLength(before);
    await ui.select(suite.cores!.machine, method);
    const p = await waitFor('chosen-machine operation acknowledges its presentation', async () => (await f.state()).presentations.find(row => row.id === `pane-${operationId}`), row => Boolean(row?.launch === 'acknowledged' && row.visibility === 'visible' && row.slot?.pane), deadline(20000));
    expect(p).toBeDefined(); if (!p) throw new Error('chosen-machine presentation missing');
    await observed(f, p);
    expect(targetFacts(await f.terminal(p.target.address)).currentCwd).toBe(f.remoteEnv.HOME);
    const defaultUi = await mountPanePicker(f, { ...intent, operationId: randomUUID() }, null);
    expect(defaultUi.view.selectedKey).toBe(suite.cores!.machine);
    await defaultUi.view.close();
  }
  const menuIntent: PaneOpenIntent = { operationId: randomUUID(), space: f.anchor.space, place: 'tab', anchor: null, program: { kind: 'shell' } };
  const menu = await mountPanePicker(f, menuIntent, suite.cores!.machine, 'menu');
  const before = (await f.state()).launches.length;
  await menu.select(suite.cores!.machine, 'mouse');
  expect((await f.state()).launches).toHaveLength(before);
  expect(menu.overlays).toHaveLength(1);
  expect(menu.overlays[0].mod).toBe('spider-new-menu');
  await actions.chooseMenuProgram(menu.overlays[0].props.machineTicket, { kind: 'agent', key: 'pi' }, f.anchor.space, menu.host);
  expect(menu.notices).toEqual([]);
  const agent = await waitFor('menu operation acknowledges its agent presentation', async () => (await f.state()).presentations.find(row => row.id === `pane-${menuIntent.operationId}`), row => Boolean(row?.launch === 'acknowledged' && row.visibility === 'visible' && row.slot?.pane), deadline(20000));
  if (!agent) throw new Error('agent presentation missing');
  expect(agent.role).toBe('agent'); await observed(f, agent);
  const once = (await f.state()).launches.length;
  await actions.chooseMenuProgram(menu.overlays[0].props.machineTicket, { kind: 'agent', key: 'pi' }, f.anchor.space, menu.host);
  expect((await f.state()).launches).toHaveLength(once);
  expect(menu.notices).toContain('Machine selection expired');
  await suite.evidence('B01-coverage.json', { handlers: ['tab-plus', 'split-right', 'split-down', 'go-to-new-terminal', 'tab-plus-menu', 'new-agent'], input: 'strict widget events and packed CLI', nativeShortcutTranslation: 'blocked: owned native input unavailable', disabled: 'box-2.invalid' });
  await f.evidence('B01-observations.json');
}

async function shell(suite: Suite): Promise<void> {
  const f = await preparePanePresentations(suite), p = await f.open();
  await observed(f, p);
  expect(targetFacts(await f.terminal(p.target.address)).currentCwd).toBe(f.remoteEnv.HOME);
  const cwd = join(suite.root, 'remote-work'); await mkdir(cwd, { mode: 0o700 });
  await f.send(p.proxy!, `cd '${cwd}'; printf '\\nB02-input-café-✓\\n'`);
  await waitFor('remote shell receives proxy input', () => f.screen(p.target.address), text => text.includes('B02-input-café-✓'), deadline(5000));
  await waitFor('remote foreground cwd changes', async () => targetFacts(await f.terminal(p.target.address)).currentCwd, value => value === cwd, deadline(5000));
  const shown = await waitFor('proxy displays remote output', () => f.screen(p.proxy!), text => text.includes('B02-input-café-✓'), deadline(5000));
  expect(shown).toContain('B02-input-café-✓');
  const next = await f.open();
  expect(targetFacts(await f.terminal(next.target.address)).currentCwd).toBe(cwd);
  expect((await f.state()).launches.find(row => row.target?.terminalId === next.target.terminalId)?.folder).toEqual({ cwd, reason: 'focused' });
  await observed(f, next);
  await f.send(next.proxy!, "printf '\\nB02-paste-one\\nB02-paste-two\\n'");
  const pasted = await waitFor('multiline text crosses the proxy', () => f.screen(next.target.address), text => text.includes('B02-paste-two'), deadline(5000));
  expect(pasted).toContain('B02-paste-one');
  const records = await suite.cores!.records();
  const attaches = records.filter(record => record.argv[0] === 'attach');
  expect(attaches.some(record => record.argv.join(' ') === `attach --history 100 ${p.target.coreId}/${p.target.terminalId}`)).toBe(true);
  const target = await f.terminal(p.target.address), proxy = await f.terminal(p.proxy!);
  const headers = await paneHeaderFunctions(f.packageRoot), facts = targetFacts(target);
  expect(headers.resolvePaneHeaderFacts({ address: p.proxy, labels: proxy.labels, programIsAgent: false, nativeTitle: 'Local proxy', nativeStatus: null, nativeCwd: '/wrong-local-folder' }, [p], { [p.target.address]: facts })).toMatchObject({ name: facts.title || 'Terminal', cwd, machine: { label: suite.cores!.machine, known: true } });
  expect({ cols: proxy.cols, rows: proxy.rows }).toEqual({ cols: target.cols, rows: target.rows });
  expect(target.cols).toBeGreaterThanOrEqual(60); expect(target.rows).toBeGreaterThanOrEqual(8);
  await suite.evidence('B02-coverage.json', { cwd, initialHistory: 'attach --history 100', text: 'UTF-8 input and multiline output observed on the execution core', nativeClipboardAndMouseSelection: 'blocked: owned native input unavailable', interactiveResize: 'blocked: no fixture resize API' });
  await f.evidence('B02-observations.json');
}

async function lifecycle(suite: Suite): Promise<void> {
  const f = await preparePanePresentations(suite), p = await f.open(), raw = await f.terminal(p.target.address), before = stableTerminal(raw), targetIdentity = identityOf(raw.pid);
  const actions = await paneActionFunctions(f.packageRoot);
  const current = await f.current(p.id), header = await f.terminal(p.proxy!), shared = new Map<string, unknown>(), overlays: any[] = [], replies: unknown[] = [];
  let operation = 'b03cancel';
  const ports = { shared: (key: string) => shared.get(key), setShared: (key: string, value: unknown) => shared.set(key, value),
    operationId: () => operation, now: Date.now, openConfirm: (value: unknown) => { overlays.push(value); }, notify: (message: string) => { throw new Error(message); },
    resolveTarget: async () => (await f.current(p.id)).target, request: async (value: PaneServiceRequest) => { const reply = await f.request(value); replies.push(reply); return reply; }, nativeClose() { throw new Error('proxy routed to native close'); }, nativePark() { throw new Error('proxy routed to native park'); } };
  await actions.handlePaneCommand('close', { pane: current.slot, header: { address: current.proxy, labels: header.labels }, presentation: current }, ports);
  expect(overlays).toHaveLength(1);
  expect(overlays[0].props.command.name).toBe('spider-pane.confirm-b03cancel');
  expect((await f.current(p.id)).visibility).toBe('visible');
  expect(stableTerminal(await f.terminal(p.target.address))).toEqual(before);
  // Cancelling leaves the confirmation callback uncalled.
  const parked = await mutate(f, p, 'park');
  expect(parked).toMatchObject({ kind: 'outcome', outcome: { status: 'complete', reason: 'parked' } });
  expect((await f.terminal(p.target.address)).state).toBe('live');
  expect(presentationRows(await f.app('ls', {}) as PresentationDocument).some(row => row.terminal === p.proxy)).toBe(false);
  const reopened = await mutate(f, p, 'open-existing');
  expect(reopened).toMatchObject({ kind: 'outcome', outcome: { status: 'complete' } });
  const again = await f.current(p.id);
  expect(again.target).toEqual(current.target);
  expect(stableTerminal(await f.terminal(p.target.address))).toEqual(before);
  await observed(f, again);
  operation = 'b03confirmed';
  const reopenedHeader = await f.terminal(again.proxy!);
  await actions.handlePaneCommand('close', { pane: again.slot, header: { address: again.proxy, labels: reopenedHeader.labels }, presentation: again }, ports);
  expect(overlays.at(-1).props.command.name).toBe('spider-pane.confirm-b03confirmed');
  await actions.handlePaneCommand('confirm-b03confirmed', null, ports);
  expect(replies.at(-1)).toMatchObject({ kind: 'outcome', outcome: { status: 'complete', reason: 'target-ended' } });
  const removed = await suite.hc(['get', p.target.address, '--json']);
  expect(removed.exitCode).not.toBe(0);
  expect(removed.json).toMatchObject({ error: { kind: 'not_found' } });
  expect(identityAlive(targetIdentity)).toBe(false);
  for (const reason of ['tab', 'space', 'proxy-crash'] as const) {
    const live = await f.open(), identity = stableTerminal(await f.terminal(live.target.address));
    if (reason === 'tab') await f.app('tab.close', { id: live.slot!.tab, confirmed: true });
    else if (reason === 'space') {
      const created = await f.app('space.new', { name: 'Disposable', argv: ['/bin/cat'] });
      const moved = await f.request({ version: 1, op: 'move', operationId: randomUUID(), presentationId: live.id, expectedRevision: (await f.current(live.id)).revision, slot: { space: created.space, tab: created.tab, pane: created.pane } });
      expect(moved).toMatchObject({ kind: 'outcome', outcome: { status: 'complete' } });
      await f.app('space.close', { id: created.space, confirmed: true });
    } else expect((await suite.hc(['kill', live.proxy!, '--json'])).exitCode).toBe(0);
    await waitFor('unexplained display exit parks the live target', async () => { await f.snapshot(); return f.current(live.id); }, row => row.visibility === 'parked', deadline(20000));
    expect(stableTerminal(await f.terminal(live.target.address))).toEqual(identity);
    const saved = await f.current(live.id);
    expect(await f.request({ version: 1, op: 'move', operationId: randomUUID(), presentationId: saved.id, expectedRevision: saved.revision, slot: f.anchor })).toMatchObject({ kind: 'outcome', outcome: { status: 'complete' } });
  }
  await suite.evidence('B03-native.json', { localPiConfirmation: 'blocked: requires the isolated native close checklist' });
  const unrelated = await f.assertUnrelated(); expect(unrelated.after).toEqual(unrelated.before);
  await f.evidence('B03-observations.json');
}

async function reconnect(suite: Suite): Promise<void> {
  const f = await preparePanePresentations(suite), p = await f.open(), target = stableTerminal(await f.terminal(p.target.address));
  const proxy = await f.terminal(p.proxy!), beforeProcesses = await paneProcesses(f);
  await f.send(p.proxy!, "printf '\\nB04-connected\\n'");
  await waitFor('connected input reaches target', () => f.screen(p.target.address), text => text.includes('B04-connected'), deadline(5000));
  await f.send(p.target.terminalId, "printf '\\033[?1049h\\033[2J\\033[H%s-%s\\n' B04-alternate screen", 'dest');
  await waitFor('proxy displays the remote alternate screen', () => f.screen(p.proxy!), text => text.includes('B04-alternate-screen'), deadline(5000));
  await writeFile(f.faultFile, JSON.stringify({ disconnected: true }), { mode: 0o600 });
  await waitFor('stream loss displays reconnect status', () => f.screen(p.proxy!), text => /reconnect|unavailable|connection/i.test(text), deadline(5000));
  expect(await f.screen(p.proxy!)).not.toContain('B04-alternate-screen');
  expect(await f.screen(p.target.terminalId, 'dest')).toContain('B04-alternate-screen');
  const downAt = Date.now();
  await f.send(p.proxy!, "printf '\\nB04-must-not-replay\\n'");
  const whileDown = await f.screen(p.target.terminalId, 'dest');
  expect(whileDown).not.toContain('B04-must-not-replay');
  await waitFor('bounded disconnected observation interval', async () => Date.now(), value => value - downAt >= 2200, deadline(5000));
  const attempts = (await readFile(join(suite.root, 'pane-hc.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { at: number; argv: string[] });
  const probes = attempts.filter(row => row.at >= downAt && row.argv[0] === 'get' && row.argv.includes(p.target.address));
  expect(probes.length).toBeGreaterThan(0);
  expect(probes.length).toBeLessThanOrEqual(5);
  expect(stableTerminal(await f.terminal(p.target.terminalId, 'dest'))).toEqual({ ...target, address: p.target.terminalId });
  expect((await f.current(p.id)).visibility).toBe('visible');
  await writeFile(f.faultFile, JSON.stringify({ disconnected: false }), { mode: 0o600 });
  await f.send(p.target.terminalId, "printf '\\nB04-restored\\n'", 'dest');
  await waitFor('same proxy reconnects to target output', () => f.screen(p.proxy!), text => text.includes('B04-restored'), deadline(15000));
  await f.send(p.proxy!, "printf '\\nB04-after-reconnect\\n'");
  const screen = await waitFor('input opens after verified reconnect', () => f.screen(p.target.address), text => text.includes('B04-after-reconnect'), deadline(5000));
  expect(screen).not.toContain('B04-must-not-replay');
  expect((await f.terminal(p.proxy!)).pid).toBe(proxy.pid);
  expect((await f.terminal(p.target.address)).pid).toBe(target.pid);
  const attaches = (await suite.cores!.records()).filter(row => row.argv[0] === 'attach');
  expect(attaches.length).toBeGreaterThanOrEqual(2);
  expect(attaches.every(row => row.argv.at(-1) === p.target.address)).toBe(true);
  const aliasAt = Date.now();
  await writeFile(f.faultFile, JSON.stringify({ disconnected: true }), { mode: 0o600 });
  await waitFor('second stream failure reaches a fenced probe', async () => (await readFile(join(suite.root, 'pane-hc.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { at: number; argv: string[] }), rows => rows.some(row => row.at >= aliasAt && row.argv[0] === 'get' && row.argv.includes(p.target.address)), deadline(10000));
  const decoy = await replaceAliasWithDecoy(f);
  expect(decoy.terminal).toBe(p.target.terminalId); expect(decoy.coreId).not.toBe(p.target.coreId);
  await writeFile(f.faultFile, JSON.stringify({ disconnected: false }), { mode: 0o600 });
  await f.send(p.proxy!, 'B04-alias-input-must-be-discarded');
  const reusedAt = Date.now();
  await waitFor('reused alias stays fenced across retries', async () => Date.now(), value => value - reusedAt >= 2200, deadline(5000));
  expect(await decoy.screen()).not.toContain('B04-alias-input-must-be-discarded');
  expect(await f.screen(p.target.terminalId, 'dest')).not.toContain('B04-alias-input-must-be-discarded');
  expect((await f.terminal(p.target.terminalId, 'dest')).state).toBe('live');
  expect((await f.terminal(p.proxy!)).pid).toBe(proxy.pid);
  expect((await suite.cores!.records()).filter(row => row.argv[0] === 'attach').every(row => row.argv.at(-1) === p.target.address)).toBe(true);
  const afterProcesses = await paneProcesses(f);
  await suite.evidence('B04-processes.json', { before: beforeProcesses, after: afterProcesses, probes, intervalMs: reusedAt - downAt, aliasReuse: { coreId: decoy.coreId, sameTerminalId: decoy.terminal }, limits: 'CPU recorded, no speed claim; alternate-screen reset observed; mouse and bracketed-paste mode bytes require isolated TTY observations' });
  const unrelated = await f.assertUnrelated(); expect(unrelated.after).toEqual(unrelated.before);
  await f.evidence('B04-observations.json');
}

async function manual(suite: Suite): Promise<void> {
  const f = await preparePanePresentations(suite), owner = await launchPaneOwner(f, 'dest');
  await owner.pi.prompt('/name Hand started');
  const row = await waitFor('named hand-started remote row', () => f.snapshot(), value => value.rows.some(row => row.sessionId === owner.row.sessionId && row.name === 'Hand started'), deadline(20000));
  expect(row.rows.filter(row => row.sessionId === owner.row.sessionId)).toHaveLength(1);
  const unplaced = await f.request({ version: 1, op: 'open-existing', operationId: randomUUID(), sessionId: owner.row.sessionId, generation: owner.row.generation, slot: null });
  expect(unplaced).toMatchObject({ kind: 'outcome', outcome: { status: 'pending', reason: 'no-placement-choice' } });
  const before = stableTerminal(await f.terminal(owner.row.target.address));
  const actions = await import(/* @vite-ignore */ pathToFileURL(join(f.packageRoot, 'packages/herdr/assets/agents/move.js')).href);
  const values = new Map<string, unknown>(), requests: PaneServiceRequest[] = [];
  const ports: any = { spaces: (await f.app('ls', {})).spaces, shared: (key: string) => values.get(key), setShared: (key: string, value: unknown) => values.set(key, value),
    pane: async (value: any) => { const request = { ...value, version: 1, operationId: randomUUID() } as PaneServiceRequest; requests.push(request); const result = await f.request(request); if (result.kind !== 'outcome') throw new Error('expected placement outcome'); return result.outcome; },
    createTab: async (space: string) => { const tab = await f.app('tab.new', { space, mod: 'spider-pane-waiting', props: { operationId: 'manual-tab' } }); return { space, tab: tab.tab, pane: tab.pane }; },
    removePlaceholder: async (slot: any) => f.app('pane.close', { pane: slot.pane }),
    movePlain: () => { throw new Error('remote execution terminal cannot be moved'); }, ipc: () => { throw new Error('presentation must use the packed pane service'); } };
  const target = () => paneNavigation(f).then(rows => rows.find(row => row.sessionId === owner.row.sessionId && row.kind === 'agent'));
  const initial = await target(); expect(initial).toMatchObject({ name: 'Hand started', disabledReason: undefined, action: { kind: 'pane' } });
  expect(await actions.moveTarget({ kind: 'session', pane: false, navigation: initial }, { kind: 'tab', tab: f.anchor.tab }, ports)).toMatchObject({ status: 'complete' });
  const first = (await f.state()).presentations.find(row => row.target.sessionId === owner.row.sessionId)!;
  expect(first.target).toEqual(owner.row.target); expect(first.proxy).not.toContain('/');
  const placed = await target();
  expect(await actions.moveTarget({ kind: 'session', pane: true, navigation: placed }, { kind: 'new', space: f.anchor.space }, ports)).toMatchObject({ status: 'complete' });
  const newTab = (await f.current(first.id)).slot!.tab;
  expect(newTab).not.toBe(f.anchor.tab);
  const afterNew = (await f.state()).choices.find(row => row.session === owner.row.sessionId);
  expect(afterNew).toMatchObject({ space: f.anchor.space, tab: newTab });
  expect(actions.beginPresentationDrag(await target(), ports)).toBe(true);
  expect(await actions.dropPresentation(f.anchor, ports)).toBe(true);
  expect(await actions.dropPresentation(f.anchor, ports)).toBe(false);
  const choice = (await f.state()).choices.find(row => row.session === owner.row.sessionId);
  expect(choice).toMatchObject({ space: f.anchor.space, tab: f.anchor.tab });
  const proxy = (await f.current(first.id)).proxy;
  expect(requests.map(request => request.op)).toEqual(['open-existing', 'move', 'move']);
  expect(requests.slice(1).every(request => 'presentationId' in request && request.presentationId === first.id)).toBe(true);
  await stopPaneHelper(f); await f.snapshot();
  const restored = await waitFor('manual destination survives service restart', () => f.snapshot(), value => value.presentations.some(row => row.id === first.id && row.slot?.tab === f.anchor.tab), deadline(10000));
  const p = restored.presentations.find(row => row.id === first.id)!;
  expect(p.target).toEqual(owner.row.target); expect(p.proxy).toBe(proxy);
  expect((await f.state()).choices.find(row => row.session === owner.row.sessionId)).toEqual(choice);
  expect(stableTerminal(await f.terminal(owner.row.target.address))).toEqual(before);
  expect(presentationRows(await f.app('ls', {}) as PresentationDocument).filter(row => row.terminal === proxy)).toEqual([{ ...p.slot, terminal: proxy }]);
  const noHc = await suite.launchPi({ mode: 'rpc', cwd: await suite.project('unhosted'), extraEnv: { ...f.remoteEnv, HC_TERMINAL_ID: '' } });
  const start = await noHc.waitEvent('session_start', event => event.mode === 'rpc', deadline(20000));
  const unavailable = await waitFor('live non-terminal owner remains visible and disabled', () => paneNavigation(f), rows => rows.some(row => row.sessionId === start.sessionId && row.disabledReason === 'Not in an hc terminal'), deadline(20000));
  const missing = unavailable.find(row => row.sessionId === start.sessionId)!;
  expect(missing).toMatchObject({ action: null, disabledReason: 'Not in an hc terminal' });
  expect(actions.menuItems({ kind: 'session', pane: false, navigation: missing }, ports.spaces, null, null).every((item: any) => item.disabled)).toBe(true);
  expect(actions.beginPresentationDrag(missing, ports)).toBe(false);
  const count = requests.length;
  await expect(actions.moveTarget({ kind: 'session', navigation: missing }, { kind: 'tab', tab: f.anchor.tab }, ports)).rejects.toThrow('Not in an hc terminal');
  expect(requests).toHaveLength(count);
  await suite.evidence('B05-coverage.json', { named: 'Hand started', session: owner.row.sessionId, afterNew, choice, restart: 'packed presentation helper', noHc: { session: start.sessionId, disabledReason: missing.disabledReason }, nativeDrag: 'blocked: physical pointer delivery needs an isolated app' });
  const unrelated = await f.assertUnrelated(); expect(unrelated.after).toEqual(unrelated.before);
  await f.evidence('B05-observations.json');
}

export const scenarios: readonly ScenarioDefinition[] = [
  { id: 'B01' as StoryId, title: 'picker creates on chosen machine', tiers: ['headless', 'app'], run: picker },
  { id: 'B02' as StoryId, title: 'remote shell keeps its current folder and carries proxy input', tiers: ['headless', 'app'], run: shell },
  { id: 'B03' as StoryId, title: 'park reopens same remote program', tiers: ['headless', 'app'], run: lifecycle },
  { id: 'B04' as StoryId, title: 'proxy reconnect leaves target alive', tiers: ['headless', 'app'], run: reconnect },
  { id: 'B05' as StoryId, title: 'manual remote placement survives restart', tiers: ['headless', 'app'], run: manual },
];
registerScenarios(scenarios);
