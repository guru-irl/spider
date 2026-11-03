// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { isAbsolute, join, win32 } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { configSocket } from './socket-config.js';
import type { CoreIdentity, CoreId, TerminalAddress, TerminalSummary, ProgramState, ProgramStatus } from '../contracts.js';
export class HerdrError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) { super(message); this.name = 'HerdrError'; }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HerdrError('invalid-reply', 'Expected an object');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) throw new HerdrError('invalid-reply', 'Expected a nonempty string');
  return value;
}
export function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new HerdrError('invalid-reply', 'Expected an integer');
  return value;
}
export function nullableInteger(value: unknown): number | null { return value === null ? null : integer(value); }
export function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HerdrError('invalid-reply', 'Expected valid UTF-8 JSON'); }
}
export function selectedSocket(env: Readonly<NodeJS.ProcessEnv>, runtime: { uid?: number; isDirectory?: (path: string) => boolean } = {}): string {
  if (env.HC_SOCKET) return env.HC_SOCKET;
  const windows = process.platform === 'win32';
  const pathJoin = windows ? win32.join : join;
  const home = windows ? env.USERPROFILE ?? 'C:\\' : env.HOME ?? '/';
  const configHome = env.XDG_CONFIG_HOME || (windows ? env.APPDATA || pathJoin(home, 'AppData', 'Roaming') : join(home, '.config'));
  let configured: string | undefined;
  try { configured = configSocket(readFileSync(pathJoin(configHome, 'herdr-core', 'config.toml'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new HerdrError('invalid-config', 'Cannot resolve the Herdr core socket from config', { cause: String(error) }); }
  if (configured !== undefined) return configured;
  const namespace = env.HC_SESSION?.trim() || 'default';
  if (namespace === '.' || namespace === '..' || /[\x00-\x1f\x7f/\\:*?"<>|]/.test(namespace)) throw new HerdrError('invalid-config', 'Invalid HC_SESSION');
  if (windows) return win32.join('\\\\.\\pipe\\', `herdr-core-${(env.USERNAME || '').replace(/[^A-Za-z0-9]/g, '')}-${namespace}.sock`);
  let run = env.XDG_RUNTIME_DIR;
  if (!run) {
    const uid = runtime.uid ?? process.getuid?.();
    const candidate = uid === undefined ? undefined : `/run/user/${uid}`;
    const isDirectory = runtime.isDirectory ?? ((path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } });
    if (candidate && isDirectory(candidate)) run = candidate;
  }
  if (run) return join(run, 'herdr-core', `${namespace}.sock`);
  const root = env.XDG_STATE_HOME || join(home, '.local/state');
  return join(root, 'herdr-core', namespace, `${namespace}.sock`);
}
export function parseCore(value: unknown, env: Readonly<NodeJS.ProcessEnv>): CoreIdentity {
  const reply = object(value); const core = object(reply.core);
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(text(reply.version));
  if (!match || (Number(match[1]) === 0 && (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 16)))) throw new HerdrError('unsupported-version', 'hc 0.1.16 or newer is required');
  return { coreId: text(core.id) as CoreId, socket: selectedSocket(env), sessionNamespace: env.HC_SESSION || 'default' };
}
export function parseProgramStatus(value: unknown): ProgramStatus | null {
  if (value === null) return null;
  const status = object(value);
  if (!['idle', 'working', 'blocked', 'done', 'error'].includes(String(status.state))) throw new HerdrError('invalid-reply', 'Invalid program status');
  if (status.msg !== undefined && typeof status.msg !== 'string') throw new HerdrError('invalid-reply', 'Invalid status message');
  return { ...status, state: status.state as ProgramState };
}
export function parseTerminal(value: unknown): TerminalSummary {
  const t = object(value); const labels = object(t.labels);
  for (const v of Object.values(labels)) if (typeof v !== 'string') throw new HerdrError('invalid-reply', 'Invalid terminal label');
  if (t.state !== 'live' && t.state !== 'finished') throw new HerdrError('invalid-reply', 'Invalid terminal state');
  const dimension = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535 ? value : undefined;
  return { address: text(t.address) as TerminalAddress, parent: nullableText(t.parent) as TerminalAddress | null,
    labels: labels as Record<string, string>, state: t.state, status: parseProgramStatus(t.status), exitCode: nullableInteger(t.exit_code),
    reason: nullableText(t.reason), signal: nullableInteger(t.signal), finishedAt: nullableInteger(t.finished_ms),
    ...(typeof t.notify === 'boolean' ? { notify: t.notify } : {}),
    ...(dimension(t.cols) === undefined ? {} : { cols: dimension(t.cols) }), ...(dimension(t.rows) === undefined ? {} : { rows: dimension(t.rows) }) };
}
export function absolutePath(value: unknown): string {
  const path = text(value); if (!isAbsolute(path)) throw new HerdrError('invalid-config', 'Configured path must be absolute'); return path;
}
