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
  const f = await mountedFixture('fake', 'tui', true, child, hc, false, requested, false, false, true, undefined, { fastInactive: !active });
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
  const f = await mountedFixture('fake', 'tui', true, false, true, false, false, false, false, true, undefined, { fastInactive: true });
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
    extensionDialogs: [], extensionOverlays: new Map(),
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
