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

it('activation regenerates shared templates from global policy only and skips unchanged files', async () => {
  const f = await mountedFixture();
  const { paths } = await import('@spider/db-core'); const { join, dirname } = await import('node:path'); const { readFile, writeFile, stat, rm, mkdir } = await import('node:fs/promises');
  const file = join(paths.globalRoot, 'config.json');
  const previous = await readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const models = [{ provider: 'fixture', id: 'shared', reasoning: true, input: ['text'] }, { provider: 'fixture', id: 'local', reasoning: true, input: ['text'] }];
  Reflect.set(f.ctx, 'modelRegistry', { getAll: () => models, getAvailable: () => models, find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id) });
  try {
    await writeFile(file, JSON.stringify({ ...JSON.parse(previous?.toString() ?? '{}'), 'models.defaults': { worker: 'fixture/shared:high', reviewer: 'fixture/shared:high', watcher: 'fixture/shared:low' } }));
    await mkdir(join(f.ctx.cwd, '.spider'), { recursive: true });
    await writeFile(join(f.ctx.cwd, '.spider/config.json'), JSON.stringify({ 'models.defaults': { worker: 'fixture/local:low', reviewer: 'fixture/local:low', watcher: 'fixture/local:low' } }));
    await f.emit('session_shutdown', { reason: 'reload' }); await f.emit('session_start', { reason: 'reload' });
    const template = join(dirname(f.config.core.config), 'templates/spider-worker.md');
    const text = await readFile(template, 'utf8'), modified = (await stat(template)).mtimeMs;
    expect(text).toContain("'fixture/shared'"); expect(text).toContain("'high'"); expect(text).not.toContain('fixture/local');
    expect(await readFile(join(f.config.globalRoot, 'herdr/instructions/worker.md'), 'utf8')).toContain('You are the worker');
    await f.emit('session_shutdown', { reason: 'reload' }); await f.emit('session_start', { reason: 'reload' });
    expect(await readFile(template, 'utf8')).toBe(text); expect((await stat(template)).mtimeMs).toBe(modified);
    expect(f.errors).toEqual([]);
  } finally { if (previous) await writeFile(file, previous); else await rm(file, { force: true }); await f.close(); }
});

it('publishes the real native and effective status while a subagent is queued', async () => {
  const f = await mountedFixture(); const { readFile } = await import('node:fs/promises');
  try {
    f.store.create({ sessionId: f.owner!.sessionId, agent: 'worker' });
    await vi.waitFor(async () => {
      const feed = JSON.parse(await readFile(f.feedPath, 'utf8'));
      expect(feed.status).toMatchObject({ native: 'done', effective: 'working', message: '1 queued' });
      expect((await f.ipc!.ping() as { status: unknown }).status).toEqual(feed.status);
    }, { timeout: 5000 });
  } finally { await f.close(); }
});

