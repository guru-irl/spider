// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test, vi } from 'vitest';
import { readPaneScreen } from '../herdr/pane-screen.js';
test('terminal screen uses separately sampled dimensions and core read completeness', async () => {
  const facts = { address: 'core-1/t1', created_ms: 10, cols: 80, rows: 24 };
  const get = vi.fn().mockResolvedValue(facts);
  expect(await readPaneScreen('core-1/t1' as never, { get, read: async () => ({ text: 'Ready', how: 'screen', complete: true }) })).toEqual({ text: 'Ready', cols: 80, rows: 24, complete: true });
  expect(get).toHaveBeenCalledTimes(2);
});
test.each(['resized', 'recreated', 'incomplete', 'malformed'])('screen %s cannot acknowledge presentation', async failure => {
  const facts = { address: 'core-1/t1', created_ms: 10, cols: 80, rows: 24 };
  const get = vi.fn().mockResolvedValueOnce(facts).mockResolvedValueOnce({ ...facts, ...(failure === 'resized' ? { cols: 81 } : failure === 'recreated' ? { created_ms: 11 } : {}) });
  const screen = await readPaneScreen('core-1/t1' as never, { get, read: async () => failure === 'malformed' ? { text: 'Ready' } : { text: 'Ready', how: 'screen', complete: failure !== 'incomplete' } });
  expect(screen.complete).toBe(false);
});
