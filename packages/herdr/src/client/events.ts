// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { spawn } from 'node:child_process';
import { requireCoreAvailable } from './liveness.js';
import { createChildTerminator } from './child-termination.js';
import { SINGLE_REPLY_BYTES, TERMINAL_LIST_BYTES } from './limits.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { HcClientOptions, HcEvent, HcEventStream, TerminalAddress, TerminalSummary, TerminalFinish } from '../contracts.js';
import { HerdrError, object, integer, text, nullableInteger, parseProgramStatus, parseTerminal, parseJson, selectedSocket } from './parse.js';

function parseEvent(value: unknown): HcEvent | null {
  const raw = object(value);
  const e = raw.method === 'event' ? object(raw.params) : raw.method === 'missed' || raw.method === 'heartbeat' ? { ...object(raw.params), type: raw.method } : raw;
  const seq = integer(e.seq);
  if (seq < 0) throw new HerdrError('invalid-reply', 'Negative event sequence');
  // hc 0.1.16 has no generation field; optional hints support future schemas only.
  const generation = e.generation === undefined ? {} : { generation: text(e.generation) };
  if (Array.isArray(e.terminals)) return { type: e.type === 'missed' ? 'missed' : 'snapshot', seq, terminals: e.terminals.map(parseTerminal), ...generation };
  if (e.type === 'heartbeat') return { type: 'heartbeat', seq, ...generation };
  if (!['created', 'status', 'finished', 'lost', 'restarted', 'removed'].includes(String(e.type))) return null;
  const terminal = text(e.terminal) as TerminalAddress;
  if (e.type === 'removed') return { type: 'removed', seq, terminal, ...generation };
  const data = object(e.data);
  if (e.type === 'created' || e.type === 'restarted') return { type: e.type, seq, terminal, data: parseTerminal(data), ...generation };
  if (e.type === 'status') return { type: 'status', seq, terminal, data: { status: parseProgramStatus(data.status) }, ...generation };
  const finish = { exitCode: nullableInteger(data.exit_code), reason: text(data.reason), signal: nullableInteger(data.signal), finishedAt: nullableInteger(data.finished_ms) };
  if (e.type === 'lost') return { type: 'lost', seq, terminal, data: finish, ...generation };
  if (finish.finishedAt === null) throw new HerdrError('invalid-reply', 'A finished event needs a timestamp');
  return { type: 'finished', seq, terminal, data: finish as TerminalFinish, ...generation };
}

