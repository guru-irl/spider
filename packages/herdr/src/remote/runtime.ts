// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { spawn, execFileSync } from 'node:child_process';
import { writeFile, appendFile, rename, mkdir, open, lstat, readdir, rm } from 'node:fs/promises';
import { constants as fileFlags } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, relative, sep, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';

export const RAW_CHUNK_BYTES: number = 48 * 1024;
export type PayloadStream = 'stdout' | 'stderr';
export interface RuntimeRequest {
  version: 1; jobId: string; nonce: string; programNonce: string; argv: readonly string[]; cwd: string | null; consoleDirectory?: string;
  env: Readonly<NodeJS.ProcessEnv>; files: readonly { path: string; sha256: string }[]; releaseWindowMs: number;
}
export interface RemoteChunk { file: string; stream: PayloadStream; offset: number; bytes: number; sha256: string }
export interface RemoteChunkPageRef { file: string; sha256: string; stdoutBytes: number; stderrBytes: number }
export interface RemoteChunkIndex { version: 1; jobId: string; nonce: string; head: RemoteChunkPageRef | null; chunks: readonly RemoteChunk[] }
export interface RuntimeReceipt {
  version: 1; jobId: string; nonce: string; requestSha256: string; indexSha256: string;
  outcome: 'exited' | 'signal' | 'spawn-error' | 'release-timeout' | 'cancelled';
  exitCode: number | null; signal: string | null; signalHint?: string; finishedAt: number; stdoutBytes: number; stderrBytes: number; error?: string;
}
export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
/** A shell may encode a signal as 128 + N; this is a hint, not proof of a signal. */
export function signalHint(exitCode: number | null): string | undefined {
  if (exitCode === null || exitCode <= 128) return;
  return Object.entries(constants.signals).find(([, value]) => value === exitCode - 128)?.[0];
}
function groupIdentities(pgid: number): Map<number, string> {
  const output = execFileSync('ps', ['-eo', 'pid=,pgid=,lstart='], { encoding: 'utf8', timeout: 2000 });
  const members = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match && Number(match[2]) === pgid) members.set(Number(match[1]), match[3]);
  }
  return members;
}
export class RemoteRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export function encodeRuntimePublication(value: Readonly<Record<string, unknown>>): Buffer {
  const body = JSON.stringify(value); return Buffer.from(JSON.stringify({ body, sha256: sha256(body) }));
}
export function parseRuntimePublication(bytes: Buffer): Record<string, unknown> {
  const envelope = record(JSON.parse(bytes.toString()));
  if (typeof envelope.body !== 'string' || envelope.sha256 !== sha256(envelope.body)) throw new RemoteRuntimeError('runtime-publication-incomplete', 'Publication checksum does not match');
  return record(JSON.parse(envelope.body));
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RemoteRuntimeError('runtime-request-invalid', 'Expected an object');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
export async function readBoundedFile(path: string, maxBytes: number = 1024 * 1024): Promise<Buffer> {
  const file = await open(path, fileFlags.O_RDONLY | (fileFlags.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new RemoteRuntimeError('runtime-file-invalid', 'Expected a bounded regular file');
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > stat.size || bytesRead > maxBytes) throw new RemoteRuntimeError('runtime-file-invalid', 'File grew beyond its bound');
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}
export async function atomicRuntimeFile(path: string, bytes: Buffer | string): Promise<void> {
  const staging = `${path}.${randomUUID()}.new`;
  const file = await open(staging, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await rename(staging, path);
  if (process.platform !== 'win32') { const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
}
export function parseRuntimeRequest(value: unknown, directory: string): RuntimeRequest {
  const v = record(value);
  if (v.version !== 1 || !identifier(v.jobId) || !identifier(v.nonce) || v.nonce.length < 16 || typeof v.programNonce !== 'string' || !/^[a-f0-9]{32}$/.test(v.programNonce) || !Array.isArray(v.argv) || v.argv.length === 0 || !v.argv.every(a => typeof a === 'string' && !a.includes('\0')) || (v.cwd !== null && (typeof v.cwd !== 'string' || !isAbsolute(v.cwd))) || typeof v.releaseWindowMs !== 'number' || !Number.isFinite(v.releaseWindowMs) || v.releaseWindowMs <= 0) {
    throw new RemoteRuntimeError('runtime-request-invalid', 'Invalid runtime request');
  }
  const env = record(v.env); const safeEnv: NodeJS.ProcessEnv = {};
  const allowed = new Set(['LANG', 'LC_ALL', 'LC_CTYPE', 'PYTHONUNBUFFERED', 'PYTHONUTF8', 'PYTHONDONTWRITEBYTECODE', 'NO_COLOR', 'TERM']);
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') throw new RemoteRuntimeError('runtime-request-invalid', 'Invalid environment value');
    if (allowed.has(key)) safeEnv[key] = value;
  }
  if (!Array.isArray(v.files)) throw new RemoteRuntimeError('runtime-request-invalid', 'Invalid uploaded files');
  const files = v.files.map(file => {
    const f = record(file);
    if (typeof f.path !== 'string' || !isAbsolute(f.path) || (relative(directory, f.path) === '..' || relative(directory, f.path).startsWith('..' + sep) || isAbsolute(relative(directory, f.path))) || f.path === directory || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new RemoteRuntimeError('runtime-request-invalid', 'Invalid source digest or path');
    return { path: f.path, sha256: f.sha256 };
  });
  if (v.consoleDirectory !== undefined && (typeof v.consoleDirectory !== 'string' || !isAbsolute(v.consoleDirectory) || dirname(resolve(v.consoleDirectory)) !== join(dirname(directory), '.consoles'))) throw new RemoteRuntimeError('runtime-console-invalid', 'Console directory must belong to the runtime root');
  return { version: 1, jobId: v.jobId, nonce: v.nonce, programNonce: v.programNonce, argv: v.argv, cwd: v.cwd as string | null, env: safeEnv, files, releaseWindowMs: Math.min(v.releaseWindowMs, 10000), ...(typeof v.consoleDirectory === 'string' ? { consoleDirectory: v.consoleDirectory } : {}) };
}
/** Never copy the local PATH. Inherit the destination's environment and remove transport capabilities. */
export function destinationEnvironment(inherited: Readonly<NodeJS.ProcessEnv>, overrides: Readonly<NodeJS.ProcessEnv>, tmpDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, ...overrides, TMPDIR: tmpDir };
  for (const key of Object.keys(env)) {
    if (/^SPIDER_HERDR_(SSH_BYPASS|ADMIN|LEASE|TRANSPORT|DELEGAT|JOB_)/.test(key) || /^BASH_FUNC_/.test(key) || key.startsWith('PI_SUBAGENT_') || key.startsWith('PI_SPIDER_')) delete env[key];
  }
  return env;
}

export interface RuntimeDirectoryProbe { directory: string; uid: number; mode: number; nodeVersion: string; nodePath: string }
export async function probeRuntimeDirectory(directory: string): Promise<RuntimeDirectoryProbe> {
  if (!isAbsolute(directory)) throw new RemoteRuntimeError('runtime-root-invalid', 'Runtime root must be absolute');
  const stat = await lstat(directory);
  if (!stat.isDirectory()) throw new RemoteRuntimeError('runtime-root-invalid', 'Runtime root must be a real directory, not a symlink');
  if (!process.getuid || stat.uid !== process.getuid()) throw new RemoteRuntimeError('runtime-root-owner', 'Runtime root must belong to the destination user');
  if ((stat.mode & 0o777) !== 0o700) throw new RemoteRuntimeError('runtime-root-unprivate', 'Runtime root must have mode 0700');
  return { directory, uid: stat.uid, mode: stat.mode & 0o777, nodeVersion: process.version, nodePath: process.execPath };
}
export async function installRuntimeDirectory(directory: string): Promise<RuntimeDirectoryProbe> {
  if (!isAbsolute(directory)) throw new RemoteRuntimeError('runtime-root-invalid', 'Runtime root must be absolute');
  await mkdir(directory, { recursive: true, mode: 0o700 }); return probeRuntimeDirectory(directory);
}
export async function verifyProgramMarker(directory: string, nonce: string): Promise<void> {
  const marker = await readBoundedFile(join(directory, '.spider-program'), 128);
  if (!/^[a-f0-9]{32}$/.test(nonce) || marker.toString() !== nonce) throw new RemoteRuntimeError('program-marker-mismatch', 'Program owner marker does not match its request');
}
async function liveConsoleHold(jobDirectory: string, root: string): Promise<boolean> {
  try {
    const hold = record(JSON.parse((await readBoundedFile(join(jobDirectory, '.spider-console-hold'), 4096)).toString()));
    const now = Date.now();
    if (hold.version !== 1 || typeof hold.createdAt !== 'number' || !Number.isFinite(hold.createdAt) || hold.createdAt > now + 60000 || now - hold.createdAt > 24 * 60 * 60 * 1000 || typeof hold.consoleDirectory !== 'string' || !isAbsolute(hold.consoleDirectory) || dirname(resolve(hold.consoleDirectory)) !== join(root, '.consoles')) return false;
    if (!(await lstat(join(root, '.consoles'))).isDirectory() || !(await lstat(hold.consoleDirectory)).isDirectory()) return false;
    const heartbeat = record(JSON.parse((await readBoundedFile(join(hold.consoleDirectory, 'heartbeat.json'), 1024)).toString()));
    return heartbeat.version === 1 && typeof heartbeat.at === 'number' && Number.isFinite(heartbeat.at) && heartbeat.at <= now + 60000 && now - heartbeat.at <= 2 * 60 * 1000;
  } catch { return false; } // A stopped console cannot retain a directory indefinitely.
}
async function releaseConsoleHold(jobDirectory: string, consoleDirectory: string): Promise<void> {
  try {
    const path = join(jobDirectory, '.spider-console-hold');
    const hold = record(JSON.parse((await readBoundedFile(path, 4096)).toString()));
    if (hold.version === 1 && hold.consoleDirectory === consoleDirectory) await rm(path, { force: true });
  } catch { /* Missing holds need no release; failed releases still expire. */ }
}
export async function pruneSettledPrograms(directory: string, activeDirectory?: string): Promise<string[]> {
  await probeRuntimeDirectory(directory);
  const pruned: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(directory, entry.name); if (child === activeDirectory) continue;
    try {
      if (!(await lstat(child)).isDirectory() || !(await lstat(join(child, '.spider-settled'))).isFile()) continue;
      if (await liveConsoleHold(child, directory)) continue;
      await rm(child, { recursive: true, force: true }); pruned.push(child);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return pruned.sort();
}

export async function runRemoteRuntime(requestFile: string): Promise<number> {
  const startedAt = performance.now();
  const directory = dirname(requestFile);
  const requestBytes = await readBoundedFile(requestFile);
  const requestSha256 = sha256(requestBytes);
  const request = parseRuntimeRequest(JSON.parse(requestBytes.toString()), directory);
  const tmpDir = join(directory, 'tmp');
  const index: { version: 1; jobId: string; nonce: string; head: RemoteChunkPageRef | null; chunks: RemoteChunk[] } = { version: 1, jobId: request.jobId, nonce: request.nonce, head: null, chunks: [] };
  let chunkCount = 0, pageCount = 0;
  const offsets = { stdout: 0, stderr: 0 };
  let indexBytes = JSON.stringify(index);
  let indexPublished = false;
  const initializedLogs = new Set<PayloadStream>();
  const receipt = async (outcome: RuntimeReceipt['outcome'], exitCode: number | null, signal: string | null, error?: string) => {
    if (!indexPublished) {
      // hc creates the job folder with the destination umask, even when the root is private.
      const jobDirectory = await lstat(directory);
      if (!jobDirectory.isDirectory() || !process.getuid || jobDirectory.uid !== process.getuid())
        throw new RemoteRuntimeError('runtime-job-invalid', 'Job folder must be a real directory owned by the destination user');
      await atomicRuntimeFile(join(directory, 'index.json'), indexBytes); indexPublished = true;
    }
    for (const stream of initializedLogs) { const file = await open(join(directory, stream + '.log'), 'r+'); try { await file.sync(); } finally { await file.close(); } }
    const hint = outcome === 'exited' ? signalHint(exitCode) : undefined;
    const result: RuntimeReceipt = { version: 1, jobId: request.jobId, nonce: request.nonce, requestSha256, indexSha256: sha256(indexBytes), outcome, exitCode, signal, ...(hint ? { signalHint: hint } : {}), finishedAt: Date.now(), stdoutBytes: offsets.stdout, stderrBytes: offsets.stderr, ...(error ? { error } : {}) };
    const bytes = JSON.stringify(result); await atomicRuntimeFile(join(directory, 'receipt.json'), bytes); await atomicRuntimeFile(join(directory, 'receipt.json.sha256'), sha256(bytes));
  };
  let child: ReturnType<typeof spawn> | undefined;
  let rootProbeFailed = false;
  let cancellation: NodeJS.Signals | null = null;
  let explicitCancel = false, checkingCancel = false;
  let cancelWatcher: ReturnType<typeof setInterval> | undefined;
  let cancelEscalation: Promise<void> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const forward = (signal: NodeJS.Signals) => {
    cancellation = signal;
    if (child?.pid) {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch { /* already exited */ }
      if (!escalation) { escalation = setTimeout(() => { if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} } }, 1500); escalation.unref(); }
    }
  };
  const handlers = { SIGHUP: () => forward('SIGHUP'), SIGINT: () => forward('SIGINT'), SIGTERM: () => forward('SIGTERM') };
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  const removeHandlers = () => { for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler); if (escalation) clearTimeout(escalation); if (cancelWatcher) clearInterval(cancelWatcher); };
  const terminate = (signal: NodeJS.Signals): number => {
    removeHandlers(); process.kill(process.pid, signal);
    return 128 + (constants.signals[signal] ?? 0);
  };
  const verifyInputs = async () => {
    await verifyProgramMarker(directory, request.programNonce);
    for (const file of request.files) if (sha256(await readBoundedFile(file.path)) !== file.sha256) throw new RemoteRuntimeError('source-digest-mismatch', 'Uploaded source digest does not match');
  };
  try {
    if ((await readBoundedFile(requestFile + '.sha256', 128)).toString().trim() !== requestSha256) throw new RemoteRuntimeError('request-digest-mismatch', 'Request digest does not match');
    try { await probeRuntimeDirectory(dirname(directory)); }
    catch (error) { rootProbeFailed = true; throw error; }
    if (request.consoleDirectory) await atomicRuntimeFile(join(directory, '.spider-console-hold'), JSON.stringify({ version: 1, jobId: request.jobId, consoleDirectory: request.consoleDirectory, createdAt: Date.now() }));
    await mkdir(tmpDir, { mode: 0o700, recursive: true });
    for (const stream of ['stdout', 'stderr'] as const) {
      await writeFile(join(directory, stream + '.log'), '', { mode: 0o600, flag: 'wx' }); initializedLogs.add(stream);
    }
    await atomicRuntimeFile(join(directory, 'index.json'), indexBytes); indexPublished = true;
    await atomicRuntimeFile(join(directory, 'capabilities.json'), JSON.stringify({ version: 1, jobId: request.jobId, nonce: request.nonce, cancelAfterRelease: true }));
    await verifyInputs();
    await pruneSettledPrograms(dirname(directory), directory);
    try { await lstat(join(directory, '.spider-settled')); throw new RemoteRuntimeError('program-already-settled', 'A settled program cannot run again'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    process.stdout.write(`SPIDER_HERDR_READY ${request.nonce}\n`);
    const deadline = startedAt + request.releaseWindowMs;
    let released = false;
    while (!released) {
      if (cancellation) { await receipt('signal', null, cancellation); return terminate(cancellation); }
      if (performance.now() >= deadline) { await receipt('release-timeout', null, null); return 124; }
      try {
        const cancel = record(JSON.parse((await readBoundedFile(join(directory, 'cancel.json'), 1024)).toString()));
        if (cancel.nonce === request.nonce && cancel.jobId === request.jobId) { await receipt('cancelled', 137, null); return 137; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)
          && !(error instanceof RemoteRuntimeError && ['runtime-file-invalid', 'runtime-request-invalid'].includes(error.code))) throw error;
      }
      try {
        const release = record(JSON.parse((await readBoundedFile(join(directory, 'release.json'), 1024)).toString()));
        released = release.version === 1 && release.jobId === request.jobId && release.nonce === request.nonce && release.requestSha256 === requestSha256;
      } catch (error) {
        // hc file write publishes in place. Only this release poll may retry a torn publication.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)
          && !(error instanceof RemoteRuntimeError && ['runtime-file-invalid', 'runtime-request-invalid'].includes(error.code))) throw error;
      }
      if (!released) await delay(25);
    }
    await verifyInputs();
    if (cancellation) { await receipt('signal', null, cancellation); return terminate(cancellation); }
    if (performance.now() >= deadline) { await receipt('release-timeout', null, null); return 124; }
    child = spawn(request.argv[0], [...request.argv.slice(1)], { cwd: request.cwd ?? undefined, env: destinationEnvironment(process.env, request.env, tmpDir), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    cancelWatcher = setInterval(() => {
      if (checkingCancel || explicitCancel || !child?.pid) return;
      checkingCancel = true;
      void (async () => {
        try {
          const cancel = record(JSON.parse((await readBoundedFile(join(directory, 'cancel.json'), 1024)).toString()));
          if (cancel.nonce !== request.nonce || cancel.jobId !== request.jobId || !child?.pid || child.exitCode !== null || child.signalCode !== null) return;
          const pid = child.pid;
          const original = process.platform === 'win32' ? new Map([[pid, 'windows']]) : groupIdentities(pid);
          if (!original.has(pid)) return;
          explicitCancel = true;
          try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM'); } catch { /* Already exited. */ }
          cancelEscalation = new Promise(resolve => setTimeout(() => {
            try {
              const current = process.platform === 'win32' ? new Map([[pid, 'windows']]) : groupIdentities(pid);
              if ([...original].some(([member, started]) => current.get(member) === started)) process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
            } catch { /* The group exited, or its identity cannot be proved. */ }
            resolve();
          }, 1500));
        } catch { /* Missing or incomplete cancellation publications are retried. */ }
        finally { checkingCancel = false; }
      })();
    }, 100);
    cancelWatcher.unref();
    const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolve => {
      child!.once('error', error => resolve({ code: null, signal: null, error }));
      child!.once('close', (code, signal) => resolve({ code, signal }));
    });
    let publication = Promise.resolve();
    const capture = async (stream: PayloadStream) => {
      let pending = Buffer.alloc(0);
      let failure: unknown;
      const flush = (force: boolean) => {
        while (pending.length >= RAW_CHUNK_BYTES || (force && pending.length > 0)) {
          const raw = pending.subarray(0, RAW_CHUNK_BYTES);
          pending = pending.subarray(raw.length);
          publication = publication.then(async () => {
            await appendFile(join(directory, stream + '.log'), raw);
            const chunk: RemoteChunk = { file: `chunk-${String(chunkCount++).padStart(8, '0')}.json`, stream, offset: offsets[stream], bytes: raw.length, sha256: sha256(raw) };
            await atomicRuntimeFile(join(directory, chunk.file), JSON.stringify({ stream, offset: chunk.offset, data: raw.toString('base64') }));
            index.chunks.push(chunk); offsets[stream] += raw.length;
            if (index.chunks.length === 64) {
              const pageName = `page-${String(pageCount++).padStart(8, '0')}.json`;
              const pageBytes = JSON.stringify({ version: 1, jobId: request.jobId, nonce: request.nonce, previous: index.head, chunks: index.chunks });
              await atomicRuntimeFile(join(directory, pageName), pageBytes);
              index.head = { file: pageName, sha256: sha256(pageBytes), stdoutBytes: offsets.stdout, stderrBytes: offsets.stderr };
              index.chunks = [];
            }
            indexBytes = JSON.stringify(index); await atomicRuntimeFile(join(directory, 'index.json'), indexBytes);
          });
          publication = publication.then(async () => { if (!process[stream].write(raw)) await once(process[stream], 'drain'); });
        }
        return publication;
      };
      const timer = setInterval(() => { void flush(true).catch(error => { failure = error; forward('SIGTERM'); }); }, 100);
      try {
        for await (const data of child![stream]!) {
          if (failure) throw failure;
          pending = Buffer.concat([pending, Buffer.from(data)]);
          await flush(false);
        }
        if (failure) throw failure;
        await flush(true);
      } finally { clearInterval(timer); }
    };
    await Promise.all([capture('stdout'), capture('stderr')]);
    const result = await finished;
    if (explicitCancel) { await cancelEscalation; await receipt('cancelled', 137, null); return 137; }
    if (result.error) { await receipt('spawn-error', null, null, result.error.message); return 127; }
    if (result.signal) { await receipt('signal', null, result.signal); return terminate(result.signal); }
    if (result.code === null) { await receipt('spawn-error', null, null, 'Payload exited without a code or signal'); return 127; }
    await receipt('exited', result.code, null); return result.code;
  } catch (error) {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} }
    const message = error instanceof Error ? error.message : String(error);
    const needsSetup = rootProbeFailed || error instanceof RemoteRuntimeError && error.code.startsWith('runtime-root-');
    await receipt('spawn-error', null, null, needsSetup ? `${message}; rerun spider herdr setup` : message);
    return 127;
  } finally { removeHandlers(); }
}

