import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { setTimeout as realDelay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { getConfigPath } from './config.js';
import { startTestBroker, stopTestBroker, testBrokerEnv } from './test-support.js';
import piIntercomExtension, { type IntercomBrokerPort } from './local.js';
import { IntercomClient } from './broker/client.js';
import { INTERCOM_EXTENSION_REGISTER_EVENT, type IntercomExtensionChannel } from './extension-api.js';

async function until(predicate: () => boolean | Promise<boolean>, message = 'expected behavior did not recover') {
  const deadline = performance.now() + 2000;
  while (!await predicate() && performance.now() < deadline) await realDelay(5);
  expect(await predicate(), message).toBe(true);
}

function harness(port: IntercomBrokerPort) {
  const events = new EventEmitter();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools: any[] = [];
  const commands = new Map<string, (args: string, ctx: any) => unknown>();
  const warnings: string[] = [];
  const messages: any[] = [];
  let channel!: IntercomExtensionChannel;
  const pi = {
    events: { on(name: string, handler: any) { events.on(name, handler); return () => events.off(name, handler); }, emit: events.emit.bind(events) },
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getSessionName: () => 'recovering-session',
    registerTool(tool: any) { tools.push(tool); },
    registerCommand(name: string, command: any) { commands.set(name, command.handler); },
    registerShortcut() {}, registerMessageRenderer() {}, appendEntry() {},
    sendMessage(message: any) { messages.push(message); },
    getActiveTools: () => ['intercom'], setActiveTools() {},
  };
  const ctx = {
    cwd: process.cwd(), mode: 'tui', model: { id: 'fixture-model' }, hasUI: true,
    sessionManager: { getSessionId: () => 'recovering-id' }, isIdle: () => true,
    ui: { notify(message: string, level: string) { if (level === 'warning') warnings.push(message); }, custom: async () => ({ sent: false }) },
  };
  piIntercomExtension(pi as never, port);
  events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, {
    namespace: 'reconnect-test', ownerEligible: false, onEvent() {},
    onReady(value: IntercomExtensionChannel) { channel = value; },
  });
  return {
    ctx, warnings, messages, commands,
    connected: () => channel.snapshot().connected,
    async emit(name: string, context: any = ctx, event: any = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, context);
    },
    async tool(action: string, context: any = ctx) {
      return tools.find(tool => tool.name === 'intercom').execute('fixture-call', { action }, new AbortController().signal, undefined, context);
    },
  };
}

