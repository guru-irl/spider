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
import { doctor, stop, writer } from './herdr-setup-doctor-feed-fixture.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => args[0] === 'ps' && args[1]?.[0] === '-U' ? '' : actual.execFileSync(...args) };
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

it('stale live-owner feeds fail, but the same unchanged feed is information after its writer dies', async () => {
  const f = await focusedSetupFixture({ coreTransport: 'process' }); await setupHerdr(f.request, f.parts);
  const w = await writer(f), bytes = await readFile(w.path);
  const live = await doctor(f);
  expect(live.code).toBe(1);
  expect(live.output).toContain('feed-stale:');
  await stop(w.child);
  const ended = await doctor(f);
  expect(ended.code, ended.output).toBe(0);
  expect(ended.output).toContain('left by a session that ended without quitting');
  expect(ended.output).not.toContain('feed-stale:');
  expect(ended.output).not.toContain('Run setup from a plain shell');
  expect(await readFile(w.path)).toEqual(bytes);
}, 60000);

it('information about an ended owner does not conceal another stale live owner', async () => {
  const f = await focusedSetupFixture({ coreTransport: 'socket' }); await setupHerdr(f.request, f.parts);
  const ended = await writer(f); await stop(ended.child);
  const live = await writer(f, true);
  const result = await doctor(f);
  expect(result.code).toBe(1);
  expect(result.output).toContain('feed-stale:');
  expect(result.output).toContain('left by a session that ended without quitting');
  await stop(live.child);
  const allEnded = await doctor(f);
  expect(allEnded.code, allEnded.output).toBe(0);
  expect(allEnded.output.match(/left by a session that ended without quitting/g)).toHaveLength(2);
  expect(allEnded.output).not.toContain('Run setup from a plain shell');
}, 60000);
