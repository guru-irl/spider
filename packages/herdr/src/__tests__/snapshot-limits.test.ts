// SPDX-License-Identifier: MIT
import { afterEach, expect, it } from 'vitest';
import { createClientFixture, terminal, type ClientFixture } from './testutil.js';
import { invokeCli as transport } from '../client/cli-transport.js';
import { createHcClient, invokeCli as core } from '../client/hc.js';

const fixtures: ClientFixture[] = [];
const clients: ReturnType<typeof createHcClient>[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose();
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() { const f = await createClientFixture(); fixtures.push(f); return f; }
const many = () => Array.from({ length: 8000 }, (_, i) => terminal(`t${i + 1}`));

it.each([['transport', transport], ['core', core]] as const)('%s accepts a terminal list larger than 1 MiB by default', async (_name, invoke) => {
  const f = await fixture(), terminals = many(), reply = JSON.stringify({ terminals });
  expect(Buffer.byteLength(reply)).toBeGreaterThan(1024 * 1024);
  await f.configure({ reply });
  expect(await invoke(f.hcBinary, ['ls', '--all', '--json'], f.localEnv)).toEqual({ terminals });
});

it('accepts a snapshot with thousands of terminals by default', async () => {
  const f = await fixture(), terminals = many(); await f.configure({ terminals });
  const client = createHcClient({ binary: f.hcBinary, env: f.localEnv }); clients.push(client);
  const stream = client.events();
  await expect(stream.ready).resolves.toBeUndefined();
  expect(await stream.lookup(f.address('t8000'))).toMatchObject({ address: 't8000' });
});

it('rejects an event over 64 MiB with a named byte-limit error', async () => {
  const f = await fixture();
  await f.configure({ reply: JSON.stringify({ padding: 'x'.repeat(64 * 1024 * 1024) }) + '\n' });
  const client = createHcClient({ binary: f.hcBinary, env: f.localEnv }); clients.push(client);
  await expect(client.events().ready).rejects.toMatchObject({ code: 'reply-too-large', message: expect.stringContaining('67108864') });
}, 30000);

it.each([['transport', transport], ['core', core]] as const)('%s rejects lists over 64 MiB with a named byte-limit error', async (_name, invoke) => {
  const f = await fixture(); await f.configure({ reply: JSON.stringify({ terminals: [], padding: 'x'.repeat(64 * 1024 * 1024) }) });
  await expect(invoke(f.hcBinary, ['ls', '--json'], f.localEnv)).rejects.toMatchObject({ code: 'reply-too-large', message: expect.stringContaining('67108864') });
}, 30000);

it.each([['transport', transport], ['core', core]] as const)('%s retains the small bound for single-object replies', async (_name, invoke) => {
  const f = await fixture(); await f.configure({ reply: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }) });
  await expect(invoke(f.hcBinary, ['get', 't1', '--json'], f.localEnv)).rejects.toMatchObject({ code: 'reply-too-large', message: expect.stringContaining('1048576') });
});
