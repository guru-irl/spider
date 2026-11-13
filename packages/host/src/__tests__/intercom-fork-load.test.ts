import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { registerIntercomOnce, intercomConflict } from '@spider/intercom';
import legacyIntercom from '../../../intercom/src/local';

function harness() {
  const bus = new EventEmitter();
  const handlers = new Map<string, Function[]>();
  const tools: any[] = [], messages: any[] = [], notices: string[] = [];
  let bound = false;
  const events = { on(name: string, fn: (...args: any[]) => void) { bus.on(name, fn); return () => bus.off(name, fn); }, emit(name: string, data: unknown) { bus.emit(name, data); } };
  const pi: any = { events, on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    getAllTools() { if (!bound) throw new Error('runtime is not bound'); return tools; },
    registerTool(tool: any) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    getSessionName: () => 'fixture-session', getActiveTools: () => tools.map(t => t.name), setActiveTools() {},
    sendMessage(message: any) { messages.push(message); }, appendEntry() {} };
  const ctx: any = { cwd: process.cwd(), mode: 'rpc', hasUI: false, model: { id: 'fixture-model' },
    sessionManager: { getSessionId: () => 'fixture-session' }, isIdle: () => true,
    ui: { notify(message: string) { notices.push(message); }, setStatus() {} }, abort: vi.fn(), shutdown: vi.fn() };
  return { pi, tools, messages, notices, ctx, async start() { bound = true; for (const fn of [...handlers.get('session_start') ?? []]) await fn({}, ctx); },
    async stop() { for (const fn of [...handlers.get('session_shutdown') ?? []]) await fn({}, ctx); } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it('both intercom load orders relay once', async () => {
  vi.useFakeTimers();
  for (const order of ['fork-first', 'legacy-first']) {
    const h = harness();
    if (order === 'fork-first') { registerIntercomOnce(h.pi); legacyIntercom(h.pi); }
    else { legacyIntercom(h.pi); registerIntercomOnce(h.pi); }
    await h.start();
    h.pi.events.emit('subagent:result-intercom', { to: 'fixture-session', message: 'synthetic result', requestId: 'result-1' });
    await Promise.resolve();
    expect(h.messages).toHaveLength(1);
    expect(h.tools.filter(t => t.name === 'intercom')).toHaveLength(1);
    expect(intercomConflict(h.pi)).toBe('intercom-extension-conflict');
    expect(h.notices).toContain('Another intercom extension is loaded. Remove its package or extension entry and run /reload.');
    await h.stop();
  }
}, 5000);

it('project and manual duplicate refuse fork startup', async () => {
  for (const source of ['project', 'manual']) {
    const h = harness(); registerIntercomOnce(h.pi);
    h.tools.push({ name: 'intercom', source });
    await h.start();
    expect(h.tools).toHaveLength(1);
    expect(h.messages).toHaveLength(0);
    expect(intercomConflict(h.pi)).toBe('intercom-extension-conflict');
    await h.stop();
  }
}, 5000);

it('repeated fork factories register one tool and relay', async () => {
  vi.useFakeTimers();
  const h = harness(); registerIntercomOnce(h.pi); registerIntercomOnce({ ...h.pi });
  expect(h.tools).toHaveLength(0);
  await h.start();
  h.pi.events.emit('subagent:result-intercom', { to: 'fixture-session', message: 'synthetic result' });
  await Promise.resolve();
  expect(h.tools.filter(t => t.name === 'intercom')).toHaveLength(1);
  expect(h.messages).toHaveLength(1);
  await h.stop();
}, 5000);

it('injected broker port fences the connection effect', async () => {
  vi.useFakeTimers();
  const h = harness(), brokerPort = vi.fn(async (_connect: () => Promise<void>) => {});
  registerIntercomOnce(h.pi, brokerPort);
  await h.start();
  const result = await h.tools.find(tool => tool.name === 'intercom').execute('fixture-list', { action: 'list' }, undefined, undefined, h.ctx);
  expect(brokerPort).toHaveBeenCalledOnce();
  expect(result.details.error).toBe(true);
  await h.stop();
}, 5000);

it('unexpected child duplicate refuses readiness', async () => {
  vi.stubEnv('PI_SUBAGENT_CHILD', '1');
  const h = harness(); registerIntercomOnce(h.pi); h.tools.push({ name: 'intercom' });
  await h.start();
  expect(h.ctx.shutdown).toHaveBeenCalledOnce();
  expect(h.tools).toHaveLength(1);
  expect(h.messages).toHaveLength(0);
}, 5000);
