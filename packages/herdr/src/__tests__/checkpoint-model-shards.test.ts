// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { checkpointModelCases } from './setup-checkpoint-model.js';

// Captured from the unsharded seed=182 run. Each row remains one model test.
const seed182 = [
  'setup,keys,fail-retry,setup,bookkeeping,doctor',
  'setup,keys,replace,pi,undo-crash',
  'setup,cutover-crash,app,batch-crash,rollback',
  'setup,undo,layout-only,layout-only',
  'setup,setup,app,setup',
  'setup,undo,move,app',
  'setup,replace,undo-replace,doctor,settings,journal-crash',
  'setup,replace,batch-crash,move,rollback',
  'setup,shell,fail-retry,undo-replace,rollback,batch-crash',
  'setup,undo-replace,shell,shell,replace,undo',
  'setup,cutover-crash,bookkeeping,undo-crash,pi,remote',
  'setup,batch-crash,layout-only,app',
  'setup,setup,move,undo-replace',
  'setup,fail-retry,shell,bookkeeping',
  'setup,undo-replace,fail-retry,doctor',
  'setup,layout-only,remote,pi',
  'setup,batch-crash,batch-crash,pi-during-undo,shell,move',
  'setup,layout-only,pi-during-undo,setup',
  'setup,template,cutover-crash,settings,settings',
  'setup,fail-retry,layout-only,template',
  'setup,fail-retry,app,app,undo-replace',
  'setup,remote,pi-during-undo,pi,pi-during-undo,keys',
  'setup,pi-during-undo,remote,undo,fail-retry',
  'setup,doctor,batch-crash,replace,bookkeeping,remote',
  'setup,undo,shell,pi-during-undo,undo',
  'setup,pi-during-undo,template,layout-only,keys,cutover-crash',
  'setup,remote,pi-during-undo,undo',
  'setup,settings,journal-crash,cutover-crash,bookkeeping',
  'setup,shell,bookkeeping,pi,batch-crash',
  'setup,pi,shell,keys',
  'setup,template,undo-crash,setup,layout-only',
  'setup,cutover-crash,fail-retry,app,pi-during-undo',
];

test('partitions all original seed 182 model sequences without changing their steps', () => {
  const shards = ([0, 1, 2, 3] as const).map(shard => checkpointModelCases(182, shard));
  expect(shards.map(shard => shard.length)).toEqual([8, 8, 8, 8]);
  const cases = shards.flat().sort((a, b) => a.sequence - b.sequence);
  expect(cases.map(row => row.sequence)).toEqual(Array.from({ length: 32 }, (_, i) => i));
  expect(cases.map(row => row.steps.join(','))).toEqual(seed182);
});
