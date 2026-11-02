import { expect, it } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerLoopSchedule } from '../index.js';
import { fakeTime } from './harness.js';
import { createHerdrViews } from '../../herdr/views.js';

it('shares the registered loop handler with the triggers view', async () => {
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const pi = { on() { return () => {}; }, registerCommand(name: string, command: unknown) { commands.set(name, command as never); }, appendEntry() {} };
  const registration = registerLoopSchedule(pi as unknown as ExtensionAPI, fakeTime());
  const notifications: string[] = [];
  const ctx = { cwd: process.cwd(), mode: 'tui', hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => 'fixture', getEntries: () => [] }, ui: { notify(text: string) { notifications.push(text); } } } as unknown as ExtensionContext;
  try {
    expect(registration.handler).toBe(commands.get('loop')!.handler);
    const views = createHerdrViews({ agents: { open() {} }, todos: { handler() {} }, usage: { handler() {} }, memory() {}, loop: registration });
    await commands.get('loop')!.handler('', ctx);
    await views.triggers(ctx);
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toBe(notifications[1]);
  } finally { registration.scheduler.shutdown(); }
});
