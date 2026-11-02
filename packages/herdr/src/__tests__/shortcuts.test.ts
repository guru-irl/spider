import { runAcceptance } from './scenarios.js';
import { buildSpiderBlock, SPIDER_BLOCK_BODY } from '../../../superpowers/src/agentsmd-content.js';
import { readFile } from 'node:fs/promises';
import { registerAgentsUI } from '../../../host/src/agents/agents-ui.js';
import { registerUsageDashboardCommand } from '../../../host/src/usage/dashboard-command.js';
import { createHerdrViews } from '../../../host/src/herdr/views.js';
import { expect, test, vi, afterEach } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, type KeyId } from '@earendil-works/pi-tui';
import { registerHerdrShortcuts, inspectHerdrShortcutCollisions } from '../shortcuts/register.js';
import type { ViewName } from '../contracts.js';

import { shortcutFixture, cleanupShortcutFixtures, acceptanceGuidance, acceptanceShortcuts } from './acceptance/h.js';

const bytes = ['\u001b[97;6u', '\u001b[111;6u', '\u001b[117;6u', '\u001b[109;6u', '\u001b[107;6u'];
const keys: KeyId[] = ['ctrl+shift+a', 'ctrl+shift+o', 'ctrl+shift+u', 'ctrl+shift+m', 'ctrl+shift+k'];
const names: ViewName[] = ['agents', 'todos', 'usage', 'memory', 'triggers'];
afterEach(() => { cleanupShortcutFixtures(); vi.unstubAllEnvs(); });
test('all five CSI-u shortcuts preserve a multibyte draft and cursor', async () => {
  const h = shortcutFixture(); registerHerdrShortcuts(h.pi, h.views);
  expect(h.editor.getCursor()).toEqual({ line: 0, col: 6 });
  for (const data of bytes) await h.press(data);
  expect(h.opened).toEqual(['agents', 'todos', 'usage', 'memory', 'triggers']);
  expect({ text: h.editor.getText(), cursor: h.editor.getCursor().col }).toEqual({ text: 'draft 漢字', cursor: 6 });
  for (let i = 0; i < bytes.length; i++) { expect(matchesKey(bytes[i], keys[i])).toBe(true); expect(matchesKey(bytes[i], names[i][0] as KeyId)).toBe(false); }
});


test('busy and idle sessions open views, but a failed handler reports an error without changing the draft', async () => {
  for (const busy of [false, true]) {
    const h = shortcutFixture(busy);
    registerHerdrShortcuts(h.pi, { ...h.views, memory: async () => { throw new Error('pending approvals unavailable'); } });
    await h.press(bytes[0]);
    await h.press(bytes[3]);
    expect(h.opened).toEqual(['agents']);
    expect(h.errors).toEqual(['Could not open spider memory: pending approvals unavailable']);
    expect(h.editor.getText()).toBe('draft 漢字');
    expect(h.editor.getCursor().col).toBe(6);
  }
});


test('routes all views through the injected owning handler instances without slash text', async () => {
  const h = shortcutFixture();
  const calls: unknown[] = [];
  const views = createHerdrViews({
    agents: { open: () => { calls.push(['agents']); } },
    todos: { handler: (args, ctx) => { calls.push(['todos', args, ctx]); } },
    usage: { handler: (args, ctx) => { calls.push(['usage', args, ctx]); } },
    memory: ctx => { calls.push(['memory', ctx]); },
    loop: { handler: (args, ctx) => { calls.push(['triggers', args, ctx]); } },
  });
  for (const name of names) await views[name](h.ctx);
  expect(calls).toEqual([['agents'], ['todos', '', h.ctx], ['usage', '', h.ctx], ['memory', h.ctx], ['triggers', '', h.ctx]]);
});


test('missing owning sessions refuse every view without mutating the draft', async () => {
  const h = shortcutFixture();
  const calls: string[] = [];
  const views = createHerdrViews({ agents: { open: () => { calls.push('agents'); } }, todos: { handler: () => { calls.push('todos'); } }, usage: { handler: () => { calls.push('usage'); } }, memory: () => { calls.push('memory'); }, loop: { handler: () => { calls.push('triggers'); } } });
  const missing = { ...h.ctx, sessionManager: { getSessionId: () => undefined } } as unknown as ExtensionContext;
  for (const name of names) await expect(views[name](missing)).rejects.toMatchObject({ code: 'session-unavailable' });
  expect(calls).toEqual([]);
  expect(h.editor.getText()).toBe('draft 漢字');
  expect(h.editor.getCursor().col).toBe(6);
});


test('the agents command and shared opener await the same activated overlay', async () => {
  const commands = new Map<string, { handler: () => void | Promise<void> }>();
  const registration = registerAgentsUI({ registerCommand: (name, def) => commands.set(name, def), registerShortcut() {} });
  const opened: string[] = [];
  registration.activate(async () => { await Promise.resolve(); opened.push('current'); });
  await registration.open();
  await commands.get('agents')!.handler();
  expect(opened).toEqual(['current', 'current']);
});

test('the usage command exposes its real shared handler without opening a browser during registration', async () => {
  const h = shortcutFixture();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => void | Promise<void> }>();
  let executions = 0;
  const pi = { registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionContext) => void | Promise<void> }) => commands.set(name, def), on: () => () => {}, exec: async () => { executions++; throw new Error('browser must not launch'); } } as unknown as ExtensionAPI;
  const usage = registerUsageDashboardCommand(pi, import.meta.url);
  expect(executions).toBe(0);
  await usage.handler('unexpected', h.ctx);
  expect(h.errors).toEqual(['Run /usage without arguments']);
  expect(usage.handler).toBe(commands.get('usage')!.handler);
  expect(executions).toBe(0);
});


