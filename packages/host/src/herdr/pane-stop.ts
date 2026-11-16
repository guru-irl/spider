// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from '@spider/db-core';
import { readLocal, writeLocal } from '@spider/db-core/roam/local-state';
import { readLocalIdentity } from '../../../roam/src/runtime.js';
import type { HostIntent } from '../../../roam/src/contracts.js';
import type { BoxLocalOrigin } from '../../../roam/src/session-control.js';
import type { Owner } from '../../../herdr/src/contracts.js';
import { HerdrError } from '../../../herdr/src/client/parse.js';
/** Called in the owning process. Generation and home checks share the intent transaction. */
export function persistPaneStoppedIntent(db: Db, input: { machineId: string; sessionId: string; sessionFile: string | null; current(): boolean }): void {
  db.raw.transaction(() => {
    if (!input.current()) throw new HerdrError('stale-pane-owner', 'Source session changed');
    const home = db.prepare('SELECT machine_id, epoch FROM session_homes WHERE session_id = ?').get(input.sessionId) as { machine_id: string; epoch: number } | undefined;
    if (home && home.machine_id !== input.machineId) throw new HerdrError('stale-pane-home', 'Session has another execution home');
    const previous = readLocal<{ intent: HostIntent; operationId: string; stopToken?: string }>(db, 'participant-intent', input.sessionId);
    if (previous) {
      if (previous.intent.file !== input.sessionFile || home && previous.intent.epoch !== home.epoch) throw new HerdrError('stale-pane-home', 'Session home changed');
      writeLocal(db, 'participant-intent', input.sessionId, { ...previous, intent: { ...previous.intent, desired: 'stopped' }, stopToken: previous.intent.desired === 'stopped' && previous.stopToken || randomUUID() });
    } else {
      const origin = readLocal<BoxLocalOrigin>(db, 'participant-origin', input.sessionId);
      if (origin) {
        if (origin.machineId !== input.machineId || origin.file !== input.sessionFile || home && origin.epoch !== home.epoch) throw new HerdrError('stale-pane-home', 'Session origin changed');
        writeLocal(db, 'participant-origin', input.sessionId, { ...origin, stopped: true });
      } else if (home) throw new HerdrError('stale-pane-home', 'Session hosting provenance is unavailable');
    }
  }).immediate();
}
export function stopPaneHosting(root: string, owner: Owner, current: () => boolean): void {
  if (!current()) throw new HerdrError('stale-pane-owner', 'Source session changed');
  if (!existsSync(join(root, 'roam', 'config.json'))) return;
  const config = readLocalIdentity(root);
  const db = openDb(join(root, 'spider.db'), { fileMustExist: true });
  try { persistPaneStoppedIntent(db, { machineId: config.machineId, sessionId: owner.sessionId, sessionFile: owner.sessionFile, current }); }
  finally { db.close(); }
}
