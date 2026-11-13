import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import { registerIntercomOnce, intercomConflict } from './single-instance.js';
import { INTERCOM_EXTENSION_REGISTRY_READY_EVENT } from './extension-api.js';
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
