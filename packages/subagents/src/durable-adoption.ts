// SPDX-License-Identifier: MIT
import { openDbReadOnly, type Db } from '@spider/db-core';
import { getShared, registerShared } from './child-registry';
import { connectDurableChild, readSupervisorState, supervisorIsAlive } from './durable-child';
import { checkProcessIdentity } from './process-identity';
import { isProcessAlive } from './kill-process';

interface DurableContext { db: Db; globalDb?: Db; sessionId?: string; runDbPath?: string; project?: { dbPath: string } }
function currentDbPath(ctx: DurableContext): string {
  return ctx.runDbPath ?? ctx.project?.dbPath ?? ctx.db.raw.name;
}
function durablePaths(ctx: DurableContext): Set<string> {
  const paths = new Set([currentDbPath(ctx)]);
  if (ctx.globalDb) {
    const routes = ctx.globalDb.prepare(`SELECT DISTINCT db_path FROM run_routes${ctx.sessionId ? ' WHERE session_id=?' : ''}`)
      .all(...(ctx.sessionId ? [ctx.sessionId] : [])) as { db_path: string }[];
    for (const route of routes) paths.add(route.db_path);
  }
  return paths;
}
function directory(payload: string): string | undefined {
  try { const metadata = JSON.parse(payload); if (metadata.version === 1 && typeof metadata.directory === 'string') return metadata.directory; } catch { /* malformed persisted metadata */ }
  return undefined;
}

/** Existing /reload adoption also owns cross-process recovery. A terminal cancellation
 * is a tombstone. It is never registered again, even if a stale socket remains. */
export function discoverDurableChildren(ctx: DurableContext & { sessionId: string }): void {
  for (const path of durablePaths(ctx)) {
    const db = path === currentDbPath(ctx) ? ctx.db : openDbReadOnly(path);
    if (!db) continue; // Removed worktrees can leave old routing records.
    try {
      const rows = db.prepare(`SELECT r.id,r.child_mode,e.payload FROM runs r JOIN run_events e ON e.run_id=r.id AND e.type='child_supervisor'
        WHERE r.session_id=? AND r.status!='cancelled'
        AND NOT EXISTS (SELECT 1 FROM run_events delivered WHERE delivered.run_id=r.id AND delivered.type='completion_delivered')
        ORDER BY e.id`).all(ctx.sessionId) as Array<{ id: string; child_mode: 'rpc' | 'print'; payload: string }>;
      for (const row of rows) {
        if (getShared(row.id)) continue;
        const pathToSupervisor = directory(row.payload); if (!pathToSupervisor) continue;
        const handle = connectDurableChild(pathToSupervisor); handle.detach();
        const entry = registerShared({ runId: row.id, sessionId: ctx.sessionId, dbPath: path, mode: row.child_mode, handle, survivable: true });
        entry.state = 'independent';
      }
    } finally { if (db !== ctx.db) db.close(); }
  }
}

export interface DurableDiagnostic {
  runId: string; status: string;
  supervisor: 'alive' | 'gone' | 'unreadable'; child: 'alive' | 'gone' | 'unknown'; owner: 'attached' | 'detached';
  supervisorPid?: number; childPid?: number;
}
/** Read-only. Tokens and task text never leave the private state file. Historical,
 * fully stopped runs are omitted; a terminal row with a live process is still a leak. */
export function diagnoseDurableChildren(ctx: DurableContext): DurableDiagnostic[] {
  const result: DurableDiagnostic[] = [];
  for (const path of durablePaths(ctx)) {
    const db = path === currentDbPath(ctx) ? ctx.db : openDbReadOnly(path);
    if (!db) continue;
    try {
      const rows = db.prepare(`SELECT r.id,r.status,e.payload FROM runs r JOIN run_events e ON e.run_id=r.id AND e.type='child_supervisor'
        ${ctx.sessionId ? 'WHERE r.session_id=?' : ''} ORDER BY e.id`).all(...(ctx.sessionId ? [ctx.sessionId] : [])) as Array<{ id: string; status: string; payload: string }>;
      for (const row of rows) {
        const pathToSupervisor = directory(row.payload), state = pathToSupervisor ? readSupervisorState(pathToSupervisor) : undefined;
        const supervisorAlive = Boolean(state && supervisorIsAlive(state));
        const childAlive = Boolean(state?.childPid && isProcessAlive(state.childPid)
          && (!state.childStartTime || checkProcessIdentity(state.childPid, state.childStartTime).matches));
        if (!['queued', 'running', 'paused'].includes(row.status) && !supervisorAlive && !childAlive) continue;
        result.push({ runId: row.id, status: row.status, supervisor: state ? supervisorAlive ? 'alive' : 'gone' : 'unreadable',
          child: state?.childPid ? childAlive ? 'alive' : 'gone' : 'unknown', owner: state?.ownerPid && isProcessAlive(state.ownerPid) ? 'attached' : 'detached',
          ...(state ? { supervisorPid: state.supervisorPid, childPid: state.childPid } : {}) });
      }
    } finally { if (db !== ctx.db) db.close(); }
  }
  return result;
}
