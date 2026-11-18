// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { waitFor, type Deadline } from '../harness/wait.js';

export interface OwnedSteer { cwd: string; runId: string; message: string }

export async function waitForOwnedSteer(target: OwnedSteer, limit: Deadline): Promise<void> {
  // Tool start precedes dispatch. The supervisor persists the child's own RPC
  // queue_update independently of the owner's event sink, including on reload.
  const db = new Database(join(target.cwd, '.spider/project.db'), { readonly: true });
  try {
    const latest = db.prepare("SELECT payload FROM run_events WHERE run_id=? AND type='queue_update' ORDER BY id DESC LIMIT 1");
    await waitFor(`owned steer queued in child ${target.runId}: ${target.message}`, () => {
      const row = latest.get(target.runId) as { payload: string } | undefined;
      return row ? JSON.parse(row.payload) as { steering?: unknown } | null : null;
    }, queue => Array.isArray(queue?.steering) && queue.steering.includes(target.message), limit);
  } finally { db.close(); }
}
