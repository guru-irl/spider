// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

const node = (row, fields = []) => ({ row, fields: [row.label, ...fields], children: [] });

/** Filter a hierarchy while retaining matching descendants and their ancestors. */
function filtered(node, query, parentMatches = false) {
  const matches = !query || parentMatches || node.fields.some(value => String(value ?? '').toLowerCase().includes(query));
  const children = node.children.flatMap(child => filtered(child, query, matches));
  return matches || children.length ? [node.row, ...children] : [];
}

export function pickerRows(spaces, targets, filter) {
  const localSpaces = spaces.filter(space => space.machine === null);
  const spaceNodes = new Map(), tabNodes = new Map(), targetNodes = new Map();
  for (const space of localSpaces) {
    const spaceNode = node({ kind: 'space', id: `space:${space.id}`, label: space.name, enabled: true, space: space.id });
    spaceNodes.set(space.id, spaceNode);
    for (const tab of space.tabs) {
      const tabNode = node({ kind: 'tab', id: `tab:${space.id}:${tab.id}`, label: tab.name, enabled: true, space: space.id, tab: tab.id }, [tab.status]);
      tabNodes.set(`${space.id}\0${tab.id}`, tabNode);
      spaceNode.children.push(tabNode);
    }
  }
  for (const target of targets) {
    targetNodes.set(target.id, node({ kind: 'target', id: target.id, label: target.name, enabled: target.action !== null, target, depth: 0 },
      [target.path, target.status, target.machine]));
  }
  const unplaced = node({ kind: 'heading', id: 'heading:unplaced', label: 'Agents without a local tab', enabled: false });
  for (const target of targets) {
    const item = targetNodes.get(target.id);
    const parent = target.ownerId && targetNodes.get(target.ownerId);
    if (parent) {
      item.row.depth = parent.row.depth + 1;
      parent.children.push(item);
      continue;
    }
    const space = spaceNodes.get(target.space);
    const tab = tabNodes.get(`${target.space}\0${target.tab}`);
    (tab ?? space ?? unplaced).children.push(item);
  }
  const selectedSpace = localSpaces.find(space => space.active) ?? localSpaces[0] ?? null;
  const createTab = node({ kind: 'new-tab', id: 'new-tab', label: 'New tab', enabled: selectedSpace !== null,
    machine: '', space: selectedSpace?.id ?? null });
  const createSpace = node({ kind: 'new-space', id: 'new-space', label: 'New space', enabled: true, machine: '' });
  const query = filter.trim().toLowerCase();
  const result = localSpaces.flatMap(space => filtered(spaceNodes.get(space.id), query));
  if (unplaced.children.length) {
    const children = unplaced.children.flatMap(child => filtered(child, query));
    if (children.length) result.push(unplaced.row, ...children);
  }
  result.push(...filtered(createTab, query), ...filtered(createSpace, query));
  return result;
}

export function selectPickerRow(rows, selectedId, direction) {
  const enabled = rows.filter(row => row.enabled);
  if (!enabled.length) return null;
  const index = enabled.findIndex(row => row.id === selectedId);
  if (index < 0) return enabled[0].id;
  return enabled[(index + direction + enabled.length) % enabled.length].id;
}
