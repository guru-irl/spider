// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, test, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { testScratchPath } from '../../../host/src/__tests__/testutil.js';
import { RUN_VIEW_PROTOCOL, type RunCursor, type RunId, type RunSummary, type RunViewFrame, type SessionFeed } from '../contracts.js';
import { runPresentedViewer } from '../viewers/program.js';
import { piPackageRoot } from '../viewers/pi-loader.js';
import { startPiViewer } from '../viewers/pi-main.js';

const terminalState = vi.hoisted(() => ({
  output: '', input: (_data: string) => {}, resize: () => {}, failStart: false,
  terminal: null as { columns: number; rows: number } | null,
  screen: null as { getScreenLines(): string[]; readonly viewportTop: number } | null,
}));
vi.mock('@earendil-works/pi-tui', async importOriginal => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-tui')>();
  class FakeTerminal {
    columns = 80; rows = 24; kittyProtocolActive = false;
    start(input: (data: string) => void, resize: () => void) {
      terminalState.terminal = this; terminalState.input = input; terminalState.resize = resize;
      if (terminalState.failStart) throw new Error('terminal startup failed');
    }
    stop() {} async drainInput() {} write(data: string) { terminalState.output += data; }
    moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
    setTitle() {} setProgress() {} setProgramStatus() {}
  }
  class TrackedAltScreen extends actual.TuiAltScreen {
    constructor(...args: ConstructorParameters<typeof actual.TuiAltScreen>) { super(...args); terminalState.screen = this; }
  }
  return { ...actual, ProcessTerminal: FakeTerminal, TuiAltScreen: TrackedAltScreen };
});

