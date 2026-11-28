// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm, stat, access, truncate } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { HerdrConfig, SessionId, SpaceId, TabId, TerminalAddress } from '../contracts.js';
import { parseHerdrConfig } from '../config.js';
import { HerdrError } from '../client/parse.js';
import { createTerminalRegistry } from '../sessions/registry.js';
import { createProcessPresence } from '../sessions/presence.js';
import { createSessionLeases, type ProcessProbe } from '../sessions/lease.js';
import { discoverSessions, readSessionMetadata, selectedProcessInventory } from '../spaces/discovery.js';
import { startCutover, type LaunchedSession } from '../spaces/cutover.js';
import { launchSession } from '../sessions/launcher.js';
import { setupSpaces, preflightSpaces, forgetCutoverTabs, readCutoverRecovery, type SpaceSetupPorts, type LayoutSnapshot } from '../spaces/setup.js';
import * as spaceSetup from '../spaces/setup.js';
let root: string; let config: HerdrConfig; let ports: SpaceSetupPorts; let files: string[]; let probes: Map<number, ProcessProbe>;
let layout: LayoutSnapshot; let messages: string[]; let listed: { name: string | null; pid: number }[]; let writers: string[]; let ticks: number; let waits: number;
let splits: { anchor: string; direction: string }[];
let unknown: boolean; let fail: boolean; let nextPid: number; let notes: boolean;
beforeEach(async () => {
  await mkdir(resolve('.spider/scratch/h'), { recursive: true }); root = await mkdtemp(resolve('.spider/scratch/h/g3-')); files = []; probes = new Map(); messages = []; listed = []; writers = []; ticks = 0; waits = 0; unknown = false; fail = false; notes = true; nextPid = 500;
  config = { enabled: true, app: { binary: 'fixture', home: root }, core: { binary: 'fixture', config: join(root, 'core.toml') }, agentDirectory: root, globalRoot: root, shellRc: join(root, 'rc'), layout: 'tabs', spaces: [{ name: 'Space A', sessions: [] }], machines: [], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };
  layout = { spaces: [] }; splits = [];
  const processInventory = { presence: createProcessPresence(root), leases: createSessionLeases(root), processes: async () => unknown ? [{ pid: 999, startIdentity: 'unknown', classification: 'pi' as const }] : [], probe: async (pid: number) => probes.get(pid) ?? { kind: 'absent' as const } };
  const results = new Map<string, LaunchedSession>(); const errors = new Map<string, Error>();
  const parked = new Map<string, { terminal: TerminalAddress; ownerSessionId: string | null }>(); let focused: string | undefined; let nextTab = 0; const placeholders = new Set<string>();
  async function allocate(name: string, spaceName: string, spaceId: SpaceId | null, argv: readonly string[], existingTab?: LayoutSnapshot['spaces'][number]['tabs'][number]) {
    const flags = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(argv.slice(0, 7)).toEqual([process.execPath, '-e', 'process.env.PI_CODING_AGENT_DIR=process.argv[1].slice("PI_CODING_AGENT_DIR=".length);process.argv.splice(1,2);import(require("node:url").pathToFileURL(process.argv[1]).href)', `PI_CODING_AGENT_DIR=${root}`, process.execPath, join(root, 'cli.mjs'), 'resume']);
    let space = layout.spaces.find(s => s.id === spaceId);
    if (!space) { space = { id: `space-${layout.spaces.length}` as SpaceId, name: spaceName, tabs: [] }; layout.spaces.push(space); }
    const terminal = `fresh-${nextPid}` as TerminalAddress;
    const tab = existingTab ?? { id: `${space.id}-tab-${nextTab++}` as TabId, name, ownerSessionId: null as string | null, terminal, terminals: [] };
    if (!existingTab) space.tabs.push(tab);
    const row = { terminal, ownerSessionId: null as string | null }; (tab.terminals ??= []).push(row);
    try {
      const result = await launchSession({ sessionFile: flags('--file'), sessionId: flags('--session-id') as SessionId, cwd: flags('--cwd'), environment: { agentDirectory: root, extensionArguments: [] } }, {
        leases: processInventory.leases, processInventory: selectedProcessInventory({ ...config, spaces: [{ name: spaceName, sessions: [{ file: flags('--file') }] }] }, processInventory), processIdentity: { pid: 400, startIdentity: 'setup' }, env: {}, publishMapping: async result => { await createTerminalRegistry(root).record({ owner: { sessionId: result.sessionId, generation: 'fixture' as import('../contracts.js').Generation, sessionFile: result.sessionFile, name, cwd: result.cwd, terminal: { coreId: 'fixture' as import('../contracts.js').CoreId, terminalId: terminal as unknown as import('../contracts.js').TerminalId, address: terminal, socket: join(root, 'fixture.sock'), sessionNamespace: 'fixture' } }, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: root, extensionArguments: [] } }); },
        spawnPi: async request => { if (fail) throw new Error('lost launch'); const pid = nextPid++; probes.set(pid, { kind: 'live', startIdentity: `start:${pid}` }); writers.push(request.sessionId); await writeFile(join(root, 'writers.json'), JSON.stringify(writers)); return { pid, startIdentity: `start:${pid}` }; },
      });
      const { token: _token, ...safe } = result; results.set(terminal, safe); row.ownerSessionId = result.sessionId; if (!existingTab) tab.ownerSessionId = result.sessionId;
    } catch (error) { errors.set(terminal, error as Error); }
    return { space: space.id, tab: tab.id, terminal };
  }
  ports = { processInventory, registry: createTerminalRegistry(root), listSessionFiles: async () => files, journalRoot: join(root, 'setup'), coreIdentity: async () => ({ coreId: 'fixture' as import('../contracts.js').CoreId, socket: join(root, 'fixture.sock'), sessionNamespace: 'fixture' }), clock: () => ticks,
    reportLive: rows => { listed = rows.map(r => ({ name: r.sessionName, pid: r.pid })); }, reportBlocked: message => { messages.push(message); }, notesDisabled: async () => notes,
    waitForChange: async () => { waits++; ticks += 100; if (waits === 1) probes.set(100, { kind: 'absent' }); else unknown = false; },
    layoutSnapshot: async () => structuredClone(layout), launcher: { nodePath: process.execPath, cliPath: join(root, 'cli.mjs'), configPath: join(root, 'config.json') },
    app: { tabTerminals: async () => [], ownerPlacement: async address => { for (const space of layout.spaces) for (const tab of space.tabs) if (tab.terminals ? tab.terminals.some(t => t.terminal === address) : tab.terminal === address) return { space: space.id, tab: tab.id, pane: `pane-${address}` as import('../contracts.js').PaneId }; throw new HerdrError('owner-unplaced', 'Not placed'); }, awaitPane: async (address, expected) => { const placement = await ports.app.ownerPlacement(address); if (placement.tab !== expected.tab || placement.space !== expected.space) throw new HerdrError('pane-timeout', 'Terminal did not reach the expected tab'); return placement.pane; }, command: async (command, args) => {
      if (command === 'space.new') return allocate(args.tab as string, args.name as string, null, args.argv as string[]);
      if (command === 'tab.new' && args.mod === 'pane') {
        const space = layout.spaces.find(space => space.id === args.space)!;
        const tab = { id: `empty-${nextTab++}` as TabId, name: String(args.name), terminal: null, terminals: [], ownerSessionId: null };
        space.tabs.push(tab); placeholders.add(`pane-${tab.id}`); return { space: space.id, tab: tab.id, pane: `pane-${tab.id}` as never };
      }
      if (command === 'tab.new') return allocate(args.name as string, '', args.space as SpaceId, args.argv as string[]);
      if (command === 'pane.focus') { focused = String(args.terminal ?? args.pane); return {}; }
      if (command === 'terminal.park') {
        for (const space of layout.spaces) for (const tab of [...space.tabs]) {
          const row = tab.terminals?.find(t => t.terminal === args.terminal);
          if (row) { parked.set(row.terminal, { ...row, ownerSessionId: row.ownerSessionId ?? null }); tab.terminals = tab.terminals!.filter(t => t !== row); if (!tab.terminals.length) space.tabs = space.tabs.filter(t => t !== tab); }
        }
        return { pending: true };
      }
      if (command === 'terminal.keep') {
        for (const space of layout.spaces) for (const tab of space.tabs) if (tab.terminals?.some(t => t.terminal === focused) || focused === `pane-${tab.id}`) {
          const row = parked.get(String(args.terminal)); if (!row) throw new Error('Expected a parked allocation');
          if (args.place === 'tab') {
            const kept = { id: `kept-${nextTab++}` as TabId, name: row.terminal, terminal: row.terminal, ownerSessionId: row.ownerSessionId, terminals: [row] };
            space.tabs.push(kept); parked.delete(row.terminal); focused = row.terminal;
            return { pending: true, tab: kept.id, terminal: row.terminal };
          }
          if (!['right', 'down'].includes(String(args.place))) throw new Error('Unsupported keep placement');
          tab.terminals!.push(row); parked.delete(row.terminal); splits.push({ anchor: focused!, direction: String(args.place) });
          return { pending: true, tab: tab.id, terminal: row.terminal };
        }
        throw new Error('Keep target not found');
      }
      if (command === 'pane.close') { if (!placeholders.delete(String(args.pane))) return { error: { code: 'app-error', message: 'no such pane' } }; for (const space of layout.spaces) space.tabs = space.tabs.filter(tab => tab.terminals?.length || args.pane !== `pane-${tab.id}`); return {}; }
      if (command === 'tab.rename') { const tab = layout.spaces.flatMap(s => s.tabs).find(t => t.id === args.id); if (tab) tab.name = args.name as string; return {}; }
      if (command === 'tab.close') { for (const space of layout.spaces) space.tabs = space.tabs.filter(t => t.id !== args.id); return {}; }
      if (command === 'space.select') return {}; throw new Error('Unexpected app command');
    } },
    terminalState: async placement => errors.has(placement.terminal) ? 'finished' : results.has(placement.terminal) && probes.get(results.get(placement.terminal)!.pid)?.kind === 'live' ? 'live' : 'absent',
    verifyOwner: async (target, placement) => {
      const launchError = errors.get(placement.terminal);
      if (launchError) throw launchError;
      if (await ports.terminalState!(placement) === 'finished') throw new HerdrError('owner-terminal-finished', 'New owner terminal finished before activation');
      for (const record of await processInventory.presence.list()) {
        if (record.kind !== 'top-level' || record.hcAddress !== placement.terminal || !record.sessionId || record.sessionId === target.sessionId) continue;
        const process = await processInventory.probe(record.pid);
        if (process.kind === 'live' && process.startIdentity === record.startIdentity) throw new HerdrError('owner-session-switched', 'A different session is open');
      }
      const result = results.get(placement.terminal);
      const probe = result && await processInventory.probe(result.pid);
      if (probe?.kind !== 'live' || probe.startIdentity !== result!.startIdentity) throw new HerdrError('owner-activation-unconfirmed', 'New owner did not activate within 30 seconds');
      return result!;
    },
  };
});
afterEach(async () => rm(root, { recursive: true, force: true }));
async function addSession(id: string, name: string) {
  const file = join(root, `${id}.jsonl`); await writeFile(file, [JSON.stringify({ type: 'session', version: 3, id, cwd: root }), JSON.stringify({ type: 'session_info', name: 'old name' }), JSON.stringify({ type: 'session_info', name })].join('\n') + '\n'); files.push(file); config.spaces[0].sessions.push({ file }); return file;
}
function ownerFeed(result: Awaited<ReturnType<typeof setupSpaces>>, sessionId: string) {
  const index = result.launched.findIndex(owner => owner.sessionId === sessionId);
  if (index < 0) return null;
  const owner = result.launched[index];
  return { sessionId: owner.sessionId, owner: { sessionId: owner.sessionId, sessionFile: owner.sessionFile, cwd: owner.cwd, terminal: { address: result.tabs[index].terminal } } } as never;
}
async function confirmOwners(result: Awaited<ReturnType<typeof setupSpaces>>) {
  for (const [index, owner] of result.launched.entries()) await ports.processInventory.presence.record({ ...owner, sessionName: owner.sessionId, kind: 'top-level', hcAddress: result.tabs[index].terminal });
  ports.liveSessionFeed = async target => ownerFeed(result, target.sessionId);
}
it('cutover lists names and blocks an unrecorded process before opening files', async () => {
  const file = await addSession('s0', 'named session'); for (let i = 1; i < 10; i++) await addSession(`s${i}`, `session ${i}`);
  await ports.processInventory.presence.record({ pid: 100, startIdentity: 'start:100', sessionFile: file, sessionName: 'named session', kind: 'top-level', hcAddress: null }); probes.set(100, { kind: 'live', startIdentity: 'start:100' }); unknown = true;
  // A live file is deliberately invalid: discovery must not read it. Restore only after both blockers leave.
  await writeFile(file, 'not readable metadata'); const originalWait = ports.waitForChange;
  ports.waitForChange = async (deadline, signal) => { if (!waits) expect(listed).toContainEqual({ name: 'named session', pid: 100 }); expect(writers).toEqual([]); await originalWait(deadline, signal); if (!unknown) await writeFile(file, JSON.stringify({ type: 'session', id: 's0', cwd: root }) + '\n'); };
  const manifest = await discoverSessions(config, ports); expect(manifest.sessions[0]).toMatchObject({ file, name: 'named session', sessionId: null });
  const result = await setupSpaces(config, ports); expect(result.launched.map(r => r.sessionId)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
  expect(messages.join('\n')).toContain('/reload in that session'); expect(waits).toBe(2); expect(layout.spaces.flatMap(s => s.tabs)).toHaveLength(10);
  await setupSpaces(config, ports); expect(layout.spaces.flatMap(s => s.tabs)).toHaveLength(10); expect(JSON.parse(await readFile(join(root, 'writers.json'), 'utf8'))).toHaveLength(10);
});
it('discovery reads latest names, resolves exact IDs and preserves shared cwd', async () => {
  await addSession('s1', 'duplicate'); await addSession('s2', 'duplicate'); config.spaces[0].sessions = [{ name: 'duplicate' }];
  await expect(discoverSessions(config, ports)).rejects.toMatchObject({ code: 'session-selector-ambiguous' });
  config.spaces[0].sessions = [{ name: 'duplicate', sessionId: 's2' }]; expect((await discoverSessions(config, ports)).sessions).toMatchObject([{ sessionId: 's2', cwd: root, name: 'duplicate' }]);
});
it('an unrelated recorded live session remains open while selected closed files launch', async () => {
  const other = await addSession('other', 'unrelated'); await addSession('selected', 'closed'); config.spaces[0].sessions.shift();
  await ports.processInventory.presence.record({ pid: 100, startIdentity: 'start:100', sessionFile: other, sessionName: 'unrelated', kind: 'top-level', hcAddress: null }); probes.set(100, { kind: 'live', startIdentity: 'start:100' });
  await writeFile(other, 'invalid live file'); await setupSpaces(config, ports); expect(writers).toEqual(['selected']); expect(waits).toBe(0); expect(probes.get(100)?.kind).toBe('live');
});
it('unclassified pi and live writers without open fds reach the 30-minute deadline', async () => {
  await addSession('s1', 'named'); unknown = true; ports.waitForChange = async () => { ticks += 30 * 60 * 1000; };
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'cutover-deadline' }); expect(writers).toEqual([]); expect(layout.spaces).toEqual([]);
});
it('notes must be disabled before any fresh terminal allocation', async () => {
  await addSession('s1', 'named'); notes = false; await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'notes-enabled' }); expect(layout.spaces).toEqual([]);
});
it('a crash after tab creation reuses its journalled IDs without overwriting a wrong owner', async () => {
  await addSession('s1', 'named'); const original = ports.verifyOwner; ports.verifyOwner = async () => { throw new Error('crash after tab'); };
  await expect(setupSpaces(config, ports)).rejects.toThrow('crash after tab'); expect(layout.spaces[0].tabs).toHaveLength(1);
  ports.verifyOwner = original; await setupSpaces(config, ports); expect(layout.spaces[0].tabs).toHaveLength(1); expect(writers).toEqual(['s1']);
});
it('wrong-owner name collisions and uncertain failed launches cannot create a second writer', async () => {
  await addSession('s1', 'named'); layout.spaces.push({ id: 'foreign-space' as SpaceId, name: 'Space A', tabs: [] });
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'space-name-conflict' }); expect(writers).toEqual([]);
  layout.spaces = []; fail = true; await expect(setupSpaces(config, ports)).rejects.toThrow('lost launch'); expect(layout.spaces[0].tabs).toHaveLength(1);
  probes.set(400, { kind: 'unknown' }); fail = false; ports.waitForChange = async () => { ticks += 30 * 60 * 1000; }; await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'cutover-deadline' }); expect(writers).toEqual([]);
});

