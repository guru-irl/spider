// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { assertSocketPath, defaultCoreSocket, ownedPath, nativeLaunchEnvironment, nativeInheritedScopeKeys, scratchRoot } from './environment.js';
import type { LedgerHandle } from './resources.js';
import { deadline, waitFor } from './wait.js';

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
  ownsTarget?(kind: NativeTargetKind, id: string): boolean;
  sourceCore?: string;
}
export class AppBoundaryError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'AppBoundaryError'; }
}

// commands.rs listing and window.rs command replies in app 0.1.11.
const commands: Readonly<Record<string, readonly string[]>> = {
  ls: [], status: [], commands: [], 'mod.open': ['name'],
  'space.new': ['name', 'folder', 'tab', 'argv', 'task', 'machine'], 'space.select': ['id', 'index'],
  'tab.new': ['name', 'space', 'folder', 'argv', 'task', 'mod', 'props'],
  'tab.rename': ['id', 'name'], 'tab.close': ['id', 'confirmed'], 'tab.move': ['id', 'index'],
  'pane.focus': ['pane', 'terminal'], 'pane.close': ['pane'], 'pane.go': ['direction'], 'terminal.peek': ['terminal'], 'terminal.park': ['terminal'], 'terminal.keep': ['terminal', 'place'],
  'layout.switch': ['name'], 'layout.show': ['id'], 'layout.hide': ['id'],
  'layout.select': ['stack', 'child'], 'app.theme': ['name'],
};
const required: Readonly<Record<string, readonly string[]>> = {
  'terminal.peek': ['terminal'], 'terminal.park': ['terminal'], 'terminal.keep': ['terminal'], 'tab.move': ['id'], 'pane.go': ['direction'],
  'layout.show': ['id'], 'layout.hide': ['id'], 'layout.select': ['stack', 'child'], 'app.theme': ['name'],
};
const privateCommands = new Set(['spider-pane.park', 'spider-agents.sort-priority', 'spider-agents.sort-space', 'spider-agents.sort-machine', 'spider-panel.refresh']);
export type NativeTargetKind = 'terminal' | 'pane' | 'console-group' | 'session';
function privateTarget(name: string): { kind: NativeTargetKind; id: string } | null {
  for (const [prefix, kind] of [['spider-agents.console-group-toggle:', 'console-group'], ['spider-agents.activate-session:', 'session']] as const) {
    if (!name.startsWith(prefix)) continue;
    const encoded = name.slice(prefix.length);
    let id: string;
    try { id = decodeURIComponent(encoded); } catch { throw new AppBoundaryError('invalid-target', 'invalid encoded mod target'); }
    if (!id.trim() || id.length > 1024 || /[\x00-\x1f\x7f]/.test(id) || encodeURIComponent(id) !== encoded) throw new AppBoundaryError('invalid-target', 'invalid encoded mod target');
    return { kind, id };
  }
  return null;
}
export function validateAppCommand(name: string, args: Record<string, unknown>): void {
  const target = privateTarget(name);
  if (privateCommands.has(name) || target) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw new AppBoundaryError('invalid-args', 'mod-private arguments must be empty');
    return;
  }
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
  if (name === 'mod.open' && !['spider-picker', 'spider-panel'].includes(String(args.name))) throw new AppBoundaryError('invalid-args', 'unsupported mod');
  if (name === 'tab.move' && (!Number.isSafeInteger(args.index) || (args.index as number) < 1)) throw new AppBoundaryError('invalid-args', 'tab.move needs a one-based index');
  if (name === 'pane.go' && !['left', 'right', 'up', 'down'].includes(String(args.direction))) throw new AppBoundaryError('invalid-args', 'unsupported pane direction');
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
  const r = name === 'commands' && Array.isArray(value) ? { commands: value } : appObject(value);
  if (r.error !== undefined) {
    if (typeof r.error !== 'string' || !r.error) invalid();
    throw new AppBoundaryError('app-error', r.error);
  }
  if (name === 'commands') {
    if (!Array.isArray(r.commands) || r.commands.some(value => typeof appObject(value).name !== 'string')) invalid();
    return r;
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
  throw new AppBoundaryError('P2-native-rendered-ui', 'No owned native element snapshot or targeted input capability is available');
}
export function createNativeAppDriver(options: NativeAppOptions): AppDriver {
  const call = async (argv: readonly string[]): Promise<CommandResult> => {
    if (!options.env.HERDR_APP_HOME || !options.env.TMPDIR) throw new AppBoundaryError('isolation-unproved', 'owned app home and TMPDIR required');
    options.ownPath(options.env.HERDR_APP_HOME); options.ownPath(options.env.TMPDIR);
    const owned = validateNativeAppOwnership(options.binary, options.env);
    if (argv[0] === 'check' || argv[0] === 'shot') ownedPath(owned.root, argv[1]);
    return options.invoke(options.binary, argv, options.env);
  };
  const command = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    validateAppCommand(name, args);
    const target = privateTarget(name);
    if (target && !options.ownsTarget?.(target.kind, target.id)) throw new AppBoundaryError('unowned-target', 'mod target is not owned by this fixture');
    if (name === 'pane.focus') {
      const kind = args.terminal === undefined ? 'pane' : 'terminal', id = String(args.terminal ?? args.pane);
      if (!options.ownsTarget?.(kind, id)) throw new AppBoundaryError('unowned-target', 'pane focus target is not owned by this fixture');
    }
    if (name === 'spider-pane.park') {
      const status = appObject(await command('status', {}));
      if (typeof status.focused_pane !== 'string' || !options.ownsTarget?.('pane', status.focused_pane)) throw new AppBoundaryError('unowned-target', 'focused pane is not owned by this fixture');
    }
    const argv = ['ls', 'status', 'commands'].includes(name) ? [name] : ['do', name, ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, typeof v === 'string' ? v : JSON.stringify(v)])];
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
    check: async path => {
      const target = options.ownPath(path);
      if (options.env.SPIDER_HERDR_E2E_APP_OWNERSHIP) return call(['check', target, '--print-spec']);
      const checkerRoot = ownedPath(scratchRoot(), dirname(String(options.env.TMPDIR)));
      ownedPath(checkerRoot, target);
      const checker = await prepareNativeChecker(options);
      return options.invoke(checker.binary, ['check', target, '--print-spec'], checker.env);
    },
    shot: async path => {
      const target = options.ownPath(path);
      const result = await call(['shot', target]);
      if (result.exitCode !== 0) throw new AppBoundaryError('app-exit', result.stderr);
      return target;
    },
    uiSnapshot: async () => nativeUiUnavailable(), activate: async () => nativeUiUnavailable(), keyToOwnedWindow: async () => nativeUiUnavailable(),
  };
}