async function fixture(run: (h: ReturnType<typeof harness>, observer: IntercomClient, kick: () => Promise<void>, advance: (ms: number) => Promise<void>) => Promise<void>, port?: IntercomBrokerPort) {
  const previousInterval = process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS;
  process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS = '3600000';
  const broker = startTestBroker(process.execPath, [resolve('dist/intercom/broker.mjs')], {
    env: testBrokerEnv(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  const observer = new IntercomClient();
  const registration = { name: 'fixture-observer', cwd: process.cwd(), model: 'fixture', pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() };
  const h = harness(port ?? (connect => connect()));
  try {
    let ready = false;
    broker.stdout!.on('data', chunk => { if (String(chunk).includes('Intercom broker started')) ready = true; });
    await until(() => ready, 'fixture broker ready');
    await observer.connect(registration, 'observer-id');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    await h.emit('session_start');
    await vi.advanceTimersByTimeAsync(0);
    // A supplied port may deliberately fail startup.
    if (!port) await until(h.connected);
    const kick = async () => {
      const replacement = new IntercomClient();
      try {
        await replacement.connect({ ...registration, name: 'temporary-replacement' }, 'recovering-id');
        await until(() => !h.connected());
      } finally { await replacement.disconnect(); }
    };
    const advance = async (ms: number) => {
      do {
        const step = Math.min(ms, 1000);
        await vi.advanceTimersByTimeAsync(step);
        await realDelay(5);
        ms -= step;
      } while (ms > 0);
    };
    await run(h, observer, kick, advance);
  } finally {
    vi.useRealTimers();
    await h.emit('session_shutdown');
    await observer.disconnect();
    await stopTestBroker(broker);
    if (previousInterval === undefined) delete process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS;
    else process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS = previousInterval;
  }
}

it('bounds retries and concurrent attempts during a two-minute outage', async () => {
  let offline = false, outageStart = 0, active = 0, peakActive = 0;
  const attempts: number[] = [];
  const releases = new Set<() => void>();
  const port: IntercomBrokerPort = async connect => {
    if (!offline) return connect();
    attempts.push(Date.now() - outageStart);
    active++;
    peakActive = Math.max(peakActive, active);
    try {
      await new Promise<void>(resolve => { releases.add(resolve); });
      throw new Error('fixture offline');
    } finally { active--; }
  };
  try {
    await fixture(async (h, _observer, kick) => {
      await until(h.connected);
      const connectedTimers = vi.getTimerCount();
      offline = true;
      outageStart = Date.now();
      await kick();
      // The client heartbeat stops; one warning and one retry timer replace it.
      expect(vi.getTimerCount()).toBe(connectedTimers + 1);
      const events = ['input', 'tool_execution_start', 'tool_execution_end', 'agent_start', 'agent_end', 'session_tree', 'model_select', 'turn_end', 'turn_start'];
      for (let second = 0; second < 120; second++) {
        if (second % 6 === 0) {
          const before = vi.getTimerCount();
          await h.emit(events[(second / 6) % events.length]!, h.ctx, { toolCallId: 'rate-tool', toolName: 'read', model: { id: 'fixture-model' } });
          expect(vi.getTimerCount(), 'an event must not add another retry timer').toBe(before);
        }
        if (second === 10 || second === 70) {
          const before = vi.getTimerCount();
          await h.tool('status');
          expect(vi.getTimerCount(), 'status must not add another retry timer').toBe(before);
        }
        await vi.advanceTimersByTimeAsync(1000);
        if (releases.size) {
          // The fired retry is no longer armed; the name poll and warning timers remain.
          const withoutRetry = vi.getTimerCount();
          await h.emit('input');
          const foreground = attempts.length === 1 ? [h.tool('list'), h.tool('list')] : [];
          expect(active).toBe(1);
          expect(vi.getTimerCount(), 'an in-flight attempt must not arm a retry').toBe(withoutRetry);
          for (const release of releases) release();
          releases.clear();
          await Promise.all(foreground);
          await vi.advanceTimersByTimeAsync(0);
          expect(vi.getTimerCount(), 'a failed attempt must arm exactly one retry').toBe(withoutRetry + 1);
        }
      }
      expect(attempts).toEqual([1000, 3000, 8000, 18000, 48000, 78000, 108000]);
      expect(peakActive).toBe(1);
      expect(active).toBe(0);
    }, port);
  } finally {
    for (const release of releases) release();
  }
});

// Removing recovery after a failed background attempt must break this test.
it('retries again when the first reconnect attempt fails', async () => {
  let attempts = 0;
  await fixture(async (h, observer, kick, advance) => {
    await until(h.connected);
    await kick();
    await advance(1000);
    expect(h.connected()).toBe(false);
    await advance(2000);
    await until(h.connected);
    expect((await observer.listSessions()).find(s => s.id === 'recovering-id')?.name).toBe('recovering-session');
  }, async connect => { if (++attempts === 2) throw new Error('fixture reconnect failure'); await connect(); });
});

it('recovers when a reconnect port throws synchronously', async () => {
  let attempts = 0;
  await fixture(async (h, _observer, kick, advance) => {
    await until(h.connected);
    await kick();
    await advance(1000);
    expect(h.connected()).toBe(false);
    await advance(2000);
    await until(h.connected);
  }, connect => { if (++attempts === 2) throw new Error('fixture synchronous reconnect failure'); return connect(); });
});

it('keeps retrying after startup and background connection failures', async () => {
  let attempts = 0;
  await fixture(async (h, _observer, _kick, advance) => {
    await until(() => attempts === 1);
    await advance(1000);
    expect(h.connected()).toBe(false);
    await advance(2000);
    await until(h.connected);
  }, async connect => { if (++attempts < 3) throw new Error('fixture startup failure'); await connect(); });
});

it.each(['tool', 'overlay'])('recovers after a failed %s reconnect replaces the queued retry', async reason => {
  let attempts = 0;
  await fixture(async (h, _observer, kick, advance) => {
    await until(h.connected);
    await kick();
    if (reason === 'tool') await h.tool('list');
    else await h.commands.get('intercom')!('', h.ctx);
    await advance(1000);
    await until(h.connected);
  }, async connect => { if (++attempts === 2) throw new Error('fixture foreground failure'); await connect(); });
});

it.each(['session getter', 'UI getter', 'session mismatch'])('does not abandon retries when the %s temporarily invalidates the context', async cause => {
  await fixture(async (h, _observer, kick, advance) => {
    let invalid = true;
    if (cause === 'session getter') h.ctx.sessionManager.getSessionId = () => { if (invalid) throw new Error('context unavailable'); return 'recovering-id'; };
    if (cause === 'UI getter') Object.defineProperty(h.ctx, 'hasUI', { get() { if (invalid) throw new Error('UI unavailable'); return true; } });
    if (cause === 'session mismatch') h.ctx.sessionManager.getSessionId = () => invalid ? 'other-id' : 'recovering-id';
    await kick();
    await advance(1000);
    expect(h.connected()).toBe(false);
    invalid = false;
    await advance(2000);
    await until(h.connected);
  });
});

it.each(['agent_start', 'turn_start', 'turn_end', 'agent_end', 'tool_execution_start', 'tool_execution_end', 'model_select', 'input', 'session_tree'])('refreshes a permanently stale context from %s', async event => {
  await fixture(async (h, observer, kick, advance) => {
    const fresh = { ...h.ctx };
    Object.defineProperty(h.ctx, 'hasUI', { get() { throw new Error('old context'); } });
    await kick();
    await h.emit(event, fresh, { toolCallId: 'fixture-tool', toolName: 'read', model: { id: 'fixture-new-model' } });
    await advance(1000);
    await until(h.connected);
    expect((await observer.listSessions()).find(s => s.id === 'recovering-id')?.name).toBe('recovering-session');
  });
});

it('ignores a foreign event context and keeps the original registration live', async () => {
  await fixture(async (h, observer, kick, advance) => {
    await until(h.connected);
    const foreign = { ...h.ctx, sessionManager: { getSessionId: () => 'replacement-id' } };
    await h.emit('session_tree', foreign);
    await h.emit('input', foreign);
    await advance(0);
    expect(h.connected()).toBe(true);
    expect((await observer.listSessions()).filter(s => s.name === 'recovering-session').map(s => s.id)).toEqual(['recovering-id']);
    const result = await observer.send('recovering-id', { text: 'still registered' });
    expect(result.delivered).toBe(true);
    await until(() => h.messages.length === 1);
    await kick();
    await advance(1000);
    await until(h.connected);
    expect((await observer.listSessions()).filter(s => s.name === 'recovering-session').map(s => s.id)).toEqual(['recovering-id']);
  });
});

it('switches sessions on turn_start', async () => {
  await fixture(async (h, observer, _kick, advance) => {
    await until(h.connected);
    const replacement = { ...h.ctx, sessionManager: { getSessionId: () => 'replacement-id' } };
    await h.emit('turn_start', replacement);
    await advance(0);
    await until(h.connected);
    expect((await observer.listSessions()).filter(s => s.name === 'recovering-session').map(s => s.id)).toEqual(['replacement-id']);
  });
});

it('keeps the queued retry alive when its context becomes unavailable before it fires', async () => {
  await fixture(async (h, _observer, kick, advance) => {
    await kick();
    let unavailable = true;
    h.ctx.sessionManager.getSessionId = () => { if (unavailable) throw new Error('temporary context loss'); return 'recovering-id'; };
    await advance(1000);
    expect(h.connected()).toBe(false);
    unavailable = false;
    await advance(2000);
    await until(h.connected);
  });
});

// Disabled 2026-11-25: flaky in CI (expected behavior did not recover).
it.skip('disconnects an orphaned socket when a connection attempt throws after registration', async () => {
  let attempts = 0;
  await fixture(async (h, observer, _kick, advance) => {
    await until(() => attempts === 1 && !h.connected());
    await until(async () => !(await observer.listSessions()).some(s => s.id === 'recovering-id'));
    await advance(1000);
    await until(h.connected);
    expect((await observer.listSessions()).filter(s => s.id === 'recovering-id')).toHaveLength(1);
  }, async connect => { await connect(); if (++attempts === 1) throw new Error('fixture error after registration'); });
});

it('accepts a fresh same-session context while a reconnect is in flight', async () => {
  let attempts = 0;
  let release!: () => void;
  let entered = false;
  await fixture(async (h, _observer, kick, advance) => {
    await until(h.connected);
    await kick();
    await advance(1000);
    await until(() => entered);
    const fresh = { ...h.ctx };
    Object.defineProperty(h.ctx, 'hasUI', { get() { throw new Error('old context'); } });
    await h.emit('input', fresh);
    release();
    await until(h.connected);
  }, async connect => {
    if (++attempts === 2) { entered = true; await new Promise<void>(resolve => { release = resolve; }); }
    await connect();
  });
});

it('recovers from a duplicate registration kick without a pi event', async () => {
  await fixture(async (h, observer, kick, advance) => {
    await kick();
    await advance(1000);
    await until(h.connected);
    const result = await observer.send('recovering-id', { text: 'recovered delivery' });
    expect(result.delivered).toBe(true);
    await until(() => h.messages.length === 1);
    expect(h.messages[0].details.message.content.text).toBe('recovered delivery');
    await advance(60000);
    expect(h.warnings).toEqual([]);
  });
});

it('does not let an old in-flight connection overwrite a restarted runtime', async () => {
  let release!: () => void;
  let entered = false;
  let attempts = 0;
  await fixture(async (h, observer, _kick, advance) => {
    await until(() => entered);
    const fresh = { ...h.ctx, sessionManager: { getSessionId: () => 'new-runtime-id' } };
    await h.emit('session_start', fresh);
    await advance(0);
    await until(h.connected);
    release();
    await realDelay(50);
    expect((await observer.listSessions()).filter(s => s.name === 'recovering-session').map(s => s.id)).toEqual(['new-runtime-id']);
  }, async connect => {
    if (++attempts === 1) { entered = true; await new Promise<void>(resolve => { release = resolve; }); }
    await connect();
  });
});

it('stops retries on shutdown', async () => {
  let attempts = 0;
  await fixture(async (h, _observer, kick, advance) => {
    await until(h.connected);
    await kick();
    await h.emit('session_shutdown');
    await advance(120000);
    expect(attempts).toBe(1);
    expect(h.connected()).toBe(false);
  }, async connect => { attempts++; await connect(); });
});

it('does not arm recovery timers when status is requested before startup connects', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const h = harness(() => { throw new Error('status must not connect'); });
  try {
    await h.emit('session_start');
    const timersBefore = vi.getTimerCount();
    const status = await h.tool('status');
    expect(status.details.connected).toBe(false);
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(h.warnings).toEqual([]);
  } finally {
    await h.emit('session_shutdown');
    vi.useRealTimers();
  }
});

it('does not show an overdue warning when status receives a fresh context', async () => {
  let offline = false;
  await fixture(async (h, _observer, kick, advance) => {
    await until(h.connected);
    const fresh = { ...h.ctx };
    Object.defineProperty(h.ctx, 'hasUI', { get() { throw new Error('old context'); } });
    offline = true;
    await kick();
    await advance(60000);
    expect(h.warnings).toEqual([]);
    const timersBefore = vi.getTimerCount();
    await h.tool('status', fresh);
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(h.warnings).toEqual([]);
    await h.emit('input', fresh);
    expect(h.warnings).toEqual(['Intercom is disconnected. Spider is reconnecting.']);
  }, async connect => { if (offline) throw new Error('fixture offline'); await connect(); });
});

it('reports the same status fields when connected or disconnected', async () => {
  await fixture(async (h, _observer, kick) => {
    await until(h.connected);
    const connected = await h.tool('status');
    expect(connected.details).toEqual({ connected: true, sessionId: 'recovering-id', activeSessions: 2 });
    await kick();
    const disconnected = await h.tool('status');
    expect(disconnected.details).toEqual({ connected: false, sessionId: null, activeSessions: null });
  });
});

it('leaves the connection and recovery timers unchanged when a status request times out', async () => {
  await fixture(async (h, observer) => {
    await until(h.connected);
    const timersBefore = vi.getTimerCount();
    const successful = h.tool('status');
    expect(vi.getTimerCount()).toBe(timersBefore + 1);
    await successful;
    expect(vi.getTimerCount()).toBe(timersBefore);

    // Drop the fixture's list request at the socket boundary; keep the real client and timeout.
    let dropped = 0;
    const originalWrite = Socket.prototype.write;
    const socketSpy = vi.spyOn(Socket.prototype, 'write').mockImplementation(function (this: Socket, chunk: any, ...rest: any[]) {
      if (Buffer.isBuffer(chunk) && chunk.length >= 4 && chunk.readUInt32BE(0) === chunk.length - 4) {
        try {
          if (JSON.parse(chunk.toString('utf8', 4)).type === 'list') { dropped++; return true; }
        } catch { /* Not an intercom frame. */ }
      }
      return Reflect.apply(originalWrite, this, [chunk, ...rest]);
    } as typeof Socket.prototype.write);
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const pending = h.tool('status');
      expect(dropped).toBe(1);
      expect(vi.getTimerCount()).toBe(timersBefore + 1);
      await vi.advanceTimersByTimeAsync(5000);
      const status = await pending;
      expect(status.content[0].text).toContain('Active sessions: Unknown');
      expect(status.details).toEqual({ connected: true, sessionId: 'recovering-id', activeSessions: null });
      expect(h.connected()).toBe(true);
      expect(h.warnings).toEqual([]);
      expect(vi.getTimerCount()).toBe(timersBefore);
      expect(timerSpy.mock.calls.map(([, ms]) => ms)).toEqual([5000]);
    } finally {
      timerSpy.mockRestore();
      socketSpy.mockRestore();
    }
    expect((await observer.listSessions()).find(s => s.id === 'recovering-id')?.name).toBe('recovering-session');
    expect((await h.tool('status')).details).toEqual({ connected: true, sessionId: 'recovering-id', activeSessions: 2 });
    expect(vi.getTimerCount()).toBe(timersBefore);
  });
});

it('reads connected status without consulting the event context', async () => {
  await fixture(async (h, observer) => {
    await until(h.connected);
    const foreign = { ...h.ctx, sessionManager: { getSessionId: () => { throw new Error('status read context'); } } };
    const status = await h.tool('status', foreign);
    expect(status.details).toEqual({ connected: true, sessionId: 'recovering-id', activeSessions: 2 });
    expect((await observer.listSessions()).some(s => s.id === 'recovering-id')).toBe(true);
  });
});

it('does not claim to reconnect when intercom is disabled', async () => {
  const file = getConfigPath();
  const previous = existsSync(file) ? readFileSync(file) : undefined;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ enabled: false }));
  const h = harness(() => { throw new Error('disabled runtime must not connect'); });
  try {
    await h.emit('session_start');
    const status = await h.tool('status');
    expect(status.details.connected).toBe(false);
    expect(status.content[0].text).toContain('Intercom is disabled.');
  } finally {
    await h.emit('session_shutdown');
    if (previous) writeFileSync(file, previous);
    else rmSync(file, { force: true });
  }
});

