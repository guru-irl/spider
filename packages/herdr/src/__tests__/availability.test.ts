// SPDX-License-Identifier: MIT
import { afterEach, expect, test } from 'vitest';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHcClient } from '../client/hc.js';
import { herdrErrorNotice } from '../notices.js';
import { createClientFixture, type ClientFixture } from './testutil.js';
const fixtures: ClientFixture[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

test('program arguments cannot turn a local failure into a destination warning', async () => {
  const f = await createClientFixture(); fixtures.push(f);
  const script = join(f.root, 'fail-run.mjs'), binary = join(f.root, 'fail-run');
  await writeFile(script, `import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === 'run') {
  console.error(JSON.stringify({ error: { kind: 'unavailable', message: 'A synthetic local failure' } }));
  process.exit(5);
}
const result = spawnSync(${JSON.stringify(f.hcBinary)}, args, { stdio: 'inherit' }); process.exit(result.status ?? 1);
`);
  await writeFile(binary, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`); await chmod(binary, 0o700);
  const client = createHcClient({ binary, env: f.localEnv });
  try {
    const error = await client.run({ argv: ['program', '--on', 'payload.invalid'], cwd: null, labels: {}, parent: null, background: true, outliveParent: true, noNotify: true }).catch(error => error);
    expect(herdrErrorNotice(error)).toContain("Herdr couldn't respond to spider");
    expect(herdrErrorNotice(error)).not.toContain('payload.invalid');
  } finally { await client.dispose(); }
});

test('remote error messages cannot inject advice or control characters into a destination warning', async () => {
  const f = await createClientFixture(); fixtures.push(f);
  await f.configure({ failure: { kind: 'unavailable', message: 'Private diagnostic text\u001b[31m', hint: '/private/location' } });
  const client = createHcClient({ binary: f.hcBinary, env: f.localEnv });
  try {
    const error = await client.get(f.address('dest.invalid/t1')).catch(error => error);
    expect(herdrErrorNotice(error)).toContain('dest.invalid');
    expect(herdrErrorNotice(error)).toContain('keep trying');
    expect(herdrErrorNotice(error)).not.toMatch(/Private|location|\u001b|herdr-setup|doctor/);
  } finally { await client.dispose(); }
});
