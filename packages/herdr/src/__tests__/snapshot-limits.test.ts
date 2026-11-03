// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
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

it('rejects an event over 16 MiB with a named byte-limit error', async () => {
  const f = await fixture();
  await f.configure({ reply: JSON.stringify({ padding: 'x'.repeat(16 * 1024 * 1024) }) + '\n' });
  const client = createHcClient({ binary: f.hcBinary, env: f.localEnv }); clients.push(client);
  await expect(client.events().ready).rejects.toMatchObject({ code: 'reply-too-large', message: expect.stringContaining('16777216') });
}, 30000);

it.each([['transport', transport], ['core', core]] as const)('%s rejects lists over 16 MiB with a named byte-limit error', async (_name, invoke) => {
  const f = await fixture(); await f.configure({ reply: JSON.stringify({ terminals: [], padding: 'x'.repeat(16 * 1024 * 1024) }) });
  await expect(invoke(f.hcBinary, ['ls', '--json'], f.localEnv)).rejects.toMatchObject({ code: 'reply-too-large', message: expect.stringContaining('16777216') });
}, 30000);

it.each([['transport', transport], ['core', core]] as const)('%s retains the small bound for single-object replies', async (_name, invoke) => {
  const f = await fixture(); await f.configure({ reply: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }) });
  await expect(invoke(f.hcBinary, ['get', 't1', '--json'], f.localEnv)).rejects.toMatchObject({ code: 'reply-too-large', message: expect.stringContaining('1048576') });
});

it.each([
  ['reply-too-large', JSON.stringify({ padding: 'x'.repeat(2048) }) + '\n'],
  ['invalid-reply', JSON.stringify({ seq: 'invalid', terminals: [] }) + '\n'],
])('does not respawn events after deterministic %s failure', async (code, reply) => {
  const f = await fixture(); await f.configure({ reply });
  const client = createHcClient({ binary: f.hcBinary, env: f.localEnv, maxReplyBytes: 1024 }); clients.push(client);
  const view = client.events();
  await expect(view.ready).rejects.toMatchObject({ code });
  await view.dispose();
  await new Promise(resolve => setTimeout(resolve, 2700));
  expect((await f.calls()).filter(call => call.argv[0] === 'events')).toHaveLength(1);
});

it('copies each event record only once across many pipe chunks', async () => {
  const f = await fixture(), reply = JSON.stringify({ seq: 1, terminals: [], padding: 'x'.repeat(3 * 1024 * 1024) }) + '\n';
  await f.configure({ reply });
  const concat = vi.spyOn(Buffer, 'concat');
  try {
    const client = createHcClient({ binary: f.hcBinary, env: f.localEnv }); clients.push(client);
    await expect(client.events().ready).resolves.toBeUndefined();
    const copied = concat.mock.calls.reduce((sum, [chunks]) => sum + chunks.reduce((bytes, chunk) => bytes + chunk.byteLength, 0), 0);
    expect(copied).toBeLessThanOrEqual(Buffer.byteLength(reply) * 2);
  } finally { concat.mockRestore(); }
});
