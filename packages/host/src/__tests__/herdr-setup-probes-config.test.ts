// SPDX-License-Identifier: MIT
import { afterEach, it, vi } from 'vitest';
import { cleanup } from './herdr-setup-fixture.js';
import { changedProbe } from './herdr-setup-probe-changes.testutil.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

it.each(['node path', 'root', 'machine'] as const)('a changed %s is checked live instead of trusting recorded evidence', change => changedProbe(change, ''), 60000);
