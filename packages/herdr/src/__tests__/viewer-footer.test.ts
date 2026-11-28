// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { stripTerminalSequences, visibleWidth, type TUI } from '@earendil-works/pi-tui';
import { createPiRunView, type PiRunView } from '../viewers/pi-app.js';

const views: PiRunView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  vi.useRealTimers();
});
function make(): PiRunView {
  const ui = { requestRender: vi.fn(), setFocus: vi.fn(), terminal: { columns: 100, rows: 30 } } as unknown as TUI;
  const view = createPiRunView({ ui, runName: 'retry-check', ownerName: 'planner', cwd: '/fixture', themeName: 'dark' });
  views.push(view);
  return view;
}
const running = { status: 'running', steerable: true, reachable: true, readOnlyReason: null } as const;

test('viewer input uses the shared band and keeps a draft across reconnect', () => {
  const view = make();
  view.setState(running);
  view.editor!.setText('Keep the retry limit at three.');
  const rows = view.render(72).map(stripTerminalSequences);
  expect(rows).toContain(`▖${'▄'.repeat(71)}`);
  expect(rows.some(row => row.startsWith('▌ Keep the retry limit at three.'))).toBe(true);
  expect(rows).toContain(`▘${'▀'.repeat(71)}`);
  for (const width of [10, 40, 72]) expect(view.render(width).every(row => visibleWidth(row) <= width)).toBe(true);
  view.setState({ status: 'running', steerable: false, reachable: false, readOnlyReason: 'Owner unavailable.' });
  expect(view.editor).toBeNull();
  view.setState(running);
  expect(view.editor!.getText()).toBe('Keep the retry limit at three.');
});
