// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it } from 'vitest';
import { createClientFixture, type ClientFixture } from './testutil.js';
import { createHcClient } from '../client/hc.js';
const fixtures: ClientFixture[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
it('passes a console name to hc without putting it in the payload argv', async () => {
  const f = await createClientFixture(); fixtures.push(f);
  const hc = createHcClient({ binary: f.hcBinary, env: f.localEnv });
  try {
    const request = { argv: ['node', 'runtime.mjs', '--console', 'console-dir'], cwd: null, labels: { 'spider.display-name': 'Builder · remote.invalid' }, background: true, outliveParent: true, noNotify: true as const, name: 'console-builder' };
    await hc.run(request);
    const call = (await f.calls()).find(c => c.argv[0] === 'run')!;
    expect(call.argv.slice(0, call.argv.indexOf('--'))).toEqual(expect.arrayContaining(['--name', 'console-builder', '--label', 'spider.display-name=Builder · remote.invalid']));
    expect(call.argv[call.argv.indexOf('--name') + 1]).toBe('console-builder');
    expect(call.argv.slice(call.argv.indexOf('--') + 1)).toEqual(['node', 'runtime.mjs', '--console', 'console-dir']);
  } finally { await hc.dispose(); }
});
