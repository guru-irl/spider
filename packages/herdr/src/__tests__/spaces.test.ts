// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, rm, stat, access, truncate } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { HerdrConfig, SessionId, SpaceId, TabId, TerminalAddress } from '../contracts.js';
import { parseHerdrConfig } from '../config.js';
import { createTerminalRegistry } from '../sessions/registry.js';
import { createProcessPresence } from '../sessions/presence.js';
import { createSessionLeases, type ProcessProbe } from '../sessions/lease.js';
import { discoverSessions, readSessionMetadata, selectedProcessInventory } from '../spaces/discovery.js';
import { startCutover, type LaunchedSession } from '../spaces/cutover.js';
import { launchSession } from '../sessions/launcher.js';
import { setupSpaces, preflightSpaces, forgetCutoverTabs, readCutoverRecovery, type SpaceSetupPorts, type LayoutSnapshot } from '../spaces/setup.js';
let root: string; let config: HerdrConfig; let ports: SpaceSetupPorts; let files: string[]; let probes: Map<number, ProcessProbe>;
let layout: LayoutSnapshot; let messages: string[]; let listed: { name: string | null; pid: number }[]; let writers: string[]; let ticks: number; let waits: number;
let unknown: boolean; let fail: boolean; let nextPid: number; let notes: boolean;
beforeEach(async () => {
  await mkdir(resolve('.spider/scratch/h'), { recursive: true }); root = await mkdtemp(resolve('.spider/scratch/h/g3-')); files = []; probes = new Map(); messages = []; listed = []; writers = []; ticks = 0; waits = 0; unknown = false; fail = false; notes = true; nextPid = 500;
  config = { enabled: true, app: { binary: 'fixture', home: root }, core: { binary: 'fixture', config: join(root, 'core.toml') }, agentDirectory: root, globalRoot: root, shellRc: join(root, 'rc'), spaces: [{ name: 'Space A', sessions: [] }], machines: [], limits: { auxiliaryPanes: 2, completedRows: 50, completedHours: 24 }, retention: { foregroundDays: 7 }, admin: { wrappers: [] } };
  layout = { spaces: [] };
  const processInventory = { presence: createProcessPresence(root), leases: createSessionLeases(root), processes: async () => unknown ? [{ pid: 999, startIdentity: 'unknown', classification: 'pi' as const }] : [], probe: async (pid: number) => probes.get(pid) ?? { kind: 'absent' as const } };
  const results = new Map<string, LaunchedSession>(); const errors = new Map<string, Error>();
  async function allocate(name: string, spaceName: string, spaceId: SpaceId | null, argv: readonly string[]) {
    const flags = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(argv.slice(0, 7)).toEqual([process.execPath, '-e', 'process.env.PI_CODING_AGENT_DIR=process.argv[1].slice("PI_CODING_AGENT_DIR=".length);process.argv.splice(1,2);import(require("node:url").pathToFileURL(process.argv[1]).href)', `PI_CODING_AGENT_DIR=${root}`, process.execPath, join(root, 'cli.mjs'), 'resume']);
    let space = layout.spaces.find(s => s.id === spaceId);
    if (!space) { space = { id: `space-${layout.spaces.length}` as SpaceId, name: spaceName, tabs: [] }; layout.spaces.push(space); }
    const tab = { id: `tab-${space.tabs.length}` as TabId, name, ownerSessionId: null as string | null, terminal: `fresh-${nextPid}` as TerminalAddress }; space.tabs.push(tab);
    try {
      const result = await launchSession({ sessionFile: flags('--file'), sessionId: flags('--session-id') as SessionId, cwd: flags('--cwd'), environment: { agentDirectory: root, extensionArguments: [] } }, {
        leases: processInventory.leases, processInventory: selectedProcessInventory({ ...config, spaces: [{ name: spaceName, sessions: [{ file: flags('--file') }] }] }, processInventory), processIdentity: { pid: 400, startIdentity: 'setup' }, env: {}, publishMapping: async result => { await createTerminalRegistry(root).record({ owner: { sessionId: result.sessionId, generation: 'fixture' as import('../contracts.js').Generation, sessionFile: result.sessionFile, name, cwd: result.cwd, terminal: { coreId: 'fixture' as import('../contracts.js').CoreId, terminalId: tab.terminal as unknown as import('../contracts.js').TerminalId, address: tab.terminal, socket: join(root, 'fixture.sock'), sessionNamespace: 'fixture' } }, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: root, extensionArguments: [] } }); },
        spawnPi: async request => { if (fail) throw new Error('lost launch'); const pid = nextPid++; probes.set(pid, { kind: 'live', startIdentity: `start:${pid}` }); writers.push(request.sessionId); await writeFile(join(root, 'writers.json'), JSON.stringify(writers)); return { pid, startIdentity: `start:${pid}` }; },
      });
      const { token: _token, ...safe } = result; results.set(tab.terminal, safe); tab.ownerSessionId = result.sessionId;
    } catch (error) { errors.set(tab.terminal, error as Error); }
    return { space: space.id, tab: tab.id, terminal: tab.terminal };
  }
  ports = { processInventory, registry: createTerminalRegistry(root), listSessionFiles: async () => files, journalRoot: join(root, 'setup'), coreIdentity: async () => ({ coreId: 'fixture' as import('../contracts.js').CoreId, socket: join(root, 'fixture.sock'), sessionNamespace: 'fixture' }), clock: () => ticks,
    reportLive: rows => { listed = rows.map(r => ({ name: r.sessionName, pid: r.pid })); }, reportBlocked: message => { messages.push(message); }, notesDisabled: async () => notes,
    waitForChange: async () => { waits++; ticks += 100; if (waits === 1) probes.set(100, { kind: 'absent' }); else unknown = false; },
    layoutSnapshot: async () => structuredClone(layout), launcher: { nodePath: process.execPath, cliPath: join(root, 'cli.mjs'), configPath: join(root, 'config.json') },
    app: { ownerPlacement: async () => { throw new Error('unused'); }, awaitPane: async () => { throw new Error('unused'); }, command: async (command, args) => {
      if (command === 'space.new') return allocate(args.tab as string, args.name as string, null, args.argv as string[]);
      if (command === 'tab.new') return allocate(args.name as string, '', args.space as SpaceId, args.argv as string[]);
      if (command === 'tab.rename') { const tab = layout.spaces.flatMap(s => s.tabs).find(t => t.id === args.id); if (tab) tab.name = args.name as string; return {}; }
      if (command === 'tab.close') { for (const space of layout.spaces) space.tabs = space.tabs.filter(t => t.id !== args.id); return {}; }
      if (command === 'space.select') return {}; throw new Error('Unexpected app command');
    } },
    terminalState: async placement => errors.has(placement.terminal) ? 'finished' : results.has(placement.terminal) && probes.get(results.get(placement.terminal)!.pid)?.kind === 'live' ? 'live' : 'absent',
    verifyOwner: async (_target, placement) => { const result = results.get(placement.terminal); if (!result) throw errors.get(placement.terminal) ?? new Error('owner unavailable'); return result; },
  };
});
afterEach(async () => rm(root, { recursive: true, force: true }));
async function addSession(id: string, name: string) {
  const file = join(root, `${id}.jsonl`); await writeFile(file, [JSON.stringify({ type: 'session', version: 3, id, cwd: root }), JSON.stringify({ type: 'session_info', name: 'old name' }), JSON.stringify({ type: 'session_info', name })].join('\n') + '\n'); files.push(file); config.spaces[0].sessions.push({ file }); return file;
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
import { acceptanceSpaces, acceptanceResume, acceptanceG } from './acceptance/g.js';
it.skipIf(process.env.SPIDER_HERDR_APP_E2E === '1' && process.env.SPIDER_HERDR_APP_TESTS !== '1')('spaces acceptance (real app requires user opt-in)', async () => runAcceptance('spaces', acceptanceSpaces), 60000);

it.skipIf(process.env.SPIDER_HERDR_APP_E2E === '1' && process.env.SPIDER_HERDR_APP_TESTS !== '1')('resume acceptance (real app requires user opt-in)', async () => runAcceptance('resume', acceptanceResume), 60000);

it.skipIf(process.env.SPIDER_HERDR_APP_E2E === '1' && process.env.SPIDER_HERDR_APP_TESTS !== '1')('combined resume and spaces acceptance leaves no finished resume fixture', async () => runAcceptance('combined-resume-spaces', acceptanceG), 60000);

it('cutover refuses a recorded absolute extension argument before allocating any tab', async () => {
  const file = await addSession('s1', 'named');
  await ports.registry.record({ owner: { sessionId: 's1' as SessionId, generation: 'old' as import('../contracts.js').Generation, sessionFile: file, cwd: root, name: 'named', terminal: { coreId: 'fixture' as import('../contracts.js').CoreId, terminalId: 'old' as import('../contracts.js').TerminalId, address: 'old' as TerminalAddress, socket: join(root, 'fixture.sock'), sessionNamespace: 'fixture' } }, recordedAt: 1, coreStartedAt: 1, environment: { agentDirectory: root, extensionArguments: ['--extension', join(root, 'foreign-extension.js')] } });
  await expect(setupSpaces(config, ports)).rejects.toMatchObject({ code: 'session-explicit-extensions', message: expect.stringContaining('named') });
  expect(writers).toEqual([]); expect(layout.spaces).toEqual([]);
});

it('a changed grouping cannot silently reuse the old journalled placement', async () => {
  await addSession('s1', 'named'); await setupSpaces(config, ports);
  const journal = await readFile(join(root, 'setup/spaces.json'), 'utf8'); config.spaces[0].name = 'Different space';
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
it('forgetting closed created tabs permits setup again without adopting user tabs', async () => {
  await addSession('s1', 'named'); const first = await setupSpaces(config, ports);
  probes.set(first.launched[0].pid, { kind: 'absent' });
  await ports.app.command('tab.close', { id: first.tabs[0].tab });
  await forgetCutoverTabs(ports.journalRoot, first.tabs, await ports.layoutSnapshot());
  nextPid++;
  const second = await setupSpaces(config, ports);
  expect(second.tabs).toHaveLength(1); expect(writers).toEqual(['s1', 's1']);
});
it('invalid unrelated sessions are counted and skipped without aborting discovery', async () => {
  await addSession('s1', 'named'); const bad = join(root, 'broken.jsonl'); await writeFile(bad, 'truncated'); files.push(bad);
  config.spaces[0].sessions = [{ name: 'named' }]; const warnings: number[] = [];
  ports.reportSkipped = count => warnings.push(count);
  expect((await discoverSessions(config, ports)).sessions[0]).toMatchObject({ sessionId: 's1', name: 'named' }); expect(warnings).toEqual([1]);
});
it('file selection does not scan unrelated files or a selected session body', async () => {
  const file = await addSession('s1', 'named'); await truncate(file, 512 * 1024 * 1024 + 1);
  files.push(join(root, 'unreadable.jsonl'));
  const manifest = await discoverSessions(config, ports);
  expect(manifest.sessions[0]).toMatchObject({ file, sessionId: 's1', cwd: root });
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

it('bounded reverse name lookup preserves UTF-8 across chunk boundaries', async () => {
  const header = JSON.stringify({ type: 'session', version: 3, id: 'utf8', cwd: root }) + '\n';
  const info = JSON.stringify({ type: 'session_info', name: 'Newest 😀' }) + '\n';
  const prefix = Buffer.from(header + info), split = prefix.indexOf(Buffer.from('😀')) + 2;
  const body = Buffer.from(JSON.stringify({ type: 'message', text: 'x'.repeat(split + 65536 - prefix.length - 29) }) + '\n');
  const file = join(root, 'utf8.jsonl'); await writeFile(file, Buffer.concat([prefix, body]));
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
