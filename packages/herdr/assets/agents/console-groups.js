// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

export function projectConsoleGroups(rows, ownerId, expandedGroups, liveKeys) {
  const groups = new Map();
  for (const row of rows) {
    if (row.kind !== 'console') continue;
    if (!groups.has(row.parentKey)) {
      const key = `console-group:${JSON.stringify([ownerId, row.parentKey])}`;
      groups.set(row.parentKey, { kind: 'console-group', key, parentKey: row.parentKey, depth: row.depth, count: 0, expanded: expandedGroups.has(key) });
    }
    groups.get(row.parentKey).count++;
  }
  // Virtual parent keys must not collide with real child keys.
  const occupied = new Set(rows.map(row => row.key)), groupParents = new Map();
  for (const [parent, group] of groups) {
    let key = group.key;
    while (occupied.has(key)) key += ':';
    occupied.add(key); groupParents.set(parent, key);
  }
  const siblings = new Map();
  for (const row of rows) {
    if (!siblings.has(row.parentKey)) siblings.set(row.parentKey, []);
    siblings.get(row.parentKey).push(row);
  }
  const ordered = [], visited = new Set();
  const append = row => {
    if (visited.has(row.key)) return;
    visited.add(row.key);
    ordered.push(row);
    visit(row.key);
  };
  const visit = parent => {
    const children = siblings.get(parent) ?? [];
    for (const row of children) if (row.kind !== 'console' && (parent !== null || !liveKeys || liveKeys.has(row.key))) append(row);
    for (const row of children) if (row.kind === 'console') append(row);
    if (parent === null && liveKeys) for (const row of children) if (row.kind !== 'console' && !liveKeys.has(row.key)) append(row);
  };
  visit(null);
  rows.forEach(append);
  const projected = [], emitted = new Set(), hidden = new Set(), offsets = new Map();
  for (const row of ordered) {
    if (hidden.has(row.parentKey)) { hidden.add(row.key); continue; }
    const offset = offsets.get(row.parentKey) ?? 0;
    if (row.kind === 'console') {
      const group = groups.get(row.parentKey);
      if (!emitted.has(row.parentKey)) { projected.push({ ...group, depth: row.depth + offset }); emitted.add(row.parentKey); }
      if (!group.expanded) { hidden.add(row.key); continue; }
      offsets.set(row.key, offset + 1);
      projected.push({ kind: 'child', row: { ...row, parentKey: groupParents.get(row.parentKey), depth: row.depth + offset + 1 } });
    } else {
      offsets.set(row.key, offset);
      projected.push({ kind: 'child', row: offset ? { ...row, depth: row.depth + offset } : row });
    }
  }
  return projected;
}

export function toggleConsoleGroup(expanded, key) {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