it('cached native notes cannot follow a retired identity into a new pi draft', async () => {
  const file = await addSession('s1', 'named');
  await ports.registry.record({ owner: { sessionId: 's1' as SessionId, generation: 'retired' as import('../contracts.js').Generation, sessionFile: file, name: 'named', cwd: root, terminal: { coreId: 'fixture' as import('../contracts.js').CoreId, terminalId: 'retired' as import('../contracts.js').TerminalId, address: 'retired' as TerminalAddress, socket: join(root, 'fixture.sock'), sessionNamespace: 'fixture' } }, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: root, extensionArguments: [] } });
  ports.app.command = async () => ({ space: 'space' as SpaceId, tab: 'tab' as TabId, terminal: 'retired' as TerminalAddress });
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'terminal-not-fresh' });
  expect(writers).toEqual([]);
});

import { runAcceptance } from './testutil.js';
import { acceptanceSpaces, acceptanceG } from './acceptance/g.js';
it.skipIf(process.env.SPIDER_HERDR_APP_E2E === '1' && process.env.SPIDER_HERDR_APP_TESTS !== '1')('spaces acceptance (real app requires user opt-in)', async () => runAcceptance('spaces', acceptanceSpaces), 60000);

it.skipIf(process.env.SPIDER_HERDR_APP_E2E === '1' && process.env.SPIDER_HERDR_APP_TESTS !== '1')('combined resume and spaces acceptance leaves no finished resume fixture', async () => runAcceptance('combined-resume-spaces', acceptanceG), 60000);

it('cutover refuses a recorded absolute extension argument before allocating any tab', async () => {
  const file = await addSession('s1', 'named');
  await ports.registry.record({ owner: { sessionId: 's1' as SessionId, generation: 'old' as import('../contracts.js').Generation, sessionFile: file, cwd: root, name: 'named', terminal: { coreId: 'fixture' as import('../contracts.js').CoreId, terminalId: 'old' as import('../contracts.js').TerminalId, address: 'old' as TerminalAddress, socket: join(root, 'fixture.sock'), sessionNamespace: 'fixture' } }, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: root, extensionArguments: ['--extension', join(root, 'foreign-extension.js')] } });
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'session-explicit-extensions', message: expect.stringContaining('named') });
  expect(writers).toEqual([]); expect(layout.spaces).toEqual([]);
});

it('a changed grouping cannot silently reuse the old journalled placement', async () => {
  const file = await addSession('s1', 'named'); await setupSpaces(config, ports);
  const journal = await readFile(join(root, 'setup/spaces.json'), 'utf8');
  config.spaces = [{ name: 'Space A', sessions: [] }, { name: 'Different space', sessions: [{ file }] }];
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'tab-owner-conflict' });
  expect(writers).toEqual(['s1']); expect(await readFile(join(root, 'setup/spaces.json'), 'utf8')).toBe(journal);
});
it('the 30-minute deadline expires even when a process watcher never acknowledges it', async () => {
  await addSession('s1', 'named'); unknown = true; vi.useFakeTimers(); ports.clock = () => Date.now();
  let entered!: () => void; let release!: () => void; const started = new Promise<void>(resolve => entered = resolve); const blocked = new Promise<void>(resolve => release = resolve);
  let signal: AbortSignal | undefined; ports.waitForChange = async (_deadline, abort) => { signal = abort; entered(); await blocked; };
  let outcome = 'pending'; const completed = setupSpaces(config, ports).then(() => { outcome = 'opened'; }, error => { outcome = error.code; });
  try { await started; await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1); await vi.waitFor(() => expect(outcome).toBe('cutover-deadline')); expect(signal?.aborted).toBe(true); expect(writers).toEqual([]); }
  finally { release(); await completed; vi.useRealTimers(); }
});

it('all unjournalled same-name spaces are listed before any new space is allocated', async () => {
  await addSession('first', 'first'); await addSession('last', 'last');
  config.spaces = [{ name: 'New space', sessions: [{ name: 'first' }] }, { name: 'Conflict', sessions: [{ name: 'last' }] }];
  layout.spaces.push({ id: 'unowned' as SpaceId, name: 'Conflict', tabs: [{ id: 'unowned-tab' as TabId, name: 'old shell', terminal: 'unowned-terminal' as TerminalAddress, ownerSessionId: null }] });
  const before = structuredClone(layout);
  await expect(preflightSpaces(config, ports)).rejects.toMatchObject({ code: 'space-name-conflict' });
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'space-name-conflict', message: expect.stringContaining('unowned-terminal') });
  expect(layout).toEqual(before); expect(writers).toEqual([]); await expect(access(join(root, 'setup'))).rejects.toMatchObject({ code: 'ENOENT' }); await expect(readFile(join(root, 'setup/spaces.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('explicit space adoption only appends tabs and its rerun preserves the journal artifact', async () => {
  await addSession('s1', 'named');
  layout.spaces.push({ id: 'existing-space' as SpaceId, name: 'Space A', tabs: [{ id: 'old-tab' as TabId, name: 'named', terminal: 'old-terminal' as TerminalAddress, ownerSessionId: null }] });
  probes.set(900, { kind: 'live', startIdentity: 'unchanged-shell' }); const before = structuredClone(layout.spaces[0].tabs);
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'space-name-conflict' }); expect(layout.spaces[0].tabs).toEqual(before);
  await preflightSpaces(config, ports, { adoptExistingSpaces: ['Space A'] }); await expect(access(join(root, 'setup'))).rejects.toMatchObject({ code: 'ENOENT' });
  const result = await setupSpaces(config, ports, { adoptExistingSpaces: ['Space A', 'Space A'] });
  expect(result.tabs[0].space).toBe('existing-space'); expect(layout.spaces[0].tabs).toHaveLength(2); expect(layout.spaces[0].tabs[0]).toEqual(before[0]); expect(probes.get(900)).toEqual({ kind: 'live', startIdentity: 'unchanged-shell' });
  const path = join(root, 'setup/spaces.json'); const written = await stat(path, { bigint: true }); const bytes = await readFile(path, 'utf8');
  await setupSpaces(config, ports, { adoptExistingSpaces: ['Space A'] }); await setupSpaces(config, ports);
  const unchanged = await stat(path, { bigint: true }); expect([unchanged.ino, unchanged.mtimeNs]).toEqual([written.ino, written.mtimeNs]); expect(await readFile(path, 'utf8')).toBe(bytes); expect(writers).toEqual(['s1']); expect(layout.spaces[0].tabs[0]).toEqual(before[0]);
});

it('an exact ID selects a live non-HC session without reading an unrelated same-name file', async () => {
  const selected = await addSession('one', 'same'); const unrelated = await addSession('two', 'same');
  for (const [pid, file, id] of [[60, selected, 'one'], [61, unrelated, 'two']] as const) {
    probes.set(pid, { kind: 'live', startIdentity: `start:${pid}` });
    await ports.processInventory.presence.record({ pid, startIdentity: `start:${pid}`, sessionId: id as SessionId, sessionFile: file, sessionName: 'same', kind: 'top-level', hcAddress: null });
  }
  config.spaces[0].sessions = [{ name: 'same', sessionId: 'one' }]; await writeFile(unrelated, 'Reading this live file is forbidden\n');
  ports.waitForChange = async () => { waits++; probes.set(60, { kind: 'absent' }); await ports.processInventory.presence.remove({ pid: 60, startIdentity: 'start:60' }); };
  expect((await discoverSessions(config, ports)).sessions[0].file).toBe(selected);
  await setupSpaces(config, ports); expect(waits).toBe(1); expect(writers).toEqual(['one']); expect((await ports.processInventory.presence.list()).some(r => r.pid === 61)).toBe(true);
});

it('the distributable example is schema-valid deployment data, not a hard-coded user grouping', async () => {
  const example = parseHerdrConfig(JSON.parse(await readFile(new URL('../../assets/config.example.json', import.meta.url), 'utf8')));
  expect(example.spaces[0].name).toBe('Example space'); expect(example.machines[0].name).toBe('example-machine'); expect(example.agentDirectory).toBe('/path/to/pi-agent');
});

it('a reused verified owner returns a fully resolved manifest without opening its live file', async () => {
  const file = await addSession('s1', 'named'); probes.set(60, { kind: 'live', startIdentity: 'start:60' });
  await ports.processInventory.presence.record({ pid: 60, startIdentity: 'start:60', sessionId: 's1' as SessionId, sessionFile: file, sessionName: 'named', kind: 'top-level', hcAddress: 'existing-terminal' as TerminalAddress });
  const manifest = await discoverSessions(config, ports); expect(manifest.unresolved).toBe(true); await writeFile(file, 'Reading the live file is forbidden');
  const result = await startCutover(manifest, { ...ports, alreadyLaunched: async () => ({ pid: 60, startIdentity: 'start:60', sessionId: 's1' as SessionId, sessionFile: file, cwd: root }), launchLeasedSession: async () => { throw new Error('Must reuse the verified owner'); } });
  expect(result.manifest.unresolved).toBe(false); expect(result.manifest.sessions[0].cwd).toBe(root);
});

it('a proved dead failed launcher is retired and replaced on retry', async () => {
  await addSession('s1', 'named'); fail = true;
  await expect(setupSpaces(config, ports)).rejects.toThrow('lost launch');
  const old = (await readCutoverRecovery(ports.journalRoot)).createdTabs[0];
  fail = false; nextPid++;
  const result = await setupSpaces(config, ports);
  expect(result.tabs).toHaveLength(1); expect(result.tabs[0].terminal).not.toBe(old.terminal);
  expect(layout.spaces[0].tabs).toHaveLength(1); expect(writers).toEqual(['s1']);
});
it('a lost allocation reply reconciles the labelled tab without a second writer', async () => {
  await addSession('s1', 'named'); const command = ports.app.command; let crash = true;
  ports.app.command = async (name, args) => { const reply = await command(name, args); if (name === 'space.new' && crash) { crash = false; throw new Error('reply lost'); } return reply; };
  await expect(setupSpaces(config, ports)).rejects.toThrow('reply lost');
  const before = layout.spaces[0].tabs[0].terminal;
  await setupSpaces(config, ports);
  expect(layout.spaces[0].tabs).toHaveLength(1); expect(layout.spaces[0].tabs[0]).toMatchObject({ terminal: before, name: 'named' }); expect(writers).toEqual(['s1']);
});
it('still refuses a non-unique allocation label after a lost reply', async () => {
  await addSession('one', 'First');
  const command = ports.app.command;
  ports.app.command = async (name, args) => {
    const reply = await command(name, args);
    if (name === 'space.new') {
      const space = layout.spaces[0];
      space.tabs.push({ ...space.tabs[0], id: 'foreign-tab' as TabId });
      throw new Error('reply lost');
    }
    return reply;
  };
  await expect(setupSpaces(config, ports)).rejects.toThrow('reply lost');
  const before = structuredClone(layout);
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'tab-owner-conflict', message: 'Allocation label is not unique' });
  expect(writers).toEqual(['one']);
  expect(layout).toEqual(before);
});

it('forgetting closed created tabs permits setup again without adopting user tabs', async () => {
  await addSession('s1', 'named'); const first = await setupSpaces(config, ports);
  probes.set(first.launched[0].pid, { kind: 'absent' });
  await ports.app.command('tab.close', { id: first.tabs[0].tab });
  await forgetCutoverTabs(ports.journalRoot, first.tabs, await ports.layoutSnapshot());
  nextPid++;
  const second = await setupSpaces(config, ports);
  expect(second.tabs).toHaveLength(1); expect(writers).toEqual(['s1', 's1']);
});
it('records a user-moved session in a foreign tab and does not move it back on setup', async () => {
  await addSession('s1', 'first'); await addSession('s2', 'second');
  const initial = await setupSpaces(config, ports), moved = initial.tabs[0];
  const originalSpace = layout.spaces[0], originalTab = originalSpace.tabs.find(tab => tab.id === moved.tab)!;
  const row = originalTab.terminals!.find(value => value.terminal === moved.terminal)!;
  originalSpace.tabs = originalSpace.tabs.filter(tab => tab !== originalTab);
  layout.spaces.push({ id: 'foreign-space' as SpaceId, name: 'Other', tabs: [{ id: 'foreign-tab' as TabId, name: 'User tab', terminal: 'shell' as TerminalAddress, ownerSessionId: null, terminals: [{ terminal: 'shell' as TerminalAddress }, row] }] });
  expect((spaceSetup as any).recordSessionMove).toBeTypeOf('function');
  await (spaceSetup as any).recordSessionMove(ports.journalRoot, { sessionId: 's1', terminal: moved.terminal }, await ports.layoutSnapshot());
  const recovery = await readCutoverRecovery(ports.journalRoot);
  expect(recovery.entries.find(entry => entry.target.sessionId === 's1')).toMatchObject({ placement: { space: 'foreign-space', tab: 'foreign-tab', terminal: moved.terminal }, manuallyMoved: true });
  const before = structuredClone(layout);
  await setupSpaces(config, ports);
  expect(layout).toEqual(before);
  expect(writers).toEqual(['s1', 's2']);
  const placement = recovery.entries.find(entry => entry.target.sessionId === 's1')!.placement;
  await expect(forgetCutoverTabs(ports.journalRoot, [placement], await ports.layoutSnapshot())).rejects.toMatchObject({ code: 'cutover-tab-still-exists' });
  const userTab = layout.spaces[1].tabs[0]; userTab.terminals = userTab.terminals!.filter(value => value.terminal !== moved.terminal);
  await forgetCutoverTabs(ports.journalRoot, [placement], await ports.layoutSnapshot());
  expect(userTab.terminals).toEqual([{ terminal: 'shell' }]);
  expect((await readCutoverRecovery(ports.journalRoot)).entries.map(entry => entry.target.sessionId)).toEqual(['s2']);
});