export type NativeAppRelease = '0.1.13' | '0.1.16';
export interface NativeAppOwnership {
  version: 1; root: string; ledgerPath: string; bundle: string; binary: string; appHome: string;
  coreBinary: string; appId: string; namespace: string; release: NativeAppRelease;
  sourceBundle: string; sourceBundleHash: string; sourceCore: string; sourceCoreHash: string;
  binaryHash: string; bundleHash: string; coreHash: string; defaultSocket: string; defaultSocketIdentity: string;
  defaultCoreBinary: string | null; defaultCoreHash: string | null;
  env: Record<string, string>;
}
export interface PrepareNativeAppOptions {
  root: string; sourceBundle: string; sourceCore: string; env: Readonly<Record<string, string>>; ledger: LedgerHandle; invoke: AppInvoke;
}
function parseNativeOwnership(text: string): NativeAppOwnership {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new AppBoundaryError('isolation-unproved', 'invalid native ownership JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppBoundaryError('isolation-unproved', 'invalid native ownership object');
  const value = raw as Record<string, unknown>;
  const fields = ['root', 'ledgerPath', 'bundle', 'binary', 'appHome', 'coreBinary', 'appId', 'namespace', 'sourceBundle', 'sourceBundleHash', 'sourceCore', 'sourceCoreHash', 'binaryHash', 'bundleHash', 'coreHash', 'defaultSocket', 'defaultSocketIdentity'];
  if (value.version !== 1 || (value.release !== '0.1.13' && value.release !== '0.1.16') || fields.some(key => typeof value[key] !== 'string' || !(value[key] as string))) throw new AppBoundaryError('isolation-unproved', 'invalid native ownership fields');
  const envFields = ['HOME', 'TMPDIR', 'HERDR_APP_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'HC_SOCKET', 'HC_SESSION', 'HERDR_RELEASES_URL', 'HERDR_TELEMETRY', 'HERDR_APP_ID', 'SPIDER_HERDR_E2E_APP_OWNERSHIP'];
  if (!value.env || typeof value.env !== 'object' || Array.isArray(value.env) || Object.values(value.env).some(v => typeof v !== 'string') || envFields.some(key => typeof (value.env as Record<string, unknown>)[key] !== 'string')) throw new AppBoundaryError('isolation-unproved', 'invalid native ownership environment');
  if (!(value.defaultCoreBinary === null || typeof value.defaultCoreBinary === 'string') || !(value.defaultCoreHash === null || typeof value.defaultCoreHash === 'string')) throw new AppBoundaryError('isolation-unproved', 'invalid default core observation');
  return value as unknown as NativeAppOwnership;
}
const fileDigest = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
function bundleDigest(bundle: string): string {
  const hash = createHash('sha256');
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), info = lstatSync(file);
      if (info.isSymbolicLink()) throw new AppBoundaryError('isolation-unproved', 'source bundle contains a symlink');
      if (info.isDirectory()) visit(file);
      else if (info.isFile()) hash.update(file.slice(bundle.length)).update('\0').update(readFileSync(file));
      else throw new AppBoundaryError('isolation-unproved', 'source bundle contains a special file');
    }
  };
  visit(bundle); return hash.digest('hex');
}
function socketIdentity(socket: string): string {
  if (!existsSync(socket)) return 'absent';
  const info = lstatSync(socket);
  return JSON.stringify({ dev: info.dev, ino: info.ino, mode: info.mode });
}
async function successful(invoke: AppInvoke, binary: string, argv: readonly string[], env: Readonly<NodeJS.ProcessEnv>): Promise<CommandResult> {
  const result = await invoke(binary, argv, env);
  if (result.exitCode !== 0) throw new AppBoundaryError('native-preparation-failed', result.stderr || result.stdout || `${binary} failed`);
  return result;
}

