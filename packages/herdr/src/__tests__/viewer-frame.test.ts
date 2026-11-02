// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
import { expect, test } from 'vitest';
import { parseRunViewFrame } from '../../assets/shared/feed.js';
const snapshot = (view?: unknown) => JSON.stringify({ runId: 'run', cursor: 'one', kind: 'snapshot', data: {
  run: { id: 'run', ownerSessionId: 'owner', name: 'review', status: 'running', childMode: 'rpc', canSteer: true, startedAt: 1, finishedAt: null, viewer: null, result: null },
  ...(view === undefined ? {} : { view }),
} });
test('legacy and pi model snapshots cross the same frame boundary', () => {
  expect(parseRunViewFrame(snapshot())).not.toBeNull();
  expect(parseRunViewFrame(snapshot({ protocol: 2, sessionFile: null, model: 'example/model-one', thinking: 'high', contextWindow: 200000 }))).not.toBeNull();
});
test.each([{ contextWindow: '200k' }, { contextWindow: -1 }, { contextWindow: 0 }, { model: [] }, { thinking: {} }])('invalid pi footer metadata is rejected, not rendered', invalid => {
  expect(parseRunViewFrame(snapshot({ protocol: 2, ...invalid }))).toBeNull();
});