it('moves an owner session and writes its observed destination into the setup journal', async () => {
  await addSession('s1', 'first'); await addSession('s2', 'second');
  const initial = await setupSpaces(config, ports), source = initial.tabs[0], target = initial.tabs[1];
  ports.app.tabSpace = async tab => layout.spaces.find(space => space.tabs.some(value => value.id === tab))?.id ?? null;
  const hc = { setLabels: async (address: TerminalAddress, labels: Record<string, string>) => {
    const space = layout.spaces.find(value => value.id === labels['herdr.space'])!;
    const tab = space.tabs.find(value => value.id === labels['herdr.tab'])!;
    tab.terminals!.push({ terminal: address, ownerSessionId: 's1' });
  } };
  const url = new URL('../spaces/move.ts', import.meta.url).href;
  const module: any = await import(url).catch(() => ({}));
  expect(module.moveOwnedSession).toBeTypeOf('function');
  await module.moveOwnedSession({ sessionId: 's1', terminal: source.terminal, coreId: 'fixture' }, { kind: 'tab', tab: target.tab }, {
    app: ports.app, hc, journalRoot: ports.journalRoot, layoutSnapshot: ports.layoutSnapshot, clock: Date.now,
  });
  expect((await ports.app.ownerPlacement(source.terminal)).tab).toBe(target.tab);
  expect((await readCutoverRecovery(ports.journalRoot)).entries.find(entry => entry.target.sessionId === 's1')).toMatchObject({ placement: { tab: target.tab }, manuallyMoved: true });
  const before = structuredClone(layout); await setupSpaces(config, ports);
  expect(layout).toEqual(before); expect(writers).toEqual(['s1', 's2']);
});

it('does not journal an ambiguous terminal appearing in two tabs', async () => {
  await addSession('s1', 'first');
  const initial = await setupSpaces(config, ports), moved = initial.tabs[0];
  const before = await readFile(join(ports.journalRoot, 'spaces.json'), 'utf8');
  layout.spaces[0].tabs.push({ id: 'foreign-tab' as TabId, name: 'Foreign', terminal: moved.terminal, ownerSessionId: 'other', terminals: [{ terminal: moved.terminal, ownerSessionId: 'other' }] });
  await expect((spaceSetup as any).recordSessionMove(ports.journalRoot, { sessionId: 's1', terminal: moved.terminal }, await ports.layoutSnapshot())).rejects.toMatchObject({ code: 'tab-owner-conflict' });
  expect(await readFile(join(ports.journalRoot, 'spaces.json'), 'utf8')).toBe(before);
});

it('invalid unrelated sessions are counted and skipped without aborting discovery', async () => {
  await addSession('s1', 'named'); const bad = join(root, 'broken.jsonl'); await writeFile(bad, 'truncated'); files.push(bad);
  config.spaces[0].sessions = [{ name: 'named' }]; const warnings: number[] = [];
  ports.reportSkipped = count => warnings.push(count);
  expect((await discoverSessions(config, ports)).sessions[0]).toMatchObject({ sessionId: 's1', name: 'named' }); expect(warnings).toEqual([1]);
});
it('file selection avoids unrelated files while streaming a large selected session', async () => {
  const file = await addSession('s1', 'named'); await truncate(file, 512 * 1024 * 1024 + 1);
  files.push(join(root, 'unreadable.jsonl'));
  const manifest = await discoverSessions(config, ports);
  expect(manifest.sessions[0]).toMatchObject({ file, sessionId: 's1', cwd: root, name: 'named' });
});

it('cutover reports and waits only for the selected recorded process', async () => {
  const selected = await addSession('selected', 'selected'); const other = await addSession('other', 'other'); const another = await addSession('another', 'another');
  config.spaces[0].sessions = [{ file: selected }];
  for (const [pid, file, sessionId] of [[100, selected, 'selected'], [101, other, 'other'], [102, another, 'another']] as const) {
    probes.set(pid, { kind: 'live', startIdentity: `start:${pid}` });
    await ports.processInventory.presence.record({ pid, startIdentity: `start:${pid}`, sessionId: sessionId as SessionId, sessionFile: file, sessionName: sessionId, kind: 'top-level', hcAddress: null });
  }
  ports.waitForChange = async () => { expect(listed.map(r => r.pid)).toEqual([100]); waits++; probes.set(100, { kind: 'absent' }); };
  await setupSpaces(config, ports); expect(waits).toBe(1); expect(writers).toEqual(['selected']); expect(probes.get(101)?.kind).toBe('live'); expect(probes.get(102)?.kind).toBe('live');
});
it('empty cutover selection never waits for recorded or unrecorded processes', async () => {
  unknown = true; probes.set(100, { kind: 'live', startIdentity: 'start:100' });
  await ports.processInventory.presence.record({ pid: 100, startIdentity: 'start:100', sessionFile: join(root, 'other.jsonl'), sessionName: 'other', kind: 'top-level', hcAddress: null });
  ports.waitForChange = async () => { throw new Error('Empty selection cannot wait'); };
  expect((await setupSpaces(config, ports)).tabs).toEqual([]); expect(writers).toEqual([]); expect(listed).toEqual([]);
});
it('an unrecorded pi blocks a nonempty selection with per-session repair advice', async () => {
  await addSession('s1', 'named'); unknown = true;
  ports.waitForChange = async () => { ticks += 30 * 60 * 1000; };
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'cutover-deadline' });
  expect(messages.join('\n')).toContain('999'); expect(messages.join('\n')).toContain('/reload in that session'); expect(messages.join('\n')).toContain('closing it'); expect(writers).toEqual([]);
});

it('an aborted wait opens no tab and is retryable after the selected owner exits', async () => {
  const file = await addSession('s1', 'named'); const controller = new AbortController();
  probes.set(100, { kind: 'live', startIdentity: 'start:100' });
  await ports.processInventory.presence.record({ pid: 100, startIdentity: 'start:100', sessionFile: file, sessionName: 'named', kind: 'top-level', hcAddress: null });
  ports.waitForChange = async () => { controller.abort(); ticks += 30 * 60 * 1000; };
  await expect(setupSpaces(config, ports, { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' }); expect(layout.spaces).toEqual([]);
  probes.set(100, { kind: 'absent' }); await setupSpaces(config, ports); expect(writers).toEqual(['s1']);
});

it('streaming name lookup preserves UTF-8 across chunk boundaries', async () => {
  const header = JSON.stringify({ type: 'session', version: 3, id: 'utf8', cwd: root }) + '\n';
  const info = JSON.stringify({ type: 'session_info', name: 'Newest 😀' }) + '\n';
  const overhead = Buffer.byteLength(JSON.stringify({ type: 'message', text: '' }) + '\n');
  const padding = 65535 - Buffer.byteLength(header) - Buffer.byteLength(info.slice(0, info.indexOf('😀'))) - overhead;
  const body = JSON.stringify({ type: 'message', text: 'x'.repeat(padding) }) + '\n';
  const file = join(root, 'utf8.jsonl'); await writeFile(file, header + body + info);
  expect((await readSessionMetadata(file)).name).toBe('Newest 😀');
});

it('a PID now recorded on an unselected session cannot keep its old selected lease blocking', async () => {
  const file = await addSession('selected', 'selected'), other = await addSession('other', 'other'); config.spaces[0].sessions = [{ file }];
  probes.set(100, { kind: 'live', startIdentity: 'old-start' });
  await ports.processInventory.leases.claim(file, { pid: 100, startIdentity: 'old-start' }, ports.processInventory);
  await ports.processInventory.presence.record({ pid: 100, startIdentity: 'old-start', sessionFile: file, sessionId: 'selected' as SessionId, sessionName: 'selected', kind: 'top-level', hcAddress: null });
  probes.set(100, { kind: 'live', startIdentity: 'new-start' });
  await ports.processInventory.presence.record({ pid: 100, startIdentity: 'new-start', sessionFile: other, sessionId: 'other' as SessionId, sessionName: 'other', kind: 'top-level', hcAddress: null });
  ports.waitForChange = async () => { throw new Error('The current process is recorded on another session'); };
  await setupSpaces(config, ports); expect(writers).toEqual(['selected']); expect(waits).toBe(0);
});

// Regression: a file selector must not lose a name once messages push it out of the tail window.
it('file selectors read early names through large messages and use the latest committed name', async () => {
  const file = await addSession('early', 'Early 😀');
  const contents = await readFile(file, 'utf8'), firstLine = contents.indexOf('\n') + 1;
  await writeFile(file, contents.slice(0, firstLine) + JSON.stringify({ type: 'message', text: 'x'.repeat(70000) }) + '\n' + contents.slice(firstLine));
  const message = JSON.stringify({ type: 'message', text: 'x'.repeat(2 * 1024 * 1024) }) + '\n';
  await writeFile(file, message, { flag: 'a' });
  expect((await discoverSessions(config, ports)).sessions[0].name).toBe('Early 😀');
  expect((await readSessionMetadata(file)).name).toBe('Early 😀');
  await writeFile(file, JSON.stringify({ type: 'session_info', name: 'Latest 雪' }) + '\n' + message + '{"type":"session_info","name":"Uncommitted"}', { flag: 'a' });
  expect((await readSessionMetadata(file)).name).toBe('Latest 雪');
  config.spaces[0].sessions = [{ name: 'Latest 雪' }];
  expect((await discoverSessions(config, ports)).sessions[0].sessionId).toBe('early');
});

it('cutover prints unchanged live and blocked advice once and prints it again when it changes', async () => {
  const file = await addSession('selected', 'selected');
  probes.set(100, { kind: 'live', startIdentity: 'start:100' });
  await ports.processInventory.presence.record({ pid: 100, startIdentity: 'start:100', sessionFile: file, sessionName: 'selected', kind: 'top-level', hcAddress: null });
  const reports: number[][] = [];
  ports.reportLive = rows => { reports.push(rows.map(row => row.pid)); };
  ports.waitForChange = async () => {
    waits++; ticks += 100;
    if (waits === 2) { unknown = true; await ports.processInventory.presence.record({ pid: 100, startIdentity: 'start:100', sessionFile: file, sessionName: 'Renamed', kind: 'top-level', hcAddress: null }); }
    if (waits === 3) { unknown = false; probes.set(100, { kind: 'absent' }); }
  };
  await setupSpaces(config, ports);
  expect(messages).toEqual(['Close selected session selected; PIDs: 100', expect.stringContaining('Unrecorded pi PID 999'), 'Close selected session selected; PIDs: 999']);
  expect(messages[0]).toContain('selected'); expect(messages[1]).toContain('999');
  expect(reports).toEqual([[100], [100], []]);
});

it.each([2, 3, 4, 7])('pane cutover opens %i sessions in one named tab and reruns without layout changes', async count => {
  config.layout = 'panes';
  for (let i = 0; i < count; i++) await addSession(`pane-${i}`, `Session ${i}`);
  const first = await setupSpaces(config, ports);
  expect(layout.spaces[0].tabs.map(tab => tab.name)).toEqual(['Space A']);
  expect(new Set(first.tabs.map(tab => tab.tab)).size).toBe(1);
  expect(new Set(first.tabs.map(tab => tab.terminal)).size).toBe(count);
  if (count <= 4) expect(splits).toEqual([
    { anchor: 'fresh-500', direction: 'right' },
    ...(count >= 3 ? [{ anchor: 'fresh-501', direction: 'down' }] : []),
    ...(count === 4 ? [{ anchor: 'fresh-500', direction: 'down' }] : []),
  ]);
  else expect(splits).toEqual([
    { anchor: 'fresh-500', direction: 'right' }, { anchor: 'fresh-501', direction: 'right' },
    { anchor: 'fresh-500', direction: 'down' }, { anchor: 'fresh-501', direction: 'down' },
    { anchor: 'fresh-502', direction: 'down' }, { anchor: 'fresh-505', direction: 'down' },
  ]);
  const saved = await readFile(join(root, 'setup/spaces.json'), 'utf8');
  const journal = JSON.parse(saved);
  expect(journal).toMatchObject({ version: 2, tabs: [{ name: 'Space A', sessions: expect.any(Array) }] });
  expect(journal.tabs[0].sessions).toHaveLength(count);
  const before = structuredClone(layout); await setupSpaces(config, ports);
  expect(layout).toEqual(before); expect(writers).toHaveLength(count);
  expect(await readFile(join(root, 'setup/spaces.json'), 'utf8')).toBe(saved);
});

it('a legacy journal adopts the same thirteen terminals merged into four named tabs without app commands', async () => {
  const groups = [['Planning', 4], ['Work', 3], ['Review', 3], ['Notes', 3]] as const;
  config.spaces = [{ name: 'placeholder', sessions: [] }];
  for (const [name, count] of groups) {
    const sessions = [];
    for (let i = 0; i < count; i++) { const file = await addSession(`${name}-${i}`, `${name} ${i}`); sessions.push({ file }); }
    config.spaces.push({ name, sessions });
  }
  // addSession also appends to the first group; reset to the thirteen explicit selectors.
  config.spaces.shift();
  const initial = await setupSpaces(config, ports);
  const recovery = await readCutoverRecovery(ports.journalRoot);
  // Persist the actual v1 format used before pane support.
  await writeFile(join(root, 'setup/spaces.json'), JSON.stringify({ version: 1, focused: true, spaces: layout.spaces.map(space => ({ name: space.name, id: space.id, adopted: false })), tabs: recovery.entries.map(entry => ({ ...entry, failure: null })) }));
  for (const space of layout.spaces) {
    const tabs = space.tabs; space.tabs = [{ ...tabs[0], name: space.name, terminals: tabs.map(tab => ({ terminal: tab.terminal!, ownerSessionId: tab.ownerSessionId })) }];
  }
  config.layout = 'panes'; const before = structuredClone(layout);
  ports.app.command = async command => { throw new Error(`Adoption must not issue ${command}`); };
  const adopted = await setupSpaces(config, ports);
  expect(adopted.launched).toEqual(initial.launched); expect(writers).toHaveLength(13);
  expect(layout).toEqual(before);
  const journal = JSON.parse(await readFile(join(root, 'setup/spaces.json'), 'utf8'));
  expect(journal.version).toBe(2); expect(journal.tabs.map((tab: { sessions: unknown[] }) => tab.sessions.length)).toEqual([4, 3, 3, 3]);
  // Pane order is not ownership. Reversing the layout must still recheck.
  for (const space of layout.spaces) space.tabs[0].terminals!.reverse();
  expect((await setupSpaces(config, ports)).launched).toEqual(initial.launched);
});

it('keeps hand-reorganised tabs in a mixed layout across setup runs', async () => {
  const groups = [['Tools', 4], ['Desk', 3], ['Projects', 3], ['Notes', 3]] as const;
  config.spaces = [{ name: 'placeholder', sessions: [] }];
  for (const [name, count] of groups) {
    const sessions = [];
    for (let index = 0; index < count; index++) sessions.push({ file: await addSession(`${name}-${index}`, `${name} ${index}`) });
    config.spaces.push({ name, sessions });
  }
  config.spaces.shift();
  const initial = await setupSpaces(config, ports);
  const path = join(ports.journalRoot, 'spaces.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  // Two of the original journal groups already shared a tab before the hand edits.
  for (const [first, second, name] of [[7, 8, 'Main'], [10, 12, 'Notes']] as const) {
    journal.tabs[first].name = name;
    journal.tabs[first].sessions.push(...journal.tabs[second].sessions);
  }
  journal.tabs = journal.tabs.filter((_: unknown, index: number) => index !== 8 && index !== 12);
  await writeFile(path, JSON.stringify(journal));

  const terminal = (index: number) => initial.tabs[index].terminal;
  type Tab = LayoutSnapshot['spaces'][number]['tabs'][number];
  // Like app ls, the layout knows terminal addresses, not session identities.
  const tab = (id: TabId, name: string, rows: string[]): Tab => ({
    id, name, ownerSessionId: null, terminal: rows[0] as TerminalAddress,
    terminals: rows.map(value => ({ terminal: value as TerminalAddress })),
  });
  const [tools, desk, projects, notesSpace] = layout.spaces;
  tools.name = 'workshop';
  tools.tabs = [tab(initial.tabs[0].tab, 'Toolbox', [terminal(0), 'shell-1', terminal(1), terminal(2), terminal(3)]), tab('tool-extra' as TabId, 'Extra', ['shell-2'])];
  desk.tabs = [tab(initial.tabs[4].tab, 'Desk', [terminal(4), 'shell-3', 'shell-4', terminal(5), 'shell-5']), tab('desk-extra' as TabId, 'Activity', ['shell-6', terminal(6)])];
  projects.name = 'projects'; projects.tabs = [tab(initial.tabs[7].tab, 'Main', [terminal(7), 'shell-7', 'shell-8', terminal(8)])];
  notesSpace.name = 'notes'; notesSpace.tabs = [tab(initial.tabs[10].tab, 'Notes', [terminal(12), 'shell-9', 'shell-10', 'shell-11'])];
  for (const index of [9, 10, 11]) probes.set(initial.launched[index].pid, { kind: 'absent' });
  await confirmOwners(initial);
  config.layout = 'panes';

  const before = structuredClone(layout);
  const notices: string[] = []; ports.reportLayout = message => notices.push(message);
  const commands = vi.fn(ports.app.command); ports.app.command = commands;
  const result = await setupSpaces(config, ports);
  expect(result.launched.map(row => row.sessionId)).toEqual([
    'Tools-0', 'Tools-1', 'Tools-2', 'Tools-3', 'Desk-0', 'Desk-1', 'Desk-2', 'Projects-0', 'Projects-1', 'Notes-2',
  ]);
  expect(writers.slice(13)).toEqual([]);
  expect(commands).not.toHaveBeenCalled();
  expect(layout).toEqual(before);
  expect(result.tabs.slice(0, 7).map(row => row.tab)).toEqual([
    tools.tabs[0].id, tools.tabs[0].id, tools.tabs[0].id, tools.tabs[0].id, desk.tabs[0].id, desk.tabs[0].id, desk.tabs[1].id,
  ]);
  expect(notices.filter(message => message.includes('reorganised by hand')).sort()).toEqual([
    'Tab "Activity" in space "Desk" was reorganised by hand. Setup kept it as it is.',
    'Tab "Desk" in space "Desk" was reorganised by hand. Setup kept it as it is.',
    'Tab "Toolbox" in space "workshop" was reorganised by hand. Setup kept it as it is.',
  ]);
  expect(notices.filter(message => message.includes('closed by hand')).sort()).toEqual([
    'Session "Notes 0" was closed by hand, so setup leaves it closed. Remove it from the spaces config or reopen it yourself.',
    'Session "Notes 1" was closed by hand, so setup leaves it closed. Remove it from the spaces config or reopen it yourself.',
    'Session "Projects 2" was closed by hand, so setup leaves it closed. Remove it from the spaces config or reopen it yourself.',
  ]);
  expect((await readCutoverRecovery(ports.journalRoot)).createdTabs).toEqual(result.tabs);

  const persisted = await readFile(path, 'utf8');
  await confirmOwners(result);
  notices.length = 0; commands.mockClear();
  expect(await spaceSetup.planSpaceCutover(config, ports)).toEqual([]);
  expect(await setupSpaces(config, ports)).toEqual(result);
  expect(commands).not.toHaveBeenCalled();
  expect(notices.filter(message => message.includes('by hand')).sort()).toEqual([
    'Session "Notes 0" was closed by hand, so setup leaves it closed. Remove it from the spaces config or reopen it yourself.',
    'Session "Notes 1" was closed by hand, so setup leaves it closed. Remove it from the spaces config or reopen it yourself.',
    'Session "Projects 2" was closed by hand, so setup leaves it closed. Remove it from the spaces config or reopen it yourself.',
  ]);
  expect(await readFile(path, 'utf8')).toBe(persisted);
});

it('adopts a renamed and merged tab whose pi owners exited, and leaves parked and finished terminals alone', async () => {
  for (const [id, name] of [['one', 'First'], ['two', 'Second'], ['three', 'Third'], ['four', 'Fourth'], ['five', 'Fifth']]) await addSession(id, name);
  const initial = await setupSpaces(config, ports);
  const space = layout.spaces[0], [first, second, third, fourth, fifth] = space.tabs;
  first.name = 'Combined';
  first.terminals = [...first.terminals!, ...second.terminals!, ...third.terminals!].map(({ terminal }) => ({ terminal }));
  space.tabs = [first];
  const state = ports.terminalState!;
  ports.terminalState = async placement => [first.terminal, second.terminal, fourth.terminal].includes(placement.terminal) ? 'live'
    : [third.terminal, fifth.terminal].includes(placement.terminal) ? 'finished' : state(placement);
  for (const owner of initial.launched) probes.set(owner.pid, { kind: 'absent' });
  ports.liveSessionFeed = async () => null;
  const notices: string[] = []; ports.reportLayout = message => notices.push(message);
  const commands = vi.fn(ports.app.command); ports.app.command = commands;
  const tabs = initial.tabs.map((placement, index) => index < 3 ? { ...placement, tab: first.id } : placement);
  const stopped = ['First', 'Second', 'Third', 'Fourth', 'Fifth'].map((label, index) =>
    `Session "${label}" isn't running in terminal ${initial.tabs[index].terminal}, so setup left it as it is.`);

  expect(await setupSpaces(config, ports)).toEqual({ launched: [], tabs });
  expect(await spaceSetup.planSpaceCutover(config, ports)).toEqual([]);
  expect(notices.sort()).toEqual([...stopped, 'Tab "Combined" in space "Space A" was reorganised by hand. Setup kept it as it is.'].sort());
  const recovery = await readCutoverRecovery(ports.journalRoot);
  expect(recovery.entries.filter(entry => entry.manuallyMoved).map(entry => entry.target.sessionId)).toEqual(['one', 'two', 'three']);
  expect(recovery.closedEntries).toBeUndefined();
  notices.length = 0;
  expect(await setupSpaces(config, ports)).toEqual({ launched: [], tabs });
  expect(notices.sort()).toEqual(stopped.sort());
  expect(commands).not.toHaveBeenCalled();
  expect(messages).toEqual([]);
  expect(writers).toEqual(['one', 'two', 'three', 'four', 'five']);
});

it('refuses a renamed shell if a different session verifiably owns its terminal', async () => {
  await addSession('one', 'First');
  const initial = await setupSpaces(config, ports), owner = initial.launched[0], placement = initial.tabs[0];
  const tab = layout.spaces[0].tabs[0]; tab.name = 'Edited';
  tab.terminal = placement.terminal; tab.terminals = [{ terminal: placement.terminal }];
  probes.set(owner.pid, { kind: 'absent' });
  ports.terminalState = async () => 'live';
  probes.set(900, { kind: 'live', startIdentity: 'different-owner' });
  await ports.processInventory.presence.record({ pid: 900, startIdentity: 'different-owner', kind: 'top-level', sessionId: 'other' as SessionId, sessionFile: null, sessionName: 'Other', hcAddress: placement.terminal });
  const commands = vi.fn(ports.app.command); ports.app.command = commands;
  const path = join(ports.journalRoot, 'spaces.json'), before = await readFile(path, 'utf8');

  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'tab-owner-conflict' });
  expect(commands).not.toHaveBeenCalled();
  expect(await readFile(path, 'utf8')).toBe(before);
});

it('keeps placement manual when the installer persists a tab rename without cutover', async () => {
  await addSession('one', 'First');
  const initial = await setupSpaces(config, ports);
  await confirmOwners(initial);
  layout.spaces[0].tabs[0].name = 'Edited';
  const notices: string[] = []; ports.reportLayout = message => notices.push(message);
  const path = join(ports.journalRoot, 'spaces.json'), before = await readFile(path, 'utf8');

  expect(await spaceSetup.planSpaceCutover(config, ports)).toEqual([]);
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(await spaceSetup.reconcileSpaceJournal(config, ports)).toEqual(initial);
  expect(notices).toEqual(['Tab "Edited" in space "Space A" was reorganised by hand. Setup kept it as it is.']);

  await ports.app.command('terminal.park', { terminal: initial.tabs[0].terminal });
  const commands = vi.fn(ports.app.command); ports.app.command = commands;
  expect(await spaceSetup.planSpaceCutover(config, ports)).toEqual([]);
  expect(await setupSpaces(config, ports)).toEqual(initial);
  expect(commands).not.toHaveBeenCalled();
  expect(notices).toHaveLength(1);
});

it.each(['two tabs', 'two panes', 'another owner'] as const)('refuses to adopt a renamed tab with %s for its terminal', async conflict => {
  await addSession('one', 'First'); await addSession('two', 'Second');
  await setupSpaces(config, ports);
  const [first, second] = layout.spaces[0].tabs;
  first.name = 'Edited';
  const row = first.terminals![0];
  if (conflict === 'two tabs') second.terminals!.push({ ...row });
  else if (conflict === 'two panes') first.terminals!.push({ ...row });
  else row.ownerSessionId = 'different-session';
  const path = join(ports.journalRoot, 'spaces.json');
  const before = await readFile(path, 'utf8');
  const notices: string[] = []; ports.reportLayout = message => notices.push(message);
  const commands = vi.fn(ports.app.command); ports.app.command = commands;

  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'tab-owner-conflict' });
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(commands).not.toHaveBeenCalled();
  expect(notices).toEqual([]);
});

