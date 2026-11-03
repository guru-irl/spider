// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createServer, type Socket } from 'node:net';
import { chmod, lstat, rm } from 'node:fs/promises';
import { paths } from '@spider/db-core';
import { claimFeedWriter } from './writer.js';
import { HerdrError } from '../client/parse.js';
import { sweepSessionIpc } from './cleanup.js';
import { join } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { parseRunViewFrame, parseSessionIpcEnvelope, parseSessionIpcReply, type Disposable, type IpcDescriptor, type IpcErrorCode, type IpcMoveDestination, type JobId, type Owner, type RunCursor, type RunId, type RunViewFrame, type SessionIpcReply, type SteerReply, type TerminalAddress, type ViewName } from '../contracts.js';
import { atomicPrivateWrite, feedError, privateDirectory, sweepSessionFeeds } from './publisher.js';
export const OPEN_BUDGET_MS = 30_000;
export const OPEN_CLIENT_TIMEOUT_MS = 60_000;
export const MAX_FRAME_BYTES: number = 256 * 1024;
export const MAX_TRANSCRIPT_BYTES: number = 64 * 1024;
export const MAX_STEER_BYTES: number = 16 * 1024;
export const MAX_PENDING_BYTES: number = 1024 * 1024;
export interface SessionEndpointPorts {
  reportError?(error: unknown): void;
  currentOwner(): Owner | null;
  /** Null means no detected live instance; never substitute a module-file inspection. */
  liveCapabilities(): Extract<SessionIpcReply, { op: 'ping' }>['status'] | null;
  ownsRun(runId: RunId): boolean | Promise<boolean>;
  subscribeRun(runId: RunId, cursor: RunCursor | null, emit: (frame: RunViewFrame) => void, options?: { view: number }): Disposable | Promise<Disposable>;
  steerRun(runId: RunId, text: string): SteerReply | Promise<SteerReply>;
  openView(view: ViewName): void | Promise<void>;
  openRun(runId: RunId, signal?: AbortSignal): TerminalAddress | null | Promise<TerminalAddress | null>;
  killRun?(runId: RunId): void | Promise<void>;
  moveRun?(runId: RunId, destination: IpcMoveDestination): TerminalAddress | null | Promise<TerminalAddress | null>;
  moveSession?(destination: Exclude<IpcMoveDestination, { kind: 'hide' }>): void | Promise<void>;
  prepareSessionStop?(): Promise<void>;
  killSessionTerminal?(): void | Promise<void>;
  ownsJob(jobId: JobId): boolean | Promise<boolean>;
  openJob(jobId: JobId, signal?: AbortSignal): TerminalAddress | null | Promise<TerminalAddress | null>;
  killJob?(jobId: JobId): void | Promise<void>;
  moveJob?(jobId: JobId, viewer: TerminalAddress, destination: Exclude<IpcMoveDestination, { kind: 'hide' }>): TerminalAddress | null | Promise<TerminalAddress | null>;
}
type HandoffReason = 'disposed' | 'wrong-generation';
export interface SessionEndpoint extends Disposable { descriptor: IpcDescriptor; dispose(reason?: HandoffReason): void | Promise<void> }
const errorCodes: readonly IpcErrorCode[] = ['wrong-generation', 'unauthorized', 'unknown-op', 'too-large', 'not-found', 'unavailable', 'status-instance-unavailable', 'refused'];
export async function startSessionEndpoint(owner: Owner, ports: SessionEndpointPorts, root: string = join(paths.globalRoot, 'herdr'), completedHours: number = 24): Promise<SessionEndpoint> {
  if (process.platform === 'win32') throw feedError('ipc-platform-unsupported');
  const directory = join(root, 'ipc');
  const capability = randomBytes(32).toString('hex');
  const sessionId = owner.sessionId; const generation = owner.generation;
  const hash = createHash('sha256').update(sessionId + '\0' + generation + '\0' + capability).digest('hex').slice(0, 12);
  const address = join(directory, `${hash}.sock`); const capabilityFile = join(directory, `${hash}.cap`);
  if (Buffer.byteLength(address) > (process.platform === 'darwin' ? 103 : 107)) throw feedError('ipc-path-too-long', 'Use a shorter configured globalRoot for the private IPC socket.');
  await privateDirectory(root); await privateDirectory(directory); await sweepSessionIpc(directory);
  await sweepSessionFeeds(root, { now: Date.now(), completedHours, excludeSessionId: owner.sessionId });
  const writer = await claimFeedWriter(root, owner);
  try { await atomicPrivateWrite(capabilityFile, capability); }
  catch (error) { await writer.dispose(); throw error; }
  let disposed = false;
  const sockets = new Map<Socket, (reason: HandoffReason) => void>();
  const releases = new Set<Promise<void>>();
  const release = (resource: Disposable) => {
    const done = Promise.resolve().then(() => resource.dispose()).then(() => {}, () => {}).finally(() => { releases.delete(done); });
    releases.add(done);
  };
  const live = () => { const current = ports.currentOwner(); return !disposed && current?.sessionId === sessionId && current.generation === generation; };
  const server = createServer(socket => {
    const openAbort = new AbortController();
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    let pending = Buffer.alloc(0); let received = false; let subscription: Disposable | undefined; let endStream: ((reason: HandoffReason) => void) | undefined;
    const unsubscribe = () => { const previous = subscription; subscription = undefined; if (previous) release(previous); };
    const sendReply = (reply: SessionIpcReply, afterWrite?: () => void) => {
      if (socket.destroyed) { afterWrite?.(); return; }
      const text = JSON.stringify(reply) + '\n';
      socket.end(Buffer.byteLength(text) <= MAX_FRAME_BYTES ? text : JSON.stringify({ ok: false, code: 'too-large', message: 'Reply exceeds 256 KiB.' } satisfies SessionIpcReply) + '\n', afterWrite);
    };
    const fail = (code: IpcErrorCode, message: string = code) => sendReply({ ok: false, code, message });
    const shutdown = (reason: HandoffReason) => { if (endStream && !socket.destroyed) endStream(reason); else socket.destroy(); unsubscribe(); };
    sockets.set(socket, shutdown);
    socket.setTimeout(30000, () => socket.destroy()); socket.on('error', () => {});
    socket.once('close', () => { openAbort.abort(); clearTimeout(openTimer); sockets.delete(socket); unsubscribe(); });
    const handle = async (bytes: Buffer) => {
      let text: string;
      try { text = new TextDecoder('utf8', { fatal: true }).decode(bytes); } catch { return fail('unavailable', 'Invalid UTF-8.'); }
      const envelope = parseSessionIpcEnvelope(text);
      if (!envelope) {
        let value: unknown; try { value = JSON.parse(text); } catch { return fail('unavailable', 'Invalid JSON.'); }
        if (value && typeof value === 'object' && 'request' in value) {
          const request = value.request;
          if (request && typeof request === 'object' && 'op' in request) {
            if (!['ping', 'openView', 'openRun', 'killRun', 'moveRun', 'moveSession', 'killSession', 'openJob', 'killJob', 'moveJob', 'steerRun', 'subscribeRun'].includes(String(request.op))) return fail('unknown-op');
            if ('text' in request && typeof request.text === 'string' && Buffer.byteLength(request.text) > MAX_STEER_BYTES) return fail('too-large');
          }
        }
        return fail('unauthorized', 'Invalid version, capability, or request.');
      }
      if (!timingSafeEqual(Buffer.from(envelope.capability, 'hex'), Buffer.from(capability, 'hex'))) return fail('unauthorized');
      const request = envelope.request;
      if (request.generation !== generation || !live()) return fail('wrong-generation');
      if (request.op === 'openRun' || request.op === 'openJob') {
        socket.setTimeout(OPEN_CLIENT_TIMEOUT_MS + 5000);
        openTimer = setTimeout(() => openAbort.abort(), OPEN_BUDGET_MS);
      }
      try {
        switch (request.op) {
          case 'ping': {
            const status = ports.liveCapabilities();
            return status === null ? fail('status-instance-unavailable') : sendReply({ ok: true, op: 'ping', status });
          }
          case 'openView': await ports.openView(request.view); return sendReply({ ok: true, op: 'openView' });
          case 'killSession': {
            if (!ports.prepareSessionStop || !ports.killSessionTerminal) return fail('unavailable');
            await ports.prepareSessionStop();
            if (!live()) return fail('wrong-generation');
            return sendReply({ ok: true, op: 'killSession' }, () => {
              void Promise.resolve().then(() => ports.killSessionTerminal!()).catch(error => ports.reportError?.(error));
            });
          }
          case 'moveSession': {
            if (!ports.moveSession) return fail('unavailable');
            await ports.moveSession(request.destination);
            return sendReply({ ok: true, op: 'moveSession' });
          }
          case 'openJob':
          case 'killJob':
          case 'moveJob': {
            if (!(await ports.ownsJob(request.jobId))) return fail('not-found');
            if (!live() || socket.destroyed) return fail('wrong-generation');
            if (request.op === 'killJob') {
              if (!ports.killJob) return fail('unavailable');
              await ports.killJob(request.jobId);
              return sendReply({ ok: true, op: 'killJob', jobId: request.jobId });
            }
            if (request.op === 'moveJob') {
              if (!ports.moveJob) return fail('unavailable');
              const viewer = await ports.moveJob(request.jobId, request.viewer, request.destination);
              return sendReply({ ok: true, op: 'moveJob', viewer });
            }
            const viewer = await ports.openJob(request.jobId, openAbort.signal);
            if (openAbort.signal.aborted) return fail('unavailable', 'open-aborted');
            clearTimeout(openTimer);
            return viewer === null ? fail('not-found') : sendReply({ ok: true, op: 'openJob', viewer });
          }

        }
        if (!(await ports.ownsRun(request.runId))) return request.op === 'steerRun'
          ? sendReply({ ok: false, code: 'refused', reason: 'wrong-owner', message: 'Run is not owned by this session.' }) : fail('not-found');
        if (!live() || socket.destroyed) return fail('wrong-generation');
        if (request.op === 'openRun') {
          const viewer = await ports.openRun(request.runId, openAbort.signal);
          if (openAbort.signal.aborted) return fail('unavailable', 'open-aborted');
          clearTimeout(openTimer);
          return viewer === null ? fail('not-found') : sendReply({ ok: true, op: 'openRun', viewer });
        }
        if (request.op === 'moveRun') {
          if (!ports.moveRun) return fail('unavailable');
          const viewer = await ports.moveRun(request.runId, request.destination);
          return sendReply({ ok: true, op: 'moveRun', viewer });
        }
        if (request.op === 'killRun') {
          if (!ports.killRun) return fail('unavailable');
          await ports.killRun(request.runId);
          return sendReply({ ok: true, op: 'killRun' });
        }
        if (request.op === 'steerRun') {
          if (!request.text.trim()) return fail('refused', 'Steer text must not be blank.');
          if (request.text.trimStart().startsWith('/')) return sendReply({ ok: false, code: 'refused', reason: 'slash-prefixed', message: 'Slash commands cannot steer a run.' });
          const acknowledgement = await ports.steerRun(request.runId, request.text);
          const reply: SessionIpcReply = { ok: true, op: 'steerRun', acknowledgement };
          if (!parseSessionIpcReply(JSON.stringify(reply))) return fail('unavailable', 'Invalid steer acknowledgement.');
          return sendReply(reply);
        }
        socket.setTimeout(0);
        let attached = false; let blocked = false; let ended = false; let queuedBytes = 0;
        let lastCursor = request.cursor; let sentCursor = request.cursor;
        let queue: { text: string; end: boolean; cursor: RunCursor }[] = [];
        const pump = () => {
          if (!attached || blocked || socket.destroyed) return;
          while (queue.length) {
            const entry = queue.shift()!; queuedBytes -= Buffer.byteLength(entry.text); sentCursor = entry.cursor;
            if (entry.end) { socket.end(entry.text); unsubscribe(); queue = []; queuedBytes = 0; return; }
            if (!socket.write(entry.text)) { blocked = true; return; }
          }
        };
        const end = (reason: Extract<RunViewFrame, { kind: 'end' }>['data']['reason'], gapReason?: string) => {
          ended = true; queue = []; queuedBytes = 0;
          const cursor = gapReason ? lastCursor : sentCursor;
          if (!cursor) { socket.destroy(); unsubscribe(); return; }
          if (gapReason) queue.push({ text: JSON.stringify({ runId: request.runId, cursor, kind: 'gap', data: { reason: gapReason } } satisfies RunViewFrame) + '\n', end: false, cursor });
          queue.push({ text: JSON.stringify({ runId: request.runId, cursor, kind: 'end', data: { reason } } satisfies RunViewFrame) + '\n', end: true, cursor });
          queuedBytes = queue.reduce((size, entry) => size + Buffer.byteLength(entry.text), 0); pump();
        };
        endStream = reason => { if (!ended) end(reason); };
        socket.on('drain', () => { blocked = false; pump(); });
        const emit = (frame: RunViewFrame) => {
          if (ended || socket.destroyed) return;
          if (!live()) { end('wrong-generation'); return; }
          if (frame.runId !== request.runId) { end('run-not-owned'); return; }
          const text = JSON.stringify(frame) + '\n';
          // Live frames are a preview; the transcript and events stay authoritative. A slow
          // viewer loses previews instead of its whole stream.
          if (frame.kind === 'live' && (blocked || queuedBytes + socket.writableLength + Buffer.byteLength(text) > MAX_PENDING_BYTES / 4 || !parseRunViewFrame(text))) return;
          lastCursor = frame.cursor;
          if (!parseRunViewFrame(text)) { end('overflow', 'transcript-page-too-large'); return; }
          if (queuedBytes + socket.writableLength + Buffer.byteLength(text) > MAX_PENDING_BYTES) { end('overflow', 'backpressure'); return; }
          queue.push({ text, end: frame.kind === 'end', cursor: frame.cursor }); queuedBytes += Buffer.byteLength(text);
          if (frame.kind === 'end') ended = true;
          pump();
        };
        const result = await ports.subscribeRun(request.runId, request.cursor, emit, request.view === undefined ? undefined : { view: request.view });
        if (socket.destroyed) { release(result); return; }
        subscription = result;
        if (!live()) end('wrong-generation');
        attached = true; pump();
      } catch (error) {
        if (live() && !openAbort.signal.aborted) ports.reportError?.(error);
        if ((error as { code?: string } | null)?.code === 'run-not-owned') return fail('not-found');
        const code = (error as { code?: IpcErrorCode } | null)?.code;
        const canonical = code && errorCodes.includes(code) ? code : 'unavailable';
        const typed = error instanceof HerdrError && /^[a-z][a-z0-9-]{0,79}$/.test(error.code);
        fail(canonical, typed ? error.code : request.op === 'openRun' ? 'run-open-failed' : 'Session action failed.');
      }
    };
    socket.on('data', data => {
      if (received) return;
      pending = Buffer.concat([pending, data]); const lf = pending.indexOf(10);
      if (lf < 0 ? pending.length > MAX_FRAME_BYTES : lf > MAX_FRAME_BYTES) { received = true; fail('too-large'); return; }
      if (lf < 0) return;
      received = true; socket.pause();
      if (pending.length !== lf + 1) { fail('unavailable', 'Only one request is allowed per connection.'); return; }
      const bytes = pending.subarray(0, lf); pending = Buffer.alloc(0); void handle(bytes);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, () => { server.off('error', reject); resolve(); }); }); await chmod(address, 0o600);
  } catch (error) { server.close(); await rm(capabilityFile, { force: true }); await writer.dispose(); throw error; }
  const fileIdentity = await lstat(capabilityFile);
  let disposal: Promise<void> | undefined;
  return { descriptor: { version: 1, sessionId, generation, address, capabilityFile }, dispose(reason: HandoffReason = 'disposed') {
    return disposal ??= (async () => {
      disposed = true;
      for (const [socket, shutdown] of sockets) { shutdown(reason); const timer = setTimeout(() => socket.destroy(), 100); timer.unref(); socket.once('close', () => clearTimeout(timer)); }
      await new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.all([...releases]);
      await writer.dispose();
      try { const info = await lstat(capabilityFile); if (!info.isSymbolicLink() && info.ino === fileIdentity.ino && info.dev === fileIdentity.dev) await rm(capabilityFile); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    })();
  } };
}
