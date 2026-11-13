// SPDX-License-Identifier: MIT
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createClientFixture } from '../../../herdr/src/__tests__/testutil.js';
import * as herdr from '../herdr/mount.js';
import { withPiEvents, hostUnitPorts } from './fixtures/pi-events';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(['missing', 'throws'])('an intercom event bus that is %s cannot prevent spider startup', async failure => {
  vi.stubEnv('PI_SUBAGENT_CHILD', '1');
  const hooks = new Map<string, Function[]>(), tools: { name: string }[] = [], notices: string[] = [];
  const pi = { on(name: string, fn: Function) { hooks.set(name, [...hooks.get(name) ?? [], fn]); return () => {}; },
    registerCommand() {}, registerShortcut() {}, registerTool(tool: { name: string }) { tools.push(tool); }, sendMessage() {},
    ...(failure === 'throws' ? { events: { on() { throw new Error('fixture bus failed'); }, emit() {} } } : {}) };
  const ctx = { cwd: process.cwd(), mode: 'rpc', hasUI: true, ui: { notify(message: string) { notices.push(message); } },
    sessionManager: { getSessionId: () => 'fixture', getSessionFile: () => undefined, getBranch: () => [] } };
  const { default: extension } = await import('../extension.js');
  expect(() => extension(pi as never)).not.toThrow();
  expect(tools.map(tool => tool.name)).toContain('spider');
  expect(tools.map(tool => tool.name)).not.toContain('intercom');
  await hooks.get('session_start')![0]({}, ctx);
  expect(notices).toEqual([expect.stringMatching(/intercom.*(?:unavailable|could not|couldn't)/i)]);
  for (const fn of hooks.get('session_shutdown') ?? []) await fn({ reason: 'quit' }, ctx);
}, 5000);

it.each([true, false])('Herdr mount failure cannot take down spider (child=%s)', async child => {
  const f = await createClientFixture();
  execFileSync('git', ['init', '-q', f.root]);
  const globalRoot = join(f.root, 'global'); await mkdir(globalRoot);
  vi.stubEnv('SPIDER_GLOBAL_ROOT', globalRoot); vi.stubEnv('PI_SUBAGENT_CHILD', child ? '1' : '0');
  const hooks = new Map<string, Function[]>(), tools: unknown[] = [], notices: string[] = [];
  const pi = { on(name: string, fn: Function) { hooks.set(name, [...hooks.get(name) ?? [], fn]); return () => hooks.set(name, (hooks.get(name) ?? []).filter(f => f !== fn)); }, registerCommand() {}, registerTool(tool: unknown) { tools.push(tool); }, sendMessage() {}, getSessionName: () => 'fixture' };
  let previousStarts = new Set<Function>();
  const mount = vi.spyOn(herdr, 'mountHerdr').mockImplementation(() => {
    previousStarts = new Set(hooks.get('session_start') ?? []);
    throw new Error('mount unavailable\n' + 'x'.repeat(2000));
  });
  const ctx = { cwd: f.root, mode: 'rpc', hasUI: true, ui: { notify(message: string) { notices.push(message); } }, sessionManager: { getSessionId: () => 'mount-session', getSessionFile: () => undefined, getBranch: () => [] } };
  try {
    const { default: extension } = await import('../extension.js');
    expect(() => extension(withPiEvents(pi as never), hostUnitPorts)).not.toThrow();
    expect(tools.length).toBeGreaterThan(0);
    for (const event of [{ reason: 'startup' }, { reason: 'reload' }]) {
      for (const fn of hooks.get('session_start') ?? []) if (!previousStarts.has(fn)) await fn(event, ctx);
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe("Spider couldn't start its Herdr features in this session. Everything else in spider still works. Run /herdr-setup to print the doctor command for this machine.");
    expect(notices[0].length).toBeLessThan(1200);
    expect(notices[0]).not.toContain('\n');
  } finally {
    mount.mockRestore();
    for (const fn of hooks.get('session_shutdown') ?? []) await fn({ reason: 'quit' }, ctx);
    await f.close();
  }
}, 30000);
