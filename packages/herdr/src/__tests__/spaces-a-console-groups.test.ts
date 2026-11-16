// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { projectConsoleGroups, toggleConsoleGroup } from '../../assets/agents/console-groups.js';
import type { ConsoleSidebarRow } from '../../assets/agents/console-groups.js';
import { selectAgentChildren } from '../../assets/agents/children.js';
import type { AgentTerminal, ChildRow } from '../../assets/agents/children.js';

function terminal(address: string, state: AgentTerminal['state'] = 'live'): AgentTerminal {
  return { address, parent: null, state, status: 'idle', labels: {} };
}
function child(key: string, kind: ChildRow['kind'], overrides: Partial<ChildRow> = {}): ChildRow {
  return { key, kind, address: key, originalAddress: key, name: key, description: null, status: 'working',
    outcome: null, completeness: 'unknown', finishedAt: null, retained: false, depth: 0, parentKey: null,
    machine: null, terminal: terminal(key), action: null, ...overrides };
}
function exampleRows(): ChildRow[] {
  return [
    child('run-1', 'subagent'),
    child('nested-console', 'console', { parentKey: 'run-1', depth: 1 }),
    child('nested-job', 'remote', { parentKey: 'nested-console', depth: 2 }),
    child('console-a', 'console'),
    child('job-a', 'remote', { parentKey: 'console-a', depth: 1 }),
    child('console-b', 'console'),
  ];
}
function group(rows: ConsoleSidebarRow[], parentKey: string | null) {
  const found = rows.find(row => row.kind === 'console-group' && row.parentKey === parentKey);
  if (!found || found.kind !== 'console-group') throw new Error('Console group not found');
  return found;
}
function visibleChildren(rows: ConsoleSidebarRow[]): ChildRow[] {
  return rows.flatMap(row => row.kind === 'child' ? [row.row] : []);
}

it('folds console rows but leaves sibling subagents visible', () => {
  const rows = projectConsoleGroups(exampleRows(), 'box-1.invalid/owner', new Set());
  expect(visibleChildren(rows).map(row => row.kind)).toEqual(['subagent']);
  expect(group(rows, null)).toMatchObject({ kind: 'console-group', count: 2, depth: 0, expanded: false });
  expect(group(rows, 'run-1')).toMatchObject({ kind: 'console-group', count: 1, depth: 1, expanded: false });
});

it('expands only one owners consoles, independently of a subagent group', () => {
  const rows = exampleRows();
  const initial = projectConsoleGroups(rows, 'box-1.invalid/owner', new Set());
  const key = group(initial, null).key;
  const expanded = toggleConsoleGroup(new Set(), key);
  const firstOwner = projectConsoleGroups(rows, 'box-1.invalid/owner', expanded);
  const otherOwner = projectConsoleGroups(rows, 'box-2.invalid/owner', expanded);

  expect(visibleChildren(firstOwner).map(row => row.key)).toEqual(['run-1', 'console-a', 'job-a', 'console-b']);
  expect(group(firstOwner, null).expanded).toBe(true);
  expect(group(firstOwner, 'run-1').expanded).toBe(false);
  expect(group(otherOwner, null).expanded).toBe(false);
  expect(group(otherOwner, null).key).not.toBe(key);
  expect(visibleChildren(otherOwner).map(row => row.key)).toEqual(['run-1']);

  const nested = toggleConsoleGroup(new Set(), group(initial, 'run-1').key);
  const nestedOnly = projectConsoleGroups(rows, 'box-1.invalid/owner', nested);
  expect(visibleChildren(nestedOnly).map(row => row.key)).toEqual(['run-1', 'nested-console', 'nested-job']);
  expect(group(nestedOnly, null).expanded).toBe(false);
});

it('keeps command history folded after group expansion', () => {
  const rows = exampleRows();
  const initial = projectConsoleGroups(rows, 'owner', new Set());
  const expanded = toggleConsoleGroup(new Set(), group(initial, null).key);
  const revealed = visibleChildren(projectConsoleGroups(rows, 'owner', expanded));

  expect(selectAgentChildren(revealed).map(row => row.key)).toEqual(['run-1', 'console-a', 'console-b']);
  expect(selectAgentChildren(revealed, ['console-a']).map(row => row.key)).toEqual(['run-1', 'console-a', 'job-a', 'console-b']);
  expect(expanded.has(group(initial, null).key)).toBe(true);
  const collapsed = toggleConsoleGroup(expanded, group(initial, null).key);
  expect(collapsed.has(group(initial, null).key)).toBe(false);
  expect(expanded.has(group(initial, null).key)).toBe(true);
});

it('counts live reachable consoles not jobs and updates when consoles disappear', () => {
  const rows = exampleRows();
  rows.push(child('console-unreachable', 'console', { status: 'unreachable' }));
  rows.push(child('console-retained', 'console', { retained: true, terminal: terminal('console-retained', 'finished') }));
  rows.push(child('console-finished', 'console', { terminal: terminal('console-finished', 'finished') }));

  expect(group(projectConsoleGroups(rows, 'owner', new Set()), null).count).toBe(2);
  expect(group(projectConsoleGroups(rows.filter(row => row.key !== 'console-a'), 'owner', new Set()), null).count).toBe(1);
  expect(group(projectConsoleGroups(rows.filter(row => !['console-a', 'console-b'].includes(row.key)), 'owner', new Set()), null).count).toBe(0);
});

it('keeps a zero-count group for unavailable consoles', () => {
  const rows = [child('away', 'console', { status: 'unreachable' }), child('old', 'console', { retained: true })];
  const projected = projectConsoleGroups(rows, 'owner', new Set());
  const unavailable = group(projected, null);
  expect(unavailable).toMatchObject({ count: 0, expanded: false });
  expect(visibleChildren(projected)).toEqual([]);
  expect(visibleChildren(projectConsoleGroups(rows, 'owner', toggleConsoleGroup(new Set(), unavailable.key))).map(row => row.key)).toEqual(['away', 'old']);
  expect(projectConsoleGroups([], 'owner', new Set())).toEqual([]);
});

it('leaves raw console rows available outside sidebar folds', () => {
  const rows = exampleRows();
  const before = rows.filter(row => row.kind === 'console').map(row => row.key);
  const initial = projectConsoleGroups(rows, 'owner', new Set());
  projectConsoleGroups(rows, 'owner', toggleConsoleGroup(new Set(), group(initial, null).key));
  expect(rows.filter(row => row.kind === 'console').map(row => row.key)).toEqual(before);
  expect(before).toEqual(['nested-console', 'console-a', 'console-b']);
});
