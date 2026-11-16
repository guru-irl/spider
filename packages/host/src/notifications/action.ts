// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { isAbsolute } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { openDb } from '@spider/db-core';
import { isLocalRun } from '@spider/db-core/roam/run-origin';
import { scrubSecrets } from '@spider/memory';
import { RunStore } from '../../../subagents/src/run-store.js';
import type { NotificationUrgency, RunId, SessionId } from '../../../herdr/src/contracts.js';
import type { ActionCtx, SpiderArgs } from '../dispatch.js';
import { openSessionHistoryDb } from '../session-run-db.js';
import { storeNotification } from './store.js';

export function parseNotificationInput(input: unknown): { message: string; urgency: NotificationUrgency } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('notify requires a message');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['action', 'message', 'urgency'].includes(key))) throw new Error('notify has an unsupported parameter');
  const { action, message, urgency } = value;
  if (action !== undefined && action !== 'notify') throw new Error('invalid notify action');
  if (typeof message !== 'string') throw new Error('notify requires a message');
  const cleaned = scrubSecrets(stripVTControlCharacters(message).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, ' ')).text.trim();
  if (!cleaned || !cleaned.replace(/\[REDACTED:[^\]]+\]/g, '').trim() || Array.from(cleaned).length > 500) throw new Error('notify message must contain 1 to 500 characters after scrubbing');
  if (urgency !== undefined && urgency !== 'low' && urgency !== 'attention' && urgency !== 'urgent') throw new Error('notify urgency must be low, attention, or urgent');
  return { message: cleaned, urgency: urgency ?? 'attention' };
}

/** Store independently of Herdr. The optional queue reports publication, not delivery. */
export function notifyHandler(args: SpiderArgs, ctx: ActionCtx, queue: (sessionId: SessionId) => boolean): { ok: true; id: string; presentation: 'stored' | 'panel-feed' } {
  const input = parseNotificationInput(args);
  if (typeof ctx.toolCallId !== 'string' || !ctx.toolCallId.trim()) throw new Error('notify requires a tool call ID');
  const child = process.env.PI_SUBAGENT_CHILD === '1';
  let sessionId: SessionId, runId: RunId | null, dbPath: string;
  if (child) {
    const inherited = process.env.PI_SPIDER_SESSION_ID, top = process.env.PI_SPIDER_TOP_SESSION_ID;
    const run = process.env.PI_SUBAGENT_RUN_ID, path = process.env.PI_SPIDER_DB_PATH;
    if (top && inherited && top !== inherited) throw new Error('notify is unavailable to nested or remote subagents');
    if (!inherited || !run || !path || !isAbsolute(path)) throw new Error('notify child ownership is unavailable; nested or remote subagents cannot notify');
    sessionId = inherited as SessionId; runId = run as RunId; dbPath = path;
  } else {
    if (!ctx.sessionId) throw new Error('notify session ownership is unavailable');
    sessionId = ctx.sessionId as SessionId; runId = null;
    const history = openSessionHistoryDb(ctx.injectionCwd ?? ctx.cwd, sessionId);
    dbPath = history.dbPath; history.db.close();
  }
  let db: ReturnType<typeof openDb>;
  try { db = openDb(dbPath, { fileMustExist: true }); }
  catch (error) {
    if (child && (error as NodeJS.ErrnoException).code === 'SQLITE_CANTOPEN') throw new Error('notify is unavailable to nested or remote subagents');
    throw error;
  }
  try {
    const note = db.withRetry(() => db.transaction(() => {
      if (runId) {
        // Lock before checking identity so ownership cannot change before the event is written.
        db.prepare('UPDATE events SET id = id WHERE 0').run();
        const run = new RunStore(db).get(runId);
        if (!run || !isLocalRun(db, runId) || run.session_id !== sessionId || run.pid !== process.pid || !['queued', 'running', 'paused'].includes(run.status)) throw new Error('notify child ownership does not match the recorded run; nested or remote subagents cannot notify');
      }
      return storeNotification(db, { sessionId, runId }, ctx.toolCallId!, input, Date.now());
    })());
    let queued = false;
    if (!child) { try { queued = queue(sessionId); } catch { /* The committed event remains available to a later feed. */ } }
    return { ok: true, id: note.id, presentation: queued ? 'panel-feed' : 'stored' };
  } finally { db.close(); }
}