export async function prepareNativeApp(options: PrepareNativeAppOptions): Promise<NativeAppOwnership> {
  const { root, ledger, invoke } = options;
  const record = ledger.read();
  if (record.root !== resolve(root) || record.state !== 'open') throw new AppBoundaryError('isolation-unproved', 'an open owned ledger is required');
  const appHome = ownedPath(root, options.env.HERDR_APP_HOME), tmp = ownedPath(root, options.env.TMPDIR);
  const socket = assertSocketPath(root, options.env.HC_SOCKET);
  const namespace = options.env.HC_SESSION;
  if (!namespace || namespace === 'default' || !/^[a-z0-9-]+$/.test(namespace)) throw new AppBoundaryError('isolation-unproved', 'a non-default core namespace is required');
  const sourceBundle = realpathSync(options.sourceBundle), sourceCore = realpathSync(options.sourceCore);
  if (sourceBundle !== resolve(options.sourceBundle) || !lstatSync(sourceBundle).isDirectory()) throw new AppBoundaryError('isolation-unproved', 'source bundle must be a physical directory');
  const sourceBundleHash = bundleDigest(sourceBundle), sourceCoreHash = fileDigest(sourceCore);
  const defaultSocket = defaultCoreSocket(), defaultSocketIdentity = socketIdentity(defaultSocket);
  const defaultCorePath = join(userInfo().homedir, '.local/bin/herdr-core');
  const defaultCoreBinary = existsSync(defaultCorePath) ? defaultCorePath : null;
  const defaultCoreHash = defaultCoreBinary ? fileDigest(defaultCoreBinary) : null;
  const infoResult = await successful(invoke, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(sourceBundle, 'Contents/Info.plist')], options.env);
  const info = appObject(JSON.parse(infoResult.stdout));
  const release = info.CFBundleShortVersionString;
  if ((release !== '0.1.13' && release !== '0.1.16') || info.CFBundleExecutable !== 'Herdr') throw new AppBoundaryError('isolation-unproved', 'unsupported source bundle');
  const bundle = ownedPath(root, join(root, 'native.app'));
  if (existsSync(bundle)) throw new AppBoundaryError('isolation-unproved', 'native destination already exists');
  await successful(invoke, '/bin/cp', ['-cR', sourceBundle, bundle], options.env);
  const binary = ownedPath(root, join(bundle, 'Contents/MacOS/Herdr'));
  const coreBinary = ownedPath(root, join(root, 'native-core'));
  copyFileSync(sourceCore, coreBinary); chmodSync(coreBinary, 0o700);
  const appId = `dev.spider.e2e.${ledger.id}`;
  await successful(invoke, '/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', appId, join(bundle, 'Contents/Info.plist')], options.env);
  await successful(invoke, '/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], options.env);
  const env = nativeLaunchEnvironment(root, { ...options.env, HERDR_APP_HOME: appHome, TMPDIR: tmp, HC_SOCKET: socket, HC_SESSION: namespace }, appId);
  mkdirSync(appHome, { recursive: true, mode: 0o700 });
  const settings = ownedPath(root, join(appHome, 'settings.json'));
  if (existsSync(settings)) throw new AppBoundaryError('isolation-unproved', 'native settings already exist');
  writeFileSync(settings, JSON.stringify({ core: coreBinary, sounds: { enabled: false } }) + '\n', { mode: 0o600 });
  const proof = ownedPath(root, join(root, 'native-ownership.json'));
  env.SPIDER_HERDR_E2E_APP_OWNERSHIP = proof;
  const owned: NativeAppOwnership = { version: 1, root, ledgerPath: ledger.path, bundle, binary, appHome, coreBinary, appId, namespace,
    release, sourceBundle, sourceBundleHash, sourceCore, sourceCoreHash,
    binaryHash: fileDigest(binary), bundleHash: bundleDigest(bundle), coreHash: fileDigest(coreBinary), defaultSocket, defaultSocketIdentity, defaultCoreBinary, defaultCoreHash, env };
  ledger.update(l => { l.appHome = appHome; });
  writeFileSync(proof, JSON.stringify(owned, null, 2) + '\n', { mode: 0o600 });
  verifyNativeAppSources(owned);
  return owned;
}