export interface ConsoleCommand {
  version: 1; jobId: string; directory: string; command: string; startedAt: number; tool?: 'exec' | 'batch' | 'exec_file';
}
export interface RemoteConsoleOptions {
  signal?: AbortSignal; pollMs?: number; write?: (text: string) => void; instance?: string; columns?: number;
}
function consoleText(text: string): string {
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
const consoleDim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const consoleColor = (color: 31 | 32, text: string) => `\x1b[${color}m${text}\x1b[0m`;
const consoleSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function consoleCellWidth(text: string): number {
  if (/^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u.test(text)) return 0;
  const code = text.codePointAt(0)!;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text) || code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a || code >= 0x2e80 && code <= 0xa4cf ||
    code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f ||
    code >= 0xff00 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 || code >= 0x20000 && code <= 0x3fffd
  ) ? 2 : 1;
}
function consoleRows(text: string, width: number): string[] {
  const rows: string[] = []; let row = ''; let cells = 0;
  for (const { segment } of consoleSegmenter.segment(text)) {
    const size = consoleCellWidth(segment);
    if (row && cells + size > width) { rows.push(row); row = ''; cells = 0; }
    row += segment; cells += size;
  }
  if (row || rows.length === 0) rows.push(row);
  return rows;
}
function consoleWidth(text: string): number {
  let width = 0; for (const { segment } of consoleSegmenter.segment(text)) width += consoleCellWidth(segment); return width;
}
function consoleClip(text: string, width: number): string {
  if (width <= 0) return '';
  if (consoleWidth(text) <= width) return text;
  let clipped = ''; let cells = 0;
  for (const { segment } of consoleSegmenter.segment(text)) {
    const size = consoleCellWidth(segment);
    if (cells + size > width - 1) break;
    clipped += segment; cells += size;
  }
  return clipped + '…';
}
function consoleTime(time: number): string {
  const date = new Date(time);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0')).join(':');
}
/** A view only. No payload argv is read, no process is spawned and no job receives a signal. */
export async function runRemoteConsole(directory: string, options: RemoteConsoleOptions = {}): Promise<void> {
  directory = resolve(directory);
  if (!(await lstat(directory)).isDirectory() || !(await lstat(dirname(directory))).isDirectory()) throw new RemoteRuntimeError('console-directory-invalid', 'Console directory must be real');
  const programRoot = dirname(dirname(directory));
  const write = options.write ?? (text => { process.stdout.write(text); });
  const instance = options.instance ?? randomUUID(); let lastTitle: string | undefined;
  type Active = { command: ConsoleCommand; tag: number; nextChunk: number; offsets: Record<PayloadStream, number>; decoders: Record<PayloadStream, StringDecoder> };
  const active = new Map<string, Active>();
  let next = 0; let lastHeartbeat = -Infinity; let nextTag = 1;
  const columns = () => {
    const value = options.columns ?? process.stdout.columns;
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  const tag = (job: Active) => active.size > 1 ? `#${job.tag} ` : '';
  const display = (job: Active, stream: PayloadStream, text: string) => {
    if (!text) return;
    const prefix = `  ${tag(job)}`; const width = columns();
    const gutter = stream === 'stderr' ? consoleColor(31, '│ ') : consoleDim('│ ');
    const lines = consoleText(text).split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) {
      const rows = width === undefined ? [line] : consoleRows(line, Math.max(1, width - prefix.length - 2));
      for (const row of rows) write(`${prefix}${gutter}${row}\n`);
    }
  };
  while (!options.signal?.aborted) {
    const now = Date.now();
    try {
      const meta = parseRuntimePublication(await readBoundedFile(join(directory, 'console.json'), 4096));
      if (meta.version === 1 && typeof meta.title === 'string') {
        const title = meta.title.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 512);
        if (title !== lastTitle) {
          const width = columns();
          write(`\x1b]0;${title}\x07${width === undefined ? title : consoleClip(title, width)}\n${consoleDim('─'.repeat(Math.min(width ?? 50, 200)))}\n`);
          lastTitle = title;
        }
      }
    } catch { /* A torn or checksum-failing host title is retried without blocking output. */ }
    if (now - lastHeartbeat >= 10000 || now < lastHeartbeat) {
      await atomicRuntimeFile(join(directory, 'heartbeat.json'), JSON.stringify({ version: 1, at: now, instance })); lastHeartbeat = now;
    }
    try {
      const head = parseRuntimePublication(await readBoundedFile(join(directory, 'head.json'), 1024));
      if (head.version === 1 && Number.isSafeInteger(head.count) && (head.count as number) >= next) {
        // Bound admissions per tick without limiting the number of concurrent jobs.
        let admissions = 0;
        while (next < (head.count as number) && admissions++ < 32) {
          let value: Record<string, unknown>;
          try { value = parseRuntimePublication(await readBoundedFile(join(directory, `command-${next}.json`), 8192)); }
          catch { break; } // Missing or partially published descriptors are retried.
          if (value.version !== 1 || !identifier(value.jobId) || typeof value.directory !== 'string' || dirname(resolve(value.directory)) !== programRoot || typeof value.command !== 'string' || value.command.length > 1024 || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt) || Math.abs(value.startedAt) > 8.64e15) { next++; continue; }
          try { if (!(await lstat(value.directory)).isDirectory()) { next++; continue; } }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { next++; continue; } break; }
          const command = value as unknown as ConsoleCommand;
          if (active.size === 0) nextTag = 1;
          const job: Active = { command, tag: nextTag++, nextChunk: 0, offsets: { stdout: 0, stderr: 0 }, decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') } };
          active.set(command.jobId, job);
          if (active.size === 2) {
            const first = active.values().next().value!;
            write(`${consoleDim(`  ○ concurrent · #${first.tag} ${first.command.jobId.slice(0, 8)} · #${job.tag} ${job.command.jobId.slice(0, 8)}`)}\n`);
          }
          const tool = command.tool === 'batch' || command.tool === 'exec_file' ? command.tool : 'exec';
          const prefix = `◆ ${tool} ${tag(job)}`;
          const left = `${prefix}${consoleText(command.command.split('\n')[0])}`;
          const right = `${consoleTime(command.startedAt)} · ${command.jobId.slice(0, 8)}`;
          const width = columns();
          if (width === undefined) write(`\n${left}  ${consoleDim(right)}\n`);
          else {
            const minimum = consoleWidth(prefix.trimEnd());
            const meta = consoleClip(right, Math.min(consoleWidth(right), Math.max(0, width - minimum - 2)));
            const leftWidth = width - consoleWidth(meta) - (meta ? 2 : 0);
            const clipped = leftWidth === minimum ? prefix.trimEnd() : consoleClip(left, leftWidth);
            const gap = Math.max(0, width - consoleWidth(clipped) - consoleWidth(meta));
            write(`\n${clipped}${' '.repeat(gap)}${meta ? consoleDim(meta) : ''}\n`);
          }
          next++;
        }
      }
    } catch { /* Missing, oversized or partial heads do not stop existing jobs' output. */ }
    const batch: [string, Active][] = [];
    for (const entry of active) { batch.push(entry); if (batch.length === 32) break; }
    for (const [jobId, job] of batch) {
      active.delete(jobId); active.set(jobId, job); // Round-robin bounded reads, including missing streams.
      // Recheck the directory so a replacement symlink cannot redirect a live tail.
      try { if (!(await lstat(job.command.directory)).isDirectory()) continue; } catch { continue; }
      for (let read = 0; read < 2; read++) {
        try {
          const chunk = record(JSON.parse((await readBoundedFile(join(job.command.directory, `chunk-${String(job.nextChunk).padStart(8, '0')}.json`), RAW_CHUNK_BYTES * 2)).toString()));
          if ((chunk.stream !== 'stdout' && chunk.stream !== 'stderr') || chunk.offset !== job.offsets[chunk.stream] || typeof chunk.data !== 'string' || chunk.data.length > Math.ceil(RAW_CHUNK_BYTES / 3) * 4) break;
          const bytes = Buffer.from(chunk.data, 'base64');
          if (bytes.length > RAW_CHUNK_BYTES || bytes.toString('base64') !== chunk.data) break;
          job.offsets[chunk.stream] += bytes.length; job.nextChunk++;
          display(job, chunk.stream, job.decoders[chunk.stream].write(bytes));
        } catch { break; } // Missing or partial chunks are retried without blocking other jobs.
      }
      try {
        const receipt = record(JSON.parse((await readBoundedFile(join(job.command.directory, 'receipt.json'), 8192)).toString()));
        if (receipt.version !== 1 || receipt.jobId !== jobId || !Number.isSafeInteger(receipt.stdoutBytes) || !Number.isSafeInteger(receipt.stderrBytes) || (receipt.stdoutBytes as number) < 0 || (receipt.stderrBytes as number) < 0 || job.offsets.stdout < (receipt.stdoutBytes as number) || job.offsets.stderr < (receipt.stderrBytes as number)) continue;
        for (const stream of ['stdout', 'stderr'] as const) display(job, stream, job.decoders[stream].end());
        let result: string;
        if (receipt.outcome === 'signal' && typeof receipt.signal === 'string') result = consoleColor(31, `✗ signal ${consoleText(receipt.signal)}`);
        else if (receipt.outcome === 'exited' && Number.isInteger(receipt.exitCode)) {
          const elapsed = typeof receipt.finishedAt === 'number' && Number.isFinite(receipt.finishedAt) && receipt.finishedAt >= job.command.startedAt ? ` · ${((receipt.finishedAt - job.command.startedAt) / 1000).toFixed(1)} s` : '';
          const code = receipt.exitCode as number;
          result = consoleColor(code === 0 ? 32 : 31, `${code === 0 ? '✓' : '✗'} exit ${code}${elapsed}`);
        } else {
          const label = receipt.outcome === 'lost' ? 'output lost' : receipt.outcome === 'cancelled' ? 'cancelled' : receipt.outcome === 'spawn-error' ? 'could not start' : receipt.outcome === 'release-timeout' ? 'release timed out' : 'outcome unknown';
          result = consoleDim(`○ ${label}`);
        }
        await releaseConsoleHold(job.command.directory, directory); write(`  ${tag(job)}${result}\n`); active.delete(jobId);
      } catch { /* A receipt may be absent or still being published. */ }
    }
    try { await delay(options.pollMs ?? 100, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal?.aborted) throw error; }
  }
}

