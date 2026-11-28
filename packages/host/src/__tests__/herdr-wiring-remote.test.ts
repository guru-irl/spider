import { afterEach, expect, it, vi } from 'vitest';
import { resolve, join } from 'node:path';
import { mountedFixture, heldObserverScenario, assertNoNativeNotes, launchScenario, installFixtureRuntime, closePaneScenario } from './herdr-wiring-fixture.js';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('a pane observer closed before startup returns zero without touching a core', async () => {
  const { runRemoteObserver } = await import('../../../herdr/src/jobs/observer.js'); const signal = new AbortController(); signal.abort();
  expect(await runRemoteObserver({ hcBinary: process.execPath, address: 'remote.invalid/t1' as never, nonce: 'closed', exitFile: resolve('.spider/scratch/no-observer-gate'), env: {}, signal: signal.signal, holdOpen: true })).toBe(0);
});

it('a naturally finished observer returns the attach exit code without a removal gate', async () => {
  const { createClientFixture } = await import('../../../herdr/src/__tests__/testutil.js');
  const { runRemoteObserver } = await import('../../../herdr/src/jobs/observer.js'); const { writeFile, chmod } = await import('node:fs/promises');
  const core = await createClientFixture(); const binary = join(core.root, 'attach');
  try {
    await writeFile(binary, '#!/bin/sh\nexit 23\n'); await chmod(binary, 0o700);
    expect(await runRemoteObserver({ hcBinary: binary, address: 'remote.invalid/t1' as never, nonce: 'finished', exitFile: join(core.root, 'removed.json'), env: core.localEnv })).toBe(23);
  } finally { await core.close(); }
}, 20000);

it('a short-job pane observer stays open after acknowledgement and exits zero when closed', async () => {
  const { createClientFixture } = await import('../../../herdr/src/__tests__/testutil.js');
  const { runRemoteObserver } = await import('../../../herdr/src/jobs/observer.js'); const { writeFile, chmod, access } = await import('node:fs/promises');
  const core = await createClientFixture(); const binary = join(core.root, 'attach'), closed = join(core.root, 'closed'), exitFile = join(core.root, 'removed.json');
  const abort = new AbortController(); let settled = false;
  try {
    await writeFile(binary, '#!/bin/sh\n[ "$1" = attach ] || exit 1\nprintf done > "$CLOSED_FILE"\nexit 23\n'); await chmod(binary, 0o700);
    const pending = runRemoteObserver({ hcBinary: binary, address: 'remote.invalid/t1' as never, nonce: 'finished', exitFile, env: { ...core.localEnv, CLOSED_FILE: closed }, holdOpen: true, signal: abort.signal }).then(code => { settled = true; return code; });
    void pending.catch(() => {});
    await vi.waitFor(async () => { await access(closed); });
    expect(settled).toBe(false);
    await writeFile(exitFile + '.ready', JSON.stringify({ version: 1, nonce: 'finished' }));
    expect(settled).toBe(false); abort.abort();
    expect(await pending).toBe(0);
  } finally { abort.abort(); await core.close(); }
}, 20000);

it.each(['before', 'after'] as const)('a job finishing %s pane acknowledgement keeps its complete observer output until closed', timing => heldObserverScenario('fake', timing), 60000);

it.skipIf(process.env.SPIDER_HERDR_E2E !== '1').each(['before', 'after'] as const)('real isolated hc retains observer output when the job finishes %s acknowledgement; requires SPIDER_HERDR_E2E=1', timing => heldObserverScenario('hc', timing), 60000);

it('the launch checker rejects a recorded producer that omitted --no-notify', () => {
  expect(() => assertNoNativeNotes([{ argv: ['run', '--', 'node'] }])).toThrow();
  expect(() => assertNoNativeNotes([])).toThrow();
});

it.each(['observer', 'console'] as const)('closing a %s pane leaves the real payload running on fake hc', pane => closePaneScenario('fake', pane), 60000);

it.skipIf(process.env.SPIDER_HERDR_E2E !== '1').each(['observer', 'console'] as const)('real isolated hc: closing a %s pane leaves the payload running; requires SPIDER_HERDR_E2E=1', pane => closePaneScenario('hc', pane), 60000);
