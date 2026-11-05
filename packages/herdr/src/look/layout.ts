// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import edits from '../../assets/look/layout-edits.json' with { type: 'json' };
import { HerdrError, object } from '../client/parse.js';
export interface CloneNames { agents: string; spaces: string; pane: string; tabs: string; spider: string; chrome: string; bodyFont?: string; props?: Partial<Record<'agents' | 'spaces' | 'pane' | 'tabs' | 'spider' | 'chrome', Readonly<Record<string, unknown>>>> }
export interface GlassLayout { [key: string]: unknown }

const removedNodeIds: readonly string[] = edits.remove;

export function buildGlassLayout(currentMain: unknown, names: CloneNames): GlassLayout {
  const root = structuredClone(object(currentMain));
  const nodes: Record<string, unknown>[] = [];
  const walk = (node: Record<string, unknown>): void => {
    nodes.push(node);
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new HerdrError('layout-anchor-mismatch', 'Layout children must be nodes');
      const children = node.children.map(object).filter(child => typeof child.id !== 'string' || !removedNodeIds.includes(child.id));
      node.children = children;
      for (const child of children) walk(child);
    }
  };
  walk(root);
  const one = (id: string): Record<string, unknown> => {
    const found = nodes.filter(n => n.id === id);
    if (found.length !== 1) throw new HerdrError('layout-anchor-mismatch', `Expected one layout node: ${id}`);
    return found[0];
  };
  const panel = one('panel'), body = one('panel-body'), sidebar = one('sidebar'), work = one('work-body');
  if (body.type !== 'stack' || !Array.isArray(body.children) || !(panel.children as unknown[]).includes(body)) throw new HerdrError('layout-anchor-mismatch', 'panel-body must be the panel stack');
  for (const id of ['files', 'changes']) if (!(body.children as unknown[]).includes(one(id))) throw new HerdrError('layout-anchor-mismatch', `${id} must remain in panel-body`);
  if (nodes.some(n => n.id === 'spider')) throw new HerdrError('layout-anchor-mismatch', 'New dock IDs already exist; stage from current main');
  const active = nodes.filter(n => (n.content as Record<string, unknown> | undefined)?.tab === 'active');
  if (active.length !== 1) throw new HerdrError('layout-anchor-mismatch', 'Expected one active tab pane');
  const pane = object(object(active[0].content).pane), header = object(pane.header), headerContent = object(header.content);
  if (headerContent.mod !== 'pane') throw new HerdrError('layout-anchor-mismatch', 'Expected the current pane header mod');
  for (const key of ['agents', 'spaces', 'pane', 'tabs', 'spider', 'chrome'] as const) if (!/^[a-z][a-z0-9-]*$/.test(names[key])) throw new HerdrError('invalid-clone-name', 'Clone names must be simple mod names');
  for (const node of nodes) {
    delete node.divider; delete node.shadow;
    const content = node.content as Record<string, unknown> | undefined;
    if ((node.id === 'brand' || node.id === 'sidebar-footer') && content?.mod === 'workspace-chrome') {
      content.mod = names.chrome; content.props = { ...object(content.props ?? {}), ...names.props?.chrome };
      if (node.id === 'sidebar-footer') Object.assign(node, structuredClone(edits.footer));
    }
    for (const key of ['agents', 'spaces', 'tabs'] as const) if (content?.mod === key) {
      content.mod = names[key]; content.props = { ...object(content.props ?? {}), ...names.props?.[key] };
    }
  }
  Object.assign(root, edits.root, { colors: { ...object(root.colors ?? {}), ...edits.root.colors } });
  if (names.bodyFont) root.ui_font = names.bodyFont;
  sidebar.background = '#00000000'; work.padding = 8; work.gap = 8;
  Object.assign(pane, structuredClone(edits.pane)); delete pane.shadow;
  headerContent.mod = names.pane; headerContent.props = { ...object(headerContent.props ?? {}), ...names.props?.pane };
  Object.assign(panel, structuredClone(edits.dock));
  body.children.push({ id: 'spider', type: 'block', content: { mod: names.spider, props: { ...names.props?.spider } } });
  return root;
}
