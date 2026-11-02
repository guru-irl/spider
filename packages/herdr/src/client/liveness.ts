// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { connect } from 'node:net';
import { HerdrError, selectedSocket } from './parse.js';

/** A bounded, transport-only probe: hc itself would auto-start a missing core. */
export function isCoreAvailable(env: Readonly<NodeJS.ProcessEnv>, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const selected = selectedSocket(env);
    if (env.HC_TERMINAL_SOCKET && env.HC_TERMINAL_SOCKET !== selected) { resolve(false); return; }
    const socket = connect(selected);
    let timeoutDecision: ReturnType<typeof setImmediate> | undefined;
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); if (timeoutDecision) clearImmediate(timeoutDecision);
      signal?.removeEventListener('abort', aborted);
      socket.destroy();
      resolve(available);
    };
    const aborted = () => finish(false);
    // A blocked loop can run overdue timers before delivering a successful
    // connect. Give pending socket I/O one poll phase before deciding timeout.
    const timeout = setTimeout(() => { timeoutDecision = setImmediate(() => finish(false)); }, 250);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export async function requireCoreAvailable(env: Readonly<NodeJS.ProcessEnv>, signal?: AbortSignal): Promise<void> {
  if (env.HC_TERMINAL_SOCKET && env.HC_TERMINAL_SOCKET !== selectedSocket(env)) throw new HerdrError('core-mismatch', 'Caller terminal belongs to a different Herdr core socket');
  if (!await isCoreAvailable(env, signal)) throw new HerdrError('core-unavailable', 'Herdr core is not running');
}
