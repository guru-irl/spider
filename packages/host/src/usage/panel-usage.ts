import { isMainThread } from 'node:worker_threads';
import { DashboardQueryError, type DashboardQueryContext } from './dashboard-contract.js';
import { openDashboardReader } from './dashboard-reader.js';
import { billingPeriod, computePace } from './billing-pace.js';
import { latestValidCounter } from './latest-valid-counter.js';
import { readCorrectedTotal, readSessionUsageCube, sumValues, type SessionUsageScope } from './query-redesign-shared.js';
import { scopeFor, scopedRange } from './query-session.js';
import { readPaceHistoryFromDb } from './pace-history.js';
import { formatValue } from './web/format.js';
import { DAY_MS } from './dashboard-selection.js';
import type { PanelUsage } from './protocol.js';

export type PanelUsageReader = {
  read(now: number, sessionId: string, budget: number | undefined, calibrationMode: 'auto' | 'off'): PanelUsage | null;
  close(): void;
};

const MAX_IDENTITY_BYTES = 512 * 1024;
type Pair = { sessionId: string | null; runId: string | null };
const pairKey = ({ sessionId, runId }: Pair) => JSON.stringify([sessionId, runId]);

// Keep this closure separate from the resolver and its request-local dictionary.
function pairMatcher(owned: Set<string>): (row: Pair) => boolean {
  return row => owned.has(pairKey(row));
}

function compactScope(ctx: DashboardQueryContext, scope: ReturnType<typeof scopeFor>): SessionUsageScope | null {
  let bytes = 2 * (scope.bindings.sessions.length + scope.bindings.runs.length + scope.sql.length);
  if (bytes > MAX_IDENTITY_BYTES) return null;
  const owned = new Set<string>();
  // Resolve every candidate pair so a later time range can reuse this revision.
  const rows = ctx.db.prepare(`${scope.sql} SELECT DISTINCT session_id AS sessionId,run_id AS runId FROM session_candidates`).iterate(scope.bindings) as Iterable<Pair>;
  for (const row of rows) {
    const key = pairKey(row);
    // Account for keys and set overhead, including non-owned pairs conservatively.
    bytes += 2 * key.length + 64;
    if (bytes > MAX_IDENTITY_BYTES) return null;
    if (scope.owns(row)) owned.add(key);
  }
  return { ownerId: scope.ownerId, sql: scope.sql, bindings: scope.bindings, owns: pairMatcher(owned) };
}

/** Worker-owned connection: preserve revision-keyed calibration fits, not panel
 * values. Each request still observes a fresh transaction and its own time range. */
export function createPanelUsageReader(file: string): PanelUsageReader {
  let reader: ReturnType<typeof openDashboardReader>;
  let identity: { revision: string; sessionId: string; scope: SessionUsageScope | null } | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let now = 0, calibrationMode: 'auto' | 'off' = 'auto';
  function close(): void {
    clearTimeout(idle); idle = undefined;
    const previous = reader; reader = undefined; identity = undefined;
    previous?.close();
  }
  return {
    close,
    read(at, sessionId, budget, mode) {
      if (isMainThread) throw new Error('usage-panel-query-requires-worker');
      now = at; calibrationMode = mode;
      try {
        reader ??= openDashboardReader(file, { instanceId: 'herdr-panel', serverBuild: 'worker', now: () => now, calibrationMode: () => calibrationMode });
        if (!reader) return null;
        const value = reader.snapshot(ctx => {
          const period = billingPeriod(now, latestValidCounter(ctx.db, now));
          let value: ReturnType<typeof sumValues> = { ...sumValues([]), credits: 0 };
          try {
            let current = identity?.scope;
            if (identity?.revision !== ctx.revision || identity.sessionId !== sessionId) {
              identity = { revision: ctx.revision, sessionId, scope: null };
              const whole = scopeFor(ctx, sessionId);
              const compact = compactScope(ctx, whole);
              // A large derived identity is used for this read only.
              if (compact) identity.scope = compact;
              else identity = undefined;
              current = compact ?? whole;
            }
            if (current) {
              const scope = scopedRange(current, { from: period.start, to: now });
              const cube = readSessionUsageCube(ctx, { start: period.start, end: now }, scope);
              if (cube.total.calls) value = cube.total;
            }
          } catch (error) {
            // A brand-new session has no ledger identity yet; it has no month calls.
            if (!(error instanceof DashboardQueryError) || error.code !== 'not-found') throw error;
          }
          const snapshots = readPaceHistoryFromDb(ctx.db, now);
          const counterPace = computePace({ now, snapshots, budget, correctedMonth: null, correctedWindow: null });
          // Counter-backed pace does not consume either corrected total. A missing
          // rate alone needs only the trailing window, not a second month pass.
          const correctedMonth = counterPace.used === null ? readCorrectedTotal(ctx, { start: period.start, end: now }) : null;
          const correctedWindow = counterPace.ratePerDay === null
            ? readCorrectedTotal(ctx, { start: Math.max(period.start, now - 7 * DAY_MS), end: now }) : null;
          return { monthCost: { credits: value.credits, label: formatValue(value, 'credits') },
            pace: counterPace.used !== null && counterPace.ratePerDay !== null ? counterPace
              : computePace({ now, snapshots, budget, correctedMonth, correctedWindow }), updatedAt: snapshots.at(-1)?.ts ?? null };
        });
        clearTimeout(idle);
        idle = setTimeout(() => { identity = undefined; idle = undefined; }, 60000);
        idle.unref?.();
        return value;
      } catch {
        // Retry with a fresh connection after a failed read.
        close(); return null;
      }
    },
  };
}