test('the additive terminal keys emit only CSI-u and preserve Ctrl-V image paste and fullscreen search', async () => {
  const patch = JSON.parse(await readFile(new URL('../../assets/keys.json', import.meta.url), 'utf8'));
  const terminal = { 'ctrl-v': 'terminal.paste_image', ...patch.terminal };
  expect(Object.keys(patch)).toEqual(['terminal']);
  expect(Object.keys(patch.terminal)).toEqual(['cmd-shift-a', 'cmd-shift-o', 'cmd-shift-u', 'cmd-shift-m', 'cmd-shift-k']);
  const h = shortcutFixture(); registerHerdrShortcuts(h.pi, h.views);
  for (const key of ['cmd-shift-a', 'cmd-shift-o', 'cmd-shift-u', 'cmd-shift-m', 'cmd-shift-k']) {
    expect(terminal[key]).toMatch(/^send:\u001b\[\d+;6u$/);
    await h.press(terminal[key].slice(5));
  }
  expect(h.opened).toEqual(['agents', 'todos', 'usage', 'memory', 'triggers']);
  expect(terminal['ctrl-v']).toBe('terminal.paste_image');
  let pasted = false;
  h.editor.onPasteImage = () => { pasted = true; };
  await h.press('\u0016');
  expect(pasted).toBe(true);
  expect(h.registered.has('ctrl+shift+f')).toBe(false);
  expect(h.keybindings.matches('\u001b[102;6u', 'tui.altScreen.search')).toBe(true);
  expect(h.editor.getText()).toBe('draft 漢字'); expect(h.editor.getCursor().col).toBe(6);
});


test('HC and non-HC sessions generate the same bounded managed guidance', () => {
  vi.stubEnv('HC_TERMINAL_ID', 'test-terminal');
  const hc = buildSpiderBlock();
  vi.stubEnv('HC_TERMINAL_ID', undefined);
  expect(buildSpiderBlock()).toBe(hc);
  expect(hc).toContain('When `HC_TERMINAL_ID` is set');
  const addition = SPIDER_BLOCK_BODY.split('## Herdr terminals')[1];
  expect(addition).toBeDefined();
  expect(addition.length + '## Herdr terminals'.length).toBeLessThanOrEqual(1000);
  expect(SPIDER_BLOCK_BODY.length).toBeLessThanOrEqual(8500);
  expect(addition).toContain('hc run --bg --no-notify spider-worker');
  expect(addition).toMatch(/never.*hc send.*pi/i);
});


test('collision reporting limits ctrl+shift+o tree conflicts to the tree view', () => {
  expect(inspectHerdrShortcutCollisions({
    'app.tree.filter.cycleBackward': 'shift+ctrl+o',
    'app.tools.expand': 'ctrl+o',
    'tui.altScreen.search': 'ctrl+shift+f',
    'other.extension': ['ctrl+shift+a'],
  })).toEqual([
    { key: 'ctrl+shift+o', action: 'app.tree.filter.cycleBackward', scope: 'tree' },
    { key: 'ctrl+shift+a', action: 'other.extension', scope: 'editor' },
  ]);
});


test('retained shortcut callbacks are inert after disposal without changing the editor', async () => {
  const h = shortcutFixture(); const registration = registerHerdrShortcuts(h.pi, h.views);
  expect(h.registered.size).toBe(5);
  await h.press(bytes[0]); expect(h.opened).toEqual(['agents']);
  await registration.dispose();
  for (const data of bytes) await h.press(data);
  expect(h.opened).toEqual(['agents']); expect(h.errors).toEqual([]);
  expect(h.editor.getText()).toBe('draft 漢字'); expect(h.editor.getCursor().col).toBe(6);
});
test('the agents shortcut gives feedback before activation and after its overlay is unmounted', async () => {
  const h = shortcutFixture();
  const agents = registerAgentsUI({ registerCommand() {}, registerShortcut() {} });
  const views = createHerdrViews({ agents, todos: { handler() {} }, usage: { handler() {} }, memory() {}, loop: { handler() {} } });
  registerHerdrShortcuts(h.pi, views);
  await h.press(bytes[0]); expect(h.errors).toHaveLength(1); expect(h.errors[0]).toMatch(/agents.*unavailable/i);
  const opened: string[] = []; const deactivate = agents.activate(() => { opened.push('agents'); });
  await h.press(bytes[0]); expect(opened).toEqual(['agents']); expect(h.errors).toHaveLength(1);
  deactivate(); await h.press(bytes[0]); expect(h.errors).toHaveLength(2);
  expect(h.editor.getText()).toBe('draft 漢字'); expect(h.editor.getCursor().col).toBe(6);
});


test('shared guidance and shortcut acceptance', async () => {
  await runAcceptance('guidance and shortcuts', async h => { await acceptanceGuidance(h); await acceptanceShortcuts(h); });
});


test('the installed regular and fullscreen TUI dispatch keys without changing the focused editor', async () => {
  for (const mode of ['regular', 'fullscreen'] as const) {
    const h = shortcutFixture(false, mode);
    const registration = registerHerdrShortcuts(h.pi, h.views);
    h.tui.addChild(h.editor); h.tui.setFocus(h.editor); h.tui.start();
    try {
      for (const data of bytes) await h.press(data);
      expect(h.opened).toEqual(['agents', 'todos', 'usage', 'memory', 'triggers']);
      expect(h.editor.getText()).toBe('draft 漢字');
      expect(h.editor.getCursor()).toEqual({ line: 0, col: 6 });
    } finally { h.tui.stop(); await registration.dispose(); }
  }
});