it('adopts a merged tab containing spider viewer, observer and console panes without restarting sessions', async () => {
  await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports), recovery = await readCutoverRecovery(ports.journalRoot);
  await writeFile(join(ports.journalRoot, 'spaces.json'), JSON.stringify({ version: 1, focused: true, spaces: [{ name: 'Space A', id: layout.spaces[0].id, adopted: false }], tabs: recovery.entries.map(entry => ({ ...entry, failure: null })) }));
  const tabs = layout.spaces[0].tabs;
  layout.spaces[0].tabs = [{ ...tabs[0], name: 'Space A', terminals: [...tabs.map(tab => ({ terminal: tab.terminal!, ownerSessionId: tab.ownerSessionId })), ...['viewer', 'observer', 'console'].map(terminal => ({ terminal: terminal as TerminalAddress, ownerSessionId: null }))] }];
  (ports as any).terminalLabels = async (address: string) => ({ 'spider.kind': { viewer: 'subagent-viewer', observer: 'remote-observer', console: 'remote-console' }[address] });
  config.layout = 'panes'; const before = structuredClone(layout);
  ports.app.command = async command => { throw new Error(`Unexpected app command ${command}`); };
  const adopted = await setupSpaces(config, ports);
  expect(adopted.launched).toEqual(initial.launched);
  expect(writers).toEqual(['one', 'two']);
  expect(layout).toEqual(before);
  expect(new Set(adopted.tabs.map(tab => tab.tab))).toEqual(new Set([tabs[0].id]));
});

it('adopts a merged tab and leaves foreign panes untouched and unrecorded', async () => {
  await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports), recovery = await readCutoverRecovery(ports.journalRoot);
  await writeFile(join(ports.journalRoot, 'spaces.json'), JSON.stringify({ version: 1, focused: true, spaces: [{ name: 'Space A', id: layout.spaces[0].id, adopted: false }], tabs: recovery.entries.map(entry => ({ ...entry, failure: null })) }));
  const tabs = layout.spaces[0].tabs;
  layout.spaces[0].tabs = [{ ...tabs[0], name: 'Space A', terminals: [...tabs.map(tab => ({ terminal: tab.terminal!, ownerSessionId: tab.ownerSessionId })), { terminal: 'shell' as TerminalAddress, ownerSessionId: null }] }];
  (ports as any).terminalLabels = async () => ({});
  const notices: string[] = []; (ports as any).reportLayout = (message: string) => notices.push(message);
  const before = structuredClone(layout); config.layout = 'panes';
  await preflightSpaces(config, ports);
  const adopted = await setupSpaces(config, ports);
  expect(adopted.launched).toEqual(initial.launched);
  expect(layout).toEqual(before); expect(writers).toEqual(['one', 'two']);
  expect((await readCutoverRecovery(ports.journalRoot)).createdTabs.map(row => row.terminal)).toEqual(initial.tabs.map(row => row.terminal));
  expect(notices.join('\n')).toMatch(/Space A[\s\S]*shell[\s\S]*left\s+\w+\s+alone/i);
});

it('adopts by space id and keeps a renamed space and tab', async () => {
  await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports), recovery = await readCutoverRecovery(ports.journalRoot);
  await writeFile(join(ports.journalRoot, 'spaces.json'), JSON.stringify({ version: 1, focused: true, spaces: [{ name: 'Space A', id: layout.spaces[0].id, adopted: false }], tabs: recovery.entries.map(entry => ({ ...entry, failure: null })) }));
  const space = layout.spaces[0], tabs = space.tabs; space.name = 'Renamed space';
  space.tabs = [{ ...tabs[0], name: 'Kept tab', terminals: tabs.map(tab => ({ terminal: tab.terminal!, ownerSessionId: tab.ownerSessionId })) }];
  const notices: string[] = []; (ports as any).reportLayout = (message: string) => notices.push(message);
  config.layout = 'panes'; const before = structuredClone(layout);
  const adopted = await setupSpaces(config, ports);
  expect(adopted.launched).toEqual(initial.launched); expect(layout).toEqual(before);
  expect(notices).toEqual([
    'Space "Space A" is now called "Renamed space". Setup kept that name.',
    'Tab "Kept tab" in space "Renamed space" was reorganised by hand. Setup kept it as it is.',
  ]);
});

it('keeps the app name when the configured space was renamed differently', async () => {
  await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports), recovery = await readCutoverRecovery(ports.journalRoot);
  await writeFile(join(ports.journalRoot, 'spaces.json'), JSON.stringify({ version: 1, focused: true, spaces: [{ name: 'Space A', id: layout.spaces[0].id, adopted: false }], tabs: recovery.entries.map(entry => ({ ...entry, failure: null })) }));
  const space = layout.spaces[0], tabs = space.tabs; space.name = 'App name';
  space.tabs = [{ ...tabs[0], name: 'Kept tab', terminals: tabs.map(tab => ({ terminal: tab.terminal!, ownerSessionId: tab.ownerSessionId })) }];
  config.spaces[0].name = 'Configured name'; config.layout = 'panes'; const before = structuredClone(layout);
  const result = await setupSpaces(config, ports);
  expect(result.launched).toEqual(initial.launched); expect(layout).toEqual(before);
  expect(writers).toEqual(['one', 'two']);
});

it('leaves a pane closed by hand in its surviving tab and reports it on every run', async () => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second'); await addSession('three', 'Third');
  const initial = await setupSpaces(config, ports), missing = initial.tabs[0];
  probes.set(initial.launched[0].pid, { kind: 'absent' });
  const space = layout.spaces[0], tab = space.tabs[0];
  tab.terminals = tab.terminals!.filter(row => row.terminal !== missing.terminal);
  tab.terminal = tab.terminals[0].terminal; tab.ownerSessionId = tab.terminals[0].ownerSessionId ?? null;
  await confirmOwners({ launched: initial.launched.slice(1), tabs: initial.tabs.slice(1) });
  const before = structuredClone(layout);
  const notices: string[] = []; ports.reportLayout = message => notices.push(message);
  const commands = vi.fn(ports.app.command); ports.app.command = commands;
  const expected = { launched: initial.launched.slice(1), tabs: initial.tabs.slice(1) };
  expect(await setupSpaces(config, ports)).toEqual(expected);
  expect(await spaceSetup.planSpaceCutover(config, ports)).toEqual([]);
  expect(await setupSpaces(config, ports)).toEqual(expected);
  const notice = 'Session "First" was closed by hand, so setup leaves it closed. Remove it from the spaces config or reopen it yourself.';
  expect(notices).toEqual([notice, notice]);
  expect(commands).not.toHaveBeenCalled();
  expect(writers).toEqual(['one', 'two', 'three']);
  expect(layout).toEqual(before);
});

