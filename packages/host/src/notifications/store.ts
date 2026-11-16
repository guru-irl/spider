// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { randomUUID } from 'node:crypto';
import { appendEvent, type Db } from '@spider/db-core';
import type { NotificationUrgency, RunId, SessionId } from '../../../herdr/src/contracts.js';
import type { parseNotificationInput } from './action.js';

const LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const LIMIT = 64;
type Input = ReturnType<typeof parseNotificationInput>;
export interface StoredNotification { id: string; createdAt: number; message: string; urgency: NotificationUrgency; runId: RunId | null }
interface EventRecord { ts: number; payload: string }

function fromEvent(row: EventRecord): StoredNotification | null {
  try {
    const payload: unknown = JSON.parse(row.payload);
    if (!payload || typeof payload !== 'object') return null;
    const value = payload as Record<string, unknown>;
    if (value.version !== 1 || value.kind !== 'agent-notification' || typeof value.id !== 'string' || !value.id
      || typeof value.message !== 'string' || !value.message.trim() || Array.from(value.message).length > 500
      || !['low', 'attention', 'urgent'].includes(value.urgency as string)
      || value.runId !== null && (typeof value.runId !== 'string' || !value.runId)) return null;
    return { id: value.id, createdAt: row.ts, message: value.message, urgency: value.urgency as NotificationUrgency, runId: value.runId as RunId | null };
  } catch { return null; }
}

/** A tool call is one occurrence even if its acknowledgement is retried. */
export function storeNotification(db: Db, caller: { sessionId: SessionId; runId: RunId | null }, toolCallId: string, input: Input, now: number): StoredNotification {
  if (!toolCallId.trim()) throw new Error('notify requires a tool call ID');
  return db.withRetry(() => db.transaction(() => {
    // Reserve the writer before reading so concurrent retries cannot both insert.
    db.prepare('UPDATE events SET id = id WHERE 0').run();
    const previous = db.prepare(`SELECT ts, payload FROM events WHERE session_id=? AND phase='after' AND tool='notify'
      AND json_valid(payload) AND json_extract(payload, '$.version')=1 AND json_extract(payload, '$.kind')='agent-notification'
      AND json_extract(payload, '$.toolCallId')=? AND COALESCE(json_extract(payload, '$.runId'), '')=COALESCE(?, '') ORDER BY id LIMIT 1`)
      .get(caller.sessionId, toolCallId, caller.runId) as EventRecord | undefined;
    const existing = previous && fromEvent(previous);
    if (existing) return existing;
    const note: StoredNotification = { id: randomUUID(), createdAt: now, message: input.message, urgency: input.urgency, runId: caller.runId };
    appendEvent(db, { sessionId: caller.sessionId, ts: now, phase: 'after', tool: 'notify', payload: {
      version: 1, kind: 'agent-notification', id: note.id, toolCallId, message: note.message, urgency: note.urgency, runId: note.runId,
    } });
    return note;
  })());
}

/** Only valid intentional occurrences within their seven-day lifetime become feed entries. */
export function readNotifications(db: Db, sessionId: SessionId, now: number): StoredNotification[] {
  const rows = db.prepare(`SELECT ts, payload FROM events WHERE session_id=? AND phase='after' AND tool='notify'
    AND ts>=? AND ts<=? AND json_valid(payload) AND json_extract(payload, '$.version')=1
    AND json_extract(payload, '$.kind')='agent-notification'
    ORDER BY ts DESC, json_extract(payload, '$.id') ASC`).iterate(sessionId, now - LIFETIME_MS, now) as Iterable<EventRecord>;
  const result: StoredNotification[] = [];
  for (const row of rows) {
    const note = fromEvent(row);
    if (note) result.push(note);
    if (result.length === LIMIT) break;
  }
  return result;
}
