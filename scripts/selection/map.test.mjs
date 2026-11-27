// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSelectionMap, shardProblems } from './map.mjs';

const metadata = { commit: 'a'.repeat(40), runId: '12345', createdAt: '2026-11-27T13:00:00.000Z' };
const a = 'packages/a/src/a.test.ts';
const b = 'packages/b/src/b.test.ts';
const c = 'packages/c/src/c.test.ts';
const shared = 'packages/shared/src/shared.ts';
const own = 'packages/b/src/b.ts';
const record = (reads, result = 'passed', ms = 10) => ({ reads, result, ms });
const shard = (records, extra = {}) => ({
  reportedFiles: Object.keys(records),
  records: Object.fromEntries(Object.entries(records).map(([file, value], i) => [file, { workerPids: [123 + i], ...value }])),
  stats: { hookErrors: 0, malformedSnapshots: 0 }, ...extra,
});
const build = (shards, expectedFiles = shards.flatMap(shard => shard.reportedFiles)) =>
  buildSelectionMap({ shards, expectedFiles, ...metadata });

test('publishes the tested commit, producing run, timestamp, and map version', () => {
  const { map } = build([shard({ [a]: record([]) })]);
  assert.deepEqual({ version: map.version, commit: map.commit, runId: map.runId, createdAt: map.createdAt }, { version: 1, ...metadata });
});

test('indexes deduplicated source paths across shards in stable order', () => {
  const { map } = build([shard({ [b]: record([shared, own, shared]) }), shard({ [a]: record([shared]) })]);
  assert.deepEqual(map.files, [own, shared]);
  assert.deepEqual(Object.keys(map.tests), [a, b]);
  assert.deepEqual(map.tests[a].reads, [1]);
  assert.deepEqual(map.tests[b].reads, [0, 1]);
});

test('keeps failure and skip results with their reported durations', () => {
  const { map } = build([shard({ [a]: record([], 'passed', 15), [b]: record([], 'failed', 47), [c]: record([], 'skipped', 0) })]);
  assert.deepEqual(map.tests, {
    [a]: { reads: [], ms: 15, result: 'passed' },
    [b]: { reads: [], ms: 47, result: 'failed' },
    [c]: { reads: [], ms: 0, result: 'skipped' },
  });
});

test('rejects a Vitest result without a record for the file', () => {
  const missing = shard({ [a]: record([]) }, { reportedFiles: [a, b] });
  assert.match(shardProblems(missing).join('\n'), /missing.*b\.test\.ts/i);
  assert.equal(build([missing]).map, null);
});

test('rejects a file that has only a child snapshot, not its Vitest fork', () => {
  const childOnly = shard({ [a]: { ...record([shared]), workerPids: [] } });
  assert.match(shardProblems(childOnly).join('\n'), /fork.*a\.test\.ts/i);
  assert.equal(build([childOnly]).map, null);
});

test('rejects two test files sharing a Vitest fork', () => {
  const sharedFork = shard({ [a]: record([]), [b]: { ...record([]), workerPids: [123] } });
  assert.match(shardProblems(sharedFork).join('\n'), /fork.*ran both/i);
  assert.equal(build([sharedFork]).map, null);
});

test('rejects a shard that logged a hook error', () => {
  const error = shard({ [a]: record([shared]) }, { stats: { hookErrors: 2, malformedSnapshots: 0 } });
  const result = build([error]);
  assert.equal(result.map, null);
  assert.equal(result.hookErrors, 2);
});

test('rejects a shard with an unreadable snapshot', () => {
  const error = shard({ [a]: record([shared]) }, { stats: { hookErrors: 0, malformedSnapshots: 1 } });
  assert.match(shardProblems(error).join('\n'), /malformed snapshot/i);
  assert.equal(build([error]).map, null);
});

test('rejects a file reported by multiple shards', () => {
  const result = build([shard({ [a]: record([shared]) }), shard({ [a]: record([shared]) })], [a]);
  assert.match(result.problems.join('\n'), /multiple shards.*a\.test\.ts/i);
  assert.equal(result.map, null);
});

test('rejects an incomplete set of Vitest reports against discovery', () => {
  const result = build([shard({ [a]: record([]) })], [a, b]);
  assert.match(result.problems.join('\n'), /not reported.*b\.test\.ts/i);
  assert.equal(result.map, null);
});