if ((import.meta as ImportMeta & { spiderHerdrRuntimeEntry?: boolean }).spiderHerdrRuntimeEntry !== false && process.argv[1] && (await import('node:fs')).realpathSync(process.argv[1]) === (await import('node:fs')).realpathSync(fileURLToPath(import.meta.url))) {
  if (!process.argv[2]) { process.stderr.write('A runtime request file is required\n'); process.exitCode = 127; }
  else {
    try {
      if (process.argv[2] === '--install' || process.argv[2] === '--probe') {
        const directory = process.argv[3]; if (!directory) throw new RemoteRuntimeError('runtime-root-invalid', 'A runtime root is required');
        const result = process.argv[2] === '--install' ? await installRuntimeDirectory(directory) : await probeRuntimeDirectory(directory);
        process.stdout.write(JSON.stringify(result) + '\n');
      } else if (process.argv[2] === '--console') {
        const directory = process.argv[3]; if (!directory) throw new RemoteRuntimeError('console-directory-invalid', 'A console directory is required');
        const controller = new AbortController(); const stop = () => controller.abort();
        for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
        try { await runRemoteConsole(directory, { signal: controller.signal, instance: process.argv[4] }); }
        finally { for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) process.off(signal, stop); }
      } else process.exitCode = await runRemoteRuntime(process.argv[2]);
    }
    catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 127; }
  }
}
