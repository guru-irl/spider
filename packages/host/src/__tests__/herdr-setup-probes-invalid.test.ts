import { afterEach, expect, it, vi } from 'vitest';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import { cleanup } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { replay, runs } from './herdr-setup-probe-checks.js';
import { changedProbe } from './herdr-setup-probe-changes.testutil.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const fastFixture = () => focusedSetupFixture({ coreTransport: 'socket' });

it.each(['invalid result'] as const)('a changed %s is checked live instead of trusting recorded evidence', change => changedProbe(change, ''), 60000);

it('a failed earlier root probe is never reused as passing evidence', async () => {
  const f = await fastFixture();
  await f.h.scenario({ steps: [{ argvIncludes: ['--probe'], stderr: 'earlier probe failed', exitCode: 1 }] });
  await expect(setupHerdr(f.request, await f.ports.setupParts(f.request))).rejects.toMatchObject({ code: 'runtime-bootstrap-failed' });
  await f.h.scenario({});
  const before = (await runs(f)).length;
  await setupHerdr(f.request, await f.ports.setupParts(f.request));
  expect((await runs(f)).slice(before).some(call => call.argv.includes('--probe'))).toBe(true);
  await replay(f);
}, 60000);
