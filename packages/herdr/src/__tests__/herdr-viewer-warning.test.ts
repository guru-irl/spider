// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

test('the built viewer explains a failed launch without exposing internal errors', () => {
  const result = spawnSync(process.execPath, [resolve('dist/herdr/viewer.mjs'), '--bad'], {
    encoding: 'utf8', env: { ...process.env, HC_TERMINAL_ID: undefined, HC_SESSION: undefined, HC_SOCKET: undefined },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("Spider couldn't open this view in Herdr. The session still works. Close the pane and open the view again.\n");
});
