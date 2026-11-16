// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { presentExistingPane } from '../../../herdr/src/spaces/move.js';
import { samePaneTarget } from '../../../herdr/src/panes/lifecycle.js';
import { capturePaneHandoff, readPaneHandoff } from './pane-handoff.js';
import { reconcilePaneRegistrations } from './pane-registration.js';
import { readPaneScreen } from './pane-screen.js';
import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDbReadOnly } from '@spider/db-core';
import { createAppClient } from '../../../herdr/src/client/app.js';
import { createArgvClient } from '../../../herdr/src/client/argv-client.js';
import { invokeBytes } from '../../../herdr/src/client/bytes.js';
import { invokeCli } from '../../../herdr/src/client/hc.js';
import { invokeCli as invokeAppCli } from '../../../herdr/src/client/cli-transport.js';
import { isCoreAvailable } from '../../../herdr/src/client/liveness.js';
import { HerdrError, object } from '../../../herdr/src/client/parse.js';
import type { CoreIdentity, HcClient, HerdrConfig, MachineName, Owner, OwnerPlacement, RunId, ConsoleId, TerminalAddress, TerminalHandle } from '../../../herdr/src/contracts.js';
import { createPresentedAuxiliaryPanes } from '../../../herdr/src/panes/auxiliary.js';
import { readAppPaneCapabilities } from '../../../herdr/src/panes/capabilities.js';
import { paneAddress, paneId, parsePaneTerminal, parsePaneTarget, parseMachineChoices } from '../../../herdr/src/panes/codec.js';
import { readPaneTerminal } from '../../../herdr/src/panes/hc.js';
import { awaitPanePresented, convertNativePresentation, openPane, presentProxy, type PaneOpenPorts, type PaneScreen } from '../../../herdr/src/panes/open.js';
import { createPaneProxyTty, runPaneProxy, type PaneProxyInput } from '../../../herdr/src/panes/proxy.js';
import { createPaneService, type PaneService, type PrivatePaneInventory } from '../../../herdr/src/panes/service.js';
import { connectPaneService, servePaneRequests } from '../../../herdr/src/panes/socket.js';
import { createPanePlacementStore, readPaneBinding } from '../../../herdr/src/panes/store.js';
import type { PanePlacementStore, MachineChoice, PaneActionOutcome, PaneAgentRow, PanePresentation, PaneServiceRequest, PaneTarget } from '../../../herdr/src/panes/types.js';
import { hash, privateDirectory, readPrivateJson, withProcessLock, writePrivateJson } from '../../../herdr/src/sessions/registry.js';
import { selectRemoteSessionSlot } from '../../../herdr/src/spaces/remote-placement.js';
import { createProductionPaneEndpointPorts } from './bin/pane-endpoint.js';
import { handleRemotePaneRequest } from './pane-endpoint.js';
import { choosePaneFolder, createPaneFolderMap, createPaneFolderPorts, createSourcePaneFolderPorts } from './pane-folders.js';
import { resolvePaneAgentProgram } from './pane-program.js';
import { createPaneRemoteRequest } from './pane-transport.js';

