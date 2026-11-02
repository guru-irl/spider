// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { installFixtureRuntime, mountedFixture } from './herdr-wiring-fixture.js';
import { createClientFixture } from '../../../herdr/src/__tests__/testutil.js';
import { createHcClient } from '../../../herdr/src/client/hc.js';
import { resolveMachine } from '../herdr/machine.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('retains a plain ssh target alias from hc even with a via transport', async () => {
  const h = await createClientFixture();
  try {
    await h.configure({ machines: [{ id: 'remote-core', name: 'alpha.invalid', host: 'host.invalid', target: 'user@alias.invalid', version: '0.1.16', session: 'remote', via: true }] });
    const client = createHcClient({ binary: h.hcBinary, env: h.localEnv });
    expect((await client.machines())[0].aliases).toContain('alias.invalid');
    await client.dispose();
  } finally { await h.close(); }
});

it('matches a configured name to a differently named hc machine and refuses collisions', async () => {
  const planner = { name: 'planner.invalid', aliases: ['alpha.invalid'], runtime: { cwd: null, directory: '/runtime', commands: {} } };
  const reviewer = { name: 'beta.invalid', aliases: ['shared.invalid'], runtime: { cwd: null, directory: '/runtime', commands: {} } };
  const hc = { machines: async () => [
    { id: 'one', name: 'alpha.invalid', aliases: ['alpha.invalid', 'ssh-alias.invalid', 'shared.invalid'], state: 'connected', sessionNamespace: 'remote', runtime: null },
    { id: 'two', name: 'beta.invalid', aliases: ['beta.invalid'], state: 'connected', sessionNamespace: 'remote', runtime: null },
  ] } as never;
  expect((await resolveMachine(hc, [planner] as never, 'SSH-ALIAS.INVALID')).on).toBe('alpha.invalid');
  await expect(resolveMachine(hc, [planner, reviewer] as never, 'shared.invalid')).rejects.toMatchObject({ code: 'machine-ambiguous' });
});

it('uses aliases in a child remote execution', async () => {
  vi.stubEnv('PI_SUBAGENT_RUN_ID', 'child-fixture');
  vi.stubEnv('PI_SPIDER_TOP_SESSION_ID', 'parent-fixture');
  const f = await mountedFixture('fake', 'tui', true, true, true, true);
  try {
    vi.stubEnv('PI_SUBAGENT_CHILD', '0');
    try { await installFixtureRuntime(f); } finally { vi.stubEnv('PI_SUBAGENT_CHILD', '1'); }
    const execution = f.mount.execution();
    const result = await execution.remote!.execute({ owner: execution.owner!, on: 'MANAGED.EXAMPLE.INVALID' as never,
      source: { kind: 'code', language: 'shell', code: 'printf child-alias-ok' } });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'child-alias-ok', remote: { machine: 'remote.invalid' } });
  } finally { await f.close(); }
}, 120000);

it('uses a configured alias for execution and file preflight, and explains misses', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, true);
  try {
    await installFixtureRuntime(f);
    const execution = f.mount.execution();
    const result = await execution.remote!.execute({ owner: execution.owner!, on: 'MANAGED.EXAMPLE.INVALID' as never,
      source: { kind: 'code', language: 'shell', code: 'printf alias-ok' } });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'alias-ok', remote: { machine: 'remote.invalid' } });
    const hcAlias = (await f.h.hc.machines()).find(machine => machine.name === 'remote.invalid')!.aliases.find(alias => alias !== 'remote.invalid');
    expect(hcAlias).toBeTruthy();
    const byHcAlias = await execution.remote!.execute({ owner: execution.owner!, on: hcAlias!.toUpperCase() as never,
      source: { kind: 'code', language: 'shell', code: 'printf hc-alias-ok' } });
    expect(byHcAlias).toMatchObject({ exitCode: 0, stdout: 'hc-alias-ok', remote: { machine: 'remote.invalid' } });

    const file = join(f.h.directories.remote, 'alias-script.sh');
    await f.h.hc.fileWrite('remote.invalid' as never, file, Buffer.from('printf file-ok'));
    expect(await f.mount.guard({ toolName: 'spider', input: { action: 'exec_file', language: 'shell', on: 'MANAGED.EXAMPLE.INVALID', path: file } })).toBeUndefined();
    const fileResult = await execution.remote!.execute({ owner: execution.owner!, on: 'MANAGED.EXAMPLE.INVALID' as never,
      source: { kind: 'file', language: 'shell', path: file, code: 'printf "%s" "$FILE_CONTENT"' } });
    expect(fileResult).toMatchObject({ exitCode: 0, stdout: 'printf file-ok' });

    await expect(execution.remote!.execute({ owner: execution.owner!, on: 'missing.invalid' as never,
      source: { kind: 'code', language: 'shell', code: 'true' } })).rejects.toThrow(/remote\.invalid.*managed\.example\.invalid/i);
  } finally { await f.close(); }
}, 120000);
