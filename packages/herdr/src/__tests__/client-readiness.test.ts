// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test } from 'vitest';
import { createHcClient } from '../client/hc.js';
import { createClientFixture, type ClientFixture } from './testutil.js';

const fixtures: ClientFixture[] = [];
const clients: ReturnType<typeof createHcClient>[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('wait did not settle')), 1000); })]); }
  finally { clearTimeout(timer!); }
}

test('every fresh event view fails fast throughout core downtime', async () => {
  const h = await createClientFixture(); fixtures.push(h); await h.stopCore();
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv }); clients.push(client);
  await expect(bounded(client.events().ready)).rejects.toMatchObject({ code: 'core-unavailable' });
  const later = client.events();
  await expect(bounded(later.ready)).rejects.toMatchObject({ code: 'core-unavailable' });
  await expect(bounded(later.lookup(h.address('t1')))).rejects.toMatchObject({ code: 'core-unavailable' });
  expect(await h.calls()).toEqual([]);
});

test('disposing a view releases its outstanding ready and lookup without stopping another view', async () => {
  const h = await createClientFixture(); fixtures.push(h);
  const client = createHcClient({ binary: h.hcBinary, env: h.localEnv }); clients.push(client);
  const first = client.events(), second = client.events();
  const ready = bounded(first.ready), lookup = bounded(first.lookup(h.address('t1')));
  const readyResult = expect(ready).rejects.toMatchObject({ code: 'disposed' });
  const lookupResult = expect(lookup).rejects.toMatchObject({ code: 'disposed' });
  await first.dispose();
  await Promise.all([readyResult, lookupResult]);
  await expect(bounded(first.ready)).rejects.toMatchObject({ code: 'disposed' });
  await bounded(second.ready);
  expect(await second.lookup(h.address('t1'))).toMatchObject({ address: 't1' });
  expect((await h.calls()).filter(call => call.argv[0] === 'events')).toHaveLength(1);
});
