// SPDX-License-Identifier: MIT
import { expect, it } from 'vitest';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptanceSetup } from './scenario-setup.js';
import { createHerdrHarness } from './testutil.js';
import type { MachineName } from '../contracts.js';

it('acceptance setup probes with the configured destination Node executable', async () => {
  const h = await createHerdrHarness('fake');
  try {
    await h.start();
    const nodePath = join(h.root, 'destination-node');
    const receipt = join(h.root, 'node-probe-argv');
    await writeFile(nodePath, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(receipt)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    await chmod(nodePath, 0o700);
    // This scenario tests Node preflight only, not runtime installation or payloads.
    await acceptanceSetup(h, {
      machines: [{ name: 'remote.invalid' as MachineName, aliases: [], nodePath, runtime: { directory: h.directories.remote, cwd: null, commands: {} } }],
      parts: { ensureRuntime: async () => [], bootstrapRuntime: async () => {} },
    });
    expect(await readFile(receipt, 'utf8')).toBe('--version\n');
    const probes = (await h.calls()).filter(call => call.argv[0] === 'run' && call.argv.includes('spider.kind=setup-probe'));
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) expect(probe.argv[probe.argv.indexOf('--') + 1]).toBe(nodePath);
  } finally { await h.close(); }
}, 60_000);
