import { afterEach, expect, it, vi } from 'vitest';
import spiderExtension from '../extension.js';
import { clearActions, getAction, type SpiderArgs } from '../dispatch.js';
import { paths } from '@spider/db-core';
import { globalConfigForTest } from '../../../db-core/src/__tests__/global-config.testutil.js';
import { runHerdrCli } from '../../../herdr/src/setup/cli.js';
import { configFixtureCwd } from './herdr-config-fixture.js';
import { resolve, join } from 'node:path';
import { mountedFixture, heldObserverScenario, assertNoNativeNotes, launchScenario, installFixtureRuntime, closePaneScenario } from './herdr-wiring-fixture.js';

afterEach(() => { clearActions(); vi.unstubAllEnvs(); vi.resetModules(); });

it.each(['reload', 'new', 'resume', 'fork'] as const)('keeps the previous feed live across %s without a closed intermediate', async reason => {
  const f = await mountedFixture(); const { readFile } = await import('node:fs/promises');
  try {
    const before = await readFile(f.feedPath, 'utf8');
    await f.emit('session_shutdown', { reason });
    expect(await readFile(f.feedPath, 'utf8')).toBe(before);
    expect(f.mount.enabled()).toBe(false);
    await f.emit('session_start', { reason });
    const current = JSON.parse(await readFile(f.feedPath, 'utf8'));
    expect(current.lifecycle).toBe('live'); expect(current.generation).not.toBe(f.feed.generation);
    // A direct replacement into disabled mode must not mark the saved feed closed either.
    f.config.enabled = false; await f.emit('session_start', { reason });
    expect(JSON.parse(await readFile(f.feedPath, 'utf8')).lifecycle).toBe('live');
  } finally { await f.close(); }
}, 30000);

it('publishes one final closed feed without IPC when the session quits', async () => {
  const f = await mountedFixture(); const { readFile } = await import('node:fs/promises'); const { existsSync } = await import('node:fs');
  try {
    await f.emit('session_shutdown', { reason: 'quit' });
    const text = await readFile(f.feedPath, 'utf8'), feed = JSON.parse(text);
    expect(feed).toMatchObject({ sessionId: f.feed.sessionId, generation: f.feed.generation, revision: f.feed.revision + 1, lifecycle: 'closed', ipc: null });
    expect(feed.updatedAt).toBeGreaterThanOrEqual(f.feed.updatedAt);
    expect(existsSync(f.feed.ipc.address)).toBe(false); expect(await f.presence.list()).toEqual([]);
    await f.emit('session_shutdown', { reason: 'quit' });
    expect(await readFile(f.feedPath, 'utf8')).toBe(text);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it('uses the configured feed root for IPC after reactivation', async () => {
  const f = await mountedFixture();
  const { join } = await import('node:path'); const { readFile } = await import('node:fs/promises');
  try {
    await f.emit('session_shutdown', { reason: 'reload' });
    vi.stubEnv('SPIDER_GLOBAL_ROOT', join(f.h.root, 'different-global'));
    await f.emit('session_start', { reason: 'startup' });
    const current = JSON.parse(await readFile(f.feedPath, 'utf8'));
    expect(current.ipc.address.startsWith(join(f.config.globalRoot, 'herdr/ipc') + '/')).toBe(true);
    expect(current.ipc.capabilityFile.startsWith(join(f.config.globalRoot, 'herdr/ipc') + '/')).toBe(true);
  } finally { await f.close(); }
});