const refused = (reason: string): PaneActionOutcome => ({ status: 'refused', reason, presentation: null });
export interface PaneRuntime {
  store: PanePlacementStore; createService(): PaneService; connect(startIfMissing?: boolean): Promise<PaneService>;
  serve(): Promise<void>; proxy(input: { id: string; bindingRoot: string; hcBinary: string }): Promise<number>; dispose(): Promise<void>;
}
export function createPaneRuntime(input: { config: HerdrConfig; hc: HcClient; packageRoot: string; env: Readonly<NodeJS.ProcessEnv>; endpointBytes: Buffer }): PaneRuntime {
  const { config, hc, packageRoot, env } = input;
  const root = join(config.globalRoot, 'herdr', 'panes'), store = createPanePlacementStore(join(config.globalRoot, 'roam', 'placement'));
  const app = config.mode === 'core-only' ? null : createAppClient({ binary: config.app.binary, env: { ...env, HERDR_APP_HOME: config.app.home } });
  const endpointDigest = createHash('sha256').update(input.endpointBytes).digest('hex');
  const source = createProductionPaneEndpointPorts(endpointDigest, { ...env, SPIDER_GLOBAL_ROOT: config.globalRoot }, packageRoot);
  const argv = createArgvClient({ binary: config.core.binary, env });
  let local: CoreIdentity | null = null;
  const identity = async () => { const current = await hc.identity(); if (local && JSON.stringify(local) !== JSON.stringify(current)) throw new HerdrError('core-mismatch', 'Local presentation core changed'); return local ??= current; };
  const machines = async (): Promise<readonly MachineChoice[]> => {
    const current = await identity();
    const raw = object(await invokeCli(config.core.binary, ['machine', 'ls', '--json'], env, undefined, undefined, { timeoutMs: 5000 }));
    if (!Array.isArray(raw.machines)) throw new HerdrError('invalid-reply', 'Machine inventory is unavailable');
    const enrolled = raw.machines.map(value => {
      const row = object(value), aliases = Array.isArray(row.aliases) ? row.aliases : [];
      const configured = config.machines.filter(machine => machine.name === row.name || aliases.includes(machine.name) || typeof row.name === 'string' && machine.aliases.includes(row.name));
      return { ...row, aliases: [...aliases, ...configured.map(machine => machine.name).filter(name => name !== row.name && !aliases.includes(name))] };
    });
    return parseMachineChoices({ machines: enrolled }, config.machines.map(machine => machine.name), current);
  };
  const remote = createPaneRemoteRequest({ buildDigest: endpointDigest, exec: argv.exec, async resolveMachine(machine) {
    const selected = (await machines()).find(row => row.coreId === machine.coreId && row.alias === machine.alias && row.machineId === machine.machineId && row.state === 'connected');
    const settings = config.machines.find(row => row.name === selected?.key);
    if (!selected?.coreId || !settings?.nodePath) throw new HerdrError('machine-changed', 'Configured pane endpoint route is unavailable');
    return { on: selected.coreId, coreId: selected.coreId, nodePath: settings.nodePath };
  } });
  const request = async (machine: { coreId: CoreIdentity['coreId']; alias: string | null; machineId: string | null }, value: Parameters<typeof handleRemotePaneRequest>[0]) => {
    if (machine.coreId === (await identity()).coreId) {
      if (machine.alias !== null) throw new HerdrError('machine-changed', 'Remote route became local');
      return handleRemotePaneRequest(value, source);
    }
    return remote(machine, value);
  };
  const findMachine = async (coreId: string) => {
    const matches = (await machines()).filter(row => row.coreId === coreId && row.state === 'connected');
    if (matches.length !== 1) throw new HerdrError('machine-changed', 'Execution source is unavailable'); return matches[0];
  };
  const inventory = async (machine: MachineChoice, cursor: string | null = null) => {
    if (!machine.coreId) throw new HerdrError('machine-changed', 'Execution source is unavailable');
    const reply = await request({ ...machine, coreId: machine.coreId }, { version: 1, op: 'list', cursor });
    if (reply.op !== 'list') throw new HerdrError('pane-reply-mismatch', 'Expected source inventory');
    const choices = await machines();
    return { ...reply.page, rows: reply.page.rows.map((sourceRow): PaneAgentRow => {
      if (sourceRow.machineKey !== machine.coreId || sourceRow.owner && sourceRow.owner.terminal.coreId !== machine.coreId || sourceRow.target && sourceRow.target.coreId !== machine.coreId) throw new HerdrError('pane-source-mismatch', 'Inventory source changed');
      if (sourceRow.unavailableReason !== null) return { ...sourceRow, machineKey: machine.key };
      const row = { ...sourceRow, consoles: sourceRow.consoles.map(console => { const matches = console.target ? choices.filter(choice => choice.coreId === console.target!.coreId && choice.state === 'connected') : []; return { ...console, target: matches.length === 1 && console.target ? { ...console.target, alias: matches[0].alias, machineId: matches[0].machineId } : null }; }) };
      if (row.machineKey !== machine.coreId || row.target && row.target.coreId !== machine.coreId) throw new HerdrError('pane-source-mismatch', 'Inventory source changed');
      return row.target ? { ...row, machineKey: machine.key, target: { ...row.target, alias: machine.alias, machineId: machine.machineId } } : { ...row, machineKey: machine.key };
    }) };
  };
  const allRows = async (machine: MachineChoice) => {
    const rows: PaneAgentRow[] = []; let cursor: string | null = null;
    do { const page = await inventory(machine, cursor); if (!page.complete) throw new HerdrError('pane-inventory-incomplete', 'Source inventory is incomplete'); rows.push(...page.rows); if (rows.length > 4096) throw new HerdrError('pane-inventory-limit', 'Source inventory exceeded its bound'); cursor = page.next; } while (cursor !== null);
    return rows;
  };
  const validateTarget: PaneOpenPorts['validateTarget'] = async (target, cause) => {
    const machine = await findMachine(target.coreId);
    if (machine.alias !== target.alias || machine.machineId !== target.machineId) throw new HerdrError('machine-changed', 'Execution source changed');
    const facts = await readPaneTerminal(target, { binary: config.core.binary, env });
    if (cause === 'handoff' && facts.terminal.state === 'finished') throw new HerdrError('pane-target-finished', 'Execution target has finished');
    if (target.kind === 'session' && facts.terminal.state !== 'finished') {
      const row = (await allRows(machine)).find(row => row.sessionId === target.sessionId && row.generation === target.generation && row.target?.terminalId === target.terminalId && row.target.createdMs === target.createdMs);
      if (!row?.target || row.target.homeEpoch !== target.homeEpoch) throw new HerdrError('stale-pane-owner', 'Source session changed');
    } else if (target.kind !== 'terminal' && facts.terminal.state !== 'finished' && facts.identityLabels['spider.view-generation'] !== target.generation) throw new HerdrError('stale-pane-owner', 'Source view generation changed');
    return { ...target, cwd: facts.currentCwd, name: target.name };
  };
  const terminals = async () => {
    const events = hc.events(); let done!: (rows: readonly import('../../../herdr/src/contracts.js').TerminalSummary[]) => void;
    const snapshot = new Promise<readonly import('../../../herdr/src/contracts.js').TerminalSummary[]>(resolve => { done = resolve; });
    const off = events.subscribe(event => { if (event.type === 'snapshot' || event.type === 'missed') done(event.terminals); });
    try { await events.ready; return await snapshot; } finally { off(); }
  };
  const readTarget = async (address: TerminalAddress, machine: MachineChoice): Promise<PaneTarget> => {
    const id = paneId(address.split('/').at(-1));
    if (!machine.coreId) throw new HerdrError('machine-changed', 'Execution source changed');
    const qualified = `${machine.coreId}/${id}` as TerminalAddress;
    if (address.includes('/') && address !== qualified) {
      const prefix = address.split('/')[0], source = (await hc.machines()).filter(row => row.id === machine.coreId && (row.name === prefix || row.aliases.includes(prefix)));
      if (source.length !== 1) throw new HerdrError('pane-source-mismatch', 'Terminal is on another core');
    }
    const facts = parsePaneTerminal(await invokeCli(config.core.binary, ['get', qualified, '--json'], env, undefined, undefined, { timeoutMs: 5000 }));
    const target = parsePaneTarget({ coreId: machine.coreId, terminalId: id, address: qualified, createdMs: facts.createdMs, identityLabels: facts.identityLabels, alias: machine.alias, machineId: machine.machineId, kind: 'terminal', sessionId: null, generation: null, homeEpoch: null, runId: null, consoleId: null, name: facts.title.trim() ? facts.title : null, cwd: facts.currentCwd });
    const verified = await readPaneTerminal(target, { binary: config.core.binary, env });
    return { ...target, cwd: verified.currentCwd };
  };
  const capabilities = async () => readAppPaneCapabilities(app && config.mode !== 'core-only' ? await invokeAppCli(config.app.binary, ['commands'], { ...env, HERDR_APP_HOME: config.app.home }) : []);
  const layout = async () => {
    if (!app || config.mode === 'core-only') throw new HerdrError('view-on-mac', 'View on Mac');
    return object(await invokeAppCli(config.app.binary, ['ls'], { ...env, HERDR_APP_HOME: config.app.home }));
  };
  const placeholders = async (operationId: string): Promise<OwnerPlacement[]> => {
    const doc = await layout(); const found: OwnerPlacement[] = [];
    if (!Array.isArray(doc.spaces)) return found;
    for (const rawSpace of doc.spaces) { const space = object(rawSpace); if (space.machine != null || !Array.isArray(space.tabs)) continue;
      for (const rawTab of space.tabs) { const tab = object(rawTab); if (!Array.isArray(tab.panes)) continue;
        for (const rawPane of tab.panes) { const pane = object(rawPane); const props = pane.props ? object(pane.props) : null;
          if (pane.mod === 'spider-pane-waiting' && props?.operationId === operationId) found.push({ space: String(space.id), tab: String(tab.id), pane: String(pane.id) } as OwnerPlacement);
        }
      }
    }
    return found;
  };
  const launchProxy = async (p: PanePresentation, waitingClaim?: PaneProxyInput['waitingClaim']): Promise<TerminalAddress> => (await hc.run({ argv: [process.execPath, join(packageRoot, 'dist/herdr/cli.mjs'), 'panes', 'proxy', '--id', p.id, '--binding-root', root, '--hc', config.core.binary, ...(waitingClaim ? ['--waiting-operation', waitingClaim.operationId, '--waiting-generation', waitingClaim.generation] : [])], cwd: null, parent: null, outliveParent: true, background: true, noNotify: true,
    labels: { 'spider.kind': 'pane-proxy', 'spider.pane-id': p.id, 'spider.target-core': p.target.coreId, 'spider.target-terminal': p.target.terminalId, 'spider.pane-operation': waitingClaim?.operationId ?? p.proxyOperationId ?? p.id, ...(waitingClaim ? { 'spider.owner-generation': waitingClaim.generation } : p.target.generation ? { 'spider.owner-generation': p.target.generation } : {}) } })).address;
  const readScreen = (address: TerminalAddress): Promise<PaneScreen> => readPaneScreen(address, {
    get: async terminal => { const coreId = terminal.includes('/') ? terminal.split('/')[0] : (await identity()).coreId; const target = await readTarget(terminal, await findMachine(coreId)); const facts = await readPaneTerminal(target, { binary: config.core.binary, env }); return { address: terminal, created_ms: facts.createdMs, cols: facts.terminal.cols, rows: facts.terminal.rows }; },
    read: terminal => invokeCli(config.core.binary, ['read', terminal, '--lines', '0', '--json'], env, undefined, undefined, { timeoutMs: 5000 }),
  });
  const openPorts: PaneOpenPorts = {
    store, hc, app, placeholderMod: 'spider-pane-waiting', validateTarget, launchProxy,
    readNativeTarget: async address => readTarget(address, (await machines())[0]),
    awaitPresented: async (proxy, target, slot) => {
      if (!app) throw new HerdrError('view-on-mac', 'View on Mac');
      return awaitPanePresented(proxy, target, slot, { app, readScreen, clock: Date.now, timeoutMs: 5000, delay: () => delay(25) });
    },
    findTargetLaunch: async (operationId, machine) => {
      const found = (await terminals()).filter(row => row.labels['spider.pane-operation'] === operationId && row.labels['spider.kind'] !== 'pane-proxy' && (row.address.startsWith(`${machine.coreId}/`) || machine.alias !== null && row.address.startsWith(`${machine.alias}/`) || machine.alias === null && !row.address.includes('/')));
      return found.length === 1 ? readTarget(found[0].address, machine) : null;
    },
    findProxy: async (p, match) => { const found = (await terminals()).filter(row => row.state === 'live' && !row.address.includes('/') && row.labels['spider.kind'] === 'pane-proxy' && row.labels['spider.pane-id'] === p.id && (match === 'launch' ? row.labels['spider.pane-operation'] === p.id : row.labels['spider.target-core'] === p.target.coreId && row.labels['spider.target-terminal'] === p.target.terminalId)); if (found.length > 1) throw new HerdrError('proxy-launch-uncertain', 'Multiple live proxies match this presentation'); return found[0]?.address ?? null; },
    agentArgv: async (machine, key) => resolvePaneAgentProgram(key, async program => {
      const script = 'const{spawnSync}=require("node:child_process");const r=process.platform==="win32"?spawnSync("where.exe",[process.argv[1]],{encoding:"utf8"}):spawnSync(process.env.SHELL||"/bin/sh",["-lc",\'command -v "$1"\',"sh",process.argv[1]],{encoding:"utf8"});process.stdout.write(r.status===0?"present":"missing")';
      const bytes = machine.alias === null ? await invokeBytes(config.core.binary, ['exec', '--timeout', '4', '--', process.execPath, '-e', script, program], env, { timeoutMs: 5000, maxBytes: 1024 })
        : await argv.exec(machine.coreId!, [(() => { const node = config.machines.find(row => row.name === machine.key)?.nodePath; if (!node) throw new HerdrError('pane-node-unconfigured', 'Source Node executable is not configured'); return node; })(), '-e', script, program], { timeoutMs: 5000, maxBytes: 1024 });
      return bytes.toString().trim() === 'present';
    }),
    launchTarget: async ({ machine, program, folder, operationId }) => {
      const command = program.kind === 'agent' ? await openPorts.agentArgv(machine, program.key) : [];
      const handle = await hc.run({ argv: command, cwd: folder.cwd, on: paneId(machine.coreId) as MachineName, labels: { 'spider.pane-operation': operationId }, parent: null, outliveParent: true, background: true, noNotify: true });
      return readTarget(handle.address, machine);
    },
    verifyPlaceholder: async (placement, operationId) => (await placeholders(operationId)).some(row => row.space === placement.space && row.tab === placement.tab && row.pane === placement.pane),
    findPlaceholder: async operationId => { const rows = await placeholders(operationId); return rows.length === 1 ? rows[0] : null; },
    appCapabilities: capabilities, deferSourceView: async () => false,
  };
  const reserveExistingSlot = async (slot: import('../../../herdr/src/panes/types.js').PaneSlot, operationId: string): Promise<OwnerPlacement> => {
    const recovered = await openPorts.findPlaceholder(operationId);
    if (recovered) {
      if (recovered.space !== slot.space || recovered.tab !== slot.tab) throw new HerdrError('placement-mismatch', 'Mac placeholder moved');
      return recovered;
    }
    const doc = await layout();
    const space = Array.isArray(doc.spaces) ? doc.spaces.map(object).find(space => space.machine == null && space.id === slot.space) : null;
    const tab = space && Array.isArray(space.tabs) ? space.tabs.map(object).find(tab => tab.id === slot.tab) : null;
    const anchor = tab && Array.isArray(tab.panes) ? tab.panes.map(object).find(pane => typeof pane.id === 'string') : null;
    if (!anchor) throw new HerdrError('destination-unavailable', 'The Mac tab has no observed pane');
    const reply = await app!.command('pane.split', { pane: anchor.id, direction: 'right', mod: openPorts.placeholderMod, props: { operationId, presentationId: 'existing-' + operationId } });
    if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
    if (!reply.pane) throw new HerdrError('placement-uncertain', 'Mac placeholder allocation is uncertain');
    const result = { space: slot.space, tab: slot.tab, pane: reply.pane };
    if (!await openPorts.verifyPlaceholder(result, operationId)) throw new HerdrError('placeholder-unavailable', 'Mac placeholder identity is unproved');
    return result;
  };
  const presentInSlot = async (p: PanePresentation, slot: import('../../../herdr/src/panes/types.js').PaneSlot, operationId: string) => {
    if (config.mode === 'core-only') throw new HerdrError('view-on-mac', 'View on Mac');
    return withProcessLock(root, `${config.app.home}:${(await identity()).coreId}:focus`, () => presentExistingPane(p, slot, operationId, openPorts, reserveExistingSlot), { timeoutMs: 20000 });
  };
  const withWaitingClaim = async <T>(kind: 'subagent' | 'console', id: RunId | ConsoleId, owner: Owner, work: (operationId: string, path: string, inspect: () => Promise<TerminalHandle | 'absent'>) => Promise<T>): Promise<T> => {
    const operationId = 'aux-' + hash(JSON.stringify([kind, id, owner.sessionId, owner.generation]));
    await privateDirectory(join(root, 'waiting'));
    return withProcessLock(root, operationId, async () => {
      const path = join(root, 'waiting', `${operationId}.json`), selected = await identity();
      await readPrivateJson(path);
      const inspect = async (): Promise<TerminalHandle | 'absent'> => {
        const found = (await terminals()).filter(row => row.labels['spider.pane-id'] === operationId && row.labels['spider.kind'] === 'pane-proxy'
          && (!row.address.includes('/') || row.address.startsWith(`${selected.coreId}/`)));
        const bound = (await store.read()).presentations.find(p => p.id === operationId && p.target.sessionId === owner.sessionId && p.target.generation === owner.generation);
        if (found.some(row => {
          const target = bound?.proxy === row.address ? bound.target : owner.terminal;
          return row.labels['spider.target-core'] !== target.coreId || row.labels['spider.target-terminal'] !== target.terminalId;
        })) throw new HerdrError('pane-view-identity', 'Waiting display identity changed');
        const live = found.filter(row => row.state === 'live');
        if (live.length > 1) throw new HerdrError('auxiliary-launch-uncertain', 'Multiple waiting displays match this view');
        if (live.length) {
          const claim = await readPrivateJson(path);
          const row = claim && typeof claim === 'object' && !Array.isArray(claim) ? claim as Record<string, unknown> : null;
          if (!row || row.coreId !== selected.coreId || row.operationId !== operationId || row.generation !== owner.generation || row.proxyOperationId !== live[0].labels['spider.pane-operation'] || live[0].labels['spider.owner-generation'] !== owner.generation) throw new HerdrError('auxiliary-launch-uncertain', 'Waiting display launch identity is unproved');
          return { address: live[0].address, coreId: selected.coreId };
        }
        for (const terminal of found) await hc.rm(terminal.address);
        await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        return 'absent';
      };
      return work(operationId, path, inspect);
    });
  };
  const auxiliary = app ? createPresentedAuxiliaryPanes({ hc, app, subagentViewer: async () => { throw new HerdrError('presented-view-required', 'Use the acknowledged presentation path'); }, discardSubagentViewer: async () => {}, placementRoot: root, appIdentity: config.mode === 'full' ? config.app.home : '', automaticSubagentPanes: config.automaticSubagentPanes, limit: config.limits.auxiliaryPanes, clock: Date.now,
    ownerPresentation: async owner => {
      const matches = (await store.read()).presentations.filter(p => p.role === 'agent' && p.target.kind === 'session' && p.visibility === 'visible'
        && p.target.sessionId === owner.sessionId && p.target.generation === owner.generation
        && p.target.coreId === owner.terminal.coreId && p.target.terminalId === owner.terminal.terminalId);
      if (matches.length !== 1) return null;
      const p = matches[0], local = await identity();
      if (p.mode === 'native') return p.target.coreId === local.coreId ? paneAddress(p.target.terminalId) : null;
      if (!p.proxy || p.proxy.includes('/') && !p.proxy.startsWith(`${local.coreId}/`)) return null;
      return p.proxy;
    },
    waitingPresentation: (kind, id, owner) => withWaitingClaim(kind, id, owner, async (operationId, path, inspect) => {
      const existing = await inspect(); if (existing !== 'absent') return existing;
      const proxyOperationId = randomUUID(), generation = owner.generation;
      await writePrivateJson(path, { version: 1, operationId, coreId: (await identity()).coreId, proxyOperationId, generation });
      const p = { id: operationId, target: { coreId: owner.terminal.coreId, terminalId: owner.terminal.terminalId } } as PanePresentation;
      try {
        const address = await launchProxy(p, { operationId: proxyOperationId, generation }), coreId = (await identity()).coreId;
        await writePrivateJson(path, { version: 1, operationId, coreId, address, proxyOperationId, generation }); return { address, coreId };
      } catch (error) {
        const recovered = await inspect(); if (recovered !== 'absent') return recovered;
        throw error;
      }
    }),
    recoverWaitingPresentation: (kind, id, owner) => withWaitingClaim(kind, id, owner, (_operationId, _path, inspect) => inspect()),
    releaseWaitingPresentation: async (kind, id, owner) => { await withWaitingClaim(kind, id, owner, (_operationId, _path, inspect) => inspect()); },
    observed: async reservation => { try { const placement = await app.ownerPlacement(reservation.viewer); return placement.pane === reservation.pane; } catch (error) { return error instanceof HerdrError && error.code === 'owner-unplaced' ? false : null; } },
    targetIsLive: async target => { try { await validateTarget(target, 'open'); return (await hc.get(target.address)).state === 'live'; } catch { return null; } },
    leaseMachine: owner => owner.terminal.coreId,
    async launchTarget(kind, id, owner, leaseId) {
      const machine = await findMachine(owner.terminal.coreId);
      const console = kind === 'console' ? (await allRows(machine)).find(row => row.sessionId === owner.sessionId && row.generation === owner.generation)?.consoles.find(console => console.consoleId === id) : null;
      if (kind === 'console' && !console) throw new HerdrError('console-identity-mismatch', 'Source console is unavailable');
      const reply = await request({ ...machine, coreId: owner.terminal.coreId }, kind === 'subagent'
        ? { version: 1, op: 'launch-viewer', sessionId: owner.sessionId, generation: owner.generation, runId: id as never, leaseId }
        : { version: 1, op: 'open-console', sessionId: owner.sessionId, generation: owner.generation, machineKey: console!.machineKey, consoleId: id as import('../../../herdr/src/contracts.js').ConsoleId, leaseId });
      if ((reply.op !== 'launch-viewer' && reply.op !== 'open-console') || !reply.target) throw new HerdrError('pane-view-unavailable', 'Source view is unavailable');
      if (kind === 'subagent' && reply.target.coreId !== owner.terminal.coreId) throw new HerdrError('pane-source-mismatch', 'Source view moved to another machine');
      const executionMachine = await findMachine(reply.target.coreId);
      return { ...reply.target, alias: executionMachine.alias, machineId: executionMachine.machineId };
    },
    async bindTarget(reservation, target) {
      await validateTarget(target, 'open');
      const id = 'aux-' + hash(JSON.stringify([reservation.kind, reservation.id, reservation.owner.sessionId, reservation.owner.generation]));
      const slot = await app.ownerPlacement(reservation.viewer), display = await hc.get(reservation.viewer);
      if (display.labels['spider.pane-id'] !== id || display.labels['spider.owner-generation'] !== reservation.owner.generation) throw new HerdrError('pane-view-identity', 'Waiting display generation changed');
      const proxyOperationId = paneId(display.labels['spider.pane-operation']);
      await store.update(state => { const old = state.presentations.find(p => p.id === id); const p: PanePresentation = { id, proxyOperationId, revision: (old?.revision ?? 0) + 1, mode: 'proxy', role: reservation.kind === 'console' ? 'console' : 'subagent', target, proxy: reservation.viewer, slot, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null }; return { ...state, presentations: [...state.presentations.filter(p => p.id !== id), p] }; });
      await hc.setLabels(reservation.viewer, { 'spider.target-core': target.coreId, 'spider.target-terminal': target.terminalId });
    },
    renew: async (key, leases) => { const machine = await findMachine(key); await request({ ...machine, coreId: machine.coreId! }, { version: 1, op: 'renew-viewers', leases }); },
    stop: async (key, leaseId) => { const machine = await findMachine(key); await request({ ...machine, coreId: machine.coreId! }, { version: 1, op: 'stop-viewer', leaseId }); },
  }) : null;
  let service: PaneService | null = null;
  const createService = () => service ??= createPaneService({ root, store, hc, app, coreAvailable: () => isCoreAvailable(env), clock: Date.now, machines,
    reconcileInventory: async inventory => { if (app) await reconcilePaneRegistrations({ store, localCoreId: (await identity()).coreId, rows: inventory.rows, nativePlacement: target => app.ownerPlacement(paneAddress(target.terminalId)).catch(() => null) }); },
    inventory: (machine, _signal, cursor) => inventory(machine, cursor), validateTarget,
    async closeSession(target, operationId) {
      const machine = await findMachine(target.coreId);
      if (!target.sessionId || !target.generation) return 'stale';
      const reply = await request({ ...machine, coreId: target.coreId }, { version: 1, op: 'close-session', sessionId: target.sessionId, generation: target.generation, homeEpoch: target.homeEpoch ?? 0, operationId });
      return reply.op === 'close-session' && reply.outcome.status === 'complete' ? 'ended' : 'pending';
    },
    async targetFacts(presentations, signal) {
      const facts: Record<string, Awaited<ReturnType<typeof readPaneTerminal>>> = {};
      const targets = [...new Map(presentations.filter(p => p.visibility === 'visible').map(p => [`${p.target.coreId}/${p.target.terminalId}`, p.target])).values()];
      let index = 0;
      const cancellation = new AbortController(), timer = setTimeout(() => cancellation.abort(), 5000);
      const budget = AbortSignal.any([signal, cancellation.signal]);
      try {
        await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
          while (index < targets.length && !budget.aborted) {
            const target = targets[index++];
            try { facts[`${target.coreId}/${target.terminalId}`] = await readPaneTerminal(target, { binary: config.core.binary, env, signal: budget }); }
            catch { /* Missing sources grant no new authority. */ }
          }
        }));
        return facts;
      } finally { clearTimeout(timer); }
    },
    renewLeases: async () => { await auxiliary?.tick(); }, appCapabilities: capabilities,
    subscribe: changed => { const stream = hc.events(); return stream.subscribe(() => changed()); },
    schedule: (tick, ms) => { const timer = setInterval(tick, ms); timer.unref(); return () => clearInterval(timer); },
    async dispatch(value, beforeLaunch, privateInventory) {
      if (!app) return refused('view-on-mac');
      if (value.op === 'open') {
        const machine = (await machines()).find(row => row.key === value.machineKey)!;
        const command = value.intent.program.kind === 'agent' ? await openPorts.agentArgv(machine, value.intent.program.key) : [];
        const focusedPlacement = await app.focusedPane(); let focused: PaneTarget | null = null;
        if (focusedPlacement) {
          const pane = (await app.tabPanes(focusedPlacement)).find(row => row.pane === focusedPlacement.pane);
          const presented = pane && (await store.read()).presentations.find(p => p.proxy === pane.terminal || p.mode === 'native' && String(p.target.terminalId) === String(pane.terminal));
          if (presented) focused = await validateTarget(presented.target, 'open');
          else if (pane) focused = await openPorts.readNativeTarget(pane.terminal);
        }
        const map = createPaneFolderMap(createPaneFolderPorts({ local: await identity(), localFolders: createSourcePaneFolderPorts(() => openDbReadOnly(join(config.globalRoot, 'spider.db'))), request }));
        const folder = await choosePaneFolder({ focused, chosen: machine }, map);
        const launchPorts = { ...openPorts, agentArgv: async () => command, launchTarget: async (launch: Parameters<PaneOpenPorts['launchTarget']>[0]) => { await beforeLaunch(); const handle = await hc.run({ argv: command, cwd: launch.folder.cwd, on: paneId(machine.coreId) as MachineName, labels: { 'spider.pane-operation': launch.operationId }, parent: null, outliveParent: true, background: true, noNotify: true }); return readTarget(handle.address, machine); } };
        await beforeLaunch(); return openPane({ intent: value.intent, machine, folder, beforeLaunch }, launchPorts);
      }
      if (value.op === 'open-auxiliary') {
        const matches = privateInventory.rows.filter(row => row.sessionId === value.sessionId && row.generation === value.generation && row.unavailableReason === null);
        const row = matches.length === 1 ? matches[0] : null;
        if (!row?.owner || !auxiliary) return refused('not-in-hc');
        if (value.mode === 'automatic' && value.view.kind === 'console') return { status: 'pending', reason: 'view-unplaced', presentation: null };
        const kind = value.view.kind; const console = kind === 'console' ? row.consoles.find(console => console.consoleId === (value.view as { consoleId: string }).consoleId && console.machineKey === (value.view as { machineKey: string }).machineKey) : null;
        const id = kind === 'subagent' ? (value.view as { runId: import('../../../herdr/src/contracts.js').RunId }).runId : console?.consoleId;
        if (!id) return refused('pane-view-unavailable');
        const automatic = value.mode === 'automatic';
        const display = await auxiliary.openPresented(kind, id, row.owner, { timeoutMs: 5000, automatic, ownerRelative: !automatic });
        const presentation = display ? (await store.read()).presentations.find(p => p.proxy === display.viewer && p.role === kind && p.visibility === 'visible' && p.launch === 'acknowledged'
          && p.target.kind === kind && p.target.sessionId === row.sessionId && p.target.generation === row.generation
          && (kind === 'subagent' ? p.target.runId === id : p.target.consoleId === id)) ?? null : null;
        return { status: presentation ? 'complete' : 'pending', reason: presentation ? 'view-presented' : 'view-unplaced', presentation };
      }
      const state = await store.read();
      let p = 'presentationId' in value ? state.presentations.find(p => p.id === value.presentationId) : value.op === 'open-existing' ? state.presentations.find(p => p.target.sessionId === value.sessionId && p.target.generation === value.generation) : null;
      if (value.op === 'open-existing' && !p && 'sessionId' in value) {
        const matches = privateInventory.rows.filter(row => row.sessionId === value.sessionId && row.generation === value.generation);
        const row = matches.length === 1 ? matches[0] : null;
        if (!row?.target || !row.owner || row.unavailableReason !== null) return refused('not-in-hc');
        await validateTarget(row.target, 'open');
        const selection = value.slot ? { kind: 'slot' as const, ...value.slot } : selectRemoteSessionSlot({ row, rows: privateInventory.rows, inventoryComplete: privateInventory.complete, inventoryStale: privateInventory.stale, config, state, layout: await macLayout(), capabilities: await capabilities() });
        if (selection.kind !== 'slot' || !selection.tab) return { status: 'pending', reason: selection.kind === 'unplaced' ? selection.reason : 'tab-choice-required', presentation: null };
        const native = row.target.coreId === (await identity()).coreId;
        p = { id: 'session-' + hash(JSON.stringify([row.sessionId, row.generation])), revision: 1, mode: native ? 'native' : 'proxy', role: 'agent', target: row.target, proxy: null, slot: { space: selection.space, tab: selection.tab, pane: null }, visibility: 'visible', launch: native ? 'acknowledged' : 'none', closeOperationId: null, conversion: null };
        const created = p; await store.update(s => ({ ...s, presentations: [...s.presentations, created] }));
      }
      if (!p) return refused('stale-presentation');
      if (value.op === 'present-ready') {
        let prepared = await readPaneHandoff(root, p) ?? (p.conversion?.state === 'waiting-readiness' && samePaneTarget(p.target, value.target) ? { source: p.conversion.source, sourceFocused: p.conversion.sourceFocused } : null);
        if (!prepared && !p.slot && !p.proxy) prepared = { source: null, sourceFocused: false };
        if (!prepared && !samePaneTarget(p.target, value.target)) {
          let source: OwnerPlacement | null = null, sourceFocused = false;
          if (p.visibility !== 'parked') {
            const display = p.mode === 'native' ? paneAddress(p.target.terminalId) : p.proxy;
            try {
              source = display ? await app.ownerPlacement(display) : null;
              if (!source || !p.slot || source.space !== p.slot.space || source.tab !== p.slot.tab || source.pane !== p.slot.pane) return { status: 'pending', reason: 'source-view-unavailable', presentation: p };
              const focused = await app.focusedPane();
              sourceFocused = focused?.space === source.space && focused.tab === source.tab && focused.pane === source.pane;
            } catch {
              return { status: 'pending', reason: 'app-unavailable', presentation: p };
            }
          }
          prepared = { source, sourceFocused };
        }
        if (!prepared) return { status: samePaneTarget(p.target, value.target) ? 'refused' : 'pending', reason: 'handoff-not-prepared', presentation: p };
        return convertNativePresentation({ presentation: p, destination: value.target, ...prepared }, openPorts);
      }
      if (value.op === 'prepare-handoff') {
        const display = p.mode === 'native' ? paneAddress(p.target.terminalId) : p.proxy;
        let source: OwnerPlacement | null = p.visibility !== 'parked' && p.slot?.pane ? { ...p.slot, pane: p.slot.pane } : null;
        let sourceFocused = false, available = true;
        if (p.visibility !== 'parked') {
          try {
            source = display ? await app.ownerPlacement(display) : null;
            if (!source || !p.slot || source.space !== p.slot.space || source.tab !== p.slot.tab || source.pane !== p.slot.pane) return { status: 'pending', reason: 'source-view-unavailable', presentation: p };
            const focused = await app.focusedPane();
            sourceFocused = focused?.space === source.space && focused.tab === source.tab && focused.pane === source.pane;
          } catch {
            available = false;
          }
        }
        if (p.visibility !== 'parked' && !source) return { status: 'pending', reason: 'source-view-unavailable', presentation: p };
        await capturePaneHandoff(root, p, source, sourceFocused);
        return { status: available ? 'complete' : 'pending', reason: available ? 'handoff-prepared' : 'app-unavailable', presentation: p };
      }
      if (value.op === 'move' || value.op === 'open-existing') {
        await validateTarget(p.target, 'open');
        let slot = value.op === 'move' ? value.slot : 'slot' in value ? value.slot ?? p.slot : p.slot;
        if (!slot && value.op === 'open-existing' && 'sessionId' in value) {
          const matches = privateInventory.rows.filter(row => row.sessionId === value.sessionId && row.generation === value.generation);
          const row = matches.length === 1 ? matches[0] : null;
          if (!row?.target || !row.owner || row.unavailableReason !== null) return refused('not-in-hc');
          const selection = selectRemoteSessionSlot({ row, rows: privateInventory.rows, inventoryComplete: privateInventory.complete, inventoryStale: privateInventory.stale, config, state, layout: await macLayout(), capabilities: await capabilities() });
          if (selection.kind !== 'slot' || !selection.tab) return { status: 'pending', reason: selection.kind === 'unplaced' ? selection.reason : 'tab-choice-required', presentation: p };
          slot = { space: selection.space, tab: selection.tab, pane: null };
        }
        if (!slot) return refused('tab-choice-required');
        try { return { status: 'complete', reason: p.mode === 'native' ? 'native-presented' : 'proxy-presented', presentation: await presentInSlot(p, slot, value.operationId) }; }
        catch (error) { if (error instanceof HerdrError && error.code === 'proxy-launch-uncertain') return { status: 'pending', reason: error.code, presentation: (await store.read()).presentations.find(item => item.id === p!.id) ?? null }; throw error; }
      }
      return refused('unsupported-pane-operation');
    },
  });
  const macLayout = async (): Promise<import('../../../herdr/src/spaces/setup.js').LayoutSnapshot> => ({ spaces: (await app!.listSpaces()).filter(space => space.machine === null).map(space => ({ id: space.id, name: space.name, tabs: space.tabs.map(tab => ({ id: tab.id, name: tab.name, ownerSessionId: null, terminal: null, terminals: [] })) })) });
  return {
    store, createService,
    async connect(startIfMissing = true) {
      const selected = await identity(); await privateDirectory(root);
      return connectPaneService({ root, identity: selected, startIfMissing,
        launchHelper: async operationId => (await hc.run({ argv: [process.execPath, join(packageRoot, 'dist/herdr/cli.mjs'), 'panes', 'serve'], cwd: null, parent: null, outliveParent: true, background: true, noNotify: true, labels: { 'spider.kind': 'pane-service', 'spider.pane-operation': operationId } })).address,
        probeHelper: address => hc.get(address) });
    },
    async serve() {
      if (!app) throw new HerdrError('view-on-mac', 'View on Mac');
      const server = await servePaneRequests(root, createService());
      try { await new Promise<void>(resolve => { const stop = () => { for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(name, stop); resolve(); }; for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(name, stop); }); }
      finally { await server.close(); await service?.stop(); await auxiliary?.dispose(); }
    },
    async proxy(input: PaneProxyInput) {
      if (resolve(input.bindingRoot) !== resolve(root) || resolve(input.hcBinary) !== resolve(config.core.binary)) throw new HerdrError('invalid-proxy-root', 'Proxy configuration differs from its installation');
      const cancellation = new AbortController(), stop = () => cancellation.abort();
      for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(name, stop);
      const tty = createPaneProxyTty({ env: { ...env } });
      try { return await runPaneProxy(input, { ...tty, signal: cancellation.signal, clock: Date.now,
        readBinding: async id => { let p = await readPaneBinding(root, id); while (!p && !input.waitingClaim && !cancellation.signal.aborted) { await delay(50, undefined, { signal: cancellation.signal }); p = await readPaneBinding(root, id); } return p; },
        probe: target => readPaneTerminal(target, { binary: config.core.binary, env }),
        verifyAttachedCore: async target => { const machine = await findMachine(target.coreId); return machine.alias === target.alias && machine.machineId === target.machineId; },
        watchBinding: (id, changed) => { const watcher = watch(join(root, 'bindings'), () => { void readPaneBinding(root, id).then(p => changed(p)).catch(() => {}); }); return () => watcher.close(); },
        delay: async (ms, signal) => { await delay(ms, undefined, { signal }); }, status: async text => { process.stdout.write(text + '\r\n'); },
      }); } finally { await tty.close(); for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(name, stop); }
    },
    async dispose() { await service?.stop(); await auxiliary?.dispose(); await source.dispose?.(); },
  };
}
