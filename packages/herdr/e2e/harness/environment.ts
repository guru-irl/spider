// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// Owned paths, socket fences and the allowlisted environment for every e2e subprocess.
import { mkdir, writeFile } from 'node:fs/promises';
import { lstatSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export type OwnedPath = string & { readonly __ownedPath: unique symbol };
export type StoryId = string & { readonly __storyId: unique symbol };
export const SOCKET_PATH_LIMIT = 103;

export class HarnessError extends Error {
  readonly code: string; readonly details: unknown;
  constructor(code: string, message: string, details?: unknown) { super(`${code}: ${message}`); this.code = code; this.details = details; this.name = 'HarnessError'; }
}

/** The execution checkout: packages/herdr/e2e/harness → four levels up. */
export function checkoutRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'); }
export function scratchRoot(): string { return join(checkoutRoot(), '.spider', 'scratch'); }
/** Ledgers and cleanup proofs live beside fixture roots, never inside them, so they survive fixture deletion. */
export function ledgerDirectory(): string { return join(scratchRoot(), 'e2', '_ledgers'); }

function physical(path: string): string {
  const tail: string[] = []; let parent = resolve(path);
  while (!existsSync(parent) && dirname(parent) !== parent) { tail.unshift(parent.slice(dirname(parent).length + 1)); parent = dirname(parent); }
  return join(realpathSync(parent), ...tail);
}
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

/** A path is owned only if it is strictly inside root and no existing component below root is a symlink. */
export function ownedPath(root: string, candidate: string): OwnedPath {
  const base = resolve(root), path = resolve(candidate);
  if (!inside(base, path)) throw new HarnessError('outside-owned-root', `${path} is not inside ${base}`);
  if (physical(base) !== base && realpathSync(base) !== base) throw new HarnessError('symlink', `owned root ${base} is not a physical path`);
  let current = base;
  for (const part of relative(base, path).split(sep)) {
    current = join(current, part);
    let stat; try { stat = lstatSync(current); } catch { break; }
    if (stat.isSymbolicLink()) throw new HarnessError('symlink', `${current} is a symlink`);
  }
  return path as OwnedPath;
}

export async function createFixtureRoot(): Promise<OwnedPath> {
  const parent = join(scratchRoot(), 'e2');
  await mkdir(parent, { recursive: true });
  for (let tries = 0; tries < 64; tries++) {
    const id = Array.from(randomBytes(5), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
    const path = join(parent, id);
    try { await mkdir(path, { mode: 0o700 }); return ownedPath(parent, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  throw new HarnessError('fixture-collision', 'no free fixture directory');
}

export function defaultCoreSocket(): string { return join(userInfo().homedir, '.local/state/herdr-core/default/default.sock'); }
/** hc 0.1.16 budgets its holder socket as `<name>.holder.<pid>.sock` with a 10-digit pid. */
export function holderSocket(primary: string): string { return primary.replace(/\.sock$/, '.holder.4294967295.sock'); }

/** Containment, symlink, default-socket and byte-length checks, including hc's holder-socket suffix. */
export function assertSocketPath(root: string, socket: string): OwnedPath {
  if (resolve(socket) === defaultCoreSocket()) throw new HarnessError('default-socket', 'refusing the default hc socket');
  const path = ownedPath(root, socket);
  for (const candidate of [path, holderSocket(path)])
    if (Buffer.byteLength(candidate, 'utf8') > SOCKET_PATH_LIMIT) throw new HarnessError('socket-path-too-long', `${candidate} exceeds ${SOCKET_PATH_LIMIT} bytes; use a shorter checkout path`);
  return path;
}

export interface FencedDirectories {
  HOME: string; TMPDIR: string; PI_CODING_AGENT_DIR: string; PI_CODING_AGENT_SESSION_DIR: string; SPIDER_GLOBAL_ROOT: string;
  HERDR_APP_HOME: string; XDG_STATE_HOME: string; XDG_CONFIG_HOME: string;
}
export function fencedDirectories(root: string): FencedDirectories {
  return { HOME: join(root, 'h'), TMPDIR: join(root, 't'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_CODING_AGENT_SESSION_DIR: join(root, 'sessions'),
    SPIDER_GLOBAL_ROOT: join(root, 'g'), HERDR_APP_HOME: join(root, 'a'), XDG_STATE_HOME: join(root, 'x'), XDG_CONFIG_HOME: join(root, 'c') };
}
export async function createFencedDirectories(root: string): Promise<FencedDirectories> {
  const dirs = fencedDirectories(root);
  for (const path of Object.values(dirs)) await mkdir(ownedPath(root, path), { recursive: true, mode: 0o700 });
  return dirs;
}

const INHERITED = ['LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', '__CF_USER_TEXT_ENCODING'] as const;
/** Never present in a fixture subprocess, even when a caller asks for it. */
const FORBIDDEN = /^(VITEST|TEST$|NODE_ENV$|NODE_OPTIONS$|PI_SUBAGENT_|PI_SPIDER_|PI_SESSION_|SSH_|GIT_SSH|SPIDER_HERDR_APP_TESTS$|SPIDER_HERDR_TEST_DISPLAY_UUID$|SPIDER_HERDR_SSH_BYPASS$|XDG_RUNTIME_DIR$|.*_API_KEY$|.*_TOKEN$)/;

export interface EnvironmentOptions { binDirectory: string; extra?: Readonly<Record<string, string>> }

/** Builds a subprocess environment from an allowlist; inherited input contributes only locale and user identity. */
export function buildEnvironment(source: Readonly<NodeJS.ProcessEnv>, fenced: FencedDirectories, options: EnvironmentOptions): Record<string, string> {
  const root = dirname(fenced.TMPDIR);
  const env: Record<string, string> = {};
  for (const key of INHERITED) { const value = source[key]; if (value !== undefined) env[key] = value; }
  for (const [key, value] of Object.entries(fenced)) env[key] = ownedPath(root, value);
  const bin = ownedPath(root, options.binDirectory);
  env.PATH = [bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  env.TERM = 'xterm-256color';
  env.PI_OFFLINE = '1'; env.PI_SKIP_VERSION_CHECK = '1'; env.PI_TELEMETRY = '0';
  env.SPIDER_TEST_FIXTURE_CHECKOUT = checkoutRoot();
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (FORBIDDEN.test(key)) throw new HarnessError('forbidden-variable', `${key} may not be set in a fixture subprocess`);
    env[key] = value;
  }
  for (const key of Object.keys(env)) if (FORBIDDEN.test(key)) throw new HarnessError('forbidden-variable', key);
  return env;
}

export async function writeJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode });
}
