// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test } from 'vitest';
import { Container, Text, stripTerminalSequences, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { createPiRunView, type PiRunView } from '../viewers/pi-app.js';

const views: PiRunView[] = [];
afterEach(() => { for (const view of views.splice(0)) view.dispose(); });

function viewer(hidden: boolean): PiRunView {
  const view = createPiRunView({
    ui: { requestRender() {} } as never, runName: 'test', ownerName: null, cwd: '/work/project', themeName: 'dark',
    builtInRenderers: name => name === 'hidden' ? { renderShell: 'self', renderCall: () => new Container() } : {
      renderCall: () => new Text(name, 0, 0),
      renderResult: (_result: unknown, options: { expanded: boolean }) => new Text(`${name} ${options.expanded ? 'expanded' : 'collapsed'}`, 0, 0),
    },
  });
  views.push(view);
  for (const name of hidden ? ['first', 'hidden', 'second'] : ['first', 'second']) {
    view.live({ type: 'tool_execution_start', toolCallId: name, toolName: name, args: {} });
    if (name !== 'hidden') view.live({ type: 'tool_execution_end', toolCallId: name, toolName: name, result: { content: [] }, isError: false });
  }
  return view;
}
const plain = (rows: string[]) => rows.map(row => stripTerminalSequences(row).trimEnd());

test.each([false, true])('adjacent viewer cards have chat half-edges with hidden tool=%s', hidden => {
  const rendered = viewer(hidden).render(40);
  const rows = plain(rendered);
  const first = rows.indexOf(' first collapsed');
  const second = rows.indexOf(' second');
  const firstCall = rows.indexOf(' first');
  const secondResult = rows.indexOf(' second collapsed');
  expect(firstCall).toBeGreaterThan(0);
  expect(first).toBeGreaterThan(firstCall);
  expect(second).toBeGreaterThan(first);
  expect(secondResult).toBeGreaterThan(second);
  expect(rows[firstCall - 1]).toBe('▄'.repeat(40));
  expect(rows.slice(first + 1, second)).toEqual(['▀'.repeat(40), '▄'.repeat(40)]);
  expect(rows[secondResult + 1]).toBe('▀'.repeat(40));
  for (const index of [firstCall - 1, first + 1, first + 2, secondResult + 1]) {
    expect(rendered[index]).toMatch(/^\x1b\[(?:38;2;\d+;\d+;\d+|38;5;\d+|3[0-7]|9[0-7])m[▄▀]{40}\x1b\[39m$/);
  }
});

test('clicking the joined second card expands that card, not the first', () => {
  const view = viewer(true);
  const rows = plain(view.render(40));
  const y = rows.indexOf(' second collapsed');
  expect(y).toBeGreaterThanOrEqual(0);
  const event: TuiMouseEvent = { type: 'click', button: 'left', x: 2, y, width: 40, height: rows.length, screenX: 2, screenY: y, shift: false, alt: false, ctrl: false };
  expect(view.root.handleMouse?.(event)).toMatchObject({ handled: true });
  const after = plain(view.render(40));
  expect(after).toContain(' first collapsed');
  expect(after).toContain(' second expanded');
});

test('visible non-tool content keeps its separator before the next tool', () => {
  const view = viewer(false);
  view.notice('Status update');
  view.live({ type: 'tool_execution_start', toolCallId: 'third', toolName: 'third', args: {} });
  const rows = plain(view.render(40));
  const note = rows.findIndex(row => row.includes('Status update'));
  const third = rows.indexOf(' third');
  expect(note).toBeGreaterThanOrEqual(0);
  expect(rows.slice(note + 1, third)).toEqual(['', '']);
});

test('a self-rendered tool without card edges keeps its separators', () => {
  const view = createPiRunView({
    ui: { requestRender() {} } as never, runName: 'test', ownerName: null, cwd: '/work/project', themeName: 'dark',
    builtInRenderers: name => name === 'raw' ? { renderShell: 'self', renderCall: () => new Text('raw output', 0, 0) }
      : { renderCall: () => new Text(name, 0, 0) },
  });
  views.push(view);
  for (const name of ['first', 'raw', 'last'])
    view.live({ type: 'tool_execution_start', toolCallId: name, toolName: name, args: {} });
  const rows = plain(view.render(40));
  const raw = rows.indexOf('raw output');
  expect(raw).toBeGreaterThanOrEqual(0);
  expect(rows.slice(raw - 2, raw + 4)).toEqual(['', '', 'raw output', '', '', ' last']);
});

test('joined cards forward child clicks at original coordinates and leave off-target clicks to Pi', () => {
  const clicks: string[] = [];
  const view = createPiRunView({
    ui: { requestRender() {} } as never, runName: 'test', ownerName: null, cwd: '/work/project', themeName: 'dark',
    builtInRenderers: name => ({
      renderCall: () => new Text(name, 0, 0),
      renderResult: (_result: unknown, options: { expanded: boolean }) => Object.assign(new Text(`${name} ${options.expanded ? 'expanded' : 'collapsed'}`, 0, 0), {
        handleMouse(event: TuiMouseEvent) {
          if (event.type !== 'click' || event.x !== 0 || event.y !== 0) return undefined;
          clicks.push(name); return { handled: true };
        },
      }),
    }),
  });
  views.push(view);
  for (const name of ['first', 'second', 'third']) {
    view.live({ type: 'tool_execution_start', toolCallId: name, toolName: name, args: {} });
    view.live({ type: 'tool_execution_end', toolCallId: name, toolName: name, result: { content: [] }, isError: false });
  }
  const rows = plain(view.render(40));
  const y = rows.indexOf(' third collapsed');
  expect(y).toBeGreaterThanOrEqual(0);
  const event: TuiMouseEvent = { type: 'click', button: 'left', x: 1, y, width: 40, height: rows.length, screenX: 1, screenY: y, shift: false, alt: false, ctrl: false };
  expect(view.root.handleMouse?.(event)).toMatchObject({ handled: true });
  expect(clicks).toEqual(['third']);
  expect(plain(view.render(40))).toContain(' third collapsed');
  expect(view.root.handleMouse?.({ ...event, x: 2, screenX: 2 })).toMatchObject({ handled: true });
  const after = plain(view.render(40));
  expect(clicks).toEqual(['third']);
  expect(after).toContain(' first collapsed');
  expect(after).toContain(' second collapsed');
  expect(after).toContain(' third expanded');
});
