// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { registerHerdrViewers } from '../viewers/register.js';
import { HerdrError } from '../client/parse.js';
import type { Owner, RunId } from '../contracts.js';

// A slow app must not turn background viewer launches into user warnings.
test('automatic viewer placement failures do not notify for each run', async () => {
  const owner = { sessionId: 'owner', generation: 'generation', terminal: { coreId: 'core', terminalId: 'owner', address: 'owner' } } as Owner;
  const runs = ['one', 'two', 'three'] as RunId[];
  const handlers = new Map<string, () => Promise<void>>();
  const notices: unknown[] = [], attempted: RunId[] = [];
  const registration = registerHerdrViewers({ on: (name: string, handler: () => Promise<void>) => handlers.set(name, handler) } as never, {
    owner: () => owner, hc: {} as never, viewerExecutable: 'viewer', feedRoot: 'feed', ipcDescriptor: () => null,
    ownedRunEvents: { list: async () => runs, subscribe: () => () => {} },
    panes: { reconcile: async () => {}, acquire: async (_kind, id) => { attempted.push(id as RunId); throw new HerdrError('pane-removal-timeout', `Slow app for ${id}`); },
      release: async () => {}, park: async () => {}, dispose: () => {} },
    reportError: error => notices.push(error),
  });
  try {
    await handlers.get('session_start')!();
    await expect.poll(() => attempted).toEqual(runs);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(notices).toEqual([]);
  } finally { await registration.dispose(); }
});
