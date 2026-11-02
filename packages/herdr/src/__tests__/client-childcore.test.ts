// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { createClientFixture, terminal } from './testutil.js';
import { createHcClient } from '../client/hc.js';

// These controls catch a client that calls a live-core ancestry failure an outage,
// or reports a verified replacement as though the current process moved terminals.
test.each(['unrelated process', 'finished terminal'] as const)('a live core reports the actual claim failure: %s', async cause => {
  const f = await createClientFixture();
  const client = createHcClient({ binary: f.hcBinary, env: f.localEnv });
  try {
    await f.configure({ terminals: [cause === 'finished terminal' ? f.finishedTerminal('t1', 0) : { ...terminal('t1'), pid: 2147483647 }] });
    expect(await client.identity()).toMatchObject({ coreId: 'local-core' });
    await expect(client.caller(f.localEnv)).rejects.toMatchObject({ code: 'terminal-core-mismatch', message: "this process is not running inside this session's Herdr terminal (t1); start this session inside that terminal" });
  } finally { await client.dispose(); await f.close(); }
});

test('a verified core-ID change reports the retired core, not a failed ancestry claim', async () => {
  const f = await createClientFixture();
  const client = createHcClient({ binary: f.hcBinary, env: f.localEnv });
  try {
    expect(await client.caller(f.localEnv)).toMatchObject({ coreId: 'local-core' });
    await f.configure({ coreId: 'replacement-core' });
    await expect(client.caller(f.localEnv)).rejects.toMatchObject({ code: 'core-mismatch', message: "this session's Herdr terminal belongs to a core that is no longer running; start a new session in Herdr" });
  } finally { await client.dispose(); await f.close(); }
});
