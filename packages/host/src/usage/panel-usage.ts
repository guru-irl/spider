import { isMainThread } from 'node:worker_threads';
import { DashboardQueryError } from './dashboard-contract.js';
import { openDashboardReader } from './dashboard-reader.js';
import { billingPeriod, computePace } from './billing-pace.js';
import { latestValidCounter } from './latest-valid-counter.js';
import { readCorrectedTotal, readSessionUsageCube, sumValues } from './query-redesign-shared.js';
import { scopeFor, scopedRange } from './query-session.js';
import { readPaceHistoryFromDb } from './pace-history.js';
import { formatValue } from './web/format.js';
import { DAY_MS } from './dashboard-selection.js';
import type { PanelUsage } from './protocol.js';

/** Worker-only: do not materialize a whole-account session/model/bucket cube. */
export function readPanelUsage(file: string, now: number, sessionId: string, budget: number | undefined, calibrationMode: 'auto' | 'off'): PanelUsage | null {
  if (isMainThread) throw new Error('usage-panel-query-requires-worker');
  let reader: ReturnType<typeof openDashboardReader> = undefined;
  try {
    reader = openDashboardReader(file, { instanceId: 'herdr-panel', serverBuild: 'worker', now: () => now, calibrationMode: () => calibrationMode });
    if (!reader) return null;
    return reader.snapshot(ctx => {
      const period = billingPeriod(now, latestValidCounter(ctx.db, now));
      let value: ReturnType<typeof sumValues> = { ...sumValues([]), credits: 0 };
      try {
        const scope = scopedRange(scopeFor(ctx, sessionId), { from: period.start, to: now });
        const cube = readSessionUsageCube(ctx, { start: period.start, end: now }, scope);
        if (cube.total.calls) value = cube.total;
      } catch (error) {
        // A brand-new session has no ledger identity yet; it has no month calls.
        if (!(error instanceof DashboardQueryError) || error.code !== 'not-found') throw error;
      }
      const snapshots = readPaceHistoryFromDb(ctx.db, now);
      const correctedMonth = readCorrectedTotal(ctx, { start: period.start, end: now });
      const correctedWindow = readCorrectedTotal(ctx, { start: Math.max(period.start, now - 7 * DAY_MS), end: now });
      return { monthCost: { credits: value.credits, label: formatValue(value, 'credits') },
        pace: computePace({ now, snapshots, budget, correctedMonth, correctedWindow }), updatedAt: snapshots.at(-1)?.ts ?? null };
    });
  } catch { return null; } finally { reader?.close(); }
}
