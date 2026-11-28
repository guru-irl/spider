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

test.each([false, true])('adjacent viewer cards have no separator with hidden tool=%s', hidden => {
  const rows = plain(viewer(hidden).render(40));
  const first = rows.indexOf(' first collapsed');
  const second = rows.indexOf(' second');
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThan(first);
  expect(rows.slice(first + 1, second)).toEqual(['', '']);
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
