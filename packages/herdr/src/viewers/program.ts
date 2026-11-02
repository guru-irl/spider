// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { open, realpath } from 'node:fs/promises';
import { watch, constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseFeed } from '../../assets/shared/feed.js';
import type { RunId, SessionId, IpcDescriptor, Disposable, SessionFeed, RunSummary, ViewerIntent } from '../contracts.js';
import type { RunCursor, RunViewFrame, SteerReply } from '../contracts.js';
import { TranscriptMessages, TranscriptSanitizer } from './transcript.js';
export interface ViewerStreamClient {
  subscribeRun(runId: RunId, cursor: RunCursor | null, emit: (frame: RunViewFrame) => void): Promise<Disposable & { closed: Promise<void> }>;
}
export interface ViewerFeedSource { read(): Promise<SessionFeed | null>; subscribe(listener: () => void): () => void }
export interface ViewerOptions<Client extends ViewerStreamClient = ViewerStreamClient> {
  runId: RunId; sessionId: SessionId; feedRoot: string; stdout: Writable; stdin: Readable; intent?: ViewerIntent; initialStatus?: RunSummary['status'];
  createClient(descriptor: IpcDescriptor): Client;
  submitSteer?: (client: Client, text: string) => Promise<SteerReply>;
  feedSource?: ViewerFeedSource; statusOutput?: Writable; signal?: AbortSignal;
  wait?: (ms: number) => Promise<void>; clock?: () => number; release?: () => Promise<void>;
}
export function createViewerFeedSource(feedRoot: string, sessionId: SessionId): ViewerFeedSource {
  if (!sessionId || /[/\\\0]/.test(sessionId) || sessionId === '.' || sessionId === '..') throw new Error('Invalid viewer session ID');
  const root = resolve(feedRoot), directory = join(root, 'sessions', sessionId), file = join(directory, 'session.json');
  return {
    async read() {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const canonicalRoot = await realpath(root);
        if (await realpath(directory) !== directory || !directory.startsWith(canonicalRoot + sep) || await realpath(file) !== file) return null;
        handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024 || process.platform !== 'win32' && (before.mode & 0o077) !== 0) return null;
        const buffer = Buffer.alloc(1024 * 1024 + 1); let length = 0;
        while (length < buffer.length) {
          const chunk = await handle.read(buffer, length, buffer.length - length, length);
          if (!chunk.bytesRead) break; length += chunk.bytesRead;
        }
        const after = await handle.stat();
        if (length > 1024 * 1024 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
        const feed = parseFeed(text); return feed?.sessionId === sessionId ? feed : null;
      } catch { return null; } finally { await handle?.close(); }
    },
    subscribe(listener) {
      try { const watcher = watch(directory, { persistent: false }, listener); watcher.on('error', listener); return () => watcher.close(); }
      catch { return () => {}; } // Reconciliation also covers a not-yet-created feed directory.
    },
  };
}
export async function runViewer<Client extends ViewerStreamClient>(options: ViewerOptions<Client>): Promise<void> {
  const wait = options.wait ?? (ms => delay(ms)); const clock = options.clock ?? Date.now;
  const status = options.statusOutput ?? options.stdout;
  const feeds = options.feedSource ?? createViewerFeedSource(options.feedRoot, options.sessionId);
  const sanitizer = new TranscriptSanitizer();
  const messages = new TranscriptMessages();
  let cursor: RunCursor | null = null; let lastResult: string | null = null;
  let finished = false; let closed = false; let userClosed = false; let sawUnfinished = options.initialStatus === 'queued' || options.initialStatus === 'running' || options.initialStatus === 'paused'; let savedFinished = false;
  let canSteer = false; let feedAvailable = false; let reconnecting = false; let ownerClosed = false;
  let reconnectDelay = 250; let nextDiscovery = 0; let ownerReplaced = false;
  let unavailableSince: number | null = null; let finalReadOnly = false;
  const showReconnect = () => {
    unavailableSince ??= clock();
    // A disposed endpoint can be a reload. Keep that expected handoff quiet
    // while its feed is fresh, without extending the 30-second deadline.
    if (handoff?.version === connectionVersion && clock() - unavailableSince < 10000) return;
    if (!reconnecting) status.write('[reconnecting]\n'); reconnecting = true;
  };
  let unavailable = 'Waiting for the owning session.';
  let currentFeed: SessionFeed | null = null; let lastRun: RunSummary | null = null; let streamActive = false;
  const liveRpc = (run: RunSummary) => run.status === 'running' && run.childMode === 'rpc' && run.canSteer;
  const updateSteering = () => {
    const feedRun = currentFeed?.runs.rows.find(run => run.id === options.runId);
    // The stream owns this run's status; a non-running feed row also rules out steering.
    const run = lastRun && lastRun.status !== 'running' ? lastRun : feedRun ?? lastRun;
    canSteer = Boolean(feedAvailable && streamActive && lastRun && liveRpc(lastRun) && run && liveRpc(run) && !finished && !closed && !finalReadOnly && !ownerClosed);
    unavailable = !feedAvailable ? 'The owning session is reconnecting.' : !run ? 'Waiting for the owning session.'
      : run.childMode === 'print' ? 'This is a one-shot print child. Start a new run to change its brief.'
      : run.status !== 'running' ? `This run is ${run.status}.` : 'The owning session has no live RPC pipe.';
  };
  let reportedUnavailable: string | null = null;
  const reportUnavailable = () => {
    if (unavailable === reportedUnavailable) return;
    status.write(`[steering unavailable] ${unavailable}\n`); reportedUnavailable = unavailable;
  };
  const connectionState: { client: Client | null } = { client: null };
  let connectionVersion = 0; let refusedVersion: number | null = null; let missingSince: number | null = null;
  let handoff: { version: number; reason: 'disposed' | 'wrong-generation' } | null = null;
  const generations = new Set<string>();
  let wake = () => {};
  let stop!: () => void; const stopped = new Promise<void>(resolve => { stop = resolve; });
  const interactiveInput = Boolean((options.stdin as Readable & { isTTY?: boolean }).isTTY);
  const composer = createInterface({ input: options.stdin, output: status, terminal: interactiveInput });
  composer.setPrompt('Steer> ');
  composer.on('SIGINT', () => { userClosed = true; stop(); });
  composer.on('close', () => { if (interactiveInput) { userClosed = true; stop(); } });
  composer.on('line', text => {
    const sendingClient = connectionState.client;
    if (!canSteer || !sendingClient || !options.submitSteer || finished || closed || options.signal?.aborted) {
      status.write(`[refused] ${unavailable}\n`);
      // Keep a submitted disconnected draft in this viewer, never in the parent editor.
      if ((options.stdin as Readable & { isTTY?: boolean }).isTTY) composer.write(text);
      return;
    }
    void options.submitSteer(sendingClient, text).then(reply => {
      status.write(`[${safe(reply.delivery)}]${reply.error ? ' ' + safe(reply.error) : ''}\n`);
      if ((options.stdin as Readable & { isTTY?: boolean }).isTTY) composer.prompt(true);
    }).catch(() => status.write('[no reply yet, delivery unknown] Do not resend this steer.\n'));
  });
  options.signal?.addEventListener('abort', stop, { once: true });
  let refreshing: Promise<void> | null = null; let lifecyclePending = false;
  const refreshOnce = async (lifecycleEvent: boolean): Promise<void> => {
    if (finished || savedFinished && !lifecycleEvent || ownerReplaced || closed || userClosed || options.signal?.aborted) return;
    const discoveryNow = Date.now();
    if (!lifecycleEvent && !savedFinished && (!feedAvailable || !streamActive || finalReadOnly || ownerClosed) && discoveryNow < nextDiscovery) return;
    nextDiscovery = discoveryNow + 1000;
    const feed = await feeds.read();
    if (finished || closed || userClosed || options.signal?.aborted) return;
    if (!feed) {
      // Retention can sweep a closed feed. It must not close its saved viewer.
      if (ownerClosed) return;
      missingSince ??= clock(); feedAvailable = false; canSteer = false; showReconnect(); unavailable = 'The owning session is reconnecting.';
      if (clock() - missingSince >= 30000) {
        finalReadOnly = true; ownerClosed = true; connectionVersion++; connectionState.client = null; streamActive = false;
        unavailable = 'The owning session feed disappeared. Saved log is read-only.';
        status.write('Owning session feed disappeared. Saved log is read-only.\n'); wake();
      }
      return;
    }
    missingSince = null;
    if (feed.sessionId !== options.sessionId || feed.owner.sessionId !== options.sessionId) {
      if (connectionState.client) { connectionVersion++; connectionState.client = null; streamActive = false; wake(); }
      if (!finalReadOnly && !ownerClosed) status.write('Owning session changed. Saved log is read-only.\n');
      ownerReplaced = true; finalReadOnly = true; ownerClosed = true; feedAvailable = false; canSteer = false;
      unavailable = 'The owning session changed. Saved log is read-only.'; return;
    }
    if (currentFeed && (feed.updatedAt < currentFeed.updatedAt || feed.generation === currentFeed.generation && feed.revision < currentFeed.revision)) return;
    if (currentFeed && feed.generation !== currentFeed.generation && (generations.has(feed.generation) || feed.updatedAt <= currentFeed.updatedAt)) return;
    const changed = !currentFeed || feed.generation !== currentFeed.generation
      || feed.ipc?.address !== currentFeed.ipc?.address || feed.ipc?.capabilityFile !== currentFeed.ipc?.capabilityFile;
    currentFeed = feed;
    if (feed.lifecycle === 'closed') {
      unavailableSince = null;
      if (!ownerClosed) {
        connectionVersion++; connectionState.client = null; streamActive = false;
        status.write('Owning session closed. Saved log is read-only.\n'); wake();
      }
      ownerClosed = true; feedAvailable = false; canSteer = false; unavailable = 'The owning session is closed. Saved log is read-only.';
      return;
    }
    if (savedFinished) return;
    ownerClosed = false;
    const settleUnavailable = () => {
      if (finalReadOnly || unavailableSince === null || clock() - unavailableSince < 30000) return false;
      finalReadOnly = true; ownerClosed = true; feedAvailable = false; canSteer = false;
      // Intentional replacement is final at the deadline. Temporary disposal
      // still permits authenticated same-session recovery, including after quit.
      ownerReplaced = handoff?.reason === 'wrong-generation';
      connectionVersion++; connectionState.client = null; streamActive = false;
      unavailable = 'The owning session is unavailable. Saved log is read-only.';
      status.write('Owning session unavailable for 30 seconds. Saved log is read-only.\n'); wake();
      return true;
    };
    if (!feed.ipc || clock() - feed.updatedAt > 10000) {
      feedAvailable = false; canSteer = false; showReconnect(); unavailable = 'The owning session is reconnecting.';
      settleUnavailable(); return;
    }
    if (!streamActive) settleUnavailable();
    const recovered = !feedAvailable; feedAvailable = true;
    if (changed || recovered || !connectionState.client) {
      streamActive = false; lastRun = null;
      generations.add(feed.generation); connectionVersion++; canSteer = false; unavailable = 'The owning session is reconnecting.';
      connectionState.client = options.createClient({ version: 1, sessionId: options.sessionId, generation: feed.generation, address: feed.ipc.address, capabilityFile: feed.ipc.capabilityFile });
      wake();
    } else {
      updateSteering();
      if (streamActive) { unavailableSince = null; handoff = null; }
      if (recovered && streamActive) { reconnecting = false; status.write('[reconnected]\n'); }
    }
  };
  const refresh = (lifecycleEvent = false): Promise<void> => {
    lifecyclePending ||= lifecycleEvent;
    if (refreshing) return refreshing;
    // Coalesce a notification burst, but retain any notice received during a read.
    refreshing = Promise.resolve().then(async () => {
      try {
        do {
          const lifecycleEvent = lifecyclePending; lifecyclePending = false;
          await refreshOnce(lifecycleEvent);
        } while (lifecyclePending);
      } finally { refreshing = null; }
    });
    return refreshing;
  };
  let lifecycleTimer: ReturnType<typeof setTimeout> | undefined; let lifecycleDeadline: number | null = null;
  // Inactive owners can emit repeated notices without a new feed. Coalesce them
  // after 100 ms of quiet, capped at 250 ms so a busy feed cannot starve recovery.
  // Completed saved logs still receive lifecycle notices, but never discover another endpoint.
  const unsubscribe = feeds.subscribe(() => {
    clearTimeout(lifecycleTimer);
    if (refreshing || savedFinished || feedAvailable && streamActive && !finalReadOnly && !ownerClosed) {
      lifecycleTimer = undefined; lifecycleDeadline = null; void refresh(true); return;
    }
    const now = Date.now(); lifecycleDeadline ??= now + 250;
    lifecycleTimer = setTimeout(() => {
      lifecycleTimer = undefined; lifecycleDeadline = null; void refresh(true);
    }, Math.min(100, Math.max(0, lifecycleDeadline - now)));
    lifecycleTimer.unref?.();
  });
  const timer = setInterval(() => { void refresh(); }, 1000); timer.unref?.();
  try {
    await refresh(); await refresh();
    while (!finished && !closed && !userClosed && !options.signal?.aborted) {
      const version = connectionVersion; const selected = connectionState.client;
      const changed = new Promise<void>(resolve => { wake = resolve; });
      if (!selected || !feedAvailable || savedFinished || refusedVersion === version) { await Promise.race([changed, stopped, delay(1000)]); await refresh(); continue; }
      let connection: Awaited<ReturnType<ViewerStreamClient['subscribeRun']>> | undefined;
      try {
        connection = await selected.subscribeRun(options.runId, cursor, frame => {
          if (version !== connectionVersion || refusedVersion === version || closed || options.signal?.aborted || frame.runId !== options.runId || frame.kind === 'event' && frame.cursor === cursor) return;
          if (frame.kind === 'snapshot' && (frame.data.run.id !== options.runId || frame.data.run.ownerSessionId !== options.sessionId)) {
            refusedVersion = version; finalReadOnly = true; streamActive = false; canSteer = false;
            unavailable = 'This run is not owned by the session. Saved log is read-only.'; wake(); return;
          }
          cursor = frame.cursor;
          switch (frame.kind) {
            case 'snapshot': {
              const run = frame.data.run; lastRun = run; streamActive = true;
              if (run.status === 'queued' || run.status === 'running' || run.status === 'paused') sawUnfinished = true;
              if (feedAvailable) {
                if (reconnecting) status.write('[reconnected]\n');
                reconnecting = false; finalReadOnly = false; ownerClosed = false; unavailableSince = null; handoff = null;
              }
              reconnectDelay = 250;
              updateSteering();
              status.write(`[${safe(run.status)} · ${run.childMode}]\n`);
              if (!canSteer) reportUnavailable();
              if (canSteer && (options.stdin as Readable & { isTTY?: boolean }).isTTY) composer.prompt(true);
              if (run.result && run.result !== lastResult) { options.stdout.write(safe(run.result) + '\n'); lastResult = run.result; }
              break;
            }
            case 'event':
              options.stdout.write(sanitizer.push(frame.data.text));
              for (const event of frame.data.events) if (event.runId === options.runId && (event.summary || event.tool) && messages.shouldRender(event)) status.write(`[${safe(event.type)}] ${safe(event.summary ?? event.tool ?? '')}\n`);
              break;
            case 'gap': status.write(`[gap] ${safe(frame.data.reason)}\n`); break;
            case 'end':
              streamActive = false; canSteer = false;
              if (frame.data.reason === 'finished') {
                if (options.intent === 'automatic' || sawUnfinished) { finished = true; stop(); }
                else { savedFinished = true; wake(); }
                updateSteering(); reportUnavailable();
              } else {
                if (frame.data.reason === 'run-not-owned') refusedVersion = version;
                if (frame.data.reason === 'disposed' || frame.data.reason === 'wrong-generation') { handoff = { version, reason: frame.data.reason }; unavailableSince ??= clock(); }
                wake();
              }
              break;
          }
        });
        await Promise.race([connection.closed, changed, stopped]);
      } catch (cause) {
        if (cause && typeof cause === 'object' && 'code' in cause && (cause.code === 'not-found' || cause.code === 'run-not-owned')) refusedVersion = version;
        else showReconnect();
      }
      finally {
        streamActive = false; canSteer = false;
        if (version === connectionVersion && !finished && !savedFinished && !ownerClosed && !userClosed && !options.signal?.aborted && refusedVersion !== version) showReconnect();
        if (!finished && !savedFinished) unavailable = finalReadOnly ? 'The owning session is unavailable. Saved log is read-only.' : ownerClosed ? 'The owning session is closed. Saved log is read-only.'
          : refusedVersion === connectionVersion ? 'This run is not owned by the session.' : 'The owning session is reconnecting.';
        if (refusedVersion === version) status.write(`[steering unavailable] ${unavailable}\n`);
        await connection?.dispose();
      }
      if (!finished && !closed && !userClosed && !options.signal?.aborted) {
        if (version === connectionVersion) {
          const changed = new Promise<void>(resolve => { wake = resolve; });
          await Promise.race([wait(reconnectDelay), changed, stopped]); reconnectDelay = Math.min(2000, reconnectDelay * 2);
        }
        await refresh();
      }
    }
    if (finished && !closed && !userClosed && !options.signal?.aborted) await wait(2000);
  } finally {
    clearInterval(timer); clearTimeout(lifecycleTimer); unsubscribe(); composer.close(); options.signal?.removeEventListener('abort', stop); await options.release?.();
  }
}
function safe(text: string): string { return new TranscriptSanitizer().push(text); }
