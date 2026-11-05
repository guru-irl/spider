// SPDX-License-Identifier: MIT
import { expect, test, vi } from 'vitest';
import { createAuxiliaryPanes } from '../jobs/placement.js';

test('a pane cleanup failure has a plain stderr notice', async () => {
  let receive: (event: unknown) => void = () => {};
  let failing = false;
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const placement = { space: 'space', tab: 'tab', pane: 'pane' };
  const hc = {
    events: () => ({ subscribe: (handler: (event: unknown) => void) => { receive = handler; return () => {}; }, dispose: async () => {} }),
    get: async () => ({ labels: {} }),
  };
  const app = { tabTerminals: async () => [], ownerPlacement: async () => { if (failing) throw new Error('private descriptor failure'); return placement; } };
  const owner = { sessionId: 'session', generation: 'first', terminal: { coreId: 'core', address: 'owner' } };
  const panes = createAuxiliaryPanes({ automaticSubagentPanes: true, hc: hc as never, app: app as never, subagentViewer: async () => 'viewer' as never,
    discardSubagentViewer: async () => {}, clock: Date.now });
  try {
    expect(await panes.acquire('subagent', 'run' as never, owner as never, { automatic: true, timeoutMs: 1000 })).not.toBeNull();
    failing = true;
    receive({ type: 'finished', terminal: 'viewer' });
    await expect.poll(() => stderr.mock.calls.length).toBe(1);
    expect(stderr.mock.calls[0]).toEqual(["Spider's Herdr features hit a problem in this session. Everything else in spider still works. Use Run doctor in the spider panel, or run /herdr-setup to print the doctor command for this machine."]);
  } finally { await panes.dispose(); stderr.mockRestore(); }
});
