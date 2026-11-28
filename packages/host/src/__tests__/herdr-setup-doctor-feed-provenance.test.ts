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

it.each(['missing', 'unreadable', 'malformed'])('doctor never treats %s writer provenance as ended', async kind => {
  const f = await focusedSetupFixture({ coreTransport: 'socket' }); await setupHerdr(f.request, f.parts);
  const w = await writer(f), bytes = await readFile(w.path); await stop(w.child);
  const record = join(f.request.config.globalRoot, 'herdr/feed-writers', w.owner.sessionId + '.json');
  if (kind === 'missing') await rm(record);
  else if (kind === 'unreadable') await chmod(record, 0);
  else await writeFile(record, '{');
  const result = await doctor(f);
  expect(result.code).toBe(1);
  expect(result.output).toContain('feed-stale:');
  expect(result.output).not.toContain('left by a session that ended without quitting');
  expect(await readFile(w.path)).toEqual(bytes);
}, 60000);