export function validateNativeAppOwnership(binary: string, env: Readonly<NodeJS.ProcessEnv>): NativeAppOwnership {
  return checkNativeOwnership(binary, env, false);
}
function checkNativeOwnership(binary: string, env: Readonly<NodeJS.ProcessEnv>, sourceOnly: boolean): NativeAppOwnership {
  if (nativeInheritedScopeKeys.some(key => env[key] !== undefined)) throw new AppBoundaryError('isolation-unproved', 'inherited native scope is forbidden');
  if (binary.startsWith('/Applications/')) throw new AppBoundaryError('isolation-unproved', 'refusing an original application executable');
  const proofPath = env.SPIDER_HERDR_E2E_APP_OWNERSHIP;
  if (!proofPath || !existsSync(proofPath)) throw new AppBoundaryError('isolation-unproved', 'native app ownership proof is required');
  const value = parseNativeOwnership(readFileSync(proofPath, 'utf8'));
  ownedPath(scratchRoot(), value.root);
  nativeLaunchEnvironment(value.root, value.env, value.appId);
  if (value.ledgerPath !== join(dirname(value.root), '_ledgers', `${value.root.split('/').at(-1)}.json`)) throw new AppBoundaryError('isolation-unproved', 'invalid native ledger path');
  if (ownedPath(value.root, proofPath) !== proofPath || lstatSync(proofPath).uid !== process.getuid?.()) throw new AppBoundaryError('isolation-unproved', 'invalid native ownership proof');
  for (const file of [value.binary, value.bundle, value.coreBinary, value.appHome, value.env.TMPDIR]) ownedPath(value.root, file);
  if (ownedPath(value.root, binary) !== value.binary || realpathSync(binary) !== binary) throw new AppBoundaryError('isolation-unproved', 'executable does not match owned bundle');
  const ledger = JSON.parse(readFileSync(value.ledgerPath, 'utf8')) as { root: string; state: string; appHome?: string };
  if (ledger.root !== value.root || !(ledger.state === 'open' || (sourceOnly && ledger.state === 'closed')) || ledger.appHome !== value.appHome) throw new AppBoundaryError('isolation-unproved', 'native ledger ownership is missing');
  if (env.HERDR_APP_HOME !== value.appHome) throw new AppBoundaryError('isolation-unproved', 'native app home mismatch');
  if (env.HC_SESSION !== value.namespace || value.namespace === 'default' || env.HC_SOCKET !== value.env.HC_SOCKET) throw new AppBoundaryError('isolation-unproved', 'native core namespace mismatch');
  assertSocketPath(value.root, String(env.HC_SOCKET));
  for (const key of ['HERDR_APP_ID', 'HERDR_RELEASES_URL', 'HERDR_TELEMETRY', 'TMPDIR', 'HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']) if (env[key] !== value.env[key]) throw new AppBoundaryError('isolation-unproved', `native environment mismatch for ${key}`);
  if (value.appId === 'dev.herdr.app' || value.env.HERDR_RELEASES_URL !== 'http://127.0.0.1:1' || value.env.HERDR_TELEMETRY !== '0') throw new AppBoundaryError('isolation-unproved', 'native updates or identity are not isolated');
  if (bundleDigest(value.bundle) !== value.bundleHash) throw new AppBoundaryError('isolation-unproved', 'owned bundle digest mismatch');
  if (fileDigest(value.binary) !== value.binaryHash) throw new AppBoundaryError('isolation-unproved', 'owned app digest mismatch');
  if (fileDigest(value.coreBinary) !== value.coreHash) throw new AppBoundaryError('isolation-unproved', 'owned core digest mismatch');
  const settings = appObject(JSON.parse(readFileSync(ownedPath(value.root, join(value.appHome, 'settings.json')), 'utf8')));
  if (settings.core !== value.coreBinary) throw new AppBoundaryError('isolation-unproved', 'copied core is not pinned');
  return value;
}

