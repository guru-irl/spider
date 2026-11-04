// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClientFixture } from './testutil.js';
import { invokeCli } from '../client/cli-transport.js';

test('an app-free terminal lookup does not load pane geometry', async () => {
  const f = await createClientFixture();
  try {
    const script = join(f.root, 'standalone.mjs');
    await copyFile(fileURLToPath(new URL('./fake-hc.mjs', import.meta.url)), script);
    await rm(join(f.root, 'app.json'));
    const terminal = await invokeCli(process.execPath, [script, 'get', 't1'], f.localEnv);
    expect(terminal).toMatchObject({ address: 't1', state: 'live', cols: 320, rows: 80 });
  } finally { await f.close(); }
});
