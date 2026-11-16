// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { PANE_LEASE_WRITER } from './pane-lease.js';
import { createArgvClient } from '../../../herdr/src/client/argv-client.js';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openDbReadOnly } from '@spider/db-core';
import { HerdrError } from '../../../herdr/src/client/parse.js';
import { invokeCli } from '../../../herdr/src/client/hc.js';
import { paneId, parseConsoleId, parsePaneTerminal, parsePaneTarget } from '../../../herdr/src/panes/codec.js';
import { createPaneConsoleDiscovery, readRetainedAgentConsole, openAgentConsoleView } from '../../../herdr/src/remote/console.js';
import { encodeRuntimePublication } from '../../../herdr/src/remote/runtime.js';
import { runtimeInstallPath } from '../../../herdr/src/setup/installer.js';
import { createViewerLauncher } from '../../../herdr/src/viewers/register.js';
import { readPaneTerminal } from '../../../herdr/src/panes/hc.js';
import { createSessionIpcClient } from '../../../herdr/src/feed/ipc-client.js';
import type { HcClient, HerdrConfig, Owner, RunId, ConsoleId, MachineName, TerminalAddress } from '../../../herdr/src/contracts.js';
import type { PaneTarget, PaneConsoleRow } from '../../../herdr/src/panes/types.js';
import { openSessionHistoryDb } from '../session-run-db.js';
import { createSourcePaneFolderPorts, type PaneEndpointPorts, type PaneSourceInventoryPorts } from './pane-endpoint.js';
import { launchPaneViewer, openPaneConsole, renewPaneViewers, stopPaneViewer, type PaneViewPorts } from './pane-views.js';

