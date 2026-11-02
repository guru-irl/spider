// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { afterEach, expect, it, vi } from 'vitest';
import { ProcessTerminal, formatProgramStatus, type ProgramStatus } from '@earendil-works/pi-tui';
import { installStatusAdapter, type StatusAdapter } from '../status/adapter.js';
import { registerHerdrStatusContribution } from '../status/register.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Owner } from '../contracts.js';
import { acceptanceB } from './acceptance/b.js';
import { createHerdrHarness } from './testutil.js';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
// This is the repository devDependency, never the live executable's bundle.
const { ProgramStatusReporter } = await import(/* @vite-ignore */ pathToFileURL(join(root, 'modes/interactive/program-status-reporter.js')).href);
function nativeStatus() {
  const terminal = Object.create(ProcessTerminal.prototype) as ProcessTerminal;
  Reflect.set(terminal, 'programStatusSupported', true);
  const bytes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((data) => { bytes.push(String(data)); return true; });
  let name = 'fixture';
  const reporter = new ProgramStatusReporter(() => terminal, () => name);
  return { terminal, reporter, bytes, rename(value: string) { name = value; }, lastStatus: () => Reflect.get(terminal, 'programStatus') as ProgramStatus | undefined };
}
const { InteractiveMode } = await import(/* @vite-ignore */ pathToFileURL(join(root, 'modes/interactive/interactive-mode.js')).href);
function registrationFixture(mode: string = 'tui') {
  const native = nativeStatus();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const widgets = { ui: { terminal: native.terminal }, extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(), renderWidgets() {} };
  let captured = false;
  const ctx = { mode, ui: { setWidget(...args: unknown[]) { captured = true; InteractiveMode.prototype.setExtensionWidget.apply(widgets, args); } } } as unknown as ExtensionContext;
  const pi = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
  return { native, pi, ctx, handlers, captured: () => captured };
}
it.each(['startup', 'reload', 'new', 'resume', 'fork'])('captures synchronously after reset and replaces the activation: %s', async reason => {
  vi.stubEnv('PI_SUBAGENT_CHILD', ''); vi.stubEnv('HC_TERMINAL_ID', 'fixture');
  const h = registrationFixture(); h.native.reporter.reset();
  const owner = { sessionId: 'owned', generation: 'g1' } as Owner;
  let refresh: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const registration = registerHerdrStatusContribution(h.pi, {
    currentOwner: () => owner,
    listPending: async o => { expect(o).toBe(owner); expect(h.captured()).toBe(true); return { running: 1, queued: 0, paused: 0 }; },
    subscribeRuns: (o, listener) => { expect(o).toBe(owner); refresh = listener; return unsubscribe; },
    reportDisabled: reason => { throw new Error(reason); },
  });
  try {
    expect(h.handlers.has('session_start')).toBe(true);
    await h.handlers.get('session_start')!({ type: 'session_start', reason }, h.ctx);
    expect(h.native.lastStatus()?.state).toBe('working');
    await h.handlers.get('session_start')!({ type: 'session_start', reason: 'reload' }, h.ctx);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await h.handlers.get('session_shutdown')!({ type: 'session_shutdown', reason: 'reload' }, h.ctx);
    refresh?.(); await Promise.resolve();
    expect(h.native.lastStatus()?.state).toBe('idle');
    expect(Object.hasOwn(h.native.terminal, 'setProgramStatus')).toBe(false);
  } finally { registration.dispose(); }
});
it('acceptance B: native status, fresh feed, and IPC lifecycle (fake or isolated hc; no app)', async () => {
  const h = await createHerdrHarness(process.env.SPIDER_HERDR_E2E === '1' ? 'hc' : 'fake');
  try { await h.start(); await acceptanceB(h); }
  finally { await h.close(); }
  expect(await h.remainingOwnedResources()).toEqual([]);
}, 30000);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each(['foreign', 'bad-cache', 'disabled', 'missing-replay'])('disables an unsafe status instance: %s', (shape) => {
  const native = nativeStatus();
  native.reporter.reset();
  if (shape === 'foreign') native.terminal.setProgramStatus = () => {};
  if (shape === 'bad-cache') Reflect.set(native.terminal, 'programStatus', { state: 'invented' });
  if (shape === 'disabled') vi.stubEnv('PI_PROGRAM_STATUS', '0');
  if (shape === 'missing-replay') Reflect.set(native.terminal, 'writeProgramStatus', undefined);
  const original = native.terminal.setProgramStatus;
  const installed = installStatusAdapter(native.terminal, { running: 1, queued: 0, paused: 0 });
  try { expect(installed).toMatchObject({ disabled: true }); expect(native.terminal.setProgramStatus).toBe(original); }
  finally { if ('dispose' in installed) installed.dispose(); }
});
it('exposes a read-only owner-scoped native/effective snapshot to the feed and ping ports', async () => {
  vi.stubEnv('PI_SUBAGENT_CHILD', ''); vi.stubEnv('HC_TERMINAL_ID', 'fixture');
  const h = registrationFixture(); h.native.reporter.reset(); const owner = { sessionId: 'owned', generation: 'g1' } as Owner;
  const contribution = registerHerdrStatusContribution(h.pi, { currentOwner: () => owner, listPending: () => ({ running: 2, queued: 0, paused: 0 }), subscribeRuns: () => () => {}, reportDisabled: reason => { throw new Error(reason); } });
  try {
    await h.handlers.get('session_start')!({ reason: 'startup' }, h.ctx); h.native.reporter.handleEvent({ type: 'agent_settled', aborted: false });
    expect(Reflect.get(contribution, 'currentStatus')).toEqual(expect.any(Function));
    const emitted = h.native.bytes.length;
    expect(contribution.currentStatus(owner)).toEqual({ native: 'done', effective: 'working', message: '2 subagents running' });
    expect(h.native.bytes).toHaveLength(emitted);
    expect(contribution.currentStatus({ ...owner, generation: 'foreign' as Owner['generation'] })).toBeNull();
    contribution.dispose(); expect(contribution.currentStatus(owner)).toBeNull();
  } finally { contribution.dispose(); }
});
it('the installed rebind resets native state before binding the contribution widget', async () => {
  vi.stubEnv('PI_SUBAGENT_CHILD', ''); vi.stubEnv('HC_TERMINAL_ID', 'fixture');
  const h = registrationFixture();
  h.native.reporter.handleEvent({ type: 'agent_start' });
  h.native.reporter.handleEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'previous session' } });
  h.native.reporter.handleEvent({ type: 'agent_settled', aborted: false });
  const reg = registerHerdrStatusContribution(h.pi, { currentOwner: () => ({ sessionId: 'owned', generation: 'g1' } as Owner), listPending: async () => { expect(h.native.lastStatus()?.state).toBe('idle'); return { running: 1, queued: 0, paused: 0 }; }, subscribeRuns: () => () => {}, reportDisabled: reason => { throw new Error(reason); } });
  const mode = { session: {}, programStatus: h.native.reporter, applyRuntimeSettings() {}, bindCurrentSessionExtensions: () => h.handlers.get('session_start')!({ reason: 'reload' }, h.ctx), subscribeToAgent() {}, updateAvailableProviderCount() {}, updateEditorBorderColor() {}, updateTerminalTitle() {} };
  try { await InteractiveMode.prototype.rebindCurrentSession.call(mode); expect(h.native.lastStatus()?.state).toBe('working'); }
  finally { reg.dispose(); }
});
it.each(['blocked', 'error', 'working'] as const)('preserves a previously cached native %s', state => {
  const n = nativeStatus(); n.terminal.setProgramStatus({ state, message: 'keep this', kind: 'question' });
  const a = installStatusAdapter(n.terminal, { running: 2, queued: 0, paused: 0 }) as StatusAdapter;
  try { a.update({ running: 1, queued: 1, paused: 1 }); expect(n.lastStatus()).toMatchObject({ state, message: 'keep this' }); }
  finally { a.dispose(); }
});
it('does not guess idle when no native cache exists', () => {
  const n = nativeStatus();
  const a = installStatusAdapter(n.terminal, { running: 1, queued: 0, paused: 0 }) as StatusAdapter;
  try {
    a.update({ running: 1, queued: 1, paused: 0 }); expect(n.bytes).toEqual([]);
    n.terminal.setProgramStatus({ state: 'idle' }); expect(n.lastStatus()?.message).toBe('1 subagent running, 1 queued');
  } finally { a.dispose(); }
});
it('raw overlay loses to native replay while native dedupe, rename, and dialogs preserve contributions', () => {
  const n = nativeStatus(); n.reporter.reset(); n.reporter.handleEvent({ type: 'agent_settled', aborted: false });
  n.bytes.push('\u001b]7501;state=working\u001b\\'); Reflect.get(n.terminal, 'writeProgramStatus').call(n.terminal); expect(n.bytes.at(-1)).toContain('state=done');
  const a = installStatusAdapter(n.terminal, { running: 1, queued: 1, paused: 1 }) as StatusAdapter;
  try {
    const length = n.bytes.length; n.reporter.report(); expect(n.bytes).toHaveLength(length);
    n.rename('renamed'); n.reporter.handleEvent({ type: 'session_info_changed' }); expect(n.lastStatus()?.message).toBe('1 subagent running, 1 queued, 1 paused');
    n.reporter.setBlocked('permission', { kind: 'permission', message: 'Allow?' }); expect(n.lastStatus()?.state).toBe('blocked');
    n.reporter.setBlocked('permission', undefined); expect(n.lastStatus()?.state).toBe('working');
    n.reporter.handleEvent({ type: 'agent_settled', aborted: true }); a.update({ running: 0, queued: 0, paused: 0 }); expect(n.lastStatus()?.state).toBe('idle');
  } finally { a.dispose(); }
});
it('restores the exact own descriptor and never restores over a foreign replacement', () => {
  const n = nativeStatus();
  Object.defineProperty(n.terminal, 'setProgramStatus', { value: ProcessTerminal.prototype.setProgramStatus, configurable: true, writable: false, enumerable: true });
  const descriptor = Object.getOwnPropertyDescriptor(n.terminal, 'setProgramStatus');
  const a = installStatusAdapter(n.terminal, { running: 1, queued: 0, paused: 0 }) as StatusAdapter; a.dispose();
  expect(Object.getOwnPropertyDescriptor(n.terminal, 'setProgramStatus')).toEqual(descriptor);
  const b = installStatusAdapter(n.terminal, { running: 1, queued: 0, paused: 0 }) as StatusAdapter;
  const foreign = () => {}; Object.defineProperty(n.terminal, 'setProgramStatus', { value: foreign, configurable: true });
  b.dispose(); expect(n.terminal.setProgramStatus).toBe(foreign);
});
it.each([['rpc', '', 'fixture'], ['tui', '1', 'fixture'], ['tui', '', '']])('does not activate without the exact owner predicate: %s %s %s', async (mode, child, terminal) => {
  vi.stubEnv('PI_SUBAGENT_CHILD', child); vi.stubEnv('HC_TERMINAL_ID', terminal);
  const h = registrationFixture(mode); const listPending = vi.fn();
  const reg = registerHerdrStatusContribution(h.pi, { currentOwner: () => null, listPending, subscribeRuns: () => () => {}, reportDisabled: () => {} });
  await h.handlers.get('session_start')!({ reason: 'startup' }, h.ctx);
  expect(h.captured()).toBe(false); expect(listPending).not.toHaveBeenCalled(); reg.dispose();
});
it('recognizes the bundled native setter without accepting a foreign wrapper', () => {
  const n = nativeStatus(); n.reporter.reset();
  // Generic recording of the supported bundler's native method, not a live bundle import.
  const factory = new Function('formatProgramStatus', 'return ({setProgramStatus(status){this.programStatus=status.state==="clear"?void 0:status,this.programStatusSupported&&process.stdout.write(formatProgramStatus(status))}}).setProgramStatus');
  const bundled = factory(formatProgramStatus) as ProcessTerminal['setProgramStatus'];
  Object.defineProperty(n.terminal, 'setProgramStatus', { value: bundled, configurable: true });
  const adapter = installStatusAdapter(n.terminal, { running: 1, queued: 0, paused: 0 });
  try { expect(adapter).not.toHaveProperty('disabled'); n.reporter.handleEvent({ type: 'agent_settled', aborted: false }); expect(n.lastStatus()?.state).toBe('working'); }
  finally { if ('dispose' in adapter) adapter.dispose(); }
});
it('warns once per failed refresh streak and permits another warning after recovery', async () => {
  vi.stubEnv('PI_SUBAGENT_CHILD', ''); vi.stubEnv('HC_TERMINAL_ID', 'fixture');
  const h = registrationFixture(); h.native.reporter.reset();
  let fail = true; let refresh!: () => void; const warnings: string[] = [];
  const contribution = registerHerdrStatusContribution(h.pi, {
    currentOwner: () => ({ sessionId: 'owned', generation: 'g1' } as Owner),
    listPending: async () => { if (fail) throw new Error('unreadable'); return { running: 1, queued: 0, paused: 0 }; },
    subscribeRuns: (_owner, listener) => { refresh = listener; return () => {}; },
    reportDisabled: reason => warnings.push(reason),
  });
  try {
    await h.handlers.get('session_start')!({}, h.ctx);
    refresh(); await Promise.resolve(); refresh(); await Promise.resolve();
    expect(warnings).toEqual(['status-counts-unavailable']);
    fail = false; refresh(); await Promise.resolve();
    expect(h.native.lastStatus()?.message).toBe('1 subagent running');
    fail = true; refresh(); await Promise.resolve(); refresh(); await Promise.resolve();
    expect(warnings).toEqual(['status-counts-unavailable', 'status-counts-unavailable']);
  } finally { contribution.dispose(); }
});
it('native cache replay cannot restore done while owned children run', () => {
  const native = nativeStatus();
  native.reporter.reset();
  const adapter = installStatusAdapter(native.terminal, { running: 2, queued: 0, paused: 0 }) as StatusAdapter;
  try {
    native.reporter.handleEvent({ type: 'agent_settled', aborted: false });
    Reflect.get(native.terminal, 'writeProgramStatus').call(native.terminal);
    expect(native.lastStatus()).toMatchObject({ state: 'working', message: '2 subagents running' });
    adapter.update({ running: 0, queued: 0, paused: 0 });
    expect(native.lastStatus()?.state).toBe('done');
  } finally { adapter.dispose(); }
});
