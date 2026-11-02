// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { createHash } from 'node:crypto';
import type { Db, RunEvent } from '@spider/db-core';
import { RunStore, type RunRow } from '../../../subagents/src/run-store.js';
import { getChild } from '../../../subagents/src/coordinators.js';
import { listTodos } from '../../../todo/src/store.js';
import { listPending } from '../../../memory/src/staging.js';
import { scrubSecrets } from '@spider/memory';
import type { Owner, SessionDataSource, SessionFeed, HerdrConfig, JobRecord, PaceSummary, PanelNotification } from '../../../herdr/src/contracts.js';
import type { SessionScheduler } from '../loop/index.js';
import { computePace } from '../usage/billing-pace.js';
import type { PanelUsage } from '../usage/protocol.js';
import { formatCompact, formatExact, formatMonthTitle, formatLocalTime } from '../usage/web/format.js';
import type { PaceLabels, SessionMonthCost } from '../../../herdr/src/contracts.js';
export interface HostDataSourceOptions {
  /** Each opener transfers a fresh handle; the adapter closes it after its read. */
  resolveRunDb(owner: Owner): { db: Db; dbPath: string };
  openApprovalDbs(owner: Owner): { global: Db; repo: { db: Db; repoKey: string } | null };
  runEvents: { on(listener: (event: RunEvent) => void): () => void };
  readJobJournal(owner: Owner): Promise<readonly JobRecord[]>;
  scheduler: Pick<SessionScheduler, 'listTriggers' | 'subscribe'>;
  readUsage(now: number, owner: Owner): Promise<PanelUsage | (Omit<Parameters<typeof computePace>[0], 'now'> & { updatedAt: number | null; monthCost?: SessionMonthCost })>;
  readConfig(owner: Owner): Pick<HerdrConfig, 'limits'> & Partial<Pick<HerdrConfig, 'globalRoot'>>;
  /** Validated core labels and read-only layout facts, never configured space guesses. */
  readOwnerFacts?(owner: Owner): Promise<Pick<SessionFeed, 'placement' | 'status' | 'ipc'>>;
  clock(): number;
}
const preview = (text: string, limit = 180): string => scrubSecrets(text).text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').slice(0, limit);
interface OwnedFacts { rows: RunRow[]; total: number; truncated: boolean; todos: SessionFeed['todos']['rows']; approvals: SessionFeed['approvals']; notifications: PanelNotification[] }
interface StoredRunNotice { run_id: string; ts: number; type: string; summary: string | null; payload: string | null; run_name: string | null; run_result: string | null; run_status: RunRow['status'] }
function readRunNotifications(db: Db, owner: Owner, cutoff: number): PanelNotification[] {
  const records = db.prepare(`SELECT e.run_id, e.ts, e.type, e.summary, e.payload, r.name AS run_name, r.result AS run_result, r.status AS run_status
    FROM run_events e JOIN runs r ON r.id = e.run_id AND r.session_id = e.session_id
    WHERE e.session_id = ? AND e.ts >= ? AND e.type IN ('escalation', 'status') ORDER BY e.ts DESC, e.id DESC LIMIT 1000`).all(owner.sessionId, cutoff) as StoredRunNotice[];
  const notifications = new Map<string, PanelNotification>();
  for (const event of records) {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(event.payload ?? '{}'); } catch { continue; }
    const escalation = event.type === 'escalation';
    if (!escalation && (!['done', 'failed', 'cancelled'].includes(String(payload?.status)) || !['done', 'failed', 'cancelled'].includes(event.run_status))) continue;
    const fingerprint = createHash('sha256').update(JSON.stringify([payload?.severity, event.summary])).digest('hex').slice(0, 16);
    const id = escalation ? `escalation:${event.run_id}:${fingerprint}` : `subagent-result:${event.run_id}`;
    if (notifications.has(id)) continue;
    notifications.set(id, { id, kind: escalation ? 'escalation' : 'subagent-result', createdAt: event.ts, scope: 'session', sessionId: owner.sessionId, ownerAddress: owner.terminal.address,
      title: preview(event.run_name ?? event.run_id), body: preview(escalation ? event.summary ?? 'Run needs attention' : event.run_result ?? event.run_status, 2000), action: { kind: 'focus-owner', sessionId: owner.sessionId, address: owner.terminal.address } });
  }
  return [...notifications.values()];
}
const USAGE_CACHE_TTL = 30000;
interface UsageCache { at: number; period?: ReturnType<typeof computePace>['period']; valueAt?: number; pending: boolean; publishedPending?: boolean; pace?: PaceSummary; monthCost?: SessionMonthCost }
interface OwnerCache { sessionId: string; readAt: number; dirty: boolean; revision: number; facts: OwnedFacts | null; lastSnapshot?: SessionFeed; usage?: UsageCache }
export interface HostSessionDataSource extends SessionDataSource { snapshot(owner: Owner, lifecycle?: SessionFeed['lifecycle']): Promise<SessionFeed> }
const unavailablePace = (): PaceSummary => ({ scope: 'shared', used: null, budget: null, projected: null, remaining: null, periodStart: null, periodEnd: null, updatedAt: null, unavailableReason: 'usage-counter-unavailable' });
/** The dashboard's own strings for the pace values; the panel runtime cannot format numbers. */
export function paceLabels(pace: Omit<PaceSummary, 'labels'>): PaceLabels {
  return { month: pace.periodStart === null ? null : formatMonthTitle(pace.periodStart), usedCompact: formatCompact(pace.used), used: formatExact(pace.used),
    projected: formatExact(pace.projected), budget: formatExact(pace.budget), remaining: formatExact(pace.remaining),
    updatedAt: pace.updatedAt === null ? null : formatLocalTime(pace.updatedAt, Intl.DateTimeFormat().resolvedOptions().timeZone) };
}
const UNAVAILABLE_COST: SessionMonthCost = { credits: null, label: 'unavailable' };
export function budgetNotifications(pace: PaceSummary): PanelNotification[] {
  if (pace.budget === null || pace.budget <= 0 || pace.periodStart === null) return [];
  const thresholds: (80 | 100 | 'projected')[] = [];
  if (pace.used !== null && pace.used >= pace.budget * 0.8) thresholds.push(80);
  if (pace.used !== null && pace.used >= pace.budget) thresholds.push(100);
  if (pace.projected !== null && pace.projected > pace.budget) thresholds.push('projected');
  return thresholds.map(threshold => ({ id: `budget:${pace.periodStart}:${threshold}`, kind: 'budget', createdAt: pace.updatedAt ?? pace.periodStart!, scope: 'shared', sessionId: null, ownerAddress: null,
    title: 'Account usage', body: threshold === 'projected' ? 'Projected usage exceeds the period budget.' : `Account usage reached ${threshold}% of the period budget.`, action: { kind: 'open-usage', scope: 'shared' } }));
}
function jobNotifications(records: readonly JobRecord[], owner: Owner): PanelNotification[] {
  return records.filter(job => job.owner.sessionId === owner.sessionId && (job.phase.kind === 'finished' || job.phase.kind === 'disconnected' && job.exitEvidence)).map(job => {
    if (job.phase.kind !== 'finished' && job.phase.kind !== 'disconnected') throw new Error('Completed job evidence expected');
    const evidence = job.exitEvidence;
    const result = job.phase.kind === 'finished' ? job.phase.result : { exitCode: null, signal: null, reason: 'unknown', finishedAt: Math.max(evidence!.native.finishedAt, evidence!.receipt.finishedAt) };
    return { id: `job-result:${job.id}`, kind: 'job-result', createdAt: result.finishedAt, scope: 'session', sessionId: job.owner.sessionId, ownerAddress: job.owner.terminal.address,
      job: { id: job.id, runId: job.runId ?? null, commandPreview: preview(job.commandPreview || `Job ${job.id}`), machine: job.machine, exitCode: result.exitCode,
        signal: result.signal, finishedAt: result.finishedAt, address: job.phase.address, ...(evidence ? { outcome: 'unknown' as const, evidenceConflict: true, exitEvidence: evidence } : {}) },
      title: preview(`Job ${job.id} on ${job.machine}`), body: preview(evidence ? `Exit uncertain: native exit ${evidence.native.exitCode ?? 'unknown'}, signal ${evidence.native.signal ?? 'none'}; receipt exit ${evidence.receipt.exitCode ?? 'unknown'}, signal ${evidence.receipt.signal ?? 'none'}.` : `Exit ${result.exitCode ?? 'unknown'} (${result.reason}).`), action: { kind: 'focus-owner', sessionId: job.owner.sessionId, address: job.owner.terminal.address } };
  });
}
export function createHerdrDataSource(options: HostDataSourceOptions): HostSessionDataSource {
  let disposed = false;
  const listeners = new Set<() => void>();
  const caches = new Map<string, OwnerCache>();
  const notify = () => { if (!disposed) for (const listener of listeners) { try { listener(); } catch { /* read-only subscribers cannot break committed writes */ } } };
  const removeEvents = options.runEvents.on(event => {
    const shared = event.tool === 'memory' || event.type.includes('memory');
    let changed = shared;
    for (const cache of caches.values()) {
      if (cache.sessionId === event.sessionId || shared) { cache.dirty = true; changed = true; }
    }
    if (changed) notify();
  });
  const removeScheduler = options.scheduler.subscribe(notify);
  const timer = setInterval(() => { for (const cache of caches.values()) cache.dirty = true; notify(); }, 2000);
  timer.unref();
  const accountUsage = async (owner: Owner, cache: OwnerCache, now: number): Promise<UsageCache> => {
    const period = cache.usage?.period;
    const periodChanged = period !== undefined && (now < period.start || now >= period.end);
    if (!cache.usage || periodChanged || !cache.usage.pending && (now - cache.usage.at >= USAGE_CACHE_TTL || now < cache.usage.at)) {
      const previous = periodChanged ? undefined : cache.usage;
      const reading: UsageCache = { at: now, period: previous?.period, pending: true, valueAt: previous?.valueAt, pace: previous?.pace, monthCost: previous?.monthCost };
      cache.usage = reading;
      void (async () => {
        try {
          const usage = await options.readUsage(now, owner);
          if (disposed || cache.usage !== reading) return;
          const calculated = 'pace' in usage ? usage.pace : computePace({ ...usage, now });
          reading.pace = { scope: 'shared', used: calculated.used, budget: calculated.budget, projected: calculated.projected, remaining: calculated.remaining, periodStart: calculated.period.start, periodEnd: calculated.period.end, updatedAt: usage.updatedAt, unavailableReason: calculated.used === null ? 'usage-counter-unavailable' : null };
          reading.pace.labels = paceLabels(reading.pace);
          reading.monthCost = usage.monthCost;
          reading.period = calculated.period;
          reading.valueAt = now;
        } catch {
          reading.pace = { ...unavailablePace(), unavailableReason: 'usage-read-failed' };
          reading.monthCost = undefined;
          reading.valueAt = undefined;
        }
        finally { reading.pending = false; if (reading.publishedPending) notify(); }
      })();
    }
    // Already-resolved adapters may populate this turn. Never await native work.
    await Promise.resolve();
    if (cache.usage.pending) {
      cache.usage.publishedPending = true;
      // A replacement must not renew the age of the number it is replacing.
      if (cache.usage.valueAt === undefined || now < cache.usage.valueAt || now - cache.usage.valueAt > 2 * USAGE_CACHE_TTL) {
        cache.usage.pace = undefined;
        cache.usage.monthCost = undefined;
      }
    }
    return cache.usage;
  };
  const readFacts = (owner: Owner): OwnedFacts => {
    const { db } = options.resolveRunDb(owner);
    let rows: RunRow[]; let total: number; let truncated: boolean; let todos: OwnedFacts['todos']; let notifications: PanelNotification[];
    try {
      const limits = options.readConfig(owner).limits;
      const cutoff = options.clock() - limits.completedHours * 3600000;
      const retained = "session_id = ? AND status IN ('done', 'failed', 'cancelled') AND ended_at >= ?";
      const values = db.transaction(() => {
        const active = new RunStore(db).listActive(owner.sessionId);
        const completed = db.prepare(`SELECT * FROM runs WHERE ${retained} ORDER BY ended_at DESC, id LIMIT ?`).all(owner.sessionId, cutoff, limits.completedRows) as RunRow[];
        const count = db.prepare(`SELECT COUNT(*) AS total FROM runs WHERE ${retained}`).get(owner.sessionId, cutoff) as { total: number };
        return { rows: [...active, ...completed], total: active.length + count.total, truncated: count.total > completed.length, todos: listTodos(db, owner.sessionId).map(todo => ({ ...todo, text: preview(todo.text, 2000), sessionId: owner.sessionId })) };
      })();
      ({ rows, total, truncated, todos } = values);
      notifications = readRunNotifications(db, owner, cutoff);
    } finally { db.close(); }
    const handles = options.openApprovalDbs(owner);
    let approvals: SessionFeed['approvals'];
    try {
      approvals = listPending(handles.global, 'global').map(record => ({ uuid: record.uuid, scope: 'global', repoKey: null, ownerSessionId: null, category: record.category, preview: preview(record.content) }));
      if (handles.repo) approvals.push(...listPending(handles.repo.db, 'repo').map(record => ({ uuid: record.uuid, scope: 'repo' as const, repoKey: handles.repo!.repoKey, ownerSessionId: record.sessionId as Owner['sessionId'] | null, category: record.category, preview: preview(record.content) })));
    } finally { handles.global.close(); handles.repo?.db.close(); }
    approvals = [...new Map(approvals.map(row => [JSON.stringify([row.scope, row.repoKey, row.uuid]), row])).values()];
    return { rows, total, truncated, todos, approvals, notifications };
  };
  return {
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { if (disposed) return; disposed = true; clearInterval(timer); removeEvents(); removeScheduler(); listeners.clear(); caches.clear(); },
    async snapshot(owner, lifecycle = 'live') {
      if (disposed) throw new Error('data-source-disposed');
      const now = options.clock(); const key = JSON.stringify([owner.sessionId, owner.generation]);
      let cache = caches.get(key);
      if (!cache) { cache = { sessionId: owner.sessionId, readAt: now, dirty: true, revision: 0, facts: null }; caches.set(key, cache); }
      if (lifecycle === 'closed') {
        if (!cache.lastSnapshot) throw new Error('No live snapshot to close');
        return { ...cache.lastSnapshot, lifecycle, ipc: null, revision: ++cache.revision, updatedAt: now };
      }
      if (cache.dirty || now - cache.readAt >= 2000 || !cache.facts) { cache.facts = readFacts(owner); cache.readAt = now; cache.dirty = false; }
      const facts = cache.facts;
      const rows: SessionFeed['runs']['rows'] = facts.rows.map(row => ({ id: row.id as SessionFeed['runs']['rows'][number]['id'], ownerSessionId: owner.sessionId, name: row.name === null ? null : preview(row.name), status: row.status, childMode: row.child_mode ?? 'print', canSteer: row.status === 'running' && row.child_mode === 'rpc' && Boolean(getChild(owner.sessionId, row.id)?.steer), startedAt: row.started_at, finishedAt: row.ended_at, viewer: null, result: row.result === null ? null : preview(row.result, 2000) }));
      const usage = await accountUsage(owner, cache, now);
      const account = { ...(usage.pace ?? unavailablePace()) };
      const errors: SessionFeed['errors'] = [];
      let live: Awaited<ReturnType<NonNullable<HostDataSourceOptions['readOwnerFacts']>>> | undefined;
      let jobs: readonly JobRecord[] = [];
      try { live = await options.readOwnerFacts?.(owner); } catch { errors.push({ source: 'placement', message: 'Observed owner placement is unavailable.' }); }
      try { jobs = await options.readJobJournal(owner); } catch { errors.push({ source: 'jobs', message: 'Owned job journal is unavailable.' }); }
      const notices = [...new Map([...facts.notifications, ...jobNotifications(jobs, owner), ...budgetNotifications(account)].map(notice => [notice.id, notice])).values()];
      if (disposed) throw new Error('data-source-disposed');
      const feed: SessionFeed = { version: 1, sessionId: owner.sessionId, generation: owner.generation, revision: ++cache.revision, updatedAt: options.clock(), owner,
        placement: live?.placement ?? null, lifecycle: 'live', status: live?.status ?? { native: null, effective: null, message: null },
        runs: { rows, total: facts.total, truncated: facts.truncated }, todos: { rows: facts.todos.map(row => ({ ...row })), total: facts.todos.length, truncated: false },
        triggers: options.scheduler.listTriggers().map(trigger => ({ name: trigger.name, kind: trigger.kind === 'once' ? 'schedule' : 'loop', nextAt: trigger.nextAt, tz: trigger.tz, state: trigger.state, prompt: preview(trigger.prompt, 80) })),
        pace: account, approvals: facts.approvals.map(row => ({ ...row })), notifications: notices, ipc: live?.ipc ?? null, errors, monthCost: { ...(usage.monthCost ?? UNAVAILABLE_COST) } };
      cache.lastSnapshot = feed; return feed;
    },
  };
}
