// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildSelectionMap, shardProblems } from './map.mjs';

const metadata = { commit: 'a'.repeat(40), runId: '12345', createdAt: '2026-11-27T13:00:00.000Z' };
const a = 'packages/a/src/a.test.ts';
const b = 'packages/b/src/b.test.ts';
const c = 'packages/c/src/c.test.ts';
const shared = 'packages/shared/src/shared.ts';
const own = 'packages/b/src/b.ts';
const record = (reads, result = 'passed', ms = 10, unresolved = [], ranBundle = unresolved.length > 0) => ({
  reads, result, ms, unresolved, ranBundle,
  processes: 1, cpuMs: 20, knownCpuMs: 20, unknownCpu: 0, missingCpu: 0 });
const shard = (records, extra = {}) => ({
  reportedFiles: Object.keys(records),
  records: Object.fromEntries(Object.entries(records).map(([file, value], i) => [file, { workerPids: [123 + i], ...value }])),
  stats: { hookErrors: 0, malformedSnapshots: 0, unresolvedBundles: 0,
    unresolvedGroups: { checkout: 0, temporary: 0, other: 0 } }, ...extra,
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
    [a]: { reads: [], unresolved: [], ranBundle: false, ms: 15, result: 'passed', processes: 1, cpuMs: 20, knownCpuMs: 20, unknownCpu: 0, missingCpu: 0 },
    [b]: { reads: [], unresolved: [], ranBundle: false, ms: 47, result: 'failed', processes: 1, cpuMs: 20, knownCpuMs: 20, unknownCpu: 0, missingCpu: 0 },
    [c]: { reads: [], unresolved: [], ranBundle: false, ms: 0, result: 'skipped', processes: 1, cpuMs: 20, knownCpuMs: 20, unknownCpu: 0, missingCpu: 0 },
  });
});

test('publishes partial CPU without turning it into a complete measurement', () => {
  const partial = { ...record([]), processes: 3, cpuMs: null, knownCpuMs: 55, unknownCpu: 1, missingCpu: 1 };
  const { map } = build([shard({ [a]: partial })]);
  assert.deepEqual({ processes: map.tests[a].processes, cpuMs: map.tests[a].cpuMs,
    knownCpuMs: map.tests[a].knownCpuMs, unknownCpu: map.tests[a].unknownCpu, missingCpu: map.tests[a].missingCpu },
  { processes: 3, cpuMs: null, knownCpuMs: 55, unknownCpu: 1, missingCpu: 1 });
});

test('rejects invalid process and CPU measurements', () => {
  for (const bad of [
    { processes: 0 }, { processes: 2, cpuMs: null, unknownCpu: 0 },
    { processes: 1, cpuMs: 21, knownCpuMs: 20 }, { processes: 1, unknownCpu: 2 }, { missingCpu: 1 },
  ]) {
    const result = build([shard({ [a]: { ...record([]), ...bad } })]);
    assert.equal(result.map, null);
    assert.match(result.problems.join('\n'), /process|CPU/i);
  }
});

test('publishes the unresolved bundles of the tests that ran them', () => {
  const unresolved = ['<tmp>/fixture/dist/out.mjs', 'packages/a/dist/bundle.js'];
  const { map } = build([shard({ [a]: record([shared], 'passed', 10, unresolved), [b]: record([]) })]);
  assert.deepEqual(map.tests[a].unresolved, unresolved);
  assert.deepEqual(map.tests[b].unresolved, []);
});

test('distinguishes an executor with a mapped bundle from a direct source reader', () => {
  const { map } = build([shard({ [a]: record([shared], 'passed', 10, [], true), [b]: record([shared]) })]);
  assert.equal(map.tests[a].ranBundle, true);
  assert.equal(map.tests[b].ranBundle, false);
});

test('aggregates unresolved observation groups across shards', () => {
  const first = shard({ [a]: record([]) }, { stats: { hookErrors: 0, malformedSnapshots: 0,
    unresolvedBundles: 5, unresolvedGroups: { checkout: 2, temporary: 3, other: 0 } } });
  const second = shard({ [b]: record([]) }, { stats: { hookErrors: 0, malformedSnapshots: 0,
    unresolvedBundles: 5, unresolvedGroups: { checkout: 1, temporary: 0, other: 4 } } });
  assert.deepEqual(build([first, second]).unresolvedGroups, { checkout: 3, temporary: 3, other: 4 });
});

test('writes unresolved observation counts to the job summary', t => {
  const scratch = resolve('.spider/scratch/selection');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'map-summary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recordFile = join(dir, 'shard.json');
  const inventory = join(dir, 'inventory.json');
  const summary = join(dir, 'summary.md');
  const data = shard({ [a]: record([], 'passed', 10, ['dist/example.js']) },
    { stats: { hookErrors: 0, malformedSnapshots: 0, unresolvedBundles: 3,
      unresolvedGroups: { checkout: 1, temporary: 2, other: 0 } } });
  writeFileSync(recordFile, JSON.stringify(data));
  writeFileSync(inventory, JSON.stringify([a]));
  const result = spawnSync(process.execPath, ['scripts/selection/map.mjs', join(dir, 'map.json'), inventory, recordFile], {
    env: { ...process.env, GITHUB_SHA: metadata.commit, GITHUB_RUN_ID: metadata.runId, GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(summary, 'utf8'), /1 checkout, 2 temporary, 0 other/);
});

test('rejects shard counts that omit unresolved observations', () => {
  const bad = shard({ [a]: record([]) }, { stats: { hookErrors: 0, malformedSnapshots: 0, unresolvedBundles: 2,
    unresolvedGroups: { checkout: 0, temporary: 1, other: 0 } } });
  const result = build([bad]);
  assert.equal(result.map, null);
  assert.match(result.problems.join('\n'), /unresolved.*count/i);
});

test('rejects a record with no unresolved list', () => {
  const { unresolved, ...incomplete } = record([shared]);
  const result = build([shard({ [a]: incomplete })]);
  assert.equal(result.map, null);
  assert.match(result.problems.join('\n'), /unresolved.*a\.test\.ts/i);
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
  const error = shard({ [a]: record([shared]) }, { stats: { hookErrors: 2, malformedSnapshots: 0, unresolvedBundles: 0, unresolvedGroups: { checkout: 0, temporary: 0, other: 0 } } });
  const result = build([error]);
  assert.equal(result.map, null);
  assert.equal(result.hookErrors, 2);
});

test('rejects a shard with an unreadable snapshot', () => {
  const error = shard({ [a]: record([shared]) }, { stats: { hookErrors: 0, malformedSnapshots: 1, unresolvedBundles: 0, unresolvedGroups: { checkout: 0, temporary: 0, other: 0 } } });
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
