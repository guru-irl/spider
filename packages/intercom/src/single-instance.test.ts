import { EventEmitter } from 'node:events';
import { queryObjects } from 'node:v8';
import { expect, it, vi } from 'vitest';
import { registerIntercomOnce, intercomConflict } from './single-instance.js';
import { INTERCOM_EXTENSION_REGISTRY_READY_EVENT } from './extension-api.js';
import { INTERCOM_HOST_EVENT } from './host-api.js';
it('a foreign registry-ready signal disables the fork before tool or relay registration', async () => {
  const bus = new EventEmitter(), starts: Function[] = [], tools: unknown[] = [];
  const notices: string[] = [];
  const events = { on(name: string, fn: (...args: any[]) => void) { bus.on(name, fn); return () => bus.off(name, fn); }, emit(name: string, value: unknown) { bus.emit(name, value); } };
  const pi: any = { events, on(name: string, fn: Function) { if (name === 'session_start') starts.push(fn); },
    getAllTools: () => [], registerTool(tool: unknown) { tools.push(tool); } };
  registerIntercomOnce(pi);
  events.emit(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, { version: 1 });
  await starts[0]({}, { ui: { notify(message: string) { notices.push(message); } }, shutdown() {} });
  expect(intercomConflict(pi)).toBe('intercom-extension-conflict');
  expect(tools).toEqual([]);
  expect(bus.listenerCount('subagent:result-intercom')).toBe(0);
  expect(notices).toHaveLength(1);
}, 5000);

it.each([
  { label: 'without restored deliveries', entries: [], hostCallback: false },
  { label: 'with a restored delivery', entries: [{ type: 'custom', customType: 'intercom_pending', id: 'pending-entry', data: { sessionId: 'own', messageId: 'message', activationEpoch: 'old' } }], hostCallback: false },
  { label: 'with a host callback', entries: [], hostCallback: true },
])('releases the active intercom session context on reload ($label)', async ({ entries, hostCallback }) => {
  vi.stubEnv('PI_SUBAGENT_CHILD', '0');
  try {
    class SessionContext {
      cwd = '/workspace';
      hasUI = false;
      mode = 'rpc';
      model = { id: 'fixture' };
      isIdle = () => true;
      getContextUsage = () => undefined;
      ui = {};
      sessionManager = { getSessionId: () => 'own', getSessionFile: () => 'fixture.jsonl', getEntries: () => entries };
    }
    const bus = new EventEmitter(), hooks = new Map<string, Function[]>(), tools: string[] = [];
    let startingContext: SessionContext | undefined;
    const events = { on(name: string, fn: (...args: any[]) => void) { bus.on(name, fn); return () => bus.off(name, fn); }, emit(name: string, value: unknown) {
      if (name === INTERCOM_HOST_EVENT && hostCallback && startingContext) {
        const captured = startingContext;
        (value as any).reconcile = async (messageId: string) => ({ messageId, status: 'unknown', timestamp: captured.cwd.length });
      }
      bus.emit(name, value);
    } };
    const pi: any = { events, on(name: string, fn: Function) { hooks.set(name, [...hooks.get(name) ?? [], fn]); },
      getAllTools: () => [], getActiveTools: () => [], getSessionName: () => 'own',
      registerTool(tool: { name: string }) { tools.push(tool.name); }, registerCommand() {}, registerShortcut() {},
      registerMessageRenderer() {}, sendMessage() {}, appendEntry() {} };
    registerIntercomOnce(pi, async () => {});
    await (async () => {
      const ctx = new SessionContext();
      startingContext = ctx;
      for (const handler of hooks.get('session_start') ?? []) await handler({}, ctx);
      startingContext = undefined;
      expect(tools).toContain('intercom');
      for (const handler of hooks.get('session_shutdown') ?? []) await handler({ reason: 'reload' }, ctx);
    })();
    expect(queryObjects(SessionContext)).toBe(0);
  } finally {
    vi.unstubAllEnvs();
  }
}, 5000);
