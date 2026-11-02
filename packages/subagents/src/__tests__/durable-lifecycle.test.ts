// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from 'vitest';
import { registerSubagentActions } from '../index';
import { registerShared, getShared, resetSharedRegistryForTests, sharedRegistry, adoptShared } from '../child-registry';
import { registerChild, teardownAllAsync } from '../coordinators';
import type { ChildHandle } from '../runner';

function parent(runId = 'run') {
  const hooks = new Map<string, Function>();
  registerSubagentActions({ registerAction() {} }, { on: (name: string, handler: Function) => hooks.set(name, handler) });
  let finish!: (value: { exitCode: number }) => void;
  const wait = new Promise<{ exitCode: number }>(r => { finish = r; });
  const kill = vi.fn(() => finish({ exitCode: 130 }));
  const release = vi.fn();
  const handle: ChildHandle = { durable: true, wait: () => wait, kill, killAsync: async () => kill(), detach() {}, unbindEvents() {}, release };
  registerShared({ sessionId: 'planner', runId, dbPath: '/fixture/unused.db', handle, mode: 'rpc', survivable: true });
  registerChild('planner', runId, handle);
  return { hooks, handle, kill, release, ctx: { sessionManager: { getSessionId: () => 'planner' } } };
}
afterEach(async () => { await teardownAllAsync(); resetSharedRegistryForTests(); });

test.each(['quit', 'new', 'resume', 'fork', undefined])('a durable child survives parent shutdown with reason %s', async reason => {
  const f = parent();
  await f.hooks.get('session_shutdown')!({ reason }, f.ctx);
  expect(f.kill).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(getShared('run')).toMatchObject({ state: 'independent', handle: { durable: true } });
  expect(getShared('run')!.timer).toBeUndefined();
});

test('reload keeps the durable socket for the new activation', async () => {
  const f = parent();
  await f.hooks.get('session_shutdown')!({ reason: 'reload' }, f.ctx);
  expect(f.release).not.toHaveBeenCalled();
  expect(f.kill).not.toHaveBeenCalled();
});

test('a process-exit hook installed before supervisors cannot reap a released durable child', async () => {
  const f = parent();
  await f.hooks.get('session_shutdown')!({ reason: 'quit' }, f.ctx);
  // Frozen b4764fcd protocol: its exit hook knows only the detached state, not durable flags.
  const legacyReaped = [...sharedRegistry().entries.values()].filter(entry => entry.state === 'detached').map(entry => entry.runId);
  expect(legacyReaped).toEqual([]);
  expect(adoptShared('planner', () => {}).adopted).toEqual(['run']);
});

test('ordinary shutdown still stops an unshared legacy child while preserving a durable child', async () => {
  const f = parent(), stop = vi.fn();
  registerChild('planner', 'legacy', { wait: () => new Promise(() => {}), kill: stop, killAsync: async () => stop(), detach() {} });
  await f.hooks.get('session_shutdown')!({ reason: 'quit' }, f.ctx);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(f.kill).not.toHaveBeenCalled();
});

test('Escape during a busy turn leaves background children running, including when a dialog receives it', async () => {
  const f = parent(), other = parent('other'), listeners: Array<(data: string) => unknown> = [];
  f.hooks.get('session_start')?.({}, { ...f.ctx, isIdle: () => false, ui: { onTerminalInput: (handler: (data: string) => unknown) => { listeners.push(handler); return () => {}; } } });
  vi.useFakeTimers();
  try {
    for (const listener of listeners) listener('\u001b');
    await vi.runAllTimersAsync();
    expect(f.kill).not.toHaveBeenCalled();
    expect(other.kill).not.toHaveBeenCalled();
    expect(getShared('run')!.state).toBe('attached');
    expect(getShared('other')!.state).toBe('attached');
  } finally { vi.useRealTimers(); }
});
