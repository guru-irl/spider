// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, test } from 'vitest';
import { capturePaneHandoff, readPaneHandoff } from '../herdr/pane-handoff.js';
import { parsePaneTarget } from '../../../herdr/src/panes/codec.js';
import type { PanePresentation } from '../../../herdr/src/panes/types.js';
test('handoff preparation survives restart and cannot authorize a different incarnation', async () => {
  const base = resolve('.spider/scratch/handoff-tests'); await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'r-'));
  const target = parsePaneTarget({ coreId: 'core-local', terminalId: 't1', address: 'core-local/t1', createdMs: 17, identityLabels: { 'spider.session': 'session' }, alias: null, machineId: null, kind: 'session', sessionId: 'session', generation: 'generation', homeEpoch: 0, runId: null, consoleId: null, name: null, cwd: null });
  const slot = { space: 's1', tab: 'tb1', pane: 'p1' } as const;
  const p: PanePresentation = { id: 'presentation-1', revision: 1, mode: 'native', role: 'agent', target, proxy: null, slot: slot as never, visibility: 'visible', launch: 'acknowledged', closeOperationId: null, conversion: null };
  try {
    expect(await readPaneHandoff(root, p)).toBeNull(); await capturePaneHandoff(root, p, slot as never, true);
    expect(await readPaneHandoff(root, p)).toMatchObject({ source: slot, sourceFocused: true });
    expect(await readPaneHandoff(root, { ...p, target: { ...target, createdMs: 18 } })).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});
