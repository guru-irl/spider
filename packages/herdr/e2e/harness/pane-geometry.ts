// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
export interface PaneTree { id: string; type: 'block' | 'row' | 'column'; children?: PaneTree[]; size?: { weight: number } }
export function paneTree(ids: readonly string[]): PaneTree { return { id: 'root', type: 'row', children: ids.map(id => ({ id, type: 'block' })) }; }
export function paneOrder(root: PaneTree): string[] { return root.type === 'block' ? [root.id] : (root.children ?? []).flatMap(paneOrder); }
export function splitPane(root: PaneTree, anchor: string, pane: string, direction: 'right' | 'down'): PaneTree {
  if (root.id === anchor && root.type === 'block') {
    const { size, ...leaf } = root;
    return { id: `split-${pane}`, type: direction === 'right' ? 'row' : 'column', ...(size ? { size } : {}), children: [leaf, { id: pane, type: 'block' }] };
  }
  return { ...root, children: root.children?.map(child => splitPane(child, anchor, pane, direction)) };
}
export function removePane(root: PaneTree, pane: string): PaneTree | null {
  if (root.type === 'block') return root.id === pane ? null : root;
  const children = (root.children ?? []).map(child => removePane(child, pane)).filter((child): child is PaneTree => child !== null);
  if (!children.length) return null;
  if (children.length === 1) return { ...children[0], ...(root.size ? { size: root.size } : {}) };
  return { ...root, children };
}
interface Bounds { id: string; x: number; y: number; width: number; height: number }
export function paneBounds(root: PaneTree, box = { x: 0, y: 0, width: 1, height: 1 }): Bounds[] {
  if (root.type === 'block') return [{ id: root.id, ...box }];
  const children = root.children ?? [], total = children.reduce((sum, child) => sum + (child.size?.weight ?? 1), 0);
  let offset = 0;
  return children.flatMap(child => {
    const fraction = (child.size?.weight ?? 1) / total;
    const bounds = root.type === 'row' ? { ...box, x: box.x + offset * box.width, width: box.width * fraction } : { ...box, y: box.y + offset * box.height, height: box.height * fraction };
    offset += fraction; return paneBounds(child, bounds);
  });
}
export function navigatePane(root: PaneTree, focus: string, direction: string, history: Readonly<Record<string, number>>): string {
  const panes = paneBounds(root), anchor = panes.find(pane => pane.id === focus);
  if (!anchor) return focus;
  const vertical = direction === 'up' || direction === 'down', forward = direction === 'right' || direction === 'down';
  const edge = vertical ? anchor.y + (forward ? anchor.height : 0) : anchor.x + (forward ? anchor.width : 0);
  const candidates = panes.filter(pane => pane.id !== focus).map(pane => {
    const otherEdge = vertical ? pane.y + (forward ? 0 : pane.height) : pane.x + (forward ? 0 : pane.width);
    const distance = (otherEdge - edge) * (forward ? 1 : -1);
    const overlap = vertical ? Math.min(anchor.x + anchor.width, pane.x + pane.width) - Math.max(anchor.x, pane.x) : Math.min(anchor.y + anchor.height, pane.y + pane.height) - Math.max(anchor.y, pane.y);
    return { pane, distance, overlap };
  }).filter(item => item.distance >= -1e-8 && item.overlap > 1e-8);
  candidates.sort((a, b) => a.distance - b.distance || (history[b.pane.id] ?? 0) - (history[a.pane.id] ?? 0) || b.overlap - a.overlap || a.pane.y - b.pane.y || a.pane.x - b.pane.x);
  return candidates[0]?.pane.id ?? focus;
}
