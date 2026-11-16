// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { projectPanePresentations, type NativePresentationFact } from '../../assets/shared/presentations.js';
import { parsePaneTarget, parseConsoleId } from '../panes/codec.js';
import type { PaneAgentRow, PanePresentation, PaneTarget } from '../panes/types.js';
import type { Owner, RunId, TerminalAddress, SpaceId, TabId, SessionId } from '../contracts.js';
const sessionId = 'session-one' as SessionId;
function target(changes: Partial<PaneTarget> = {}): PaneTarget {
  return parsePaneTarget({ coreId: 'box-core', terminalId: 't7', address: 'box-core/t7', createdMs: 100, identityLabels: { 'spider.session': sessionId },
    alias: 'box-1.invalid', machineId: null, kind: 'session', sessionId, generation: 'generation-one', homeEpoch: null, runId: null, consoleId: null, name: 'Source writer', cwd: '/source/current', ...changes });
}
function agent(changes: Partial<Extract<PaneAgentRow, {unavailableReason: null}>> = {}): PaneAgentRow {
  const execution = target(changes.target ? { ...changes.target } : {});
  return { sessionId, generation: execution.generation!, owner: { sessionId, generation: execution.generation!, terminal: { coreId: execution.coreId, terminalId: execution.terminalId, address: execution.address, socket: '/fixture/core.sock', sessionNamespace: 'fixture' }, cwd: '/source/start', name: 'Old name', sessionFile: null },
    name: 'Renamed writer', status: 'blocked', updatedAt: 1000, machineKey: 'box-1.invalid', target: execution, unavailableReason: null, children: [], consoles: [], ...changes };
}
function presentation(execution = target(), changes: Partial<PanePresentation> = {}): PanePresentation {
  return { id: 'presentation-one', revision: 1, mode: 'proxy', role: 'agent', target: execution, proxy: 't-proxy' as TerminalAddress,
    slot: { space: 'mac-space' as SpaceId, tab: 'mac-tab' as TabId, pane: null }, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null, ...changes };
}
function native(address: string, changes: Partial<NativePresentationFact> = {}): NativePresentationFact {
  return { address: address as TerminalAddress, space: 'native-space' as SpaceId, tab: 'native-tab' as TabId, name: 'Native title', isAgent: true, labels: {}, ...changes };
}
test('target and proxy make one agent row', () => {
  const source = agent(); const input = { agents: [source], presentations: [presentation()], native: [native('box-core/t7', { labels: { 'spider.session': sessionId } }), native('t-proxy', { labels: { 'spider.kind': 'pane-proxy', 'spider.session': sessionId } })] };
  const rows = projectPanePresentations(input);
  expect(rows.filter(row => row.sessionId === sessionId)).toHaveLength(1);
  expect(rows[0]).toMatchObject({ name: 'Renamed writer', status: 'blocked', cwd: '/source/current', displayTerminal: 't-proxy', space: 'mac-space', tab: 'mac-tab', machineLabel: 'box-1.invalid' });
  expect(rows[0].execution).toEqual(source.target);
});
test('parked remote session remains searchable', () => {
  const rows = projectPanePresentations({ agents: [agent()], presentations: [presentation(target(), { visibility: 'parked' })], native: [] });
  expect(rows).toHaveLength(1); expect(rows[0].displayTerminal).toBeNull(); expect(rows[0].machineLabel).toBe('box-1.invalid');
  expect(rows[0].space).toBeNull(); expect(rows[0].tab).toBeNull(); expect(rows[0].name).toBe('Renamed writer');
});
test('child and console use owner Mac space', () => {
  const child = target({ kind: 'subagent', runId: 'child-one' as RunId, terminalId: 't-child' as PaneTarget['terminalId'], address: 'box-core/t-child' as TerminalAddress });
  const console = target({ kind: 'console', consoleId: parseConsoleId(('console-' + '1'.repeat(64))), coreId: 'console-core' as PaneTarget['coreId'], terminalId: 't-console' as PaneTarget['terminalId'], address: 'console-core/t-console' as TerminalAddress, alias: 'box-2.invalid' });
  const rows = projectPanePresentations({ agents: [agent({ children: [{ runId: 'child-one' as RunId, name: 'Child', status: 'running' }], consoles: [{ consoleId: console.consoleId!, machineKey: 'box-2.invalid', name: console.name, target: console }] })],
    presentations: [presentation(), presentation(child, { id: 'child-view', role: 'subagent', proxy: 't-child-proxy' as TerminalAddress, slot: { space: 'other-space' as SpaceId, tab: 'other-tab' as TabId, pane: null } }), presentation(console, { id: 'console-view', role: 'console', proxy: 't-console-proxy' as TerminalAddress })], native: [] });
  const [childRow, consoleRow] = rows[0].children;
  expect(childRow.space).toBe(rows[0].space); expect(childRow.tab).toBe(rows[0].tab); expect(childRow.runId).toBe('child-one'); expect(childRow.displayTerminal).toBe('t-child-proxy');
  expect(consoleRow.space).toBe(rows[0].space); expect(consoleRow.consoleId).toBe(('console-' + '1'.repeat(64))); expect(consoleRow.machineLabel).toBe('box-2.invalid'); expect(consoleRow.displayTerminal).toBe('t-console-proxy');
});
test('all sorting modes use real execution machine', () => {
  const source = agent(); const p = presentation(); const original = JSON.stringify({ source, p });
  const rows = projectPanePresentations({ agents: [source], presentations: [p], native: [native('t-local'), native('t-proxy')] });
  for (const mode of ['name','status','machineLabel','space'] as const) {
    const sorted = [...rows].sort((a,b) => String(a[mode]).localeCompare(String(b[mode])));
    expect(sorted.find(row => row.sessionId === sessionId)?.machineLabel).toBe('box-1.invalid');
    expect(sorted.find(row => row.sessionId === sessionId)?.displayTerminal).toBe('t-proxy');
    expect(sorted.find(row => row.displayTerminal === 't-local')?.machineLabel).toBe('This computer');
  }
  expect(JSON.stringify({ source, p })).toBe(original);
});
test('ordinary native local agents need no proxy', () => {
  const rows = projectPanePresentations({ agents: [], presentations: [], native: [native('t-local', { labels: { 'spider.session': 'local-session' } })] });
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ kind: 'session', sessionId: 'local-session', displayTerminal: 't-local', machineLabel: 'This computer', space: 'native-space' });
});
test('stale feed and native titles cannot replace newer source names and status', () => {
  const newest = agent(); const old = agent({ name: 'Stale name', updatedAt: 1, status: 'working' });
  const rows = projectPanePresentations({ agents: [old,newest], presentations: [], native: [native('box-core/t7', { name: 'Stale native' })] });
  expect(rows).toHaveLength(1); expect(rows[0].name).toBe('Renamed writer'); expect(rows[0].status).toBe('blocked'); expect(rows[0].displayTerminal).toBeNull();
});
test('two remote cores with terminal t7 and duplicate session names stay distinct', () => {
  const otherSession = 'session-two' as SessionId;
  const second = agent({ sessionId: otherSession, target: target({ sessionId: otherSession, coreId: 'other-core' as PaneTarget['coreId'], address: 'other-core/t7' as TerminalAddress, alias: 'box-2.invalid' }) });
  const rows = projectPanePresentations({ agents: [agent(), second], presentations: [presentation(), presentation(second.target!, { id: 'other-view', proxy: 't-other' as TerminalAddress })], native: [native('box-core/t7'), native('other-core/t7')] });
  expect(rows).toHaveLength(2); expect(rows.map(row => row.name)).toEqual(['Renamed writer','Renamed writer']);
  expect(rows.map(row => row.displayTerminal)).toEqual(['t-proxy','t-other']);
});
test('finished children retain run identity without inventing a view', () => {
  const rows = projectPanePresentations({ agents: [agent({ children: [{ runId: 'finished-run' as RunId, name: 'Saved run', status: 'done' }] })], presentations: [], native: [] });
  expect(rows[0].children).toHaveLength(1); expect(rows[0].children[0]).toMatchObject({ runId: 'finished-run', name: 'Saved run', status: 'done', displayTerminal: null, presentationId: null });
});
test('box layout agent appears once and never focuses a remote pane', () => {
  const rows = projectPanePresentations({ agents: [agent()], presentations: [], native: [native('box-core/t7', { labels: { 'spider.session': sessionId } }), native('box-1.invalid/t7', { labels: { 'spider.session': sessionId } })] });
  expect(rows).toHaveLength(1); expect(rows[0].displayTerminal).toBeNull(); expect(rows[0].space).toBeNull();
});
test('remote pi missing from native agents uses spider inventory', () => {
  const rows = projectPanePresentations({ agents: [agent()], presentations: [presentation()], native: [] });
  expect(rows).toHaveLength(1); expect(rows[0].displayTerminal).toBe('t-proxy'); expect(rows[0].name).toBe('Renamed writer');
});
test('not-in-hc rows remain visible but disabled and unplaced', () => {
  const unavailable: PaneAgentRow = { sessionId, generation: null, name: 'Outside hc', status: 'working', updatedAt: 1, machineKey: 'box-1.invalid', owner: null, target: null, unavailableReason: 'not-in-hc', children: [], consoles: [] };
  const row = projectPanePresentations({ agents: [unavailable], presentations: [presentation()], native: [] })[0];
  expect(row).toMatchObject({ execution: null, unavailableReason: 'not-in-hc', displayTerminal: null, machineLabel: 'box-1.invalid', space: null, tab: null });
});
test.each([['local-core','This computer'],[null,'local-core']] as const)('display-only local row uses selected local core %s', (localCoreId, machineLabel) => {
  const row: PaneAgentRow = { sessionId, generation: null, name: 'Outside hc', status: 'working', updatedAt: 1, machineKey: 'local-core', owner: null, target: null, unavailableReason: 'not-in-hc', children: [], consoles: [] };
  expect(projectPanePresentations({ agents: [row], presentations: [], native: [], localCoreId: localCoreId as import('../contracts.js').CoreId | null })[0].machineLabel).toBe(machineLabel);
});
test('parked remote shell stays reopenable in sidebar and Go to', () => {
  const shell = target({ kind: 'terminal', sessionId: null, generation: null, name: 'Untrusted title' });
  const rows = projectPanePresentations({ agents: [], presentations: [presentation(shell, { role: 'shell', visibility: 'parked' })], native: [native('box-core/unrelated', { isAgent: false })] });
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ kind: 'terminal', name: 'Terminal', machineLabel: 'box-1.invalid', displayTerminal: null, presentationId: 'presentation-one' });
  expect(rows[0].execution).toBe(shell);
  // Reopen consumers receive the original execution identity, never a launch program.
  expect(rows[0]).not.toHaveProperty('argv'); expect(rows[0]).not.toHaveProperty('program');
});
test('unrelated remote shells and background jobs never appear', () => {
  const rows = projectPanePresentations({ agents: [], presentations: [], native: [native('box-core/t-shell', { isAgent: false }), native('t-job', { labels: { 'spider.kind': 'exec' } }), native('t-orphan-proxy', { labels: { 'spider.kind': 'pane-proxy' } })] });
  expect(rows).toEqual([]);
});
test('newer presentation revision wins and a parked successor cannot fall back to native target', () => {
  const rows = projectPanePresentations({ agents: [agent()], presentations: [presentation(), presentation(target(), { revision: 2, visibility: 'parked' })], native: [native('box-core/t7')] });
  expect(rows).toHaveLength(1); expect(rows[0].displayTerminal).toBeNull();
});
test('source-local console facts keep their execution machine after remote discovery', () => {
  const console = target({ kind: 'console', consoleId: parseConsoleId(('console-' + '1'.repeat(64))), coreId: 'console-core' as PaneTarget['coreId'], address: 'console-core/t7' as TerminalAddress, alias: null, identityLabels: { 'spider.machine': 'box-2.invalid' } });
  const row = projectPanePresentations({ agents: [agent({ consoles: [{ consoleId: console.consoleId!, machineKey: 'box-2.invalid', name: console.name, target: console }] })], presentations: [], native: [], localCoreId: 'mac-core' as import('../contracts.js').CoreId })[0];
  expect(row.children[0].machineLabel).toBe('box-2.invalid');
});
test('adjacent Mac tab stays distinct while remaining in the owner space', () => {
  const child = target({ kind: 'subagent', runId: 'child-one' as RunId });
  const rows = projectPanePresentations({ agents: [agent({ children: [{ runId: 'child-one' as RunId, name: 'Child', status: 'running' }] })], native: [],
    presentations: [presentation(), presentation(child, { id: 'child', role: 'subagent', slot: { space: 'mac-space' as SpaceId, tab: 'adjacent-tab' as TabId, pane: null } })] });
  expect(rows[0].children[0].space).toBe('mac-space'); expect(rows[0].children[0].tab).toBe('adjacent-tab');
});
test('parked tracked session survives absent source inventory without granting source authority', () => {
  const rows = projectPanePresentations({ agents: [], presentations: [presentation(target(), { visibility: 'parked' })], native: [] });
  expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ sessionId, displayTerminal: null, unavailableReason: 'source-unavailable', machineLabel: 'box-1.invalid' });
});
test('a remote t7 never deduplicates an unrelated local t7', () => {
  const rows = projectPanePresentations({ agents: [agent()], presentations: [], native: [native('t7')] });
  expect(rows).toHaveLength(2); expect(rows[1].displayTerminal).toBe('t7'); expect(rows[0].displayTerminal).toBeNull();
});
test('ended tracked shell disappears and a visible shell focuses only its Mac proxy', () => {
  const shell = target({ kind: 'terminal', sessionId: null, generation: null });
  const input = { agents: [], presentations: [presentation(shell, { role: 'shell' })], native: [] };
  expect(projectPanePresentations(input)[0].displayTerminal).toBe('t-proxy');
  expect(projectPanePresentations({ ...input, presentations: [presentation(shell, { role: 'shell', visibility: 'ended' })] })).toEqual([]);
});
test('source-local address normalization never steals an unrelated Mac terminal id', () => {
  const source = agent({ target: target({ alias: null }) });
  const rows = projectPanePresentations({ agents: [source], presentations: [], native: [native('t7')], localCoreId: 'mac-core' as import('../contracts.js').CoreId });
  expect(rows).toHaveLength(2); expect(rows[0].displayTerminal).toBeNull(); expect(rows[1].displayTerminal).toBe('t7');
});
test('native local source and unlabelled local app fact form one row', () => {
  const source = agent({ target: target({ alias: null }) });
  const rows = projectPanePresentations({ agents: [source], presentations: [], native: [native('t7')] });
  expect(rows).toHaveLength(1); expect(rows[0].displayTerminal).toBe('t7'); expect(rows[0].name).toBe('Renamed writer');
});
test('remote native-mode record never yields a box focus address', () => {
  const row = projectPanePresentations({ agents: [agent()], presentations: [presentation(target(), { mode: 'native', proxy: null })], native: [], localCoreId: 'mac-core' as import('../contracts.js').CoreId })[0];
  expect(row.displayTerminal).toBeNull();
});
test('old generation presentation cannot become a successor display', () => {
  const source = agent({ generation: 'new-generation' as Owner['generation'], target: target({ generation: 'new-generation' as Owner['generation'] }) });
  const row = projectPanePresentations({ agents: [source], presentations: [presentation()], native: [] })[0];
  expect(row.displayTerminal).toBeNull(); expect(row.presentationId).toBeNull();
});

test('retained console is searchable without a terminal, display address or stop authority', () => {
  const consoleId = parseConsoleId('console-' + 'a'.repeat(64));
  const rows = projectPanePresentations({ agents: [agent({ consoles: [{ consoleId, machineKey: 'box-2.invalid', name: 'Retained output', target: null }] })], presentations: [], native: [] });
  expect(rows[0].children[0]).toMatchObject({ kind: 'console', consoleId, name: 'Retained output', status: 'retained, not open', execution: null, displayTerminal: null, presentationId: null, machineLabel: 'box-2.invalid' });
});
