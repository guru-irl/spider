// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
// One named wait primitive: observe, test, re-observe on a signal or a bounded reconcile tick, fail at the deadline.
import { HarnessError } from './environment.js';

export interface Deadline { expiresAt: number; signal: AbortSignal }
export function deadline(ms: number, signal?: AbortSignal): Deadline {
  const timeout = AbortSignal.timeout(ms);
  return { expiresAt: Date.now() + ms, signal: signal ? AbortSignal.any([timeout, signal]) : timeout };
}
export interface WaitOptions {
  /** Install a change listener; call wake() on every change. Returns an unsubscribe function. */
  subscribe?: (wake: () => void) => () => void;
  /** Bounded reconcile interval when the interface has no event. A tick schedules an observation, never success. */
  reconcileMs?: number;
}

export async function waitFor<T>(description: string, observe: () => T | Promise<T>, predicate: (value: T) => boolean, limit: Deadline, options: WaitOptions = {}): Promise<T> {
  let last: T | undefined; let wake: (() => void) | undefined;
  const unsubscribe = options.subscribe?.(() => wake?.());
  const started = Date.now();
  try {
    for (;;) {
      if (limit.signal.aborted) {
        const timedOut = Date.now() >= limit.expiresAt - 5;
        throw new HarnessError(timedOut ? 'wait-deadline' : 'wait-aborted', `${description} (after ${Date.now() - started} ms)`, { last });
      }
      const changed = new Promise<void>(resolve => { wake = resolve; });
      last = await observe();
      if (predicate(last)) return last;
      await new Promise<void>(resolve => {
        const tick = setTimeout(resolve, options.reconcileMs ?? 100);
        const stop = () => { clearTimeout(tick); limit.signal.removeEventListener('abort', stop); resolve(); };
        limit.signal.addEventListener('abort', stop, { once: true });
        void changed.then(stop);
      });
    }
  } finally { unsubscribe?.(); }
}