it('persists the closure without another cutover when the last tab and terminal are gone', async () => {
  await addSession('one', 'First');
  const initial = await setupSpaces(config, ports);
  probes.set(initial.launched[0].pid, { kind: 'absent' });
  layout.spaces[0].tabs = [];
  const path = join(ports.journalRoot, 'spaces.json'), before = await readFile(path, 'utf8');
  const notices: string[] = []; ports.reportLayout = message => notices.push(message);
  const commands = vi.fn(ports.app.command); ports.app.command = commands;

  expect(await spaceSetup.planSpaceCutover(config, ports)).toEqual([]);
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(notices).toEqual([]);
  expect(await spaceSetup.reconcileSpaceJournal(config, ports)).toEqual({ launched: [], tabs: [] });
  const notice = 'Session "First" was closed by hand, so setup leaves it closed. Remove it from the spaces config or reopen it yourself.';
  expect(notices).toEqual([notice]);
  expect(await setupSpaces(config, ports)).toEqual({ launched: [], tabs: [] });
  expect(notices).toEqual([notice, notice]);
  expect(commands).not.toHaveBeenCalled();
  expect(writers).toEqual(['one']);
});

it('accepts dropping closed file selectors but still refuses to reorder the survivors', async () => {
  await addSession('one', 'First'); await addSession('two', 'Second'); await addSession('three', 'Third');
  const initial = await setupSpaces(config, ports);
  probes.set(initial.launched[0].pid, { kind: 'absent' });
  layout.spaces[0].tabs.shift(); config.spaces[0].sessions.shift();
  await confirmOwners({ launched: initial.launched.slice(1), tabs: initial.tabs.slice(1) });
  const command = vi.spyOn(ports.app, 'command');
  expect(await setupSpaces(config, ports)).toEqual({ launched: initial.launched.slice(1), tabs: initial.tabs.slice(1) });
  expect(await spaceSetup.planSpaceCutover(config, ports)).toEqual([]);
  config.spaces[0].sessions.reverse();
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'tab-owner-conflict', message: 'Session selection changed since tab allocation' });
  expect(command).not.toHaveBeenCalled();
  expect(writers).toEqual(['one', 'two', 'three']);
});

it('does not allocate another session on the terminal address of a closed tab', async () => {
  await addSession('one', 'First');
  const initial = await setupSpaces(config, ports);
  const [record] = await ports.registry.list();
  probes.set(initial.launched[0].pid, { kind: 'absent' });
  layout.spaces[0].tabs = [];
  await ports.registry.remove(record.owner.terminal, true);
  await setupSpaces(config, ports);

  await addSession('two', 'Second');
  const { space, terminal } = initial.tabs[0];
  ports.app.command = async command => {
    expect(command).toBe('tab.new');
    return { space, tab: 'new-tab' as TabId, terminal };
  };
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'terminal-not-fresh' });
  expect(writers).toEqual(['one']);
});

it('reports a closed pane and the renamed surviving tab without changing either', async () => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports), missing = initial.tabs[0], space = layout.spaces[0], tab = space.tabs[0];
  probes.set(initial.launched[0].pid, { kind: 'absent' });
  space.name = 'Renamed space'; tab.name = 'Kept tab';
  tab.terminals = tab.terminals!.filter(row => row.terminal !== missing.terminal); tab.terminal = tab.terminals[0].terminal;
  const before = structuredClone(layout);
  const notices: string[] = []; ports.reportLayout = message => notices.push(message);
  const command = vi.spyOn(ports.app, 'command');
  expect(await setupSpaces(config, ports)).toEqual({ launched: initial.launched.slice(1), tabs: initial.tabs.slice(1) });
  expect(notices).toEqual([
    'Space "Space A" is now called "Renamed space". Setup kept that name.',
    'Session "First" was closed by hand, so setup leaves it closed. Remove it from the spaces config or reopen it yourself.',
    'Tab "Kept tab" in space "Renamed space" was reorganised by hand. Setup kept it as it is.',
  ]);
  expect(command).not.toHaveBeenCalled();
  expect(layout).toEqual(before);
  expect(writers).toEqual(['one', 'two']);
});

it('keeps a closed pane out of a mixed merged layout', async () => {
  const replay = JSON.parse(await readFile(new URL('./fixtures/merged-space-replay.json', import.meta.url), 'utf8'));
  config.layout = 'panes'; config.spaces = replay.journal.spaces.map((space: { name: string }) => ({ name: space.name, sessions: [] }));
  const known = new Map<string, LaunchedSession>();
  for (const entry of replay.journal.tabs) {
    const file = join(root, `${entry.target.sessionId}.jsonl`);
    await writeFile(file, JSON.stringify({ type: 'session', id: entry.target.sessionId, cwd: root }) + '\n' + JSON.stringify({ type: 'session_info', name: entry.target.name }) + '\n');
    files.push(file); config.spaces[entry.target.spaceOrder].sessions.push({ file });
    entry.target.file = file; entry.target.cwd = root; entry.result.sessionFile = file; entry.result.cwd = root;
    known.set(entry.placement.terminal, entry.result);
    probes.set(entry.result.pid, replay.missing.includes(entry.placement.terminal) ? { kind: 'absent' } : { kind: 'live', startIdentity: entry.result.startIdentity });
  }
  await mkdir(ports.journalRoot, { recursive: true });
  await writeFile(join(ports.journalRoot, 'spaces.json'), JSON.stringify(replay.journal), { mode: 0o600 });
  layout = replay.layout;
  ports.terminalState = async placement => known.has(placement.terminal) && !replay.missing.includes(placement.terminal) ? 'live' : 'absent';
  ports.verifyOwner = async (_target, placement) => {
    const owner = known.get(placement.terminal);
    if (!owner || replay.missing.includes(placement.terminal)) throw new HerdrError('owner-activation-unconfirmed', 'New owner did not activate within 30 seconds');
    return owner;
  };
  ports.terminalLabels = async terminal => replay.labels[terminal] ?? {};
  const notices: string[] = []; ports.reportLayout = message => notices.push(message);
  const before = structuredClone(layout);
  const command = vi.spyOn(ports.app, 'command');
  const result = await setupSpaces(config, ports);
  expect(result.launched.map(owner => owner.sessionId)).toEqual(['session-1', 'session-2', 'session-3', 'session-4', 'session-5', 'session-6', 'session-7', 'session-9', 'session-10', 'session-11', 'session-12', 'session-13']);
  expect(writers).toEqual([]);
  expect(command).not.toHaveBeenCalled();
  expect(layout).toEqual(before);
  expect(new Set(result.tabs.map(tab => tab.tab))).toEqual(new Set(['tab-0', 'tab-4', 'tab-7', 'tab-10']));
  expect(notices.join('\n')).toMatch(/Group 1 renamed[\s\S]*kept/i);
  expect(notices.join('\n')).toMatch(/terminal-14[\s\S]*terminal-15[\s\S]*left\s+\w+\s+alone/i);
  const recovery = await readCutoverRecovery(ports.journalRoot);
  expect(recovery.createdTabs).toEqual(result.tabs);
  expect(recovery.closedEntries?.map(entry => entry.target.sessionId)).toEqual(['session-8']);
});

it('recovers all spaces from a mixed merged layout with moved and duplicate live owners', async () => {
  const replay = JSON.parse(await readFile(new URL('./fixtures/merged-space-replay.json', import.meta.url), 'utf8'));
  config.layout = 'panes'; config.spaces = replay.journal.spaces.map((space: { name: string }) => ({ name: space.name, sessions: [] }));
  const known = new Map<string, LaunchedSession>(), feeds = new Map<string, unknown>();
  const extra: { sessionId: string; terminal: TerminalAddress; pid: number; startIdentity: string; kind: 'moved' | 'duplicate' }[] = replay.liveOwners ?? [];
  for (const [index, entry] of replay.journal.tabs.entries()) {
    const file = join(root, `${entry.target.sessionId}.jsonl`);
    await writeFile(file, JSON.stringify({ type: 'session', id: entry.target.sessionId, cwd: root }) + '\n' + JSON.stringify({ type: 'session_info', name: entry.target.name }) + '\n');
    files.push(file); config.spaces[entry.target.spaceOrder].sessions.push({ file });
    entry.target.file = file; entry.target.cwd = root; entry.result.sessionFile = file; entry.result.cwd = root;
    const moved = extra.find(owner => owner.kind === 'moved' && owner.sessionId === entry.target.sessionId);
    const missing = replay.missing.includes(entry.placement.terminal);
    if (missing) probes.set(entry.result.pid, { kind: 'absent' });
    if (missing && !moved) continue;
    const address = moved?.terminal ?? entry.placement.terminal;
    const pid = moved?.pid ?? entry.result.pid, startIdentity = moved?.startIdentity ?? entry.result.startIdentity;
    probes.set(pid, { kind: 'live', startIdentity });
    await ports.processInventory.presence.record({ pid, startIdentity, sessionId: entry.target.sessionId, sessionFile: file, sessionName: entry.target.name, kind: 'top-level', hcAddress: address });
    known.set(address, { pid, startIdentity, sessionId: entry.target.sessionId, sessionFile: file, cwd: root });
    feeds.set(entry.target.sessionId, { sessionId: entry.target.sessionId, generation: `generation-${index}`, owner: { sessionId: entry.target.sessionId, sessionFile: file, cwd: root, terminal: { address } } });
  }
  for (const owner of extra.filter(owner => owner.kind === 'duplicate')) {
    const entry = replay.journal.tabs.find((item: any) => item.target.sessionId === owner.sessionId);
    probes.set(owner.pid, { kind: 'live', startIdentity: owner.startIdentity });
    await ports.processInventory.presence.record({ pid: owner.pid, startIdentity: owner.startIdentity, sessionId: owner.sessionId as SessionId, sessionFile: entry.target.file, sessionName: entry.target.name, kind: 'top-level', hcAddress: owner.terminal });
    known.set(owner.terminal, { pid: owner.pid, startIdentity: owner.startIdentity, sessionId: owner.sessionId as SessionId, sessionFile: entry.target.file, cwd: root });
  }
  await mkdir(ports.journalRoot, { recursive: true });
  await writeFile(join(ports.journalRoot, 'spaces.json'), JSON.stringify(replay.journal), { mode: 0o600 });
  layout = replay.layout;
  const previousState = ports.terminalState!, previousVerify = ports.verifyOwner;
  ports.terminalState = async placement => known.has(placement.terminal) ? 'live' : previousState(placement);
  ports.verifyOwner = async (target, placement, signal) => known.get(placement.terminal) ?? previousVerify(target, placement, signal);
  (ports as any).liveSessionFeed = async (target: { sessionId: string }) => feeds.get(target.sessionId) ?? null;
  ports.terminalLabels = async terminal => replay.labels[terminal] ?? {};
  const reports: string[] = []; ports.reportLayout = message => reports.push(message); ports.reportBlocked = message => reports.push(message);
  const commands = vi.fn(ports.app.command); ports.app.command = commands;
  const before = structuredClone(layout);
  const result = await setupSpaces(config, ports);
  expect(writers).toEqual([]);
  expect(commands).not.toHaveBeenCalled();
  expect(layout).toEqual(before);
  expect(result.launched.map(row => row.sessionId)).toHaveLength(12);
  expect(result.launched.map(row => row.sessionId)).toContain('session-8');
  expect(result.launched.map(row => row.sessionId)).not.toContain('session-9');
  expect(result.conflicts).toEqual([{ sessionId: 'session-9', terminals: ['terminal-8', 'terminal-15'] }]);
  expect(reports.join('\n')).toMatch(/session-9[\s\S]*terminal-8[\s\S]*terminal-15/i);
  const recovered = await readCutoverRecovery(ports.journalRoot);
  expect(recovered.entries.find(entry => entry.target.sessionId === 'session-8')?.placement).toMatchObject({ terminal: 'terminal-14', tab: 'tab-7' });
});

it('plans no cutover for a recorded session running in the same tab under a new terminal and core', async () => {
  const file = await addSession('one', 'First');
  const initial = await setupSpaces(config, ports), owner = initial.launched[0], placement = initial.tabs[0];
  const address = 'replacement' as TerminalAddress;
  layout.spaces[0].tabs[0].terminal = address;
  layout.spaces[0].tabs[0].terminals = [{ terminal: address, ownerSessionId: 'one' }];
  await ports.processInventory.presence.record({ pid: owner.pid, startIdentity: owner.startIdentity, sessionId: owner.sessionId, sessionFile: file, sessionName: 'First', kind: 'top-level', hcAddress: address });
  ports.terminalState = async current => current.terminal === address ? 'live' : 'absent';
  ports.liveSessionFeed = async () => ({ sessionId: 'one', owner: { sessionId: 'one', sessionFile: file, cwd: root, terminal: { address } } } as never);
  ports.coreIdentity = async () => ({ coreId: 'restarted' as never, socket: join(root, 'fixture.sock'), sessionNamespace: 'fixture' });
  ports.app.command = async () => { throw new Error('No app changes allowed'); };
  const before = await readFile(join(ports.journalRoot, 'spaces.json'));
  expect(await spaceSetup.planSpaceCutover(config, ports)).toEqual([]);
  expect(await readFile(join(ports.journalRoot, 'spaces.json'))).toEqual(before);
  const result = await setupSpaces(config, ports);
  expect(result.tabs).toEqual([{ ...placement, terminal: address }]);
  expect(writers).toEqual(['one']);
  expect(probes.get(owner.pid)).toEqual({ kind: 'live', startIdentity: owner.startIdentity });
});

it('plans no cutover for live sessions already sharing a merged tab', async () => {
  await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports), firstTab = layout.spaces[0].tabs[0];
  firstTab.name = 'Combined'; firstTab.terminals = initial.tabs.map(tab => ({ terminal: tab.terminal, ownerSessionId: null }));
  layout.spaces[0].tabs = [firstTab];
  for (const [index, owner] of initial.launched.entries()) await ports.processInventory.presence.record({ pid: owner.pid, startIdentity: owner.startIdentity, sessionId: owner.sessionId, sessionFile: owner.sessionFile, sessionName: index ? 'Second' : 'First', kind: 'top-level', hcAddress: initial.tabs[index].terminal });
  ports.liveSessionFeed = async target => { const index = initial.launched.findIndex(owner => owner.sessionId === target.sessionId), owner = initial.launched[index]; return { sessionId: target.sessionId, owner: { sessionId: target.sessionId, sessionFile: owner.sessionFile, cwd: root, terminal: { address: initial.tabs[index].terminal } } } as never; };
  ports.app.command = async () => { throw new Error('Already running sessions must not move'); };
  expect(await spaceSetup.planSpaceCutover(config, ports)).toEqual([]);
  expect((await setupSpaces(config, ports)).tabs.map(tab => tab.tab)).toEqual([firstTab.id, firstTab.id]);
  expect(writers).toEqual(['one', 'two']);
});

it.each([true, false])('leaves an unproved visible running session alone with confirmed feed %s', async fresh => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports), tab = layout.spaces[0].tabs[0];
  for (const [index, owner] of initial.launched.entries()) await ports.processInventory.presence.record({ pid: owner.pid, startIdentity: owner.startIdentity, sessionId: owner.sessionId, sessionFile: owner.sessionFile, sessionName: index ? 'Second' : 'First', kind: 'top-level', hcAddress: initial.tabs[index].terminal });
  ports.liveSessionFeed = async target => { const index = initial.launched.findIndex(owner => owner.sessionId === target.sessionId), owner = initial.launched[index]; return { sessionId: target.sessionId, owner: { sessionId: target.sessionId, sessionFile: owner.sessionFile, cwd: root, terminal: { address: initial.tabs[index].terminal } } } as never; };
  if (!fresh) ports.liveSessionFeed = async () => null;
  tab.terminals!.find(row => row.terminal === initial.tabs[0].terminal)!.ownerSessionId = 'another-session';
  const before = structuredClone(layout);
  ports.app.command = async () => { throw new Error('Already running sessions must not move'); };
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'running-session-unplaced' });
  expect(layout).toEqual(before);
  expect(writers).toEqual(['one', 'two']);
});