const roots: string[] = [];
const presentations: { dispose(): void }[] = [];
function fixture(settings: Record<string, unknown> = {}) {
  const root = mkdtempSync(testScratchPath('viewer-fullscreen-')); roots.push(root);
  const agent = join(root, 'agent'); mkdirSync(agent); writeFileSync(join(agent, 'settings.json'), JSON.stringify(settings));
  vi.stubEnv('PI_CODING_AGENT_DIR', agent); terminalState.output = ''; terminalState.screen = null; terminalState.terminal = null; terminalState.failStart = false;
  return root;
}
async function start(root: string) {
  const presentation = await startPiViewer({ piRoot: piPackageRoot()!, runId: 'run-one' as RunId, cwd: root, scratch: root });
  presentations.push(presentation); return presentation;
}
afterEach(() => {
  for (const presentation of presentations.splice(0)) presentation.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

test('fullscreen setting enters the alternate screen and enables mouse input', async () => {
  await start(fixture({ tuiMode: 'fullscreen' }));
  expect(terminalState.output).toContain('\x1b[?1049h');
  expect(terminalState.output).toContain('\x1b[?1000h');
});

test('regular setting leaves the alternate screen and mouse mode untouched', async () => {
  await start(fixture({ tuiMode: 'regular' }));
  expect(terminalState.output).not.toContain('\x1b[?1049h');
  expect(terminalState.output).not.toContain('\x1b[?1000h');
});

test('a missing effective mode uses the regular renderer', async () => {
  const root = fixture();
  vi.spyOn(SettingsManager.prototype, 'getTuiMode').mockReturnValue(undefined as never);
  await start(root);
  expect(terminalState.output).not.toContain('\x1b[?1049h');
  expect(terminalState.output).not.toContain('\x1b[?1000h');
});

test('an unset setting uses pi\'s effective default fullscreen mode', async () => {
  await start(fixture());
  expect(terminalState.output).toContain('\x1b[?1049h');
});

test.each([['fullscreen', 'regular'], ['regular', 'fullscreen']] as const)(
  'project mode %s overrides user mode %s', async (project, user) => {
    const root = fixture({ tuiMode: user }); const projectDir = join(root, '.pi'); mkdirSync(projectDir);
    writeFileSync(join(projectDir, 'settings.json'), JSON.stringify({ tuiMode: project }));
    await start(root);
    if (project === 'fullscreen') expect(terminalState.output).toContain('\x1b[?1049h');
    else expect(terminalState.output).not.toContain('\x1b[?1049h');
  },
);

const plain = () => terminalState.screen!.getScreenLines().join('\n')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
const run = { id: 'run-one', ownerSessionId: 'owner', name: 'child', status: 'running', childMode: 'rpc', canSteer: true,
  startedAt: 1, finishedAt: null, viewer: null, result: null } as RunSummary;
const message = (text: string, timestamp: number) => ({ role: 'assistant', content: [{ type: 'text', text }], provider: 'example', model: 'model',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop', timestamp, api: 'example' });

test('fullscreen shows the saved tail, streaming updates, thinking toggle and resize', async () => {
  const root = fixture({ tuiMode: 'fullscreen', hideThinkingBlock: false });
  const file = join(root, 'session.jsonl');
  const saved = { type: 'message', id: 'saved', parentId: null, timestamp: 't', message: { role: 'user', content: 'SAVED_HISTORY', timestamp: 1 } };
  writeFileSync(file, JSON.stringify(saved) + '\n');
  const viewer = await start(root);
  viewer.presenter.snapshot(run, { protocol: RUN_VIEW_PROTOCOL, sessionFile: file });
  await vi.waitFor(() => expect(plain()).toContain('SAVED_HISTORY'));
  const live = { ...message('STREAMING_FIRST', 2), content: [{ type: 'thinking', thinking: 'VISIBLE_THOUGHT' }, { type: 'text', text: 'STREAMING_FIRST' }] };
  viewer.presenter.live({ type: 'message_start', message: live });
  await vi.waitFor(() => { expect(plain()).toContain('VISIBLE_THOUGHT'); expect(plain()).toContain('STREAMING_FIRST'); });
  terminalState.input('\x14');
  await vi.waitFor(() => { expect(plain()).not.toContain('VISIBLE_THOUGHT'); expect(plain()).toContain('STREAMING_FIRST'); });
  terminalState.input('\x14');
  await vi.waitFor(() => expect(plain()).toContain('VISIBLE_THOUGHT'));
  viewer.presenter.live({ type: 'message_update', message: { ...live, content: [{ type: 'text', text: 'STREAMING_UPDATED' }] } });
  await vi.waitFor(() => expect(plain()).toContain('STREAMING_UPDATED'));
  appendFileSync(file, JSON.stringify({ ...saved, id: 'later', message: { ...saved.message, content: 'TAIL_AFTER_STREAM', timestamp: 3 } }) + '\n');
  viewer.presenter.live({ type: 'message_end', message: live });
  await vi.waitFor(() => expect(plain()).toContain('TAIL_AFTER_STREAM'));
  terminalState.terminal!.columns = 45; terminalState.terminal!.rows = 12; terminalState.resize();
  await vi.waitFor(() => { expect(terminalState.screen!.getScreenLines()).toHaveLength(12); expect(plain()).toContain('TAIL_AFTER_STREAM'); });
});

test('invalid saved records mark the viewer credits as incomplete', async () => {
  const root = fixture({ tuiMode: 'fullscreen' });
  const file = join(root, 'session.jsonl');
  const saved = { type: 'message', id: 'priced', parentId: null, timestamp: '2026-10-02T12:00:00Z', message: {
    ...message('SAVED_ANSWER', Date.parse('2026-10-02T12:00:00Z')), provider: 'github-copilot', model: 'gpt-6.1-sol',
    usage: { input: 10000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 11000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } };
  writeFileSync(file, JSON.stringify(saved) + '\n{invalid json}\n');
  const viewer = await start(root);
  viewer.presenter.snapshot(run, { protocol: RUN_VIEW_PROTOCOL, sessionFile: file, model: 'github-copilot/gpt-6.1-sol', contextWindow: 200000 });
  await vi.waitFor(() => {
    expect(plain()).toContain('Some saved session records could not be shown.');
    expect(plain()).toContain('partial totals');
    expect(plain()).toContain('? AIC');
  });
});

test.each(['always', 'hidden'] as const)('fullscreen applies the %s scrollbar setting', async setting => {
  const viewer = await start(fixture({ tuiMode: 'fullscreen', fullscreenScrollbar: setting }));
  for (let i = 0; i < 40; i++) viewer.presenter.page(`HISTORY_${i}`);
  await vi.waitFor(() => expect(plain()).toContain('HISTORY_39'));
  if (setting === 'always') expect(plain()).toMatch(/[│┃]/);
  else expect(plain()).not.toMatch(/[│┃]/);
});

test('the automatic scrollbar appears when scrolling', async () => {
  const viewer = await start(fixture({ tuiMode: 'fullscreen', fullscreenScrollbar: 'auto' }));
  for (let i = 0; i < 40; i++) viewer.presenter.page(`HISTORY_${i}`);
  await vi.waitFor(() => expect(plain()).toContain('HISTORY_39'));
  expect(plain()).not.toMatch(/[│┃]/);
  terminalState.input('\x1b[5~');
  await vi.waitFor(() => expect(plain()).toMatch(/[│┃]/));
});

test('fullscreen uses the configured wheel scroll distance', async () => {
  const viewer = await start(fixture({ tuiMode: 'fullscreen', fullscreenWheelScrollLines: 4 }));
  for (let i = 0; i < 60; i++) viewer.presenter.page(`HISTORY_${i}`);
  await vi.waitFor(() => expect(plain()).toContain('HISTORY_59'));
  terminalState.input('\x1b[5~'); terminalState.input('\x1b[5~');
  await vi.waitFor(() => expect(plain()).not.toContain('HISTORY_59'));
  const top = terminalState.screen!.viewportTop;
  terminalState.input('\x1b[<65;10;10M');
  await vi.waitFor(() => expect(terminalState.screen!.viewportTop).toBe(top + 4));
});

test.each([true, false])('fullscreen copy on select follows the %s setting', async enabled => {
  const viewer = await start(fixture({ tuiMode: 'fullscreen', fullscreenCopyOnSelect: enabled }));
  viewer.presenter.page('SELECT_THIS_TEXT');
  await vi.waitFor(() => expect(plain()).toContain('SELECT_THIS_TEXT'));
  const line = plain().split('\n').findIndex(row => row.includes('SELECT_THIS_TEXT')) + 1;
  terminalState.output = '';
  terminalState.input(`\x1b[<0;3;${line}M`);
  terminalState.input(`\x1b[<32;10;${line}M`);
  terminalState.input(`\x1b[<0;10;${line}m`);
  if (enabled) await vi.waitFor(() => expect(terminalState.output).toContain('\x1b]52;'));
  else expect(terminalState.output).not.toContain('\x1b]52;');
});

test('regular mode still renders streamed output', async () => {
  const viewer = await start(fixture({ tuiMode: 'regular' }));
  viewer.presenter.live({ type: 'message_start', message: message('REGULAR_STREAM', 7) });
  await vi.waitFor(() => expect(terminalState.output).toContain('REGULAR_STREAM'));
  expect(terminalState.output).not.toContain('\x1b[?1049h');
});

test('fullscreen startup failure restores the alternate screen and mouse', async () => {
  const root = fixture({ tuiMode: 'fullscreen' }); terminalState.failStart = true;
  await expect(start(root)).rejects.toThrow('terminal startup failed');
  expect(terminalState.output).toContain('\x1b[?1049h');
  expect(terminalState.output).toContain('\x1b[?1000l');
  expect(terminalState.output).toContain('\x1b[?1049l');
});

test.each(['finished', 'lease lost', 'generation change', 'signal', 'ctrl-c', 'ctrl-d'] as const)(
  'fullscreen restores the terminal when the viewer exits on %s', async reason => {
    const root = fixture({ tuiMode: 'fullscreen' }); const presentation = await start(root);
    expect(terminalState.output).toContain('\x1b[?1049h');
    const abort = new AbortController(); let emit!: (frame: RunViewFrame) => void; let subscribed!: () => void; let changed = () => {};
    const ready = new Promise<void>(resolve => { subscribed = resolve; });
    let feed = { sessionId: 'owner', generation: 'generation', revision: 1, updatedAt: Date.now(),
      owner: { sessionId: 'owner', generation: 'generation', name: 'owner' }, lifecycle: 'live', runs: { rows: [run] },
      ipc: { address: '/fixture/socket', capabilityFile: '/fixture/capability' } } as unknown as SessionFeed;
    const lease = join(root, 'display-lease');
    if (reason === 'lease lost') writeFileSync(lease, JSON.stringify({ version: 1, sessionId: feed.sessionId, generation: 'generation', runId: run.id, expiresAt: Date.now() + 15000 }), { mode: 0o600 });
    const running = runPresentedViewer({ runId: run.id, sessionId: feed.sessionId, generation: 'generation', feedRoot: root,
      displayLeaseFile: reason === 'lease lost' ? lease : undefined,
      stdin: new PassThrough(), stdout: new PassThrough(), signal: abort.signal, wait: async () => {},
      feedSource: { read: async () => feed, subscribe: listener => { changed = listener; return () => {}; } },
      createClient: () => ({ subscribeRun: async (_runId, _cursor, listener) => {
        emit = listener; listener({ runId: run.id, cursor: 'snapshot' as RunCursor, kind: 'snapshot', data: { run, view: { protocol: RUN_VIEW_PROTOCOL } } });
        subscribed(); return { closed: new Promise<void>(() => {}), dispose() {} };
      } }),
    }, presentation);
    try {
      await ready;
      emit({ runId: run.id, cursor: 'live' as RunCursor, kind: 'live', data: { event: { type: 'message_start', message: message('LIVE_BEFORE_EXIT', 8) } } });
      await vi.waitFor(() => expect(plain()).toContain('LIVE_BEFORE_EXIT'));
      if (reason === 'finished') emit({ runId: run.id, cursor: 'end' as RunCursor, kind: 'end', data: { reason: 'finished' } });
      else if (reason === 'signal') abort.abort();
      else if (reason === 'ctrl-c') terminalState.input('\x03');
      else if (reason === 'ctrl-d') terminalState.input('\x04');
      else if (reason === 'lease lost') rmSync(lease);
      else { feed = { ...feed, generation: 'successor' as SessionFeed['generation'], revision: 2 }; changed(); }
      await running;
      expect(terminalState.output).toContain('\x1b[?1006l');
      expect(terminalState.output).toContain('\x1b[?1004l');
      expect(terminalState.output).toContain('\x1b[?1003l');
      expect(terminalState.output).toContain('\x1b[?1002l');
      expect(terminalState.output).toContain('\x1b[?1000l');
      expect(terminalState.output).toContain('\x1b[?7h');
      expect(terminalState.output).toContain('\x1b[?1049l');
    } finally { abort.abort(); await running; }
  },
);

test('fullscreen restores the terminal when release fails', async () => {
  const root = fixture({ tuiMode: 'fullscreen' }); const presentation = await start(root);
  const abort = new AbortController(); abort.abort();
  await expect(runPresentedViewer({ runId: run.id, sessionId: 'owner' as SessionFeed['sessionId'], feedRoot: root,
    stdin: new PassThrough(), stdout: new PassThrough(), signal: abort.signal,
    feedSource: { read: async () => null, subscribe: () => () => {} },
    createClient: () => { throw new Error('must not connect'); }, release: async () => { throw new Error('release failed'); },
  }, presentation)).rejects.toThrow('release failed');
  expect(terminalState.output).toContain('\x1b[?1000l');
  expect(terminalState.output).toContain('\x1b[?1049l');
});

test('fullscreen follows new output and keeps an explicitly scrolled position', async () => {
  const viewer = await start(fixture({ tuiMode: 'fullscreen' }));
  for (let i = 0; i < 40; i++) viewer.presenter.page(`HISTORY_${String(i).padStart(2, '0')}`);
  await vi.waitFor(() => expect(plain()).toContain('HISTORY_39'));
  terminalState.input('\x1b[5~');
  await vi.waitFor(() => expect(plain()).not.toContain('HISTORY_39'));
  const top = terminalState.screen!.viewportTop;
  viewer.presenter.page('NEW_AFTER_SCROLL');
  await vi.waitFor(() => expect(terminalState.screen!.viewportTop).toBe(top));
  expect(plain()).not.toContain('NEW_AFTER_SCROLL');
  terminalState.input('\x1b[1;5F');
  await vi.waitFor(() => expect(plain()).toContain('NEW_AFTER_SCROLL'));
  viewer.presenter.page('FOLLOWED_OUTPUT');
  await vi.waitFor(() => expect(plain()).toContain('FOLLOWED_OUTPUT'));
});
