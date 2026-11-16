// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

export function projectConsoleGroups(rows, ownerId, expandedGroups) {
  const groups = new Map();
  for (const row of rows) {
    if (row.kind !== 'console') continue;
    if (!groups.has(row.parentKey)) {
      const key = `console-group:${JSON.stringify([ownerId, row.parentKey])}`;
      groups.set(row.parentKey, { kind: 'console-group', key, parentKey: row.parentKey, depth: row.depth, count: 0, expanded: expandedGroups.has(key) });
    }
    if (!row.retained && row.status !== 'unreachable' && row.terminal?.state === 'live') groups.get(row.parentKey).count++;
  }
  const projected = [], emitted = new Set(), hidden = new Set();
  for (const row of rows) {
    if (hidden.has(row.parentKey)) { hidden.add(row.key); continue; }
    if (row.kind === 'console') {
      const group = groups.get(row.parentKey);
      if (!emitted.has(row.parentKey)) { projected.push(group); emitted.add(row.parentKey); }
      if (!group.expanded) { hidden.add(row.key); continue; }
    }
    projected.push({ kind: 'child', row });
  }
  return projected;
}

export function toggleConsoleGroup(expanded, key) {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
