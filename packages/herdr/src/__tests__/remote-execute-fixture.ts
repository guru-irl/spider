// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '@spider/db-core';
import { createRemoteExecutor } from '../remote/execute.js';
import { createHerdrHarness, type HerdrHarness } from './testutil.js';
import { createRemoteTestFixture, type RemoteTestFixture } from './acceptance/c.js';
import { installFastCoreTransport } from '../../../host/src/__tests__/herdr-setup-fast-core.js';
import type { ExecCtx } from '../../../context/src/actions/exec.js';
import type { RemoteExecuteRequest, MachineName } from '../contracts.js';

const harnesses: { h: HerdrHarness; restore?: () => void }[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { h, restore } of harnesses.splice(0)) {
    try {
      await h.close(); expect(await h.remainingOwnedResources()).toEqual([]);
      const directory = join(paths.scratch('worktree', process.cwd()), 'h', 'logs');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `c3-${h.mode}-cleanup.json`), JSON.stringify(h.cleanupProof, null, 2));
    } finally { restore?.(); }
  }
});

export async function createOwnedRemoteHarness(mode: 'fake' | 'hc' = 'fake', coreTransport: 'process' | 'socket' = 'process'): Promise<HerdrHarness> {
  if (mode !== 'fake' && coreTransport === 'socket') throw new Error('Socket transport requires fake cores');
  const h = await createHerdrHarness(mode);
  const restore = coreTransport === 'socket' ? installFastCoreTransport(h) : undefined;
  harnesses.push({ h, restore }); await h.start();
  return h;
}

export async function fixture(mode: 'fake' | 'hc' = 'fake', coreTransport: 'process' | 'socket' = 'process'): Promise<{
  h: HerdrHarness;
  f: RemoteTestFixture;
  request: (code: string, options?: Partial<RemoteExecuteRequest>) => RemoteExecuteRequest;
  ctx: ExecCtx;
}> {
  const h = await createOwnedRemoteHarness(mode, coreTransport);
  const f = await createRemoteTestFixture(h);
  const request = (code: string, options: Partial<RemoteExecuteRequest> = {}): RemoteExecuteRequest => ({ source: { kind: 'code', language: 'javascript', code }, on: 'remote.invalid' as MachineName, owner: h.owner!, ...options });
  const ctx = { cwd: h.owner!.cwd, owner: h.owner!, remote: createRemoteExecutor(f.ports) };
  return { h, f, request, ctx };
}
