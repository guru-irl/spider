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

it.each((['startup', 'reload', 'new', 'resume', 'fork'] as const).flatMap(reason => [
  { reason, requested: true as const, hc: true, child: false, active: true },
  { reason, requested: false as const, hc: true, child: false, active: false },
  { reason, requested: 'auto' as const, hc: false, child: false, active: false },
  { reason, requested: true as const, hc: true, child: true, active: false },
]))('session $reason requested=$requested HC=$hc child=$child replaces only its own activation', async ({ reason, requested, hc, child, active }) => {
  const f = await mountedFixture('fake', 'tui', true, child, hc, false, requested);
  const { join } = await import('node:path'); const { readFile } = await import('node:fs/promises'); const { existsSync } = await import('node:fs');
  const { createSessionIpcClient } = await import('../../../herdr/src/feed/ipc-client.js');
  try {
    const old = f.owner;
    await f.emit('session_shutdown', { reason });
    if (active) expect(JSON.parse(await readFile(f.feedPath, 'utf8'))).toMatchObject({ generation: old!.generation, lifecycle: 'live' });
    const sessionId = ['new', 'resume', 'fork'].includes(reason) ? 'destination-' + reason : f.h.owner!.sessionId;
    Reflect.set(f.ctx.sessionManager, 'getSessionId', () => sessionId);
    const sessionFile = ['new', 'resume', 'fork'].includes(reason) ? join(f.h.root, reason + '.jsonl') : null;
    if (sessionFile) {
      const { mkdir, writeFile, chmod } = await import('node:fs/promises');
      await writeFile(sessionFile, JSON.stringify({ type: 'session', id: sessionId, cwd: f.ctx.cwd }) + '\n');
      Reflect.set(f.ctx.sessionManager, 'getSessionFile', () => sessionFile);
      const bin = join(f.h.root, 'process-bin'); await mkdir(bin);
      await writeFile(join(bin, 'ps'), '#!/bin/sh\nif [ "$1" = -U ]; then exit 0; fi\nexec /bin/ps "$@"\n'); await chmod(join(bin, 'ps'), 0o700);
      vi.stubEnv('PATH', bin + ':' + process.env.PATH);
    }
    await f.emit('session_start', { reason });
    const records = await f.presence.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ sessionId, sessionFile, kind: child ? 'child' : 'top-level', hcAddress: active ? f.h.owner!.terminal.address : null });
    const file = join(f.config.globalRoot, 'herdr/sessions', sessionId, 'session.json');
    expect(existsSync(file)).toBe(active); expect(f.mount.enabled()).toBe(active);
    if (active) {
      const feed = JSON.parse(await readFile(file, 'utf8'));
      expect(feed).toMatchObject({ sessionId, lifecycle: 'live', runs: { total: 0 }, triggers: [], ipc: { sessionId } });
      expect(feed.generation).not.toBe(old!.generation);
      const ipc = createSessionIpcClient(feed.ipc);
      try { expect(await ipc.ping()).toMatchObject({ ok: true, status: { native: 'done', effective: 'done' } }); } finally { ipc.dispose(); }
      expect(f.captured).toHaveLength(2);
    } else {
      expect(f.captured).toEqual([]); expect(await f.calls()).toEqual([]);
      expect(f.registrations.tools).toEqual([]); expect(f.registrations.shortcuts).toEqual([]);
      if (sessionFile && !child) {
        const { readdir } = await import('node:fs/promises');
        const files = (await readdir(join(f.config.globalRoot, 'herdr'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
        expect(files).toHaveLength(2);
        expect(files.map(entry => entry.parentPath).sort()).toEqual([join(f.config.globalRoot, 'herdr/leases'), join(f.config.globalRoot, 'herdr/processes')]);
        expect(await f.emit('session_before_switch', { reason: 'resume', targetSessionFile: sessionFile })).toBeUndefined();
        const { createSessionLeases } = await import('../../../herdr/src/sessions/lease.js');
        await f.emit('session_shutdown', { reason: 'quit' });
        expect(await createSessionLeases(join(f.config.globalRoot, 'herdr')).get(sessionFile)).toBeNull();
        expect(await f.presence.list()).toEqual([]); expect(await f.calls()).toEqual([]);
      }
    }
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it('inactive saved-session bookkeeping ignores live conflicts and replaces crashed leases', async () => {
  const f = await mountedFixture('fake', 'tui', true, false, true, false, false);
  const { spawn } = await import('node:child_process'); const { join } = await import('node:path'); const { writeFile } = await import('node:fs/promises');
  const { createProcessInventory } = await import('../herdr/ports.js'); const { processStartTime } = await import('../../../subagents/src/process-identity.js');
  const file = join(f.h.root, 'saved.jsonl'), inventory = createProcessInventory(join(f.config.globalRoot, 'herdr'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env } });
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const identity = { pid: child.pid!, startIdentity: processStartTime(child.pid!)! };
  try {
    await writeFile(file, JSON.stringify({ type: 'session', id: f.h.owner!.sessionId, cwd: f.ctx.cwd }) + '\n');
    Reflect.set(f.ctx.sessionManager, 'getSessionFile', () => file);
    await f.presence.record({ ...identity, sessionId: 'other-session' as never, sessionFile: file, sessionName: null, hcAddress: null, kind: 'top-level' });
    await inventory.leases.claim(file, identity, inventory, { mode: 'bookkeeping' });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      expect(await f.emit('session_before_switch', { reason: 'resume', targetSessionFile: file })).toBeUndefined();
      await f.emit('session_start', { reason: 'resume' });
      expect(timers).not.toHaveBeenCalled();
    } finally { timers.mockRestore(); }
    expect(await inventory.leases.get(file)).toMatchObject({ pid: process.pid, file });
    expect(await f.calls()).toEqual([]); expect(f.notices).toEqual([]); expect(f.errors).toEqual([]);
    child.kill('SIGTERM'); await exited; await f.presence.remove(identity);
    await f.emit('session_shutdown', { reason: 'quit' });
    expect(await inventory.leases.get(file)).toBeNull();
    await inventory.leases.claim(file, identity, inventory, { mode: 'bookkeeping' });
    await f.emit('session_start', { reason: 'resume' });
    expect(await inventory.leases.get(file)).toMatchObject({ pid: process.pid, file });
    expect(await f.calls()).toEqual([]); expect(f.notices).toEqual([]); expect(f.errors).toEqual([]);
    await f.emit('session_shutdown', { reason: 'quit' });
    expect(await inventory.leases.get(file)).toBeNull(); expect(await f.presence.list()).toEqual([]);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; await f.presence.remove(identity); await f.close(); }
}, 30000);

it('pi reload preserves a real unsent editor draft while replacing Herdr IPC', async () => {
  const f = await mountedFixture();
  const { InteractiveMode } = await import('@earendil-works/pi-coding-agent');
  const { Editor, Container } = await import('@earendil-works/pi-tui');
  const identity = (text: string) => text;
  const ui = { hideOverlay() {}, setFocus() {}, requestRender() {} };
  const theme = { borderColor: identity, selectList: {} } as import('@earendil-works/pi-tui').EditorTheme;
  const draftEditor = new Editor(ui as unknown as import('@earendil-works/pi-tui').TUI, theme), defaultEditor = new Editor(ui as unknown as import('@earendil-works/pi-tui').TUI, theme);
  const draft = 'Unsent draft\nwith a second line and a trailing space ';
  draftEditor.setText(draft);
  const native = Object.create(InteractiveMode.prototype);
  for (const key of ['session', 'settingsManager']) Object.defineProperty(native, key, { value: undefined, writable: true });
  const noop = () => {};
  Object.assign(native, {
    editor: draftEditor, defaultEditor, editorContainer: new Container(), ui,
    session: { isStreaming: false, isCompacting: false, reload: async ({ beforeSessionStart }: { beforeSessionStart(): void }) => {
      await f.emit('session_shutdown', { reason: 'reload' }); beforeSessionStart(); await f.emit('session_start', { reason: 'reload' });
    }, resourceLoader: { getThemes: () => ({ themes: [] }) }, modelRuntime: { getError: () => undefined } },
    footerDataProvider: { clearExtensionStatuses: noop }, footer: { invalidate: noop },
    settingsManager: { getHideThinkingBlock: () => false, getOutputPad: () => 0 }, keybindings: { reload: noop }, themeController: { applyFromSettings: noop },
    clearExtensionTerminalInputListeners: noop, setExtensionFooter: noop, setExtensionHeader: noop, clearExtensionWidgets: noop,
    setupAutocompleteProvider: noop, updateTerminalTitle: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop, disposeActiveSelector: noop,
    rebuildChatFromMessages: noop, applyRuntimeSettings: noop, setupExtensionShortcuts: noop, showLoadedResources: noop,
    maybeSaveImplicitProjectTrustAfterReload: () => false, showStatus: noop, showError: (text: string) => { throw new Error(text); },
  });
  Object.assign(f.ctx.ui, { getEditorText: () => native.editor.getText(), setEditorText: (text: string) => native.editor.setText(text) });
  const { readFile } = await import('node:fs/promises');
  try {
    await native.handleReloadCommand();
    expect(native.editor).toBe(defaultEditor);
    expect(native.editor.getText()).toBe(draft);
    const current = JSON.parse(await readFile(f.feedPath, 'utf8'));
    expect(current.generation).not.toBe(f.feed.generation);
    expect(current.lifecycle).toBe('live'); expect(await f.presence.list()).toHaveLength(1);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it('reload replaces the endpoint without carrying the old generation', async () => {
  const f = await mountedFixture();
  try {
    const previous = f.feed;
    await f.emit('session_shutdown', { reason: 'reload' });
    await f.emit('session_start', { reason: 'resume' });
    const { readFile } = await import('node:fs/promises');
    const current = JSON.parse(await readFile(f.feedPath, 'utf8'));
    expect(current.generation).not.toBe(previous.generation);
    expect(await f.presence.list()).toHaveLength(1); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

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

it('reads G cutover recovery without writes and rejects malformed journals', async () => {
  const f = await mountedFixture();
  const { readCutoverRecovery } = await import('../../../herdr/src/spaces/setup.js');
  const { join } = await import('node:path'); const { writePrivateJson } = await import('../../../herdr/src/sessions/registry.js');
  const { existsSync } = await import('node:fs');
  try {
    const root = join(f.h.root, 'recovery');
    expect(await readCutoverRecovery(root)).toEqual({ createdTabs: [], entries: [], recoveredCutover: null });
    expect(existsSync(root)).toBe(false);
    await writePrivateJson(join(root, 'spaces.json'), { version: 1, spaces: [], tabs: [{ target: { file: 'relative' } }], focused: false });
    await expect(readCutoverRecovery(root)).rejects.toMatchObject({ code: 'invalid-space-journal' });
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
    const request = { config: f.config, configPath: join(f.h.root, 'config.json'), packageRoot: f.h.root, journalRoot: join(root, 'setup') };
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
