// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

export interface RenderedUi {
  frame: number;
  nodes: readonly { id: string; text: string; enabled: boolean; bounds: readonly [number, number, number, number]; attributes?: Readonly<Record<string, unknown>> }[];
}
export interface AppDriver {
  command(name: string, args: Record<string, unknown>): Promise<unknown>;
  ls(): Promise<unknown>;
  status(): Promise<unknown>;
  check(installedDirectory: string): Promise<CommandResult>;
  shot(path: string): Promise<string>;
  uiSnapshot(): Promise<RenderedUi>;
  activate(controlId: string): Promise<void>;
  keyToOwnedWindow(key: string): Promise<void>;
}
export interface CommandResult { exitCode: number; stdout: string; stderr: string }
export type AppInvoke = (binary: string, argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>) => Promise<CommandResult>;
export interface NativeAppOptions {
  binary: string;
  env: Readonly<NodeJS.ProcessEnv>;
  invoke: AppInvoke;
  ownPath(path: string): string;
}
export class AppBoundaryError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'AppBoundaryError'; }
}

// commands.rs listing and window.rs command replies in app 0.1.11.
const commands: Readonly<Record<string, readonly string[]>> = {
  ls: [], status: [],
  'space.new': ['name', 'folder', 'tab', 'argv', 'task', 'machine'], 'space.select': ['id', 'index'],
  'tab.new': ['name', 'space', 'folder', 'argv', 'task', 'mod', 'props'],
  'tab.rename': ['id', 'name'], 'tab.close': ['id', 'confirmed'],
  'pane.focus': ['pane', 'terminal'], 'pane.close': ['pane'], 'terminal.peek': ['terminal'], 'terminal.park': ['terminal'], 'terminal.keep': ['terminal', 'place'],
  'layout.switch': ['name'], 'layout.show': ['id'], 'layout.hide': ['id'],
  'layout.select': ['stack', 'child'], 'app.theme': ['name'],
};
const required: Readonly<Record<string, readonly string[]>> = {
  'terminal.peek': ['terminal'], 'terminal.park': ['terminal'], 'terminal.keep': ['terminal'],
  'layout.show': ['id'], 'layout.hide': ['id'], 'layout.select': ['stack', 'child'], 'app.theme': ['name'],
};
export function validateAppCommand(name: string, args: Record<string, unknown>): void {
  if (!Object.hasOwn(commands, name)) throw new AppBoundaryError('unknown-command', `unknown command ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new AppBoundaryError('invalid-args', 'arguments must be an object');
  for (const [key, value] of Object.entries(args)) {
    if (!commands[name].includes(key)) throw new AppBoundaryError('unknown-argument', `${name}: unknown argument ${key}`);
    if (key === 'argv') {
      if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || v.includes('\0'))) throw new AppBoundaryError('invalid-args', 'argv must be a string array');
    } else if (key === 'index') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AppBoundaryError('invalid-args', 'index must be an unsigned integer');
    } else if (key === 'confirmed') {
      if (typeof value !== 'boolean') throw new AppBoundaryError('invalid-args', 'confirmed must be boolean');
    } else if (key !== 'props' && (typeof value !== 'string' || value.includes('\0'))) {
      throw new AppBoundaryError('invalid-args', `${key} must be a string`);
    }
  }
  for (const key of required[name] ?? []) {
    if (typeof args[key] !== 'string' || !(args[key] as string).trim()) throw new AppBoundaryError('missing-argument', `${name} needs ${key}`);
  }
  if (name === 'pane.focus' && Number(args.pane !== undefined) + Number(args.terminal !== undefined) !== 1) throw new AppBoundaryError('invalid-args', 'pane.focus needs one target');
  if (name === 'terminal.keep' && args.place !== undefined && !['right', 'down', 'tab'].includes(String(args.place))) throw new AppBoundaryError('invalid-args', 'unsupported terminal.keep place');
}
function invalid(): never { throw new AppBoundaryError('invalid-reply', 'invalid app reply'); }
export function appObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
export function appId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) return invalid();
  return value;
}
const nullableString = (v: unknown): boolean => v === null || typeof v === 'string';
const nativeStatuses = new Set(['working', 'blocked', 'done', 'idle']);
function parseWorld(reply: Record<string, unknown>): void {
  if (!Array.isArray(reply.spaces) || !Array.isArray(reply.recent)) invalid();
  const ids = new Set<string>();
  const unique = (v: unknown) => { const id = appId(v); if (ids.has(id)) invalid(); ids.add(id); };
  const addresses = new Set<string>();
  for (const raw of reply.spaces) {
    const s = appObject(raw); unique(s.id);
    if (typeof s.name !== 'string' || typeof s.folder !== 'string' || !nullableString(s.machine) || typeof s.active !== 'boolean' || !Array.isArray(s.tabs)) invalid();
    for (const raw of s.tabs) {
      const t = appObject(raw); unique(t.id);
      if (typeof t.name !== 'string' || typeof t.active !== 'boolean' || typeof t.settled !== 'boolean' || !Array.isArray(t.terminals)) invalid();
      for (const raw of t.terminals) {
        const p = appObject(raw); unique(p.pane); const address = appId(p.terminal);
        if (addresses.has(address)) invalid(); addresses.add(address);
        if (!nullableString(p.app) || !nullableString(p.name) || !Array.isArray(p.sub_agents) || p.sub_agents.some(v => typeof v !== 'string')) invalid();
        if (p.status !== null && typeof p.status !== 'object' && !(typeof p.status === 'string' && nativeStatuses.has(p.status))) invalid();
      }
    }
  }
}
export function parseAppReply(name: string, args: Record<string, unknown>, value: unknown): Record<string, unknown> {
  const r = appObject(value);
  if (r.error !== undefined) {
    if (typeof r.error !== 'string' || !r.error) invalid();
    throw new AppBoundaryError('app-error', r.error);
  }
  if (name === 'ls') { parseWorld(r); return r; }
  if (name === 'status') {
    appId(r.layout);
    for (const key of ['space', 'tab', 'focused_pane', 'agent']) if (!nullableString(r[key])) invalid();
    if (!Array.isArray(r.errors) || r.errors.some(v => typeof v !== 'string') || !Array.isArray(r.overlays)) invalid();
    if (!Array.isArray(r.floats)) appObject(r.floats);
    return r;
  }
  if (name === 'space.new' || name === 'tab.new') {
    appId(r.space); appId(r.tab); appId(args.mod ? r.pane : r.terminal); return r;
  }
  if (name === 'terminal.park' || name === 'terminal.keep') {
    if (name === 'terminal.keep' && r.pending === undefined) { appId(r.pane); return r; }
    if (r.pending !== true) invalid();
    if (appId(r.terminal) !== args.terminal) throw new AppBoundaryError('wrong-id', 'wrong terminal in app acknowledgement');
    if (name === 'terminal.keep') { appId(r.pane); appId(r.tab); }
    return r;
  }
  if (r.ok !== true) invalid();
  return r;
}
export function parseAppEnvelope(requestId: string, name: string, args: Record<string, unknown>, value: unknown): Record<string, unknown> {
  const r = appObject(value);
  if (r.requestId !== requestId) throw new AppBoundaryError('wrong-id', 'wrong request id in app reply');
  return parseAppReply(name, args, r.result);
}
export function nativeUiUnavailable(): never {
  throw new AppBoundaryError('P2-native-rendered-ui', 'P2 blocked: app 0.1.11 has no owned rendered snapshot or targeted input capability');
}
export function createNativeAppDriver(options: NativeAppOptions): AppDriver {
  const call = async (argv: readonly string[]): Promise<CommandResult> => {
    if (!options.env.HERDR_APP_HOME || !options.env.TMPDIR) throw new AppBoundaryError('isolation-unproved', 'owned app home and TMPDIR required');
    options.ownPath(options.env.HERDR_APP_HOME); options.ownPath(options.env.TMPDIR);
    return options.invoke(options.binary, argv, options.env);
  };
  const command = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    validateAppCommand(name, args);
    const argv = ['ls', 'status'].includes(name) ? [name] : ['do', name, ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, typeof v === 'string' ? v : JSON.stringify(v)])];
    const response = await call(argv);
    let value: unknown;
    try { value = JSON.parse(response.stdout); } catch { return invalid(); }
    const reply = parseAppReply(name, args, value);
    if (response.exitCode !== 0) throw new AppBoundaryError('app-exit', response.stderr || `app exited ${response.exitCode}`);
    if (name === 'space.new' || name === 'tab.new') {
      const document = await command('ls', {}) as { spaces: { id: string; tabs: { id: string; terminals: { terminal: string; pane: string }[] }[] }[] };
      const placed = document.spaces.some(s => s.id === reply.space && s.tabs.some(t => t.id === reply.tab && (args.mod || t.terminals.some(p => p.terminal === reply.terminal))));
      if (!placed) throw new AppBoundaryError('wrong-id', 'unobserved allocated IDs in app reply');
    }
    return reply;
  };
  return {
    command, ls: () => command('ls', {}), status: () => command('status', {}),
    check: async path => call(['check', options.ownPath(path), '--print-spec']),
    shot: async path => {
      const target = options.ownPath(path);
      const result = await call(['shot', target]);
      if (result.exitCode !== 0) throw new AppBoundaryError('app-exit', result.stderr);
      return target;
    },
    uiSnapshot: async () => nativeUiUnavailable(), activate: async () => nativeUiUnavailable(), keyToOwnedWindow: async () => nativeUiUnavailable(),
  };
}
