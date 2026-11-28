// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildGlassLayout } from '../look/layout.js';
import { composite, contrastRatio } from '../look/contrast.js';
import theme from '../../assets/themes/spider-glass.json' with { type: 'json' };

const layouts = new URL('./fixtures/herdr-0.1.12/layouts/', import.meta.url);
const names = { agents: 'spider-agents', spaces: 'spider-spaces', pane: 'spider-pane', tabs: 'spider-tabs', spider: 'spider-panel', chrome: 'spider-chrome', bodyFont: 'Google Sans Flex' };
async function source(): Promise<any> {
  return JSON.parse(await readFile(new URL('main.json', layouts), 'utf8'));
}
function nodes(node: any): any[] {
  return [node, ...(node.children ?? []).flatMap(nodes)];
}

describe('generated glass layout', () => {
  it('defaults explicit terminal cell backgrounds to 60% opacity', async () => {
    expect(buildGlassLayout(await source(), { ...names, release: '0.1.18' }).cell_background_opacity).toBe(0.6);
  });

  it('keeps an explicit cell background opacity of zero', async () => {
    const layout = { ...await source(), cell_background_opacity: 0 };
    expect(buildGlassLayout(layout, { ...names, release: '0.1.18' }).cell_background_opacity).toBe(0);
  });

  it('gives 0.1.18 Settings an opaque popover without making the surface token opaque', async () => {
    const input = await source();
    expect(buildGlassLayout(input, { ...names, release: '0.1.16' }).colors).toMatchObject({ popover: '#161618f0', surface: '#161618f0' });
    expect(buildGlassLayout(input, { ...names, release: '0.1.18' }).colors).toMatchObject({ popover: '#161618', surface: '#161618f0' });
  });

  it.each([true, false])('uses the 0.1.18 shared glass gradient and keeps pane outlines with blur=%s', async windowBlur => {
    const input = JSON.parse(await readFile(new URL('./fixtures/herdr-0.1.18/layouts/main.json', import.meta.url), 'utf8'));
    const result = buildGlassLayout(input, { ...names, release: '0.1.18', windowBlur });
    expect.soft(result.window_blur).toBe(windowBlur ? true : undefined);
    expect.soft(result.background).toEqual({ gradient: ['#18181ab3', '#22201eb3'], angle: 176 });
    expect.soft(result.colors).toMatchObject({ background: '#00000000', canvas: '#00000000', chrome: '#00000000', hover: '#ffffff12', selected: '#ffffff14', raised: '#ffffff1c' });
    expect.soft(result.terminal_opacity).toBe(0);
    expect.soft(nodes(result).find(node => node.id === 'sidebar').background).toBe('#00000000');
    expect.soft(nodes(result).find(node => node.id === 'tabs')).not.toHaveProperty('background');
    const border = { width: 1, color: '#38383a' };
    expect.soft(nodes(result).find(node => node.id === 'panel')).toMatchObject({ background: '#16161833', border });
    expect.soft(nodes(result).find(node => node.content?.tab === 'active').content.pane)
      .toMatchObject({ background: '#16161833', border, focus: { width: 1, color: 'accent' } });
  });

  it('defaults to neutral window blur only for 0.1.16 and retains readable translucent chrome', async () => {
    const input = await source();
    const result = buildGlassLayout(input, { ...names, release: '0.1.16' });
    expect(result.window_blur).toBe(true);
    expect(result.background).toBe('#16161800');
    expect(result.colors).toMatchObject({ canvas: '#16161800', chrome: '#16161899' });
    expect(nodes(result).find(node => node.id === 'sidebar').background).toBe('#161618fa');
    const panel = nodes(result).find(node => node.id === 'panel');
    expect(panel.background).toBe('#161618fa');
    const baseline = buildGlassLayout(input, names);
    expect(panel.border).toEqual(nodes(baseline).find(node => node.id === 'panel').border);
    const pane = nodes(result).find(node => node.content?.tab === 'active').content.pane;
    expect(pane.background).toBe('#161618fa');
    const baselinePane = nodes(baseline).find(node => node.content?.tab === 'active').content.pane;
    expect(pane.border).toEqual(baselinePane.border);
    expect(pane.focus).toEqual(baselinePane.focus);
    for (const token of ['border', 'ring', 'hover', 'selected', 'raised', 'input']) expect((result.colors as Record<string, string>)[token]).toEqual((baseline.colors as Record<string, string>)[token]);
    expect(input).not.toHaveProperty('window_blur');
  });

  it.each(['0.1.13', '0.1.16'])('%s honors blur opt-out and never leaks an inherited field', async release => {
    const off = buildGlassLayout(await source(), { ...names, release, windowBlur: false });
    expect(off).not.toHaveProperty('window_blur');
    const input = { ...await source(), window_blur: true };
    const requested = buildGlassLayout(input, { ...names, release, windowBlur: release === '0.1.13' });
    expect(requested).not.toHaveProperty('window_blur');
    expect(requested.background).toEqual(off.background);
    expect(requested.terminal_menu).toBe('spider-menu');
  });
  it('keeps the same neutral surfaces when blur is switched off', async () => {
    const on = buildGlassLayout(await source(), { ...names, release: '0.1.16' });
    const off = buildGlassLayout(await source(), { ...names, release: '0.1.16', windowBlur: false });
    delete on.window_blur;
    expect(on).toEqual(off);
  });

  it('keeps body text AA over the brightest possible backdrop, including row fills', async () => {
    const result = buildGlassLayout(await source(), { ...names, release: '0.1.16' });
    const colors = result.colors as Record<string, string>;
    const pane = nodes(result).find(node => node.content?.tab === 'active').content.pane;
    const surfaces: Record<string, string> = Object.fromEntries(['sidebar', 'panel', 'tabs'].map(id => [id, nodes(result).find(node => node.id === id).background]));
    surfaces.pane = pane.background;
    const report = Object.entries(surfaces).map(([surface, paint]) => {
      const pairs = ['foreground', 'muted', 'dim'].flatMap(token => ['#00000000', colors.hover, colors.selected, colors.input, ...(token === 'dim' ? [] : [colors.raised])].map(fill => {
        const foreground = theme.colors[token as 'foreground' | 'muted' | 'dim'];
        const background = composite(fill, composite(paint, '#ffffff'));
        return { token, foreground, background, ratio: contrastRatio(foreground, background) };
      }));
      const worst = pairs.sort((a, b) => a.ratio - b.ratio)[0];
      expect(worst.ratio, surface).toBeGreaterThanOrEqual(4.5);
      return { surface, paint, ...worst };
    });
    expect(contrastRatio(theme.colors.dim, composite(colors.selected, composite('#161618cc', '#ffffff')))).toBeLessThan(4.5);
    expect(contrastRatio(theme.foreground, composite(pane.background, '#ffffff'))).toBeGreaterThanOrEqual(4.5);
    for (const token of ['hover', 'selected']) expect(parseInt(colors[token].slice(7), 16) / 255).toBeGreaterThanOrEqual(0.07);
    for (const token of ['hover', 'selected']) expect(parseInt(colors[token].slice(7), 16) / 255).toBeLessThanOrEqual(0.12);
    console.info('Blur contrast over white', JSON.stringify(report));
  });

  it('reserves six pixels for tabs and keeps native window dragging', async () => {
    const result = buildGlassLayout(await source(), names);
    expect(nodes(result).find(node => node.id === 'tabs')).toMatchObject({ size: { px: 6 }, window_drag: true, content: { mod: 'spider-tabs', props: { autoHideTabs: true } } });
    expect(nodes(result).filter(node => node.window_drag).map(node => node.id)).toContain('tabs');
  });

  it('the opt-out restores the full tab block', async () => {
    const on = buildGlassLayout(await source(), names);
    const off = buildGlassLayout(await source(), { ...names, autoHideTabs: false });
    expect(nodes(on).find(node => node.id === 'tabs').size).not.toEqual(nodes(off).find(node => node.id === 'tabs').size);
    expect(nodes(off).find(node => node.id === 'tabs')).toMatchObject({ size: { px: 42 }, window_drag: true, content: { props: { autoHideTabs: false } } });
  });
  it('does not install the workspace status mod', async () => {
    const result = buildGlassLayout(await source(), names);
    expect(nodes(result).map(node => node.content?.mod).filter(Boolean)).not.toContain('workspace-status');
  });

  it('selects a terminal menu only on releases that provide its mod', async () => {
    const input = await source();
    expect(buildGlassLayout(input, names)).not.toHaveProperty('terminal_menu');
    for (const release of ['0.1.13', '0.1.16']) {
      expect(buildGlassLayout(input, { ...names, release }).terminal_menu).toBe('spider-menu');
    }
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