it('does not ask live owners to close when an unrelated pi is unrecorded', async () => {
  await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports);
  unknown = true; messages = []; listed = [];
  ports.waitForChange = async () => { throw new Error('Already open sessions must not wait'); };
  const result = await setupSpaces(config, ports);
  expect(result.launched).toEqual(initial.launched); expect(writers).toEqual(['one', 'two']);
  expect(messages).toEqual([]); expect(listed).toEqual([]);
});

it('reconciles changed live owners and reports duplicate sessions while recovering the other spaces', async () => {
  const replay = JSON.parse(await readFile(new URL('./fixtures/merged-space-replay.json', import.meta.url), 'utf8'));
  config.layout = 'panes'; config.spaces = replay.journal.spaces.map((space: { name: string }) => ({ name: space.name, sessions: [] }));
  config.spaces[0].name = 'Group 1 renamed';
  const feeds = new Map<string, unknown>(), known = new Map<string, LaunchedSession>();
  const moved = replay.journal.tabs[7], duplicate = replay.journal.tabs[1], closed = replay.journal.tabs[12];
  const duplicateAddress = 'terminal-18' as TerminalAddress;
  replay.layout.spaces[0].tabs[0].terminals.push({ terminal: duplicateAddress, ownerSessionId: null });
  replay.layout.spaces[3].tabs[0].terminals = replay.layout.spaces[3].tabs[0].terminals.filter((row: { terminal: string }) => row.terminal !== closed.placement.terminal);
  for (const [index, entry] of replay.journal.tabs.entries()) {
    const file = join(root, `${entry.target.sessionId}.jsonl`);
    await writeFile(file, JSON.stringify({ type: 'session', id: entry.target.sessionId, cwd: root }) + '\n' + JSON.stringify({ type: 'session_info', name: entry.target.name }) + '\n');
    files.push(file); config.spaces[entry.target.spaceOrder].sessions.push({ file });
    entry.target.file = file; entry.target.cwd = root; entry.result.sessionFile = file; entry.result.cwd = root;
    if (entry === closed) { probes.set(entry.result.pid, { kind: 'absent' }); continue; }
    const address = entry === moved ? 'terminal-14' : entry.placement.terminal;
    const pid = entry === moved ? 3100 : entry.result.pid, startIdentity = entry === moved ? 'fixture:3100' : entry.result.startIdentity;
    if (entry === moved) probes.set(entry.result.pid, { kind: 'absent' });
    probes.set(pid, { kind: 'live', startIdentity });
    await ports.processInventory.presence.record({ pid, startIdentity, sessionId: entry.target.sessionId, sessionFile: file, sessionName: entry.target.name, kind: 'top-level', hcAddress: address });
    known.set(address, { pid, startIdentity, sessionId: entry.target.sessionId, sessionFile: file, cwd: root });
    feeds.set(entry.target.sessionId, { sessionId: entry.target.sessionId, generation: index === 1 || index === 5 ? 'new-generation' : 'old-generation', owner: { sessionId: entry.target.sessionId, sessionFile: file, cwd: root, terminal: { address } } });
  }
  probes.set(3200, { kind: 'live', startIdentity: 'fixture:3200' });
  await ports.processInventory.presence.record({ pid: 3200, startIdentity: 'fixture:3200', sessionId: duplicate.target.sessionId, sessionFile: duplicate.target.file, sessionName: duplicate.target.name, kind: 'top-level', hcAddress: duplicateAddress });
  await mkdir(ports.journalRoot, { recursive: true });
  await writeFile(join(ports.journalRoot, 'spaces.json'), JSON.stringify(replay.journal), { mode: 0o600 });
  layout = replay.layout;
  const previousState = ports.terminalState!, previousVerify = ports.verifyOwner;
  ports.terminalState = async placement => placement.terminal === duplicateAddress || known.has(placement.terminal) ? 'live' : previousState(placement);
  ports.verifyOwner = async (target, placement, signal) => {
    if (['session-2', 'session-6', 'session-8'].includes(target.sessionId)) throw new HerdrError('owner-activation-unconfirmed', 'Old mapping no longer matches');
    return known.get(placement.terminal) ?? previousVerify(target, placement, signal);
  };
  (ports as any).liveSessionFeed = async (target: { sessionId: string }) => feeds.get(target.sessionId) ?? null;
  ports.coreIdentity = async () => ({ coreId: 'new-core' as never, socket: join(root, 'fixture.sock'), sessionNamespace: 'fixture' });
  ports.terminalLabels = async terminal => replay.labels[terminal] ?? {};
  const reports: string[] = []; ports.reportLayout = message => reports.push(message); ports.reportBlocked = message => reports.push(message);
  ports.reportLive = records => { for (const record of records) reports.push(`Close session ${record.sessionId}`); };
  const before = structuredClone(layout), journalBefore = await readFile(join(ports.journalRoot, 'spaces.json'), 'utf8');
  const preflight = await (readCutoverRecovery as any)(ports.journalRoot, await ports.layoutSnapshot(), config, ports);
  expect(preflight.entries.find((entry: any) => entry.target.sessionId === 'session-8')?.placement.terminal).toBe('terminal-14');
  expect(preflight.conflicts).toEqual([{ sessionId: 'session-2', terminals: ['terminal-1', 'terminal-18'] }]);
  expect(await readFile(join(ports.journalRoot, 'spaces.json'), 'utf8')).toBe(journalBefore);
  const result = await setupSpaces(config, ports);
  expect(writers).toEqual([]);
  expect(result.launched).toHaveLength(11);
  expect(result.launched.map(row => row.sessionId)).not.toContain('session-13');
  expect((result as any).conflicts).toEqual([{ sessionId: 'session-2', terminals: ['terminal-1', 'terminal-18'] }]);
  expect(reports.join('\n')).toMatch(/session-2[\s\S]*terminal-1[\s\S]*terminal-18/i);
  expect(reports.join('\n')).not.toMatch(/Close session/);
  expect(reports.filter(report => report.includes('closed by hand'))).toEqual([
    'Session "Session 13" was closed by hand, so setup leaves it closed. Remove it from the spaces config or reopen it yourself.',
  ]);
  const recovered = await readCutoverRecovery(ports.journalRoot);
  expect(recovered.closedEntries?.map(entry => entry.target.sessionId)).toEqual(['session-13']);
  expect(recovered.entries.find(entry => entry.target.sessionId === 'session-8')?.placement).toMatchObject({ terminal: 'terminal-14', tab: 'tab-7' });
  expect(recovered.entries.find(entry => entry.target.sessionId === 'session-2')?.placement).toMatchObject({ terminal: 'terminal-1', tab: duplicate.placement.tab });
  expect(layout.spaces.map(space => [space.name, space.tabs[0].name, space.tabs.length])).toEqual(before.spaces.map(space => [space.name, space.tabs[0].name, 1]));
  for (const [i, space] of before.spaces.entries()) for (const row of space.tabs[0].terminals!) expect(layout.spaces[i].tabs[0].terminals).toContainEqual(row);
});

it('does not reuse an owner whose heartbeat disappears after preflight', async () => {
  config.layout = 'panes'; const file = await addSession('one', 'First');
  const initial = await setupSpaces(config, ports), owner = initial.launched[0], address = initial.tabs[0].terminal;
  await ports.processInventory.presence.record({ pid: owner.pid, startIdentity: owner.startIdentity, sessionId: owner.sessionId, sessionFile: file, sessionName: 'First', kind: 'top-level', hcAddress: address });
  let reads = 0;
  (ports as any).liveSessionFeed = async () => ++reads === 1 ? { sessionId: 'one', generation: 'new', owner: { sessionId: 'one', sessionFile: file, cwd: root, terminal: { address } } } : null;
  ports.verifyOwner = async () => { throw new HerdrError('owner-activation-unconfirmed', 'Owner is no longer confirmed'); };
  const before = structuredClone(layout);
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'running-session-unplaced' });
  expect(messages).toEqual([expect.stringContaining('Setup left "First" running')]);
  expect(layout).toEqual(before);
  expect(waits).toBe(0);
  expect(writers).toEqual(['one']);
});

it('adopts a live session by id when its file path has changed', async () => {
  config.layout = 'panes'; await addSession('one', 'First');
  const initial = await setupSpaces(config, ports), old = initial.tabs[0], tab = layout.spaces[0].tabs[0];
  probes.set(initial.launched[0].pid, { kind: 'absent' });
  const currentFile = join(root, 'moved-session.jsonl');
  await writeFile(currentFile, JSON.stringify({ type: 'session', id: 'one', cwd: root }) + '\n');
  const address = 'new-terminal' as TerminalAddress, identity = { pid: 900, startIdentity: 'start:900' };
  probes.set(identity.pid, { kind: 'live', startIdentity: identity.startIdentity });
  await ports.processInventory.presence.record({ ...identity, sessionId: 'one' as SessionId, sessionFile: currentFile, sessionName: 'First', kind: 'top-level', hcAddress: address });
  tab.terminal = address; tab.terminals = [{ terminal: address, ownerSessionId: 'one' }];
  const priorState = ports.terminalState!;
  ports.terminalState = async placement => placement.terminal === address ? 'live' : priorState(placement);
  (ports as any).liveSessionFeed = async () => null;
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'running-session-unplaced', message: expect.stringContaining('Setup left "First" running') });
  expect(writers).toEqual(['one']);
  (ports as any).liveSessionFeed = async () => ({ sessionId: 'one', generation: 'new', owner: { sessionId: 'one', sessionFile: currentFile, cwd: root, terminal: { address } } });
  const result = await setupSpaces(config, ports);
  expect(writers).toEqual(['one']);
  expect(result.launched).toMatchObject([{ ...identity, sessionId: 'one', sessionFile: currentFile }]);
  expect(result.tabs).toMatchObject([{ terminal: address, tab: old.tab }]);
  expect((await readCutoverRecovery(ports.journalRoot)).entries[0].result?.sessionFile).toBe(currentFile);
});

it('reopens a session whose old terminal now holds a different live session', async () => {
  config.layout = 'panes'; const file = await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports), old = initial.tabs[0], tab = layout.spaces[0].tabs[0];
  await ports.processInventory.presence.record({ pid: initial.launched[0].pid, startIdentity: initial.launched[0].startIdentity, sessionId: 'other' as SessionId, sessionFile: join(root, 'other.jsonl'), sessionName: 'Other', kind: 'top-level', hcAddress: old.terminal });
  tab.terminals!.find(row => row.terminal === old.terminal)!.ownerSessionId = null;
  const previous = ports.verifyOwner;
  ports.verifyOwner = async (target, placement, signal) => placement.terminal === old.terminal ? Promise.reject(new HerdrError('owner-session-switched', 'A different session is open')) : previous(target, placement, signal);
  ports.liveSessionFeed = async target => target.sessionId === 'one' ? null : ownerFeed(initial, target.sessionId);
  const notices: string[] = []; ports.reportLayout = message => notices.push(message);
  const result = await setupSpaces(config, ports);
  expect(writers).toEqual(['one', 'two', 'one']);
  expect(result.launched[0].sessionFile).toBe(file);
  expect(result.tabs[0].terminal).not.toBe(old.terminal);
  expect(tab.terminals?.map(row => row.terminal)).toContain(old.terminal);
  expect(tab.terminals?.map(row => row.terminal)).toContain(result.tabs[0].terminal);
  expect(notices.join('\n')).toMatch(/fresh-500[\s\S]*left\s+\w+\s+alone/i);
});

it('reopens beside a different session when the old pane is the only pane in the space', async () => {
  config.layout = 'panes'; await addSession('one', 'First');
  const initial = await setupSpaces(config, ports), old = initial.tabs[0], tab = layout.spaces[0].tabs[0];
  await ports.processInventory.presence.record({ pid: initial.launched[0].pid, startIdentity: initial.launched[0].startIdentity, sessionId: 'other' as SessionId, sessionFile: join(root, 'other.jsonl'), sessionName: 'Other', kind: 'top-level', hcAddress: old.terminal });
  tab.terminals![0].ownerSessionId = null;
  const previous = ports.verifyOwner;
  ports.verifyOwner = async (target, placement, signal) => placement.terminal === old.terminal ? Promise.reject(new HerdrError('owner-session-switched', 'A different session is open')) : previous(target, placement, signal);
  (ports as any).liveSessionFeed = async () => null;
  const list = ports.registry.list; let interrupted = false;
  ports.registry.list = async (...args) => {
    if (!interrupted && (await readCutoverRecovery(ports.journalRoot)).entries.length === 0) { interrupted = true; throw new Error('interrupted before allocation'); }
    return list(...args);
  };
  await expect(setupSpaces(config, ports)).rejects.toThrow('interrupted before allocation');
  const result = await setupSpaces(config, ports);
  expect(writers).toEqual(['one', 'one']);
  expect(layout.spaces[0].tabs).toHaveLength(1);
  expect(tab.terminals?.map(row => row.terminal)).toEqual([old.terminal, result.tabs[0].terminal]);
});

it('restores a parked live session to its shared tab without launching another writer', async () => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports), parked = initial.tabs[0];
  await ports.app.command('terminal.park', { terminal: parked.terminal });
  const result = await setupSpaces(config, ports);
  expect(result.tabs.map(tab => tab.tab)).toEqual([parked.tab, parked.tab]);
  expect(layout.spaces[0].tabs[0].terminals?.map(row => row.terminal)).toContain(parked.terminal);
  expect(probes.get(initial.launched[0].pid)?.kind).toBe('live');
  expect(writers).toEqual(['one', 'two']);
});

it.each(['terminal.park', 'terminal.keep'])('a lost %s reply restores placement without launching another writer', async operation => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second');
  const command = ports.app.command; let lost = false;
  ports.app.command = async (name, args) => { const reply = await command(name, args); if (name === operation && !lost) { lost = true; throw new Error('lost move reply'); } return reply; };
  await expect(setupSpaces(config, ports)).rejects.toThrow('lost move reply');
  const before = structuredClone(layout);
  const resumed = await setupSpaces(config, ports);
  expect(resumed.launched.map(row => row.sessionId)).toEqual(['one', 'two']);
  expect(writers).toEqual(['one', 'two']);
  if (operation === 'terminal.keep') expect(layout).toEqual(before);
  expect(layout.spaces[0].tabs).toHaveLength(1);
  expect(new Set(resumed.tabs.map(tab => tab.tab)).size).toBe(1);
});

it('adding a session to an older tab layout preserves its existing tabs', async () => {
  await addSession('one', 'First'); await addSession('two', 'Second');
  await setupSpaces(config, ports); delete config.layout;
  await addSession('three', 'Third');
  const result = await setupSpaces(config, ports);
  expect(layout.spaces[0].tabs.map(tab => tab.name)).toEqual(['First', 'Second', 'Third']);
  expect(result.launched.map(row => row.sessionId)).toEqual(['one', 'two', 'three']);
  expect(writers).toEqual(['one', 'two', 'three']);
});

it('a malformed grouped journal fails at the journal boundary', async () => {
  await mkdir(ports.journalRoot, { recursive: true });
  await writeFile(join(ports.journalRoot, 'spaces.json'), JSON.stringify({ version: 2, spaces: [], tabs: [{ space: 's', tab: 't', name: 'Group', sessions: [null] }], focused: false }), { mode: 0o600 });
  await expect(readCutoverRecovery(ports.journalRoot)).rejects.toMatchObject({ code: 'invalid-space-journal' });
});

