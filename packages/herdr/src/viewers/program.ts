// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { open, realpath } from 'node:fs/promises';
import { watch, constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { openDbReadOnly, type Db } from '@spider/db-core';
import { parseFeed } from '../../assets/shared/feed.js';
import type { RunId, SessionId, IpcDescriptor, Disposable, SessionFeed, RunSummary, ViewerIntent } from '../contracts.js';
import type { RunCursor, RunViewFrame, RunViewInfo, SteerReply, SessionIpcReply } from '../contracts.js';
import { RUN_VIEW_PROTOCOL } from '../contracts.js';
import { TranscriptMessages, TranscriptSanitizer } from './transcript.js';
export interface ViewerStreamClient {
  ping?(options?: { timeoutMs?: number }): Promise<SessionIpcReply>;
  subscribeRun(runId: RunId, cursor: RunCursor | null, emit: (frame: RunViewFrame) => void, options?: { view?: number }): Promise<Disposable & { closed: Promise<void> }>;
}
/** What the viewer shows in its footer, recomputed whenever the connection or run changes. */
export interface ViewerState { status: RunSummary['status'] | null; statusIsStale?: boolean; steerable: boolean; canCompose?: boolean; reachable: boolean; readOnlyReason: string | null; unreachableSince?: number | null }
/**
 * Draws the run. Without one, the viewer prints plain text and reads steers
 * line by line. The pi presenter draws with pi's components instead.
 */
export interface ViewerPresenter {
  /** `view` is null when the owner predates versioned run views. */
  snapshot(run: RunSummary, view: RunViewInfo | null): void;
  page(text: string): void;
  live(event: { type: string } & Record<string, unknown>): void;
  state(state: ViewerState): void;
  /** One line in the transcript for something the user needs to know. */
  notice(text: string): void;
  owner(name: string | null): void;
  bindSteer(submit: (text: string) => Promise<SteerReply | null>): void;
  onQuit(handler: () => void): void;
}
export interface ViewerFeedSource { read(): Promise<SessionFeed | null>; subscribe(listener: () => void): () => void }
export interface ViewerOptions<Client extends ViewerStreamClient = ViewerStreamClient> {
  piPackageRoot?: string;
  runId: RunId; sessionId: SessionId; feedRoot: string; runDbPath?: string; stdout: Writable; stdin: Readable; intent?: ViewerIntent; initialStatus?: RunSummary['status'];
  createClient(descriptor: IpcDescriptor): Client;
  submitSteer?: (client: Client, text: string) => Promise<SteerReply>;
  feedSource?: ViewerFeedSource; statusOutput?: Writable; signal?: AbortSignal; presenter?: ViewerPresenter;
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
  const presenter = options.presenter;
  // A line the user needs: the transcript in the pi view, the status stream in text.
  const say = (line: string) => { if (presenter) presenter.notice(line); else status.write(line + '\n'); };
  const feeds = options.feedSource ?? createViewerFeedSource(options.feedRoot, options.sessionId);
  const sanitizer = new TranscriptSanitizer();
  const messages = new TranscriptMessages();
  let cursor: RunCursor | null = null; let lastResult: string | null = null;
  let finished = false; let closed = false; let userClosed = false; let sawUnfinished = options.initialStatus === 'queued' || options.initialStatus === 'running' || options.initialStatus === 'paused'; let savedFinished = false;
  let canSteer = false; let canCompose = false; let feedAvailable = false; let reconnecting = false; let ownerClosed = false;
  let reconnectDelay = 250; let nextDiscovery = 0; let ownerReplaced = false;
  let unavailableSince: number | null = null; let finalReadOnly = false;
  const showReconnect = () => {
    // Reconnects are silent. The footer reports an owner that stays unreachable.
    unavailableSince ??= clock(); reconnecting = true; pushState();
  };
  let unavailable = 'Waiting for the owning session.';
  let currentFeed: SessionFeed | null = null; let lastRun: RunSummary | null = null; let streamActive = false;
  let lastReplyAt: number | null = null; let probePending = false; let compatible = false;
  let runDb: Db | undefined; let ownerlessFinalStatus: RunSummary['status'] | null = null;
  const responsive = () => streamActive && (!connectionState.client?.ping || lastReplyAt !== null && clock() - lastReplyAt < 3000);
  const finalStatus = (status: RunSummary['status'] | null) => status === 'done' || status === 'failed' || status === 'cancelled';
  const liveRpc = (run: RunSummary) => run.status === 'running' && run.childMode === 'rpc' && run.canSteer;
  const updateSteering = () => {
    const feedRun = currentFeed?.runs.rows.find(run => run.id === options.runId);
    // The stream owns this run's status; a non-running feed row also rules out steering.
    const run = lastRun && lastRun.status !== 'running' ? lastRun : feedRun ?? lastRun;
    canCompose = Boolean(feedAvailable && streamActive && lastRun && liveRpc(lastRun) && run && liveRpc(run) && !finished && !closed && !finalReadOnly && !ownerClosed);
    canSteer = canCompose && responsive();
    if (ownerClosed || finalReadOnly) return;
    unavailable = run && run.status !== 'running' ? `This run is ${run.status}.`
      : run?.childMode === 'print' ? 'This is a one-shot print child. Start a new run to change its brief.'
      : !feedAvailable || !responsive() ? 'The owning session is reconnecting.'
      : !run ? 'Waiting for the owning session.' : 'The owning session has no live RPC pipe.';
  };
  let reportedUnavailable: string | null = null;
  const reportUnavailable = () => {
    pushState();
    if (presenter || unavailable === reportedUnavailable) return;
    status.write(`[steering unavailable] ${unavailable}\n`); reportedUnavailable = unavailable;
  };
  let lastState = '';
  function pushState() {
    if (!presenter) return;
    updateSteering();
    const feedRun = currentFeed?.runs.rows.find(run => run.id === options.runId);
    const reachable = ownerClosed || finished || savedFinished || finalReadOnly || responsive();
    const status = ownerlessFinalStatus ?? (lastRun && finalStatus(lastRun.status) ? lastRun.status : feedRun && finalStatus(feedRun.status) ? feedRun.status
      : lastRun?.status ?? feedRun?.status ?? options.initialStatus ?? null);
    const next: ViewerState = { status, statusIsStale: status !== null && !finalStatus(status) && (ownerClosed || finalReadOnly || !responsive()), steerable: canSteer, canCompose,
      reachable, unreachableSince: reachable ? null : lastReplyAt ?? unavailableSince,
      readOnlyReason: canSteer ? null : unavailable };
    const key = JSON.stringify(next); if (key === lastState) return; lastState = key; presenter.state(next);
  }
  let versionNoticeShown = false; let lastStatusLine: string | null = null; let ownerName: string | null | undefined;
  const checkVersion = (view: RunViewInfo | undefined) => {
    if (!presenter || versionNoticeShown || view?.protocol === RUN_VIEW_PROTOCOL) return;
    versionNoticeShown = true;
    presenter.notice(view && view.protocol > RUN_VIEW_PROTOCOL ? 'The owning session runs a newer spider build. Reopen this viewer to see live updates.'
      : 'The owning session runs an older spider build. Live updates are off until it reloads.');
  };
  const connectionState: { client: Client | null } = { client: null };
  let connectionVersion = 0; let refusedVersion: number | null = null; let missingSince: number | null = null;
  let handoff: { version: number; reason: 'disposed' | 'wrong-generation' } | null = null;
  const generations = new Set<string>();
  let wake = () => {};
  let stop!: () => void; const stopped = new Promise<void>(resolve => { stop = resolve; });
  const interactiveInput = Boolean((options.stdin as Readable & { isTTY?: boolean }).isTTY);
  const composer = presenter ? null : createInterface({ input: options.stdin, output: status, terminal: interactiveInput });
  composer?.setPrompt('Steer> ');
  composer?.on('SIGINT', () => { userClosed = true; stop(); });
  composer?.on('close', () => { if (interactiveInput) { userClosed = true; stop(); } });
  composer?.on('line', text => {
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
  presenter?.bindSteer(async text => {
    const sendingClient = connectionState.client;
    if (!canSteer || !sendingClient || !options.submitSteer || finished || closed || options.signal?.aborted)
      return { delivery: 'refused', accepted: false, delivered: false, queued: false, error: unavailable };
    try { return await options.submitSteer(sendingClient, text); } catch { return null; }
  });
  presenter?.onQuit(() => { userClosed = true; stop(); });
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
        say('Owning session feed disappeared. Saved log is read-only.'); wake();
      }
      return;
    }
    missingSince = null;
    if (presenter && feed.owner.name !== ownerName) { ownerName = feed.owner.name; presenter.owner(ownerName); }
    if (feed.sessionId !== options.sessionId || feed.owner.sessionId !== options.sessionId) {
      if (connectionState.client) { connectionVersion++; connectionState.client = null; streamActive = false; wake(); }
      if (!finalReadOnly && !ownerClosed) say('Owning session changed. Saved log is read-only.');
      ownerReplaced = true; finalReadOnly = true; ownerClosed = true; feedAvailable = false; canSteer = false;
      unavailable = 'The owning session changed. Saved log is read-only.'; return;
    }
    if (currentFeed && (feed.updatedAt < currentFeed.updatedAt || feed.generation === currentFeed.generation && feed.revision < currentFeed.revision)) return;
    if (currentFeed && feed.generation !== currentFeed.generation && (generations.has(feed.generation) || feed.updatedAt <= currentFeed.updatedAt)) return;
    const changed = !currentFeed || feed.generation !== currentFeed.generation
      || feed.ipc?.address !== currentFeed.ipc?.address || feed.ipc?.capabilityFile !== currentFeed.ipc?.capabilityFile;
    if (finalReadOnly && !changed && currentFeed && feed.revision <= currentFeed.revision && feed.lifecycle !== 'closed') return;
    currentFeed = feed;
    if (feed.lifecycle === 'closed') {
      unavailableSince = null;
      if (!ownerClosed) {
        connectionVersion++; connectionState.client = null; streamActive = false;
        say('Owning session closed. Saved log is read-only.'); wake();
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
      say('Owning session unavailable for 30 seconds. Saved log is read-only.'); wake();
      return true;
    };
    if (!feed.ipc) {
      feedAvailable = false; canSteer = false; showReconnect(); unavailable = 'The owning session is reconnecting.';
      settleUnavailable(); return;
    }
    if (!streamActive && settleUnavailable()) return;
    const recovered = !feedAvailable; feedAvailable = true;
    if (changed || recovered || !connectionState.client) {
      streamActive = false; lastRun = null;
      generations.add(feed.generation); connectionVersion++; canSteer = false; unavailable = 'The owning session is reconnecting.';
      connectionState.client = options.createClient({ version: 1, sessionId: options.sessionId, generation: feed.generation, address: feed.ipc.address, capabilityFile: feed.ipc.capabilityFile });
      wake();
    } else {
      updateSteering();
      if (streamActive) { unavailableSince = null; handoff = null; }
      if (recovered && streamActive) reconnecting = false;
      pushState();
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
  const probe = async () => {
    const selected = connectionState.client, version = connectionVersion;
    if (!selected?.ping || !streamActive || probePending || ownerClosed || finished || savedFinished) return;
    probePending = true;
    try {
      const reply = await selected.ping({ timeoutMs: 3000 });
      if (version === connectionVersion && selected === connectionState.client && reply.ok && reply.op === 'ping') lastReplyAt = clock();
    } catch { /* The age of the last reply drives the footer, not a feed heartbeat. */ }
    finally { probePending = false; updateSteering(); pushState(); }
  };
  const checkOwnerlessRun = () => {
    if (!options.runDbPath || streamActive && feedAvailable || finished || savedFinished || userClosed || options.signal?.aborted) return;
    try {
      runDb ??= openDbReadOnly(options.runDbPath, { busyTimeoutMs: 50 });
      const row = runDb?.prepare('SELECT status FROM runs WHERE id=? AND session_id=?').get(options.runId, options.sessionId) as { status: RunSummary['status'] } | undefined;
      if (!row) return;
      if (row.status === 'queued' || row.status === 'running' || row.status === 'paused') sawUnfinished = true;
      else if (finalStatus(row.status) && (options.intent === 'automatic' || sawUnfinished)) {
        ownerlessFinalStatus = row.status; finished = true; canSteer = false; pushState(); stop();
      }
    } catch { runDb?.close(); runDb = undefined; }
  };
  const timer = setInterval(() => { void refresh(); void probe(); checkOwnerlessRun(); }, 1000); timer.unref?.();
  const stateTimer = presenter ? setInterval(pushState, 250) : undefined; stateTimer?.unref?.();
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
          lastReplyAt = clock();
          cursor = frame.cursor;
          switch (frame.kind) {
            case 'snapshot': {
              const run = frame.data.run; lastRun = run; streamActive = true; compatible = frame.data.view?.protocol === RUN_VIEW_PROTOCOL;
              if (run.status === 'queued' || run.status === 'running' || run.status === 'paused') sawUnfinished = true;
              if (feedAvailable) {
                reconnecting = false; finalReadOnly = false; ownerClosed = false; unavailableSince = null; handoff = null;
              }
              reconnectDelay = 250;
              updateSteering();
              const line = `[${safe(run.status)} · ${run.childMode}]`;
              if (presenter) { presenter.snapshot(run, frame.data.view ?? null); checkVersion(frame.data.view); pushState(); }
              else if (line !== lastStatusLine) { status.write(line + '\n'); lastStatusLine = line; }
              if (!canSteer) reportUnavailable();
              if (canSteer && (options.stdin as Readable & { isTTY?: boolean }).isTTY) composer?.prompt(true);
              if (!presenter && run.result && run.result !== lastResult) { options.stdout.write(safe(run.result) + '\n'); lastResult = run.result; }
              break;
            }
            case 'event': {
              const text = sanitizer.push(frame.data.text);
              const summaries = frame.data.events.filter(event => event.runId === options.runId && (event.summary || event.tool) && messages.shouldRender(event))
                .map(event => `[${safe(event.type)}] ${safe(event.summary ?? event.tool ?? '')}\n`).join('');
              if (presenter) { if (text || summaries) presenter.page(text + summaries); break; }
              options.stdout.write(text); status.write(summaries);
              break;
            }
            case 'live': if (compatible) presenter?.live(frame.data.event); break;
            case 'gap': if (!presenter) status.write(`[gap] ${safe(frame.data.reason)}\n`); break;
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
        }, ...(presenter ? [{ view: RUN_VIEW_PROTOCOL }] : []));
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
        if (refusedVersion === version && !presenter) status.write(`[steering unavailable] ${unavailable}\n`);
        pushState();
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
    clearInterval(timer); clearInterval(stateTimer); clearTimeout(lifecycleTimer); unsubscribe(); composer?.close(); runDb?.close(); options.signal?.removeEventListener('abort', stop); await options.release?.();
  }
}
function safe(text: string): string { return new TranscriptSanitizer().push(text); }
