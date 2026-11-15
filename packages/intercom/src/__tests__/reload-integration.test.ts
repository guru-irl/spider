import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import localIntercom from '../local.js';
import { IntercomClient } from '../broker/client.js';
import type { Message, SessionInfo } from '../types.js';
import { startTestBroker, stopTestBroker, testBrokerEnv } from '../test-support.js';
import { trackReloadActivity } from '../../../host/src/reload-activity.js';
import { registerAutoReload } from '../../../host/src/auto-reload.js';

const autoKey = Symbol.for('spider.auto-reload.v1');
afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[autoKey];
});

async function ready(broker: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Fixture broker did not start')); }, 2000);
    const onData = (chunk: Buffer) => { if (chunk.toString().includes('Intercom broker started')) { cleanup(); resolve(); } };
    const onExit = () => { cleanup(); reject(new Error('Fixture broker exited before startup')); };
    const cleanup = () => { clearTimeout(timer); broker.stdout.off('data', onData); broker.off('exit', onExit); };
    broker.stdout.on('data', onData);
    broker.once('exit', onExit);
  });
}

async function fixture(custom: (...args: any[]) => Promise<unknown> = async () => undefined) {
  vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  delete (globalThis as Record<symbol, unknown>)[autoKey];
  const broker = startTestBroker(process.execPath, [join(process.cwd(), 'dist/intercom/broker.mjs')], {
    cwd: process.cwd(), env: testBrokerEnv(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  await ready(broker);
  const planner = new IntercomClient();
  await planner.connect({ name: 'planner', cwd: process.cwd(), model: 'fixture', pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() });
  const hooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
  const events = new EventEmitter();
  let reloads = 0;
  const pi = {
    events: { on(name: string, handler: (value: unknown) => void) { events.on(name, handler); return () => { events.off(name, handler); }; },
      emit(name: string, value: unknown) { events.emit(name, value); } },
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    getSessionName: () => 'reload-worker',
    setSessionName() {}, registerMessageRenderer() {}, registerShortcut() {}, appendEntry() {}, sendMessage() {},
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools.push(tool); },
    getActiveTools: () => tools.map(tool => tool.name), setActiveTools() {},
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => unknown }) { commands.set(name, command.handler); },
  };
  const ctx = { cwd: process.cwd(), mode: 'tui' as const, model: { id: 'fixture' }, hasUI: true,
    sessionManager: { getSessionId: () => 'reload-session', getEntries: () => [] },
    isIdle: () => true, hasPendingMessages: () => false, abort() {},
    ui: { notify() {}, getEditorText: () => '', custom },
    reload: async () => { reloads++; },
  };
  const activity = trackReloadActivity(pi as never);
  const registration = localIntercom(activity.pi);
  registerAutoReload(activity.pi, { identity: { sha: 'aaaaaaa', dirty: false, builtAt: '2026-01-01T00:00:00.000Z', version: '0.1.0' },
    url: new URL('../../../../dist/extension.js', import.meta.url).href }, () => true, () => true, () => false,
    () => activity.busy() || registration.hasPendingInboundAsks());
  const emit = async (name: string, event: unknown = {}) => { for (const handler of hooks.get(name) ?? []) await handler(event, ctx); };
  await emit('session_start', { reason: 'startup' });
  const session = await vi.waitFor(async () => {
    const found = (await planner.listSessions()).find(item => item.name === 'reload-worker');
    expect(found).toBeDefined();
    return found!;
  }, { timeout: 2000, interval: 20 });
  return { planner, broker, ctx, commands, tools, registration, session, emit, reloads: () => reloads,
    async cleanup() { await emit('session_shutdown', { reason: 'quit' }); await planner.disconnect(); await stopTestBroker(broker); } };
}

it('blocks reload for a real inbound ask until its reply is delivered', async () => {
  const f = await fixture();
  const replies: Message[] = [];
  f.planner.on('message', (_from: SessionInfo, message: Message) => { replies.push(message); });
  try {
    const askId = 'reload-blocking-ask';
    expect((await f.planner.send(f.session.id, { messageId: askId, text: 'Need an answer', expectsReply: true })).delivered).toBe(true);
    await vi.waitFor(() => expect(f.registration.hasPendingInboundAsks()).toBe(true));
    await f.commands.get('spider-reload')!('', f.ctx);
    expect(f.reloads()).toBe(0);
    const result = await f.tools.find(tool => tool.name === 'intercom')!.execute('reload-reply',
      { action: 'reply', replyTo: askId, message: 'Answered' }, new AbortController().signal, undefined, f.ctx);
    expect(result.details?.delivered).toBe(true);
    await vi.waitFor(() => expect(replies.some(message => message.replyTo === askId)).toBe(true));
    expect(f.registration.hasPendingInboundAsks()).toBe(false);
    await f.commands.get('spider-reload')!('', f.ctx);
    expect(f.reloads()).toBe(1);
  } finally { await f.cleanup(); }
});

it('blocks reload for the real intercom picker and compose overlays', async () => {
  let showPicker!: () => void, showCompose!: () => void;
  let choose!: (session: SessionInfo | undefined) => void, closeCompose!: (value: undefined) => void;
  const pickerOpened = new Promise<void>(resolve => { showPicker = resolve; });
  const composeOpened = new Promise<void>(resolve => { showCompose = resolve; });
  let step = 0;
  const f = await fixture(() => {
    step++;
    if (step === 1) return new Promise<SessionInfo | undefined>(resolve => { choose = resolve; showPicker(); });
    return new Promise<undefined>(resolve => { closeCompose = resolve; showCompose(); });
  });
  try {
    const selected = (await f.planner.listSessions()).find(session => session.name === 'planner');
    expect(selected).toBeDefined();
    const overlay = Promise.resolve(f.commands.get('intercom')!('', f.ctx));
    await pickerOpened;
    await f.commands.get('spider-reload')!('', f.ctx);
    expect(f.reloads()).toBe(0);
    choose(selected);
    await composeOpened;
    await f.commands.get('spider-reload')!('', f.ctx);
    expect(f.reloads()).toBe(0);
    closeCompose(undefined);
    await overlay;
    await f.commands.get('spider-reload')!('', f.ctx);
    expect(f.reloads()).toBe(1);
  } finally { choose?.(undefined); closeCompose?.(undefined); await f.cleanup(); }
});