it.each([undefined, 'panes', 'tabs'] as const)('space layout overrides the global %s default', async globalLayout => {
  config.layout = globalLayout;
  for (let i = 0; i < 4; i++) await addSession(`layout-${i}`, `Session ${i}`);
  const second = config.spaces[0].sessions.splice(2);
  const firstLayout = globalLayout ?? 'panes', otherLayout = firstLayout === 'panes' ? 'tabs' : 'panes';
  config.spaces.push({ name: 'Space B', sessions: second, layout: otherLayout });
  await setupSpaces(config, ports);
  expect(layout.spaces[0].tabs.map(tab => tab.name)).toEqual(firstLayout === 'panes' ? ['Space A'] : ['Session 0', 'Session 1']);
  expect(layout.spaces[1].tabs.map(tab => tab.name)).toEqual(otherLayout === 'panes' ? ['Space B'] : ['Session 2', 'Session 3']);
  expect(writers).toEqual(['layout-0', 'layout-1', 'layout-2', 'layout-3']);
});

it('a pane session may have the same name as its space', async () => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Space A');
  const result = await setupSpaces(config, ports);
  expect(layout.spaces[0].tabs.map(tab => tab.name)).toEqual(['Space A']);
  expect(result.tabs).toHaveLength(2); expect(writers).toEqual(['one', 'two']);
});
it('pane moves wait for a pending park acknowledgement before keeping the terminal', async () => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second');
  const command = ports.app.command; let pending: (() => Promise<unknown>) | undefined; let observed = 0;
  ports.app.command = async (name, args) => { if (name === 'terminal.park') { pending = () => command(name, args); return { pending: true }; } return command(name, args); };
  ports.waitForChange = async () => { observed++; await pending!(); pending = undefined; };
  const result = await setupSpaces(config, ports);
  expect(observed).toBe(1); expect(new Set(result.tabs.map(tab => tab.tab)).size).toBe(1); expect(writers).toEqual(['one', 'two']);
});

it('retries the transient no-running-terminal response for a parked parentless session', async () => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second');
  const command = ports.app.command; let attempts = 0, waitsForApp = 0;
  ports.app.command = async (name, args) => {
    if (name === 'terminal.keep' && ++attempts <= 2) return { error: { code: 'app-error', message: `no running terminal "${args.terminal}"` } };
    return command(name, args);
  };
  ports.waitForChange = async () => { waitsForApp++; ticks += 100; };
  const result = await setupSpaces(config, ports);
  expect(attempts).toBe(3); expect(waitsForApp).toBe(2);
  expect(splits).toEqual([{ anchor: result.tabs[0].terminal, direction: 'right' }]);
  expect(writers).toEqual(['one', 'two']);
  await setupSpaces(config, ports); expect(attempts).toBe(3); expect(writers).toEqual(['one', 'two']);
});

it('recovers a lost successful keep reply after transient lookup failures without another launch', async () => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second');
  const command = ports.app.command; let attempts = 0;
  ports.app.command = async (name, args) => {
    if (name !== 'terminal.keep') return command(name, args);
    if (++attempts <= 2) return { error: { code: 'app-error', message: `no running terminal "${args.terminal}"` } };
    const reply = await command(name, args);
    if (attempts === 3) throw new Error('lost accepted keep reply');
    return reply;
  };
  ports.waitForChange = async () => { ticks += 100; };
  await expect(setupSpaces(config, ports)).rejects.toThrow('lost accepted keep reply');
  const before = structuredClone(layout);
  await setupSpaces(config, ports);
  expect(attempts).toBe(3); expect(layout).toEqual(before); expect(writers).toEqual(['one', 'two']);
});

it('bounds retries when the app never recognizes a live parked session', async () => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second');
  const command = ports.app.command; let attempts = 0;
  ports.app.command = async (name, args) => name === 'terminal.keep' ? (++attempts, { error: { code: 'app-error', message: `no running terminal "${args.terminal}"` } }) : command(name, args);
  ports.waitForChange = async () => { ticks += 15000; };
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'pane-placement-timeout' });
  expect(attempts).toBe(3); expect(writers).toEqual(['one', 'two']);
});

it('does not retry unrelated keep failures', async () => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second');
  const command = ports.app.command; let attempts = 0;
  ports.app.command = async (name, args) => name === 'terminal.keep' ? (++attempts, { error: { code: 'app-error', message: 'permission denied' } }) : command(name, args);
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'app-error', message: 'permission denied' });
  expect(attempts).toBe(1);
});


it('reports every unproved running pane and opens independent sessions before refusing', async () => {
  await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports);
  for (const tab of layout.spaces[0].tabs) tab.terminals![0].ownerSessionId = 'another-session';
  const before = structuredClone(layout.spaces[0].tabs);
  await addSession('three', 'Third');
  const error = await setupSpaces(config, ports).then(() => null, error => error);
  expect(error).toMatchObject({ code: 'running-session-unplaced' });
  expect(error.message).toContain('Setup left "First" running');
  expect(error.message).toContain('Setup left "Second" running');
  expect(error.message).toContain('/reload');
  expect(error.message).toContain('/herdr-setup');
  expect(error.message).not.toContain('Rollback:');
  expect(messages).toHaveLength(2);
  expect(writers).toEqual(['one', 'two', 'three']);
  expect(layout.spaces[0].tabs.slice(0, 2)).toEqual(before);
  expect(initial.launched.every(owner => probes.get(owner.pid)?.kind === 'live')).toBe(true);
});

it('plans to leave an unconfirmed parked live pane running without reopening it', async () => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports);
  await ports.app.command('terminal.park', { terminal: initial.tabs[1].terminal });
  ports.liveSessionFeed = async () => null;
  const before = structuredClone(layout);
  expect((await spaceSetup.planSpaceCutover(config, ports)).join('\n')).toContain('Setup left "Second" running');
  expect(layout).toEqual(before);
  expect(writers).toEqual(['one', 'two']);
});

it('does not plan an owner-conflicting pane as running in place', async () => {
  const file = await addSession('one', 'First'), initial = await setupSpaces(config, ports), owner = initial.launched[0];
  await ports.processInventory.presence.record({ ...owner, sessionName: 'First', kind: 'top-level', hcAddress: initial.tabs[0].terminal });
  ports.liveSessionFeed = async () => ({ sessionId: 'one', owner: { sessionId: 'one', sessionFile: file, cwd: root, terminal: { address: initial.tabs[0].terminal } } } as never);
  layout.spaces[0].tabs[0].terminals![0].ownerSessionId = 'another-session';
  expect(await spaceSetup.planSpaceCutover(config, ports)).not.toEqual([]);
  expect(writers).toEqual(['one']);
});


it('plans from the preflight snapshot without repeating layout or live-feed reads', async () => {
  const file = await addSession('one', 'First'), initial = await setupSpaces(config, ports), owner = initial.launched[0];
  await ports.processInventory.presence.record({ ...owner, sessionName: 'First', kind: 'top-level', hcAddress: initial.tabs[0].terminal });
  ports.liveSessionFeed = async () => ({ sessionId: 'one', owner: { sessionId: 'one', sessionFile: file, cwd: root, terminal: { address: initial.tabs[0].terminal } } } as never);
  const snapshot = await ports.layoutSnapshot(), recovery = await readCutoverRecovery(ports.journalRoot, snapshot, config, ports);
  ports.layoutSnapshot = async () => { throw new Error('Preflight already read the layout'); };
  ports.liveSessionFeed = async () => { throw new Error('Preflight already read live owners'); };
  expect(await (spaceSetup.planSpaceCutover as any)(config, ports, { snapshot, recovery })).toEqual([]);
  expect(writers).toEqual(['one']);
});


it('restores a lone parked live session into a process-free pane tab', async () => {
  config.layout = 'panes'; await addSession('one', 'First');
  const initial = await setupSpaces(config, ports), terminal = initial.tabs[0].terminal;
  await confirmOwners(initial);
  await ports.app.command('terminal.park', { terminal });
  expect(layout.spaces[0].tabs).toEqual([]);
  const result = await setupSpaces(config, ports);
  expect(result.tabs[0].terminal).toBe(terminal);
  expect(layout.spaces[0].tabs).toHaveLength(1);
  expect(layout.spaces[0].tabs[0].terminals).toEqual([{ terminal, ownerSessionId: 'one' }]);
  expect(layout.spaces[0].tabs[0].name).toBe('Space A');
  expect(probes.get(initial.launched[0].pid)?.kind).toBe('live');
  expect(writers).toEqual(['one']);
  const before = structuredClone(layout), journal = await readFile(join(ports.journalRoot, 'spaces.json'), 'utf8');
  expect(await spaceSetup.planSpaceCutover(config, ports)).toEqual([]);
  const command = vi.spyOn(ports.app, 'command');
  await setupSpaces(config, ports);
  expect(command).not.toHaveBeenCalled();
  expect(layout).toEqual(before);
  expect(await readFile(join(ports.journalRoot, 'spaces.json'), 'utf8')).toBe(journal);
  expect(writers).toEqual(['one']);
});

it('re-anchors an interrupted pane move when its recorded destination has disappeared', async () => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second');
  const command = ports.app.command; let lost = false;
  ports.app.command = async (name, args) => { const reply = await command(name, args); if (name === 'terminal.park' && !lost) { lost = true; throw new Error('lost park'); } return reply; };
  await expect(setupSpaces(config, ports)).rejects.toThrow('lost park');
  await ports.app.command('terminal.park', { terminal: 'fresh-500' });
  const result = await setupSpaces(config, ports);
  expect(result.tabs.map(tab => tab.terminal)).toEqual(['fresh-500', 'fresh-501']);
  expect(layout.spaces[0].tabs).toHaveLength(1);
  expect(layout.spaces[0].tabs[0].terminals).toHaveLength(2);
  expect(writers).toEqual(['one', 'two']);
});


it('skips a session whose feed names another pane while opening the remaining selections', async () => {
  const file = await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports), owner = initial.launched[0];
  await ports.processInventory.presence.record({ ...owner, sessionName: 'First', kind: 'top-level', hcAddress: initial.tabs[0].terminal });
  ports.liveSessionFeed = async target => target.sessionId === 'one' ? ({ sessionId: 'one', owner: { sessionId: 'one', sessionFile: file, cwd: root, terminal: { address: initial.tabs[1].terminal } } } as never) : ownerFeed(initial, target.sessionId);
  const verify = ports.verifyOwner;
  ports.verifyOwner = async (...args) => { if (args[0].sessionId === 'one') throw new HerdrError('owner-activation-unconfirmed', 'Pane belongs to another session'); return verify(...args); };
  await addSession('three', 'Third');
  const error = await setupSpaces(config, ports).then(() => null, error => error);
  expect(error).toMatchObject({ code: 'running-session-unplaced' });
  expect(error.message).toContain('Setup left "First" running');
  expect(messages).toHaveLength(1);
  expect(writers).toEqual(['one', 'two', 'three']);
  expect(layout.spaces[0].tabs.slice(0, 2).map(tab => tab.terminal)).toEqual(initial.tabs.map(tab => tab.terminal));
});


it('plans to finish a journalled move even while its live pane is still visible in the temporary tab', async () => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second');
  const command = ports.app.command;
  ports.app.command = async (name, args) => { if (name === 'terminal.park') throw new Error('park not yet applied'); return command(name, args); };
  await expect(setupSpaces(config, ports)).rejects.toThrow('park not yet applied');
  const recovery = await readCutoverRecovery(ports.journalRoot);
  for (const entry of recovery.entries) await ports.processInventory.presence.record({ ...entry.result!, sessionName: entry.target.name, kind: 'top-level', hcAddress: entry.placement.terminal });
  ports.liveSessionFeed = async target => { const entry = recovery.entries.find(entry => entry.target.sessionId === target.sessionId)!; return { sessionId: target.sessionId, owner: { sessionId: target.sessionId, sessionFile: entry.target.file, cwd: root, terminal: { address: entry.placement.terminal } } } as never; };
  expect((await spaceSetup.planSpaceCutover(config, ports)).join('\n')).toMatch(/Re-place.*Second/);
  ports.app.command = command;
  await setupSpaces(config, ports);
  expect(layout.spaces[0].tabs).toHaveLength(1);
  expect(layout.spaces[0].tabs[0].terminals).toHaveLength(2);
  expect(writers).toEqual(['one', 'two']);
});


it.each(['tabs', 'panes'] as const)('restores a parked session only into its own tab with %s layout', async requestedLayout => {
  config.layout = 'tabs'; await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports), first = structuredClone(layout.spaces[0].tabs[0]);
  await confirmOwners(initial);
  config.layout = requestedLayout;
  await ports.app.command('terminal.park', { terminal: initial.tabs[1].terminal });
  const result = await setupSpaces(config, ports);
  expect(layout.spaces[0].tabs).toHaveLength(2);
  expect(layout.spaces[0].tabs[0]).toEqual(first);
  expect(layout.spaces[0].tabs[1]).toMatchObject({ name: 'Second', terminals: [{ terminal: initial.tabs[1].terminal, ownerSessionId: 'two' }] });
  expect(result.tabs[1].tab).not.toBe(initial.tabs[0].tab);
  expect(probes.get(initial.launched[1].pid)?.kind).toBe('live');
  expect(writers).toEqual(['one', 'two']);
  const before = structuredClone(layout), journal = await readFile(join(ports.journalRoot, 'spaces.json'), 'utf8');
  expect(await spaceSetup.planSpaceCutover(config, ports)).toEqual([]);
  const command = vi.spyOn(ports.app, 'command');
  await setupSpaces(config, ports);
  expect(command).not.toHaveBeenCalled();
  expect(layout).toEqual(before);
  expect(await readFile(join(ports.journalRoot, 'spaces.json'), 'utf8')).toBe(journal);
  expect(writers).toEqual(['one', 'two']);
});

