// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { createReplica } from '@spider/db-core/testutil';
import { readLocal, writeLocal } from '@spider/db-core/roam/local-state';
import { persistPaneStoppedIntent } from '../herdr/pane-stop.js';
const machineId = '11111111-1111-4111-8111-111111111111';
const intent = { sessionId: 'session-1', epoch: 2, file: '/home/example/session.jsonl', cwd: '/home/example', desired: 'running', suspended: null, moveId: null };
test('pane close persists stopped hosting intent without changing source ownership', () => {
  const f = createReplica('global', machineId);
  try {
    writeLocal(f.db, 'participant-intent', 'session-1', { intent, operationId: 'operation-1' });
    persistPaneStoppedIntent(f.db, { machineId, sessionId: 'session-1', sessionFile: intent.file, current: () => true });
    expect(readLocal(f.db, 'participant-intent', 'session-1')).toMatchObject({ intent: { ...intent, desired: 'stopped' }, operationId: 'operation-1', stopToken: expect.any(String) });
    const stopped = readLocal(f.db, 'participant-intent', 'session-1');
    persistPaneStoppedIntent(f.db, { machineId, sessionId: 'session-1', sessionFile: intent.file, current: () => true });
    expect(readLocal(f.db, 'participant-intent', 'session-1')).toEqual(stopped);
  } finally { f.close(); }
});
test('stale generation and changed session file leave hosting intent unchanged', () => {
  const f = createReplica('global', machineId);
  try {
    const record = { intent, operationId: 'operation-1' }; writeLocal(f.db, 'participant-intent', 'session-1', record);
    for (const [current, sessionFile] of [[false, intent.file], [true, '/home/example/other.jsonl']] as const) {
      expect(() => persistPaneStoppedIntent(f.db, { machineId, sessionId: 'session-1', sessionFile, current: () => current })).toThrow();
      expect(readLocal(f.db, 'participant-intent', 'session-1')).toEqual(record);
    }
  } finally { f.close(); }
});
