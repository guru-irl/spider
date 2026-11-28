// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createBundledFixture } from './herdr-setup-bundled-writer.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { setupHerdr } from '../../../herdr/src/setup/installer.js';
import type { Owner, SessionFeed, SessionId, Generation } from '../../../herdr/src/contracts.js';
import { cleanup, type SetupFixture } from './herdr-setup-fixture.js';
import { focusedSetupFixture } from './herdr-setup-focused-fixture.js';
import { closedOwner, doctor } from './herdr-setup-closed-feed-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

it.each(['missing', 'unreadable', 'malformed'])('a closed feed with %s writer provenance still fails verification', async kind => {
  const f = await focusedSetupFixture({ coreTransport: 'socket' }); await setupHerdr(f.request, f.parts);
  const owner = await closedOwner(f, true);
  if (kind === 'missing') await rm(owner.record, { force: true });
  else if (kind === 'unreadable') await chmod(owner.record, 0);
  else await writeFile(owner.record, '{');
  const result = await doctor(f);
  expect(result.code).toBe(1);
  expect(result.output).toContain('feed-stale:');
  expect(result.output).not.toContain('feed-owner-ended:');
}, 60000);
