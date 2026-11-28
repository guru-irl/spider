// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { cleanup, fixture, type SetupFixture } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { replay, runs } from './herdr-setup-probe-checks.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function observeCore(f: SetupFixture): Promise<void> {
  const log = join(f.h.root, 'observed-core-calls.jsonl'), script = join(f.h.root, 'observe-core.mjs'), binary = join(f.h.root, 'observed-core');
  await writeFile(log, '');
  await writeFile(script, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv:process.argv.slice(2)}) + '\\n');\n`);
  await writeFile(binary, `#!/bin/sh\n'${process.execPath}' '${script}' "$@" || exit $?\nexec '${f.h.hcBinary}' "$@"\n`); await chmod(binary, 0o700);
  const config = JSON.parse(await readFile(f.request.configPath, 'utf8')); config.core.binary = binary;
  await writeFile(f.request.configPath, JSON.stringify(config)); f.request = await f.ports.request(f.request.configPath);
}

for (const mode of ['fake', 'hc'] as const) it.skipIf(mode === 'hc' && process.env.SPIDER_HERDR_E2E !== '1')(`unchanged setup launches one live root probe per machine (${mode})`, async () => {
  const f = mode === 'hc' ? await fixture(mode) : await focusedSetupFixture({ coreTransport: 'process' });
  if (mode === 'hc') await observeCore(f);
  await setupHerdr(f.request, await f.ports.setupParts(f.request));
  expect((await runs(f)).length).toBeGreaterThan(0);
  await replay(f);
}, 60000);