export function createPaneSourceEffects(input: {
  config: HerdrConfig; hc: HcClient; source: PaneSourceInventoryPorts;
  resolveOwner: PaneEndpointPorts['resolveOwner']; packageRoot: string; env: Readonly<NodeJS.ProcessEnv>;
}): Pick<PaneEndpointPorts, 'locateFolder' | 'resolveFolder' | 'launchViewer' | 'renewViewers' | 'stopViewer' | 'openConsole' | 'closeSession'> & { readConsoles: PaneSourceInventoryPorts['readConsoles'] } {
  const { config, hc, source, resolveOwner, packageRoot, env } = input;
  const root = join(config.globalRoot, 'herdr'), argv = createArgvClient({ binary: config.core.binary, env });
  const folders = createSourcePaneFolderPorts(() => openDbReadOnly(join(config.globalRoot, 'spider.db')));
  const currentOwner = async (owner: Owner) => {
    const current = await resolveOwner(owner.sessionId, owner.generation);
    if (current.terminal.coreId !== owner.terminal.coreId || current.terminal.terminalId !== owner.terminal.terminalId || current.sessionFile !== owner.sessionFile) throw new HerdrError('stale-pane-owner', 'Source session changed');
    return current;
  };
  const ownsRun = async (owner: Owner, id: RunId) => {
    await currentOwner(owner); const { db } = openSessionHistoryDb(owner.cwd, owner.sessionId);
    try { return Boolean(db.prepare('SELECT 1 FROM runs WHERE id = ? AND session_id = ?').get(id, owner.sessionId)); } finally { db.close(); }
  };
  const targetRoute = async (coreId: string) => {
    const local = await hc.identity(); if (coreId === local.coreId) return { coreId: local.coreId, alias: null };
    const matches = (await hc.machines()).filter(machine => machine.id === coreId && machine.state === 'connected');
    if (matches.length !== 1) throw new HerdrError('core-mismatch', 'Source view core is unavailable');
    return { coreId: matches[0].id, alias: matches[0].name };
  };
  const readFacts = async (address: TerminalAddress) => {
    const prefix = address.split('/')[0], route = await targetRoute(prefix);
    const facts = parsePaneTerminal(await invokeCli(config.core.binary, ['get', address, '--json'], env, undefined, undefined, { timeoutMs: 5000 }));
    if (JSON.stringify(route) !== JSON.stringify(await targetRoute(prefix))) throw new HerdrError('core-mismatch', 'Source view route changed');
    const target = parsePaneTarget({ coreId: route.coreId, terminalId: address.split('/').at(-1), address, createdMs: facts.createdMs, identityLabels: facts.identityLabels, alias: route.alias, machineId: null, kind: 'terminal', sessionId: null, generation: null, homeEpoch: null, runId: null, consoleId: null, name: null, cwd: null });
    return readPaneTerminal(target, { binary: config.core.binary, env });
  };
  const readTarget: PaneViewPorts['readTarget'] = async (address, owner, runId, consoleId) => {
    await currentOwner(owner);
    const identity = await hc.identity(); const id = address.split('/').at(-1)!;
    const route = await targetRoute(address.includes('/') ? address.split('/')[0] : identity.coreId);
    const qualified = `${route.coreId}/${paneId(id)}` as TerminalAddress;
    if (address.includes('/') && address !== qualified) throw new HerdrError('core-mismatch', 'View is not on its selected source');
    const facts = await readFacts(qualified), labels = facts.identityLabels;
    if (facts.createdMs <= 0 || labels['spider.session'] !== owner.sessionId || labels['spider.owner-core'] !== owner.terminal.coreId || labels['spider.owner-terminal']?.split('/').at(-1) !== owner.terminal.terminalId || labels['spider.view-generation'] !== owner.generation || runId && labels['spider.run'] !== runId || consoleId && labels['spider.console-id'] !== consoleId) throw new HerdrError('pane-view-identity', 'Source view identity changed');
    return { coreId: route.coreId, terminalId: id as PaneTarget['terminalId'], address: qualified, createdMs: facts.createdMs,
      identityLabels: Object.fromEntries(Object.entries(labels).filter(([key]) => key !== 'spider.console-key')), alias: route.alias, machineId: null,
      kind: consoleId ? 'console' : 'subagent', sessionId: owner.sessionId, generation: owner.generation, homeEpoch: null, runId, consoleId, name: facts.title, cwd: facts.currentCwd };
  };
  const runtimeBytes = () => readFile(join(packageRoot, 'dist/herdr/remote-runtime.mjs'));
  const consoleEnv = (owner: Owner, runId: RunId | null): Readonly<NodeJS.ProcessEnv> => ({ ...env, HC_TERMINAL_ID: owner.terminal.terminalId, PI_SUBAGENT_CHILD: runId ? '1' : '0', PI_SUBAGENT_RUN_ID: runId ?? undefined });
  const configuredRoute = async (machine: HerdrConfig['machines'][number]) => {
    const matches = (await hc.machines()).filter(row => row.state === 'connected' && (row.name === machine.name || row.aliases.includes(machine.name) || machine.aliases.includes(row.name)));
    if (matches.length !== 1) throw new HerdrError('machine-changed', 'Console machine is unavailable');
    return matches[0];
  };
  const boundConsoleClient = (machine: HerdrConfig['machines'][number], coreId: string): HcClient => ({ ...hc,
    async machines() { const selected = await configuredRoute(machine); if (selected.id !== coreId) throw new HerdrError('machine-changed', 'Console route changed'); return [{ ...selected, name: machine.name }]; },
    async run(value) { const selected = await configuredRoute(machine); if (selected.id !== coreId) throw new HerdrError('machine-changed', 'Console route changed'); return hc.run({ ...value, on: coreId as MachineName }); },
    fileRead: (_on, path) => hc.fileRead(coreId as MachineName, path), fileWrite: (_on, path, bytes) => hc.fileWrite(coreId as MachineName, path, bytes),
  });
  const retainedConsoles = async (owner: Owner) => {
    await currentOwner(owner); const feed = await source.readFeed(owner.sessionId);
    const ids: Array<RunId | null> = [null, ...(feed?.runs.rows.map(run => run.id) ?? [])];
    if (!config.machines.length) return [];
    const bytes = await runtimeBytes(), found = [];
    if (ids.length * config.machines.length > 256) throw new HerdrError('console-inventory-limit', 'Console inventory exceeded its bound');
    for (const machine of config.machines) {
      const route = await configuredRoute(machine), client = boundConsoleClient(machine, route.id);
      for (const runId of ids) {
        if (runId && !await ownsRun(owner, runId)) continue;
        const request = { owner, on: machine.name, target: { ...machine.runtime, on: machine.name, environment: {}, nodePath: machine.nodePath ?? '', runtimePath: runtimeInstallPath(machine.runtime.directory, bytes), runtimeSha256: createHash('sha256').update(bytes).digest('hex') }, source: { kind: 'code' as const, language: 'shell' as const, code: '' } };
        const retained = await readRetainedAgentConsole(request, client, consoleEnv(owner, runId));
        if (retained) found.push({ ...retained, machine, route, request, client });
      }
    }
    await currentOwner(owner); return found;
  };
  const findConsole = async (owner: Owner, consoleId: ConsoleId, machineKey?: string) => {
    const matches = (await retainedConsoles(owner)).filter(console => console.consoleId === consoleId && (machineKey === undefined || console.machine.name === machineKey || console.route.id === machineKey));
    if (matches.length !== 1) throw new HerdrError('console-identity-mismatch', 'Source console is unavailable'); return matches[0];
  };
  const mirrorLease = async (console: Awaited<ReturnType<typeof findConsole>>, lease: { leaseId: string }, bytes: Buffer) => {
    if (!console.machine.nodePath) throw new HerdrError('pane-node-unconfigured', 'Console Node executable is not configured');
    const current = await configuredRoute(console.machine); if (current.id !== console.route.id) throw new HerdrError('machine-changed', 'Console route changed');
    await argv.exec(console.route.id, [console.machine.nodePath, '-e', PANE_LEASE_WRITER, console.machine.runtime.directory, paneId(lease.leaseId)], { timeoutMs: 5000, maxBytes: 1024, stdin: bytes });
  };
  const feeds = new Map<string, Awaited<ReturnType<PaneSourceInventoryPorts['readFeed']>>>();
  const views: PaneViewPorts = {
    leaseRoot: join(root, 'panes', 'view-leases'), clock: Date.now,
    readOwner: async (id, generation) => { const owner = await resolveOwner(id, generation).catch(() => null); if (owner) feeds.set(id, await source.readFeed(id)); return owner; }, ownsRun, readTarget,
    viewerLauncher(owner, displayLeaseFile) {
      return createViewerLauncher({ hc, owner: () => owner, viewerExecutable: join(packageRoot, 'dist/herdr/viewer.mjs'), feedRoot: root, displayLeaseFile,
        ipcDescriptor: () => { const feed = feeds.get(owner.sessionId); return feed?.ipc ? { version: 1, sessionId: owner.sessionId, generation: owner.generation, ...feed.ipc } : null; },
        async runInfo(id) {
          const feed = await source.readFeed(owner.sessionId); const run = feed?.runs.rows.find(row => row.id === id);
          const { db, dbPath } = openSessionHistoryDb(owner.cwd, owner.sessionId);
          try {
            const row = db.prepare('SELECT name, status, child_mode FROM runs WHERE id = ? AND session_id = ?').get(id, owner.sessionId) as { name: string | null; status: string; child_mode: string } | undefined;
            if (!row) throw new HerdrError('pane-run-unavailable', 'Source run is unavailable');
            return { name: row.name ?? id, status: run?.status, parentName: owner.name ?? 'Agent', cwd: owner.cwd, dbPath, steer: row.child_mode === 'rpc' ? 'rpc' : 'headless' };
          } finally { db.close(); }
        } });
    },
    async stopTarget(target) {
      const current = await readTarget(target.address, await resolveOwner(target.sessionId!, target.generation!), target.runId, target.consoleId);
      if (current.createdMs !== target.createdMs || Object.entries(target.identityLabels).some(([key, value]) => current.identityLabels[key] !== value)) throw new HerdrError('pane-view-identity', 'Source view changed before stop');
      await hc.kill(target.address);
    },
    async consoleSource(owner, machineKey, consoleId) {
      const console = await findConsole(owner, consoleId, machineKey);
      return { consoleId, runId: console.runId, async launch(displayLeaseFile) {
        await currentOwner(owner);
        const remoteLease = join(console.machine.runtime.directory, '.view-leases', basename(displayLeaseFile));
        const bytes = await readFile(displayLeaseFile); await mirrorLease(console, JSON.parse(bytes.toString()) as { leaseId: string }, bytes);
        const handle = await openAgentConsoleView({ ...console.request, displayLeaseFile: remoteLease }, console.client, consoleEnv(owner, console.runId));
        if (!handle || handle.consoleId !== consoleId || handle.coreId !== console.route.id) throw new HerdrError('pane-console-unavailable', 'Source console changed during launch');
        return `${console.route.id}/${handle.address.split('/').at(-1)}` as TerminalAddress;
      } };
    },
    async publishLease(lease) {
      if (!lease.consoleId) return;
      const owner = await resolveOwner(lease.sessionId, lease.generation), console = await findConsole(owner, lease.consoleId);
      await mirrorLease(console, lease, Buffer.from(JSON.stringify(lease)));
    },
  };
  return {
    ...folders,
    async readConsoles(owner) {
      try {
        const retained = await retainedConsoles(owner);
        const live = await createPaneConsoleDiscovery({ hc, validateOwner: owner => currentOwner(owner).then(() => true, () => false), ownsRun, readFacts })(owner);
        if (!live) return null;
        return retained.map(console => ({ consoleId: console.consoleId, machineKey: console.machineKey, name: console.name, target: live.find(target => target.consoleId === console.consoleId) ?? null } satisfies PaneConsoleRow));
      } catch { return null; }
    },
    launchViewer: (_owner, request) => launchPaneViewer(request, views),
    renewViewers: leases => renewPaneViewers(leases, views), stopViewer: id => stopPaneViewer(id, views),
    openConsole: (_owner, request) => openPaneConsole(request, views),
    async closeSession(owner, request) {
      await currentOwner(owner);
      if ((await source.readHomeEpoch?.(owner.sessionId) ?? 0) !== request.homeEpoch) throw new HerdrError('stale-pane-home', 'Session home changed');
      const feed = await source.readFeed(owner.sessionId);
      if (!feed?.ipc || feed.generation !== owner.generation) throw new HerdrError('pane-session-unavailable', 'Source session endpoint is unavailable');
      const ipc = createSessionIpcClient({ version: 1, sessionId: owner.sessionId, generation: owner.generation, ...feed.ipc });
      try {
        const reply = await ipc.request({ op: 'killSession', generation: owner.generation });
        if (!reply.ok) throw new HerdrError(reply.code, reply.message);
        return { status: 'pending', reason: 'session-shutdown-pending', presentation: null };
      } finally { ipc.dispose(); }
    },
  };
}
