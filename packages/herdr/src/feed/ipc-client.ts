// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { connect, type Socket } from 'node:net';
import { lstat } from 'node:fs/promises';
import { parseRunViewFrame, parseSessionIpcReply, type Disposable, type IpcDescriptor, type JobId, type RunCursor, type RunId, type RunViewFrame, type SessionIpcEnvelope, type SessionIpcReply, type SessionIpcRequest, type ViewName } from '../contracts.js';
import { feedError, readPrivateText, rejectSymlinks } from './publisher.js';
import { MAX_FRAME_BYTES } from './ipc-server.js';
import { HerdrError } from '../client/parse.js';
/** Never expose filesystem or socket error messages to panel diagnostics. */
export function ipcFailureReply(error: unknown): SessionIpcReply {
  const slug = error instanceof HerdrError && /^[a-z][a-z0-9-]{0,79}$/.test(error.code) ? error.code : null;
  const typed = slug ? parseSessionIpcReply(JSON.stringify({ ok: false, code: slug, message: slug })) : null;
  return typed ?? { ok: false, code: 'unavailable', message: slug ?? 'endpoint-unavailable' };
}
export interface SessionIpcClient extends Disposable {
  request(request: Exclude<SessionIpcRequest, { op: 'subscribeRun' }>): Promise<SessionIpcReply>;
  ping(options?: { timeoutMs?: number }): Promise<SessionIpcReply>;
  steerRun(runId: RunId, text: string): Promise<SessionIpcReply>;
  openView(view: ViewName): Promise<SessionIpcReply>;
  openRun(runId: RunId): Promise<SessionIpcReply>;
  openJob(jobId: JobId): Promise<SessionIpcReply>;
  killJob(jobId: JobId): Promise<SessionIpcReply>;
  /** `view` requests a run-view protocol; owners that predate it ignore the field. */
  subscribeRun(runId: RunId, cursor: RunCursor | null, emit: (frame: RunViewFrame) => void, options?: { view?: number }): Promise<Disposable & { closed: Promise<void> }>;

}
export function createSessionIpcClient(descriptor: IpcDescriptor): SessionIpcClient {
  let disposed = false;
  const sockets = new Set<Socket>();
  const send = async (request: SessionIpcRequest, emit?: (frame: RunViewFrame) => void, timeoutMs?: number): Promise<{ reply: SessionIpcReply | null; socket: Socket; closed: Promise<void> }> => {
    if (disposed) throw feedError('ipc-client-disposed');
    if (descriptor.version !== 1) throw feedError('unavailable', 'Unsupported IPC descriptor version.');
    await rejectSymlinks(descriptor.address);
    const info = await lstat(descriptor.address);
    if (!info.isSocket() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw feedError('unsafe-ipc-socket');
    const capability = await readPrivateText(descriptor.capabilityFile, 64);
    if (!/^[a-f0-9]{64}$/i.test(capability)) throw feedError('unauthorized', 'Invalid capability file.');
    if (disposed) throw feedError('ipc-client-disposed');
    const text = JSON.stringify({ v: 1, capability, request } satisfies SessionIpcEnvelope) + '\n';
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw feedError('too-large');
    return await new Promise((resolve, reject) => {
      const socket = connect(descriptor.address); sockets.add(socket);
      let pending = Buffer.alloc(0); let settled = false;
      let resolveClosed!: () => void;
      const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
      const fail = (error: Error) => { socket.destroy(); if (!settled) reject(error); };
      // A steer may spend 10 s queued plus 10 s awaiting its child acknowledgement.
      // A user open has a 30 s placement budget plus app acknowledgements.
      socket.setTimeout(request.op === 'ping' && timeoutMs !== undefined ? Math.max(10, Math.min(10000, timeoutMs)) : request.op === 'openRun' ? 45000 : request.op === 'steerRun' ? 25000 : 10000, () => fail(feedError('unavailable', 'IPC acknowledgement timed out.')));
      socket.once('connect', () => socket.write(text)); socket.on('error', fail);
      socket.once('close', () => { resolveClosed(); sockets.delete(socket); if (!settled) reject(feedError('unavailable', 'IPC disconnected before acknowledgement.')); });
      socket.on('data', data => {
        pending = Buffer.concat([pending, data]);
        try {
          let lf: number;
          while ((lf = pending.indexOf(10)) >= 0) {
            if (lf > MAX_FRAME_BYTES) throw feedError('too-large');
            const line = new TextDecoder('utf8', { fatal: true }).decode(pending.subarray(0, lf)); pending = pending.subarray(lf + 1);
            if (emit) {
              const frame = parseRunViewFrame(line);
              if (!frame) {
                const reply = parseSessionIpcReply(line);
                if (reply && !reply.ok) throw Object.assign(feedError(reply.code, reply.message), 'reason' in reply ? { reason: reply.reason } : {});
                throw feedError('unavailable', 'Invalid stream frame.');
              }
              if (request.op !== 'subscribeRun' || frame.runId !== request.runId) throw feedError('unauthorized', 'Foreign run frame.');
              if (!settled) { settled = true; socket.setTimeout(0); resolve({ reply: null, socket, closed }); }
              emit(frame);
              // End frames are followed by EOF; closed resolves on the actual socket close.
            } else {
              const reply = parseSessionIpcReply(line);
              if (!reply || settled || (reply.ok && reply.op !== request.op)) throw feedError('unavailable', 'Invalid action reply.');
              settled = true; socket.destroy(); resolve({ reply, socket, closed });
            }
          }
          if (pending.length > MAX_FRAME_BYTES) throw feedError('too-large');
        } catch (error) { fail(error instanceof Error ? error : feedError('unavailable')); }
      });
    });
  };
  const action = async (request: Exclude<SessionIpcRequest, { op: 'subscribeRun' }>): Promise<SessionIpcReply> => (await send(request)).reply!;
  return {
    request: action,
    ping: async options => (await send({ op: 'ping', generation: descriptor.generation }, undefined, options?.timeoutMs)).reply!,
    openView: view => action({ op: 'openView', view, generation: descriptor.generation }),
    openRun: runId => action({ op: 'openRun', runId, generation: descriptor.generation }),
    openJob: jobId => action({ op: 'openJob', jobId, generation: descriptor.generation }),
    killJob: jobId => action({ op: 'killJob', jobId, generation: descriptor.generation }),
    steerRun: (runId, text) => action({ op: 'steerRun', runId, text, generation: descriptor.generation }),
    async subscribeRun(runId, cursor, emit, options) {
      const { socket, closed } = await send({ op: 'subscribeRun', runId, cursor, generation: descriptor.generation, ...(options?.view === undefined ? {} : { view: options.view }) }, emit);
      return { closed, dispose() { socket.destroy(); } };
    },
    dispose() { disposed = true; for (const socket of sockets) socket.destroy(); },
  };
}