export function readNativeAppOwnership(binary: string): NativeAppOwnership {
  if (binary.startsWith('/Applications/')) throw new AppBoundaryError('isolation-unproved', 'refusing an original application executable');
  const root = dirname(dirname(dirname(dirname(resolve(binary)))));
  const proof = ownedPath(scratchRoot(), join(root, 'native-ownership.json'));
  if (!existsSync(proof)) throw new AppBoundaryError('isolation-unproved', 'native ownership proof is missing');
  const value = parseNativeOwnership(readFileSync(proof, 'utf8'));
  return checkNativeOwnership(binary, value.env, true);
}

export function verifyNativeAppSources(owned: NativeAppOwnership): void {
  if (bundleDigest(owned.sourceBundle) !== owned.sourceBundleHash || fileDigest(owned.sourceCore) !== owned.sourceCoreHash) throw new AppBoundaryError('isolation-unproved', 'native source digest changed');
  if ((owned.defaultCoreBinary ? fileDigest(owned.defaultCoreBinary) : null) !== owned.defaultCoreHash) throw new AppBoundaryError('isolation-unproved', 'default core binary digest changed');
  if (socketIdentity(owned.defaultSocket) !== owned.defaultSocketIdentity) throw new AppBoundaryError('isolation-unproved', 'default core socket changed');
}
export interface NativeLaunchOptions {
  invoke: AppInvoke; ledger: LedgerHandle;
  frontmost?(): Promise<string>;
  ready?(): Promise<boolean>;
  observe?(): Promise<{ pid: number; bundlePath: string; appId: string } | null>;
}
export async function frontmostApp(invoke: AppInvoke, env: Readonly<NodeJS.ProcessEnv>): Promise<string> {
  const result = await successful(invoke, '/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier);'], env);
  if (!result.stdout.trim()) throw new AppBoundaryError('isolation-unproved', 'frontmost application is unavailable');
  return result.stdout.trim();
}
async function observeNativeApp(owned: NativeAppOwnership, invoke: AppInvoke): Promise<{ pid: number; bundlePath: string; appId: string } | null> {
  const script = `ObjC.import("AppKit"); const apps=$.NSWorkspace.sharedWorkspace.runningApplications; let result=null; for(let i=0;i<apps.count;i++){const a=apps.objectAtIndex(i); const path=ObjC.unwrap(a.bundleURL.path); if(path===${JSON.stringify(owned.bundle)}) result={pid:Number(a.processIdentifier),bundlePath:path,appId:ObjC.unwrap(a.bundleIdentifier)};} JSON.stringify(result);`;
  const result = await successful(invoke, '/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], owned.env);
  return JSON.parse(result.stdout) as { pid: number; bundlePath: string; appId: string } | null;
}
export async function launchNativeApp(owned: NativeAppOwnership, options: NativeLaunchOptions): Promise<{ before: string; after: string; pid: number }> {
  validateNativeAppOwnership(owned.binary, owned.env);
  verifyNativeAppSources(owned);
  const frontmost = options.frontmost ?? (() => frontmostApp(options.invoke, owned.env));
  const before = await frontmost();
  if (!before || before === owned.appId) throw new AppBoundaryError('isolation-unproved', 'frontmost identity is not an independent application');
  const argv = ['-g', '-n', ...Object.entries(owned.env).flatMap(([key, value]) => ['--env', `${key}=${value}`]), owned.bundle];
  await successful(options.invoke, '/usr/bin/open', argv, owned.env);
  const application = await waitFor('owned native application', options.observe ?? (() => observeNativeApp(owned, options.invoke)), value => Boolean(value), deadline(15_000));
  if (!application || application.bundlePath !== owned.bundle || application.appId !== owned.appId) throw new AppBoundaryError('isolation-unproved', 'native application identity mismatch');
  const { identityOf } = await import('./resources.js');
  const identity = identityOf(application.pid);
  options.ledger.update(l => { l.processes.push({ ...identity, label: 'native-app', group: false, startsCores: true }); });
  const ready = options.ready ?? (async () => {
    const socket = ownedPath(owned.root, join(owned.appHome, 'herdr-app.sock'));
    return existsSync(socket) && lstatSync(socket).isSocket() && lstatSync(socket).uid === process.getuid?.();
  });
  await waitFor('owned native app IPC', ready, Boolean, deadline(15_000));
  const after = await frontmost();
  if (after !== before) throw new AppBoundaryError('isolation-unproved', 'frontmost application changed');
  verifyNativeAppSources(owned);
  return { before, after, pid: application.pid };
}

/** A copied command-only checker never opens a native window. */
async function prepareNativeChecker(options: NativeAppOptions): Promise<{ binary: string; env: Record<string, string> }> {
  const root = dirname(String(options.env.TMPDIR));
  ownedPath(scratchRoot(), root);
  const input = Object.fromEntries(Object.entries(options.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]));
  const env = nativeLaunchEnvironment(root, input, `dev.spider.check.${basenameForIdentity(root)}`);
  const binary = options.ownPath(ownedPath(root, join(root, 'native-check')));
  const source = realpathSync(options.binary), sourceHash = fileDigest(source);
  const proof = options.ownPath(join(root, 'native-check.json'));
  if (!existsSync(binary)) {
    copyFileSync(source, binary); chmodSync(binary, 0o700);
    if (process.platform === 'darwin') await successful(options.invoke, '/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', `dev.spider.check.${basenameForIdentity(root)}`, binary], options.env);
    writeFileSync(proof, JSON.stringify({ source, sourceHash, outputHash: fileDigest(binary) }) + '\n', { mode: 0o600 });
  }
  if (!existsSync(proof)) throw new AppBoundaryError('isolation-unproved', 'owned checker proof is missing');
  const recorded = appObject(JSON.parse(readFileSync(proof, 'utf8')));
  if (recorded.source !== source || recorded.sourceHash !== sourceHash || recorded.outputHash !== fileDigest(binary)) throw new AppBoundaryError('isolation-unproved', 'owned checker digest mismatch');
  const sourceCore = options.sourceCore ?? join(dirname(options.binary), 'herdr-core'), core = options.ownPath(join(root, 'checker-core'));
  if (!existsSync(core)) { copyFileSync(sourceCore, core); chmodSync(core, 0o700); }
  if (fileDigest(core) !== fileDigest(sourceCore)) throw new AppBoundaryError('isolation-unproved', 'owned checker core digest mismatch');
  const settings = options.ownPath(join(ownedPath(root, env.HERDR_APP_HOME), 'settings.json'));
  const previous = existsSync(settings) ? appObject(JSON.parse(readFileSync(settings, 'utf8'))) : {};
  writeFileSync(settings, JSON.stringify({ ...previous, core }) + '\n', { mode: 0o600 });
  return { binary, env };
}
function basenameForIdentity(root: string): string { return root.split('/').at(-1)!.replace(/[^a-zA-Z0-9-]/g, '-'); }
