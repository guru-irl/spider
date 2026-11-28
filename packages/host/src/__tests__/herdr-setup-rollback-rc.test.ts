import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJournal } from '../../../herdr/src/setup/backup.js';
import { setupHerdr, rollbackHerdr } from '../../../herdr/src/setup/installer.js';
import { cleanup, fixture } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';

// These fixtures own no unrelated pi sessions on the host.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture({ coreTransport: 'socket' });

it.each(['export BEFORE=1', '# existing rc\nexport BEFORE=1', '', 'export BEFORE=1\n'])('rollback restores an untouched rc byte for byte: %j', async original => {
  const f = await fastFixture();
  await writeFile(f.request.config.shellRc, original);
  await setupHerdr(f.request, f.parts);
  await rollbackHerdr(f.request, f.parts);
  expect(await readFile(f.request.config.shellRc)).toEqual(Buffer.from(original));
});
