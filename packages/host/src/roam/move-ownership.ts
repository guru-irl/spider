import { bootIdChanged, inspectIdLock } from '@spider/herdr/sessions/id-lock';
import type { ProcessInventoryPorts } from '@spider/herdr/sessions/lease';
import type { Probe } from '@spider/db-core/roam/types';
import { OwnershipFailure } from '@spider/roam/ownership-failure';

export function createMoveOwnershipProbe(input: {
  root: string;
  inventory: ProcessInventoryPorts;
  bootId(): Promise<string>;
  /** Null means no claim here; false means a previously held claim was lost. */
  heldClaim(sessionId: string): Promise<boolean | null>;
}): (sessionId: string) => Promise<Probe> {
  return async sessionId => {
    try {
      const held = await input.heldClaim(sessionId);
      if (held === false) throw new OwnershipFailure('ownership-lock-lost');
      const lock = await inspectIdLock(input.root, sessionId);
      if (lock && held !== true) {
        if (lock.pendingOperationId) throw new OwnershipFailure('ownership-handoff-pending');
        const bootId = await input.bootId();
        if (!bootId || !lock.bootId) throw new OwnershipFailure('ownership-boot-unavailable');
        if (!bootIdChanged(lock.bootId, bootId)) {
          const observed = await input.inventory.probe(lock.identity.pid);
          if (observed.kind === 'unknown') throw new OwnershipFailure('ownership-process-unavailable');
          if (observed.kind === 'live' && observed.startIdentity === lock.identity.startIdentity)
            return { kind: 'live', identity: { bootId, pid: lock.identity.pid, startTime: observed.startIdentity } };
        }
        // A stale lock proves only its recorded owner gone, not every replacement.
      }
      const records = await input.inventory.presence.list();
      for (const record of records.filter(record => record.sessionId === sessionId)) {
        const observed = await input.inventory.probe(record.pid);
        if (observed.kind === 'unknown') throw new OwnershipFailure('ownership-process-unavailable');
        if (observed.kind === 'live' && observed.startIdentity === record.startIdentity)
          throw new OwnershipFailure('ownership-presence-live');
      }
      const processes = await input.inventory.processes();
      if (processes.some(row => row.classification !== 'pi' || !row.startIdentity ||
          !records.some(record => record.pid === row.pid && record.startIdentity === row.startIdentity)))
        throw new OwnershipFailure('ownership-unregistered-process');
      return { kind: 'absent' };
    } catch (error) {
      if (error instanceof OwnershipFailure) throw error;
      throw new OwnershipFailure('ownership-state-unavailable');
    }
  };
}
