// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Disposable, Owner, PendingCounts, SessionFeed } from '../contracts.js';
import { installStatusAdapter, type StatusAdapter, type StatusTerminal } from './adapter.js';
export interface StatusPorts {
  currentOwner(ctx: ExtensionContext): Owner | null;
  listPending(owner: Owner): PendingCounts | Promise<PendingCounts>;
  subscribeRuns(owner: Owner, listener: () => void): () => void;
  reportDisabled(reason: string): void;
}
export interface StatusContribution extends Disposable { currentStatus(owner: Owner): SessionFeed['status'] | null }
export function registerHerdrStatusContribution(pi: ExtensionAPI, ports: StatusPorts): StatusContribution {
  let active: { adapter: StatusAdapter; owner: Pick<Owner, 'sessionId' | 'generation'>; stop: () => void } | null = null;
  let disposed = false;
  const stop = () => { const previous = active; active = null; previous?.stop(); };
  pi.on('session_start', async (_event, ctx) => {
    stop();
    if (disposed || ctx.mode !== 'tui' || process.env.PI_SUBAGENT_CHILD === '1' || !process.env.HC_TERMINAL_ID) return;
    let terminal: StatusTerminal | undefined;
    let accepting = true;
    ctx.ui.setWidget('spider-herdr-status', tui => {
      if (accepting) terminal = tui.terminal;
      return { render: () => [], invalidate() {} };
    });
    accepting = false;
    ctx.ui.setWidget('spider-herdr-status', undefined);
    if (!terminal) { ports.reportDisabled('status-widget-capture-unavailable'); return; }
    const owner = ports.currentOwner(ctx);
    if (!owner) { ports.reportDisabled('status-owner-unavailable'); return; }
    const adapter = installStatusAdapter(terminal, { running: 0, queued: 0, paused: 0 });
    if ('disabled' in adapter) { ports.reportDisabled(adapter.reason); return; }
    let sequence = 0;
    let warned = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    const activation = { adapter, owner: { sessionId: owner.sessionId, generation: owner.generation }, stop() { unsubscribe(); clearInterval(timer); adapter.dispose(); } };
    active = activation;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const counts = await ports.listPending(owner);
        if (active === activation && request === sequence) { warned = false; adapter.update(counts); }
      } catch {
        if (active === activation && request === sequence && !warned) {
          warned = true; ports.reportDisabled('status-counts-unavailable');
        }
      }
    };
    unsubscribe = ports.subscribeRuns(owner, () => { void refresh(); });
    timer = setInterval(() => { void refresh(); }, 2000);
    timer.unref();
    await refresh();
  });
  pi.on('session_shutdown', () => { stop(); });
  return {
    currentStatus(owner) { return active?.owner.sessionId === owner.sessionId && active.owner.generation === owner.generation ? active.adapter.currentStatus() : null; },
    dispose() { disposed = true; stop(); },
  };
}
