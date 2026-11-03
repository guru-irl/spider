// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildGlassLayout } from '../look/layout.js';

const layouts = new URL('./fixtures/herdr-0.1.12/layouts/', import.meta.url);
const names = { agents: 'spider-agents', spaces: 'spider-spaces', pane: 'spider-pane', tabs: 'spider-tabs', spider: 'spider-panel', chrome: 'spider-chrome', bodyFont: 'Google Sans Flex' };
async function source(): Promise<any> {
  return JSON.parse(await readFile(new URL('main.json', layouts), 'utf8'));
}
function nodes(node: any): any[] {
  return [node, ...(node.children ?? []).flatMap(nodes)];
}

describe('generated glass layout', () => {
  it('does not install the workspace status mod', async () => {
    const result = buildGlassLayout(await source(), names);
    expect(nodes(result).map(node => node.content?.mod).filter(Boolean)).not.toContain('workspace-status');
  });

  it('matches the desired layout bytes', async () => {
    const result = JSON.stringify(buildGlassLayout(await source(), names), null, 2);
    const expected = await readFile(new URL('spider-glass.json', layouts), 'utf8');
    expect(result).toBe(expected);
  });

  it('removes the status node even when its mod has changed', async () => {
    const input = await source();
    nodes(input).find(node => node.id === 'status').content.mod = 'other-mod';
    const result = buildGlassLayout(input, names);
    expect(nodes(result).find(node => node.id === 'status')).toBeUndefined();
  });
});