it('CLI ports recover verified G owners and rollback only G-created tabs', async () => {
  const f = await mountedFixture();
  const { createProductionHerdrCliPorts } = await import('../herdr/ports.js');
  const { writePrivateJson } = await import('../../../herdr/src/sessions/registry.js');
  const { readJournal, saveJournal } = await import('../../../herdr/src/setup/backup.js');
  const { readFile, writeFile } = await import('node:fs/promises'); const { join } = await import('node:path');
  const { processStartTime } = await import('../../../subagents/src/process-identity.js');
  const root = join(f.config.globalRoot, 'herdr'), file = join(f.h.root, 'selected.jsonl');
  const target = { file, cwd: f.ctx.cwd, sessionId: f.owner!.sessionId, name: 'Owner', spaceName: 'Fixture', spaceOrder: 0, sessionOrder: 0, extensionArguments: [] };
  const placement = { space: 's1', tab: 'tb1', terminal: f.owner!.terminal.address };
  const result = { pid: process.pid, startIdentity: processStartTime(process.pid)!, sessionFile: file, sessionId: target.sessionId, cwd: target.cwd };
  const g = { version: 1, spaces: [{ name: 'Fixture', id: 's1', adopted: true }], tabs: [{ target, placement, result, failure: null }], focused: true };
  vi.stubEnv('PI_CODING_AGENT_DIR', f.config.agentDirectory);
  const ports = configFixtureCwd(createProductionHerdrCliPorts(f.h.root, Object.freeze({ ...process.env })), f.ctx.cwd);
  try {
    await writeFile(file, JSON.stringify({ type: 'session', id: target.sessionId, cwd: target.cwd }) + '\n');
    const { createTerminalRegistry } = await import('../../../herdr/src/sessions/registry.js');
    const { publishSessionFeed } = await import('../../../herdr/src/feed/publisher.js');
    const registry = createTerminalRegistry(root), mapping = (await registry.list())[0], present = (await f.presence.list())[0];
    await f.emit('session_shutdown', { reason: 'quit' });
    await registry.record({ ...mapping, owner: { ...mapping.owner, sessionFile: file } });
    await f.presence.record({ ...present, sessionFile: file });
    await publishSessionFeed(root, { ...f.feed, updatedAt: Date.now(), owner: { ...f.feed.owner, sessionFile: file } });
    const { mkdir, chmod } = await import('node:fs/promises');
    const bin = join(f.h.root, 'process-bin'); await mkdir(bin);
    await writeFile(join(bin, 'ps'), '#!/bin/sh\nif [ "$1" = -U ]; then exit 0; fi\nexec /bin/ps "$@"\n'); await chmod(join(bin, 'ps'), 0o700);
    vi.stubEnv('PATH', bin + ':' + process.env.PATH);
    await writePrivateJson(join(root, 'spaces/spaces.json'), g);
    const appBinary = join(bin, 'app');
    await writeFile(appBinary, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'herdr-app 0.1.12'; else exec ${JSON.stringify(f.config.app.binary)} "$@"; fi\n`);
    await chmod(appBinary, 0o700);
    const request = { config: { ...f.config, app: { ...f.config.app, binary: appBinary } }, configPath: join(f.h.root, 'config.json'), packageRoot: f.h.root, journalRoot: join(root, 'setup') };
    const look = join(f.h.root, 'packages/herdr/assets/look'); await mkdir(look, { recursive: true });
    await writeFile(join(look, 'patches.json'), await readFile(resolve('packages/herdr/assets/look/patches.json')));
    const intent = await readJournal(request.journalRoot); intent.cutoverPending = true; await saveJournal(request.journalRoot, intent);
    const parts = await ports.setupParts(request as never);
    const feedPath = join(root, 'sessions', target.sessionId, 'session.json');
    await writeFile(feedPath, '{}');
    const activation = setTimeout(() => { void publishSessionFeed(root, { ...f.feed, updatedAt: Date.now(), owner: { ...f.feed.owner, sessionFile: file } }); }, 1500);
    const preflight = await parts.preflight(request as never).finally(() => clearTimeout(activation));
    expect(preflight.recoveredCutover).toEqual({ terminals: [placement.terminal], identities: { [target.sessionId]: result.startIdentity } });
    expect(preflight.retiredTerminals).not.toContain(placement.terminal);
    await expect(parts.rollback(preflight.recoveredCutover!)).rejects.toMatchObject({ code: 'cutover-owner-live' });
    await f.presence.remove(present);
    g.tabs[0].result = { ...result, pid: 2147483647, startIdentity: 'retired-owner' };
    await writePrivateJson(join(root, 'spaces/spaces.json'), g);
    const journal = await readJournal(request.journalRoot); journal.cutoverPending = false; journal.cutover = { terminals: [placement.terminal], identities: { [target.sessionId]: 'retired-owner' } };
    await saveJournal(request.journalRoot, journal);
    await writeFile(join(f.h.directories.local, 'app.json'), JSON.stringify({ spaces: [{ id: 's1', name: 'Fixture', tabs: [{ id: 'tb1', name: 'Owner', terminals: [{ terminal: placement.terminal }] }, { id: 'unowned', name: 'User', terminals: [{ terminal: 't-user' }] }] }] }));
    await writeFile(request.configPath, JSON.stringify(request.config));
    vi.stubEnv('HC_TERMINAL_ID', '');
    await f.h.scenario({ appSteps: [{ argvPrefix: ['do', 'tab.close'], reply: {}, writes: { [join(f.h.directories.local, 'app.json')]: JSON.stringify({ spaces: [{ id: 's1', name: 'Fixture', tabs: [{ id: 'unowned', name: 'User', terminals: [{ terminal: 't-user' }] }] }] }) } }] });
    expect(await runHerdrCli(['rollback', '--config', request.configPath], ports)).toBe(0);
    expect((await (await import('../../../herdr/src/spaces/setup.js')).readCutoverRecovery(join(root, 'spaces'))).entries).toEqual([]);
    const calls = (await readFile(join(f.h.directories.local, 'app-calls.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(calls.filter(call => call[1] === 'tab.close')).toEqual([['do', 'tab.close', '--id', 'tb1', '--confirmed', 'true']]);
  } finally { await ports.dispose(); await f.close(); }
}, 30_000);