export function createHcEventStream(options: HcClientOptions): HcEventStream {
  const env = Object.freeze({ ...options.env, HC_SOCKET: selectedSocket(options.env) });
  const maxRecordBytes = options.maxReplyBytes ?? TERMINAL_LIST_BYTES;
  const maxErrorBytes = Math.min(options.maxReplyBytes ?? SINGLE_REPLY_BYTES, SINGLE_REPLY_BYTES);
  const terminals = new Map<TerminalAddress, TerminalSummary>();
  const listeners = new Set<(event: HcEvent) => void>();
  const children = new Map<ChildProcessWithoutNullStreams, () => Promise<void>>();
  let disposal: Promise<void> | undefined;
  let disposed = false; let seq = -1; let generation: string | undefined; let attempt = 0;
  const lifetime = new AbortController();
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: () => void; let rejectReady!: (error: Error) => void;
  let ready!: Promise<void>;
  let readyPending = false;
  function resetReady(): void {
    readyPending = true;
    ready = new Promise<void>((resolve, reject) => {
      resolveReady = () => { readyPending = false; resolve(); };
      rejectReady = error => { readyPending = false; reject(error); };
    });
    void ready.catch(() => {});
  }
  resetReady();
  async function launch(): Promise<void> {
    if (disposed) return;
    try { await requireCoreAvailable(env, lifetime.signal); }
    catch (cause) {
      if (disposed) return;
      const error = cause instanceof Error ? cause : new HerdrError('core-unavailable', 'Herdr core is not running');
      rejectReady(error);
      ready = Promise.reject(error); void ready.catch(() => {});
      reconnect = setTimeout(() => { void launch(); }, 2000); reconnect.unref();
      return;
    }
    if (disposed) return;
    if (!readyPending) resetReady();
    // hc auto-starts absent cores. No await between the socket probe and spawn:
    // only a core exiting in this unavoidable check-then-call gap can race us.
    const child = spawn(options.binary, ['events', '--json'], { env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const stopChild = createChildTerminator(child);
    children.set(child, stopChild); child.stdin.end(); let pending: Buffer[] = []; let pendingBytes = 0; let stderrBytes = 0;
    let lastAt = Date.now(); let initial = true; let failed = false; let terminalFailure = false;
    const watchdog = setInterval(() => { if (Date.now() - lastAt >= 30000) void stopChild(); }, 1000); watchdog.unref();
    const fail = (error: Error) => {
      if (failed) return;
      failed = true; terminalFailure = error instanceof HerdrError && ['reply-too-large', 'invalid-reply'].includes(error.code);
      pending = []; pendingBytes = 0; rejectReady(error);
      if (terminalFailure) { ready = Promise.reject(error); void ready.catch(() => {}); }
      void stopChild();
    };
    child.stdout.on('data', (bytes: Buffer) => {
      if (disposed || failed) return;
      let offset = 0;
      while (offset < bytes.length) {
        const end = bytes.indexOf(10, offset), chunk = bytes.subarray(offset, end < 0 ? bytes.length : end);
        pendingBytes += chunk.length;
        if (pendingBytes > maxRecordBytes) { fail(new HerdrError('reply-too-large', `Event record exceeded its byte limit (${maxRecordBytes} bytes)`, { source: 'event-record' })); return; }
        if (chunk.length) pending.push(chunk);
        if (end < 0) break;
        const line = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
        pending = []; pendingBytes = 0; offset = end + 1;
        try {
          const event = parseEvent(parseJson(line)); if (!event) continue;
          if (!initial && generation !== undefined && event.generation !== undefined && event.generation !== generation) continue;
          lastAt = Date.now();
          if (event.type === 'snapshot' || event.type === 'missed') {
            if (!initial && event.seq <= seq) continue;
            if (event.generation !== undefined) generation = event.generation;
            terminals.clear(); for (const t of event.terminals) terminals.set(t.address, t);
            seq = event.seq; initial = false; attempt = 0; resolveReady();
          } else {
            if (initial) continue;
            if (event.type === 'heartbeat') { for (const listener of [...listeners]) listener(event); continue; }
            if (event.seq <= seq) continue; seq = event.seq;
            if (event.type === 'created' || event.type === 'restarted') terminals.set(event.terminal, event.data);
            else if (event.type === 'removed') terminals.delete(event.terminal);
            else if (event.type === 'status' || event.type === 'finished' || event.type === 'lost') {
              const t = terminals.get(event.terminal);
              if (t && event.type === 'status') terminals.set(event.terminal, { ...t, status: event.data.status });
              else if (t && event.type === 'finished') terminals.set(event.terminal, { ...t, state: 'finished', ...event.data });
              else if (t && event.type === 'lost') terminals.set(event.terminal, { ...t, ...event.data });
              // Loss retains metadata, but does not complete the original command.
            }
          }
          for (const listener of [...listeners]) listener(event);
        } catch (error) { fail(error instanceof Error ? error : new HerdrError('invalid-reply', 'Invalid event')); return; }
      }
    });
    child.stderr.on('data', (bytes: Buffer) => { stderrBytes += bytes.length; if (stderrBytes > maxErrorBytes) fail(new HerdrError('reply-too-large', `Event stderr exceeded its byte limit (${maxErrorBytes} bytes)`, { source: 'error-output' })); });
    child.once('error', error => fail(new HerdrError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-hc' : 'events-disconnected', error.message)));
    child.once('close', () => {
      clearInterval(watchdog); children.delete(child);
      if (disposed || terminalFailure) return;
      if (initial) rejectReady(new HerdrError('events-disconnected', 'Event transport closed before its snapshot'));
      resetReady();
      reconnect = setTimeout(() => { void launch(); }, Math.min(250 * 2 ** attempt++, 2000)); reconnect.unref();
    });
  }
  void launch();
  return {
    get ready() { return ready; },
    lookup: async address => { await ready; return terminals.get(address) ?? null; },
    subscribe: listener => {
      if (disposed) throw new HerdrError('disposed', 'Event stream disposed');
      // Capture the replay boundary before live events can update the map.
      let pending: HcEvent[] | null = seq < 0 ? null : [{
        type: 'snapshot', seq, terminals: [...terminals.values()],
        ...(generation === undefined ? {} : { generation }),
      }];
      let active = true;
      const deliver = (event: HcEvent) => {
        if (!active) return;
        if (pending) pending.push(event);
        else listener(event);
      };
      listeners.add(deliver);
      if (pending) {
        const backlog = pending;
        queueMicrotask(() => {
          for (const event of backlog) {
            if (!active || disposed) break;
            listener(event);
          }
          pending = null;
        });
      }
      return () => { active = false; listeners.delete(deliver); };
    },
    dispose: () => disposal ??= (async () => {
      disposed = true; lifetime.abort(); if (reconnect) clearTimeout(reconnect); listeners.clear();
      rejectReady(new HerdrError('disposed', 'Event stream disposed'));
      await Promise.all([...children.values()].map(stopChild => stopChild()));
    })(),
  };
}