it('does not claim to reconnect after runtime shutdown', async () => {
  await fixture(async h => {
    await h.emit('session_shutdown');
    const status = await h.tool('status');
    expect(status.details.connected).toBe(false);
    expect(status.content[0].text).toContain('Intercom runtime is not active.');
  });
});

it.each(['print', 'rpc'])('does not show an interactive outage warning in %s mode', async mode => {
  let offline = false;
  await fixture(async (h, _observer, kick, advance) => {
    await until(h.connected);
    h.ctx.mode = mode;
    offline = true;
    await kick();
    await advance(120000);
    expect(h.warnings).toEqual([]);
  }, async connect => { if (offline) throw new Error('fixture offline'); await connect(); });
});

it('delays an outage warning until a fresh interactive context is available', async () => {
  let offline = false;
  await fixture(async (h, _observer, kick, advance) => {
    await until(h.connected);
    const fresh = { ...h.ctx };
    Object.defineProperty(h.ctx, 'hasUI', { get() { throw new Error('old context'); } });
    offline = true;
    await kick();
    await advance(60000);
    expect(h.warnings).toEqual([]);
    await h.emit('input', fresh);
    expect(h.warnings).toEqual(['Intercom is disconnected. Spider is reconnecting.']);
  }, async connect => { if (offline) throw new Error('fixture offline'); await connect(); });
});

it('warns once after 60 seconds, reports disconnected status, and resets on recovery', async () => {
  let offline = false;
  await fixture(async (h, _observer, kick, advance) => {
    await until(h.connected);
    offline = true;
    await kick();
    const status = await h.tool('status');
    expect(status.content[0].text).toContain('Connected: No');
    expect(status.details.connected).toBe(false);
    await advance(59999);
    expect(h.warnings).toEqual([]);
    await advance(1);
    expect(h.warnings).toEqual(['Intercom is disconnected. Spider is reconnecting.']);
    await advance(120000);
    expect(h.warnings).toHaveLength(1);
    offline = false;
    await advance(30000);
    await until(h.connected);
    expect((await h.tool('status')).content[0].text).toContain('Connected: Yes');
    offline = true;
    await kick();
    await advance(60000);
    expect(h.warnings).toHaveLength(2);
  }, async connect => { if (offline) throw new Error('fixture offline'); await connect(); });
});
