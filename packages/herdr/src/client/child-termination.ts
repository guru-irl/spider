// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import type { ChildProcess } from 'node:child_process';

/** Capture close at spawn; all stop callers join the same reaping fence. */
export function createChildTerminator(child: ChildProcess): () => Promise<void> {
  let closed = false, stopping: Promise<void> | undefined;
  const exit = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
  return () => {
    if (stopping) return stopping;
    if (closed) return exit;
    stopping = (async () => {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      try { await exit; } finally { clearTimeout(timer); }
    })();
    return stopping;
  };
}