it.each([
  ['parked', 'missing-feed'], ['visible', 'missing-feed'],
  ['parked', 'owner-activation-unconfirmed'], ['visible', 'owner-activation-unconfirmed'],
  ['parked', 'owner-terminal-finished'], ['visible', 'owner-terminal-finished'],
] as const)('skips an unproved %s owner with %s and finishes independent sessions', async (placement, reason) => {
  config.layout = 'panes'; await addSession('one', 'First'); await addSession('two', 'Second');
  const initial = await setupSpaces(config, ports), owner = initial.launched[1], terminal = initial.tabs[1].terminal;
  await ports.processInventory.presence.record({ ...owner, sessionName: 'Second', kind: 'top-level', hcAddress: terminal });
  if (placement === 'parked') await ports.app.command('terminal.park', { terminal });
  let feedReads = 0;
  ports.liveSessionFeed = async target => target.sessionId !== 'two' ? ownerFeed(initial, target.sessionId) : reason !== 'missing-feed' ? ({ sessionId: 'two', owner: { sessionId: 'two', sessionFile: owner.sessionFile, cwd: root, terminal: { address: ++feedReads === 1 ? terminal : initial.tabs[0].terminal } } } as never) : null;
  const verify = ports.verifyOwner;
  ports.verifyOwner = async (...args) => {
    if (args[0].sessionId === 'two') {
      if (reason === 'missing-feed') { waits++; ticks += 30000; }
      throw new HerdrError(reason === 'missing-feed' ? 'owner-activation-unconfirmed' : reason, 'New owner did not activate within 30 seconds');
    }
    return verify(...args);
  };
  await addSession('three', 'Third');
  const before = structuredClone(layout);
  const error = await setupSpaces(config, ports).then(() => null, error => error);
  expect(error).toMatchObject({ code: 'running-session-unplaced' });
  expect(error.message).toContain('Setup left "Second" running');
  expect(error.message).toContain('/reload in that session');
  expect(error.message).toContain('/herdr-setup');
  expect(error.message).not.toContain('Rollback:');
  expect(messages).toEqual([expect.stringContaining('Setup left "Second" running')]);
  expect(writers).toEqual(['one', 'two', 'three']);
  expect(probes.get(owner.pid)?.kind).toBe('live');
  expect(layout.spaces[0].tabs.flatMap(tab => tab.terminals ?? []).filter(row => row.terminal === terminal)).toHaveLength(placement === 'parked' ? 0 : 1);
  const location = (snapshot: LayoutSnapshot) => snapshot.spaces.flatMap(space => space.tabs.filter(tab => tab.terminals?.some(row => row.terminal === terminal)).map(tab => ({ space: space.id, tab: tab.id })));
  expect(location(layout)).toEqual(location(before));
  expect(layout.spaces[0].tabs.filter(tab => !tab.terminals?.length)).toEqual([]);
  expect(waits).toBe(0);
  expect(ticks).toBe(0);
  const completed = (await readCutoverRecovery(ports.journalRoot)).recoveredCutover!;
  ports.liveSessionFeed = async target => target.sessionId === 'two' ? null : ownerFeed(completed, target.sessionId);
  const plan = (await spaceSetup.planSpaceCutover(config, ports)).join('\n');
  expect(plan).toContain('Setup left "Second" running');
  expect(plan).not.toMatch(/Re-place.*Second/);
  const after = structuredClone(layout), command = vi.spyOn(ports.app, 'command');
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'running-session-unplaced' });
  expect(command).not.toHaveBeenCalled();
  expect(messages).toEqual([expect.stringContaining('Setup left "Second" running'), expect.stringContaining('Setup left "Second" running')]);
  expect(waits).toBe(0);
  expect(layout).toEqual(after);
  expect(writers).toEqual(['one', 'two', 'three']);
  expect(before.spaces[0].tabs[0].terminals?.every(row => after.spaces[0].tabs.flatMap(tab => tab.terminals ?? []).some(value => value.terminal === row.terminal))).toBe(true);
});

it('journal retains real target beside remote presentation', async () => {
  const file = await addSession('one', 'First');
  const initial = await setupSpaces(config, ports), owner = initial.launched[0];
  const journalPath = join(ports.journalRoot, 'spaces.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.tabs[0].sessions[0].terminal = 'core-remote/t7';
  await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 });
  const tab = layout.spaces[0].tabs[0];
  tab.terminal = 'proxy-1' as TerminalAddress;
  tab.terminals = [{ terminal: 'proxy-1' as TerminalAddress, ownerSessionId: 'one' }];
  await ports.processInventory.presence.record({ ...owner, sessionFile: file, sessionName: 'First', kind: 'top-level', hcAddress: 'core-remote/t7' as TerminalAddress });
  ports.liveSessionFeed = async () => ({ sessionId: 'one', owner: { sessionId: 'one', sessionFile: file, cwd: root, terminal: { address: 'core-remote/t7' } } } as never);
  ports.terminalState = async placement => placement.terminal === 'core-remote/t7' ? 'live' : 'absent';
  const notices: string[] = []; ports.reportLayout = message => notices.push(message);
  ports.terminalLabels = async () => ({ 'spider.kind': 'pane-proxy' });
  ports.observedPresentation = async (target, execution, snapshot) => {
    expect(target.sessionId).toBe('one');
    expect(execution.terminal).toBe('core-remote/t7');
    expect(snapshot.spaces[0].tabs[0].terminals?.[0].terminal).toBe('proxy-1');
    return 'proxy-1' as TerminalAddress;
  };
  const recovery = await readCutoverRecovery(ports.journalRoot, await ports.layoutSnapshot(), config, ports);
  expect(recovery.entries[0].placement.terminal).toBe('core-remote/t7');
  expect(recovery.entries[0].result?.presentationTerminal).toBe('proxy-1');
  const before = structuredClone(layout), command = vi.spyOn(ports.app, 'command');
  const result = await setupSpaces(config, ports);
  expect(result.tabs[0].terminal).toBe('core-remote/t7');
  expect(result.launched[0].presentationTerminal).toBe('proxy-1');
  expect(command).not.toHaveBeenCalled();
  expect(layout).toEqual(before);
  expect(notices).toEqual([]);
  expect(writers).toEqual(['one']);
  const saved = await readFile(journalPath, 'utf8'), written = JSON.parse(saved);
  expect(written.tabs[0].sessions[0]).toMatchObject({ terminal: 'core-remote/t7', result: { presentationTerminal: 'proxy-1' } });
  await setupSpaces(config, ports);
  expect(await readFile(journalPath, 'utf8')).toBe(saved);
  expect(writers).toEqual(['one']);
});
it('an already placed remote display completes an interrupted journal move without touching the target', async () => {
  config.layout = 'panes';
  const file = await addSession('one', 'First');
  const initial = await setupSpaces(config, ports), owner = initial.launched[0];
  const path = join(ports.journalRoot, 'spaces.json'), journal = JSON.parse(await readFile(path, 'utf8'));
  journal.tabs[0].sessions[0].terminal = 'core-remote/t7';
  journal.tabs[0].sessions[0].result.presentationTerminal = 'proxy-1';
  journal.tabs[0].sessions[0].pane = { tab: initial.tabs[0].tab, direction: 'down' };
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  const tab = layout.spaces[0].tabs[0]; tab.terminal = 'proxy-1' as TerminalAddress;
  tab.terminals = [{ terminal: 'proxy-1' as TerminalAddress, ownerSessionId: 'one' }];
  await ports.processInventory.presence.record({ ...owner, sessionFile: file, sessionName: 'First', kind: 'top-level', hcAddress: 'core-remote/t7' as TerminalAddress });
  ports.liveSessionFeed = async () => ({ sessionId: 'one', owner: { sessionId: 'one', sessionFile: file, cwd: root, terminal: { address: 'core-remote/t7' } } } as never);
  ports.terminalState = async placement => placement.terminal === 'core-remote/t7' ? 'live' : 'absent';
  ports.observedPresentation = async () => 'proxy-1' as TerminalAddress;
  const before = structuredClone(layout), command = vi.spyOn(ports.app, 'command');
  const result = await setupSpaces(config, ports);
  expect(result.tabs[0].terminal).toBe('core-remote/t7');
  expect(result.launched[0].presentationTerminal).toBe('proxy-1');
  expect((await readCutoverRecovery(ports.journalRoot)).entries[0].pendingMove).toBeUndefined();
  expect(command).not.toHaveBeenCalled();
  expect(layout).toEqual(before);
  expect(writers).toEqual(['one']);
});

it('an incomplete remote display move never keeps the execution target', async () => {
  config.layout = 'panes';
  const file = await addSession('one', 'First');
  const initial = await setupSpaces(config, ports), owner = initial.launched[0];
  const path = join(ports.journalRoot, 'spaces.json'), journal = JSON.parse(await readFile(path, 'utf8'));
  journal.tabs[0].sessions[0].terminal = 'core-remote/t7';
  journal.tabs[0].sessions[0].result.presentationTerminal = 'proxy-1';
  journal.tabs[0].sessions[0].pane = { tab: 'destination', direction: 'down' };
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  const space = layout.spaces[0], tab = space.tabs[0]; tab.terminal = 'proxy-1' as TerminalAddress;
  tab.terminals = [{ terminal: 'proxy-1' as TerminalAddress, ownerSessionId: 'one' }];
  space.tabs.push({ id: 'destination' as TabId, name: 'Space A', terminal: 'other' as TerminalAddress, ownerSessionId: null });
  await ports.processInventory.presence.record({ ...owner, sessionFile: file, sessionName: 'First', kind: 'top-level', hcAddress: 'core-remote/t7' as TerminalAddress });
  ports.liveSessionFeed = async () => ({ sessionId: 'one', owner: { sessionId: 'one', sessionFile: file, cwd: root, terminal: { address: 'core-remote/t7' } } } as never);
  ports.terminalState = async placement => placement.terminal === 'core-remote/t7' ? 'live' : 'absent';
  ports.observedPresentation = async () => 'proxy-1' as TerminalAddress;
  const before = structuredClone(layout), command = vi.spyOn(ports.app, 'command');
  const plan = (await spaceSetup.planSpaceCutover(config, ports)).join('\n');
  expect(plan).toContain('Setup left "First" running');
  expect(plan).not.toContain('Re-place');
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'running-session-unplaced' });
  expect(command).not.toHaveBeenCalled();
  expect(layout).toEqual(before);
  expect(writers).toEqual(['one']);
  expect((await readCutoverRecovery(ports.journalRoot)).entries[0]).toMatchObject({ placement: { terminal: 'core-remote/t7' }, result: { presentationTerminal: 'proxy-1' } });
});

it('a remote journal without an observed display never keeps or recreates its target', async () => {
  const file = await addSession('one', 'First');
  const initial = await setupSpaces(config, ports), owner = initial.launched[0];
  const path = join(ports.journalRoot, 'spaces.json'), journal = JSON.parse(await readFile(path, 'utf8'));
  journal.tabs[0].sessions[0].terminal = 'core-remote/t7';
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  const tab = layout.spaces[0].tabs[0];
  tab.terminal = 'foreign-shell' as TerminalAddress;
  tab.terminals = [{ terminal: 'foreign-shell' as TerminalAddress, ownerSessionId: null }];
  await ports.processInventory.presence.record({ ...owner, sessionFile: file, sessionName: 'First', kind: 'top-level', hcAddress: 'core-remote/t7' as TerminalAddress });
  ports.liveSessionFeed = async () => ({ sessionId: 'one', owner: { sessionId: 'one', sessionFile: file, cwd: root, terminal: { address: 'core-remote/t7' } } } as never);
  ports.terminalState = async placement => placement.terminal === 'core-remote/t7' ? 'live' : 'absent';
  ports.observedPresentation = async () => null;
  const before = await readFile(path, 'utf8'), oldLayout = structuredClone(layout), command = vi.spyOn(ports.app, 'command');
  expect((await readCutoverRecovery(ports.journalRoot)).entries[0].result?.presentationTerminal).toBeUndefined();
  const plan = (await spaceSetup.planSpaceCutover(config, ports)).join('\n');
  expect(plan).toContain('Setup left "First" running');
  expect(plan).not.toContain('Re-place');
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'running-session-unplaced' });
  expect(command).not.toHaveBeenCalled();
  expect(layout).toEqual(oldLayout);
  expect(writers).toEqual(['one']);
  expect(await readFile(path, 'utf8')).toBe(before);
});

it('an observed proxy cannot authorize a replacement for an unproved remote owner', async () => {
  await addSession('one', 'First');
  const initial = await setupSpaces(config, ports), owner = initial.launched[0];
  const path = join(ports.journalRoot, 'spaces.json'), journal = JSON.parse(await readFile(path, 'utf8'));
  journal.tabs[0].sessions[0].terminal = 'core-remote/t7';
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  const tab = layout.spaces[0].tabs[0];
  tab.terminal = 'proxy-1' as TerminalAddress;
  tab.terminals = [{ terminal: 'proxy-1' as TerminalAddress, ownerSessionId: 'one' }];
  probes.set(owner.pid, { kind: 'absent' });
  ports.terminalState = async () => 'absent';
  ports.liveSessionFeed = async () => null;
  ports.verifyOwner = async () => { throw new HerdrError('owner-activation-unconfirmed', 'Source unavailable'); };
  ports.observedPresentation = async () => 'proxy-1' as TerminalAddress;
  const before = structuredClone(layout), command = vi.spyOn(ports.app, 'command');
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'running-session-unplaced' });
  const recovery = await readCutoverRecovery(ports.journalRoot);
  expect(recovery.entries[0]).toMatchObject({ placement: { terminal: 'core-remote/t7' }, result: { presentationTerminal: 'proxy-1' } });
  expect(command).not.toHaveBeenCalled();
  expect(layout).toEqual(before);
  expect(writers).toEqual(['one']);
});

it('an interrupted remote allocation stays pending without a second writer', async () => {
  await addSession('one', 'First');
  const initial = await setupSpaces(config, ports);
  const path = join(ports.journalRoot, 'spaces.json'), journal = JSON.parse(await readFile(path, 'utf8'));
  journal.tabs[0].sessions[0].terminal = 'core-remote/t7';
  journal.tabs[0].sessions[0].result = null;
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  probes.set(initial.launched[0].pid, { kind: 'absent' });
  ports.terminalState = async () => 'absent';
  ports.verifyOwner = async () => { throw new HerdrError('owner-activation-unconfirmed', 'Source unavailable'); };
  const before = await readFile(path, 'utf8'), command = vi.spyOn(ports.app, 'command');
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'running-session-unplaced' });
  expect(command).not.toHaveBeenCalled();
  expect(writers).toEqual(['one']);
  expect(await readFile(path, 'utf8')).toBe(before);
});

it('old journal rerun preserves native local terminal', async () => {
  await addSession('one', 'First');
  const initial = await setupSpaces(config, ports), recovered = await readCutoverRecovery(ports.journalRoot);
  const path = join(ports.journalRoot, 'spaces.json');
  await writeFile(path, JSON.stringify({ version: 1, focused: true, spaces: [{ name: 'Space A', id: layout.spaces[0].id, adopted: false }], tabs: recovered.entries.map(entry => ({ ...entry, failure: null })) }), { mode: 0o600 });
  const before = await readFile(path, 'utf8'), command = vi.spyOn(ports.app, 'command');
  const again = await setupSpaces(config, ports);
  expect(again.tabs[0].terminal).toBe(initial.tabs[0].terminal);
  expect(again.launched[0].presentationTerminal).toBeUndefined();
  expect(Object.hasOwn(again.launched[0], 'presentationTerminal')).toBe(false);
  expect((await readCutoverRecovery(ports.journalRoot)).entries[0].result?.presentationTerminal).toBeUndefined();
  expect(command).not.toHaveBeenCalled();
  expect(writers).toEqual(['one']);
  expect(await readFile(path, 'utf8')).toBe(before);
});

it.each(['tab.new', 'pane.close'] as const)('recovers a lost %s reply while replacing a lone parked pane without empty tabs', async operation => {
  config.layout = 'panes'; await addSession('one', 'First');
  const initial = await setupSpaces(config, ports), terminal = initial.tabs[0].terminal;
  await confirmOwners(initial);
  await ports.app.command('terminal.park', { terminal });
  const command = ports.app.command; let lost = false;
  ports.app.command = async (name, args) => { const reply = await command(name, args); if (name === operation && !lost) { lost = true; throw new Error('lost placeholder reply'); } return reply; };
  await expect(setupSpaces(config, ports)).rejects.toThrow('lost placeholder reply');
  await setupSpaces(config, ports);
  expect(layout.spaces[0].tabs).toHaveLength(1);
  expect(layout.spaces[0].tabs[0]).toMatchObject({ name: 'Space A', terminals: [{ terminal, ownerSessionId: 'one' }] });
  expect(writers).toEqual(['one']);
  expect(probes.get(initial.launched[0].pid)?.kind).toBe('live');
  const before = structuredClone(layout), noCommands = vi.spyOn(ports.app, 'command');
  expect(await spaceSetup.planSpaceCutover(config, ports)).toEqual([]);
  await setupSpaces(config, ports);
  expect(noCommands).not.toHaveBeenCalled();
  expect(layout).toEqual(before);
  expect(writers).toEqual(['one']);
});
